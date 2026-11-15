# Wallet Ledger API

An HTTP API that keeps a money ledger for many users, with `credit`, `debit` and `get_balance`,
backed by PostgreSQL. It is built to stay correct under heavy concurrency and fast on a ledger
of 10M+ rows.

**Stack:** Node.js 24 + TypeScript, Fastify 5, node-postgres, PostgreSQL 17, Vitest, Docker Compose.

**Results at a glance** (10.2M ledger rows, 100 concurrent clients; [details](#load-test-results)):

| | p50 | p99 | Errors |
|---|---:|---:|---:|
| `GET /balance` | 6.3 ms | 15.8 ms | 0 |
| `POST /credit` | 11.6 ms | 24.6 ms | 0 |
| `POST /debit` | 11.6 ms | 24.6 ms | 0 |

- Latency at 10M rows is the same as at 1M.
- Ledger and balances reconcile exactly after every test.
- No balance went negative at any point.

---

## How to run

Requirements: Docker with Compose v2. Node.js 22.18+ is only needed to run the tests.

```bash
# 1. Start the API (port 8080) and the database. Creates the schema on first start.
docker compose up -d --build

# 2. Load the seed: 10,210,049 ledger rows, 100,000 users (~1 minute).
docker compose --profile seed run --rm seed

#    Or ~1M rows (same users, fewer rows each):
SEED_SCALE=0.1 docker compose --profile seed run --rm seed

# 3. Try it
curl -s -X POST localhost:8080/credit -H 'Authorization: Bearer recruitment-test-token' \
     -H 'Content-Type: application/json' -d '{"user_id":"u123","amount":10000}'
curl -s localhost:8080/balance/u123 -H 'Authorization: Bearer recruitment-test-token'

# 4. Full consistency check: every count must be 0
docker compose exec -T db psql -U ledger -d ledger -f /db/verify.sql

# 5. Query plans
docker compose exec -T db psql -U ledger -d ledger -f /db/explain.sql

# Reset everything (deletes the data volume)
docker compose down -v
```

- The token comes from `API_TOKEN`, which defaults to `recruitment-test-token` in `docker-compose.yml`.
  Override it with `API_TOKEN=other docker compose up`.
- The database is published on `127.0.0.1:55432` (change it with `DB_HOST_PORT`) for tests and SQL checks.
  It uses an uncommon port so it can't clash with a PostgreSQL already running on 5432.

### Swagger UI (optional)

```bash
ENABLE_DOCS=true docker compose up -d --build     # PowerShell: $env:ENABLE_DOCS="true"; docker compose up -d --build
```

Open <http://localhost:8080/docs>, click **Authorize**, enter the token (`recruitment-test-token`),
then use **Execute** on any endpoint. The raw OpenAPI document is at `/docs/json`.

- **Off by default.** The brief requires the bearer token on every endpoint, and a browser can't send
  one just to open a page. With docs off, `/docs` gets 401 like everything else. A plain
  `docker compose up` turns it back off.
- **When on, only the docs pages are public.** Every API call made from Swagger still needs the token.
  The exemption matches Fastify's matched route pattern, not the raw URL, so tricks like
  `/docs/../credit` can't get around it.
- **The schemas are documentation only.** Fastify's built-in validator converts types (it would accept
  `"100"` as `100`), so it's switched off. Input rules stay in [`validation.ts`](src/validation.ts),
  and a test proves the schemas don't weaken them.

### Tests

```bash
npm ci
npm run test:unit          # 165 tests, no database needed (~3 s)
npm run test:integration   # 18 tests against the running stack (~10 s)
```

Integration tests cover:
- the API contract,
- each of the six concurrency rules from the brief, with real parallel HTTP requests, and
- a reconciliation of the whole database.

### Load test

```bash
docker compose --profile loadtest run --rm loadtest --scenario mixed   # 100 clients, 60 s
docker compose --profile loadtest run --rm loadtest --scenario hot     # 50 clients on one user + 50 mixed
```

- **Runs inside the Docker network**, so host port-forwarding doesn't distort the numbers.
- **Spreads clients over worker threads**, so the generator isn't the bottleneck.
- **Uses only Node built-ins.** No install is needed.
- **Options:** `--concurrency`, `--duration`, `--threads`, `--label`.
- **Output:** results are saved to `loadtest/results/`.

---

## API

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /credit` | `{"user_id": "u123", "amount": 10000}` | `200 {"user_id", "balance"}` | 400, 401 |
| `POST /debit` | `{"user_id": "u123", "amount": 4000}` | `200 {"user_id", "balance"}` | 400, 401, 404, 409 |
| `GET /balance/{user_id}` | none | `200 {"user_id", "balance"}` | 400, 401, 404 |
| `GET /health` (extra) | none | `200 {"status": "ok"}` | 401, 500 |
| `GET /docs` (extra, off by default) | none | Swagger UI | — |

Errors are always `{"error": "<code>", "message": "<text>"}`. Unknown routes return
`404 {"error": "not_found"}`, after the auth check.

---

## Design

### Request pipeline

```
request
  -> onRequest hook: constant-time bearer token check        401, before body parsing or DB access
  -> strict JSON parser (rejects 1.0 and 1e3 as decimals)    400
  -> validation: user_id pattern, amount 1..1,000,000,000    400
  -> writes: per-user batcher -> apply_movements(...)        one statement = one transaction
             retried as a whole on deadlock / serialization failure
     reads:  primary-key lookup on balances                  no locks, never queued
  -> response sent only after COMMIT                         read-your-writes
```

| File | Responsibility |
|---|---|
| [`src/server.ts`](src/server.ts) | Process wiring: worker processes, DB pool, graceful shutdown |
| [`src/app.ts`](src/app.ts) | HTTP layer: auth hook, JSON parser, routes, error mapping |
| [`src/docs.ts`](src/docs.ts) | OpenAPI description and the optional Swagger UI |
| [`src/auth.ts`](src/auth.ts) | Constant-time bearer token check |
| [`src/json.ts`](src/json.ts) | JSON parsing that rejects decimals written as `1.0` |
| [`src/validation.ts`](src/validation.ts) | Input rules |
| [`src/walletService.ts`](src/walletService.ts) | Domain: per-user batching, retries, 404/409 mapping |
| [`src/keyedBatcher.ts`](src/keyedBatcher.ts) | One batch at a time per user, parallel across users |
| [`src/ledgerRepository.ts`](src/ledgerRepository.ts) | All SQL issued by the API |
| [`src/retry.ts`](src/retry.ts) | Retry of deadlocks and serialization failures only |
| [`db/schema.sql`](db/schema.sql) | Tables, constraints, indexes, `apply_movements`, immutability triggers |
| [`db/seed.sql`](db/seed.sql), [`db/verify.sql`](db/verify.sql), [`db/explain.sql`](db/explain.sql) | Seed, consistency checks, query plans |

### Schema

```
ledger    id bigint identity PK | user_id text | type enum(credit,debit) | amount bigint 1..1e9 | created_at timestamptz
          index (user_id, id)
          triggers reject UPDATE / DELETE / TRUNCATE  -> append-only, enforced by the database

balances  user_id text PK | balance bigint CHECK (balance >= 0) | created_at | updated_at
          fillfactor 80, aggressive autovacuum
```

- **`ledger` is the source of truth.** Every credit and debit is one row. The database itself refuses to
  update, delete or truncate ledger rows.
- **`balances` is a running total**, changed in the same transaction as each ledger insert, so the
  two always agree.
- **Money is `bigint` minor units.** No floating point, no rounding.
- **`user_id` uses `COLLATE "C"`** (byte comparison), which is cheaper than locale-aware comparison for an identifier.
- **One secondary index on the ledger, `(user_id, id)`.** It serves per-user history and reconciliation. Every
  extra index would slow down every insert.
- **`balances` has `fillfactor = 80`.** Balance updates can then be HOT updates that skip the primary-key
  index, and autovacuum runs early because these rows change constantly.

### How the balance is computed

`get_balance` is a primary-key lookup on `balances`: 0.06 ms in the plan below, the same for a user
with 1 row or 120,000. Summing the ledger on every read would scan the user's whole history, which
the brief rules out.

### How writes stay correct under concurrency

Every write goes through one database function,
[`apply_movements(user_id, types[], amounts[])`](db/schema.sql). It applies a list of credits and debits
for **one** user in order and returns one outcome per movement. The API calls it as a single statement,
so each call is **one transaction and one network round trip**.

For each movement inside the function:

**Credit:** create the balance row on the first credit, otherwise add to it, then insert the ledger row.
```sql
INSERT INTO balances AS b (user_id, balance) VALUES (p_user_id, p_amount)
ON CONFLICT (user_id) DO UPDATE SET balance = b.balance + EXCLUDED.balance
RETURNING b.balance;
INSERT INTO ledger (user_id, type, amount) VALUES (p_user_id, 'credit', p_amount);
```

**Debit:** check and subtract in one atomic UPDATE. The ledger row is inserted only if it matched.
```sql
UPDATE balances AS b SET balance = b.balance - p_amount
WHERE b.user_id = p_user_id AND b.balance >= p_amount
RETURNING b.balance;
-- FOUND     -> insert the ledger row, outcome 'ok'
-- not FOUND -> nothing written; outcome 'insufficient_funds' (409) or 'user_not_found' (404)
```

Why this is safe:
- **Two debits of 60 against 100:** the first locks the user's `balances` row and subtracts. The second
  waits on that lock. When it gets the lock, PostgreSQL (in READ COMMITTED) **re-evaluates the WHERE
  clause against the newly committed row**: `40 >= 60` is false, so it matches nothing, nothing is
  written, and the API returns 409.
- **No lost updates:** `balance = balance + amount` is computed by the database under the row lock. The
  application never reads a balance and writes it back.
- **Racing first credits:** the second insert waits on the primary-key entry, then takes the
  `DO UPDATE` path, so both amounts count.
- **Last line of defence:** `CHECK (balance >= 0)` makes a negative balance impossible to store, whatever the code does.

### Isolation level: READ COMMITTED

Every statement touches exactly one `balances` row, and safety comes from that row's lock plus the
re-check after waiting. There is no multi-row invariant for SERIALIZABLE to protect. Under SERIALIZABLE
or REPEATABLE READ, concurrent writers to one row **abort** (error 40001) instead of waiting, so a hot
user would see constant retries.

### Per-user group commit (the hot-user problem)

Writes to one user are serialized by the row lock, and each durable commit waits for a WAL flush to
disk (a few milliseconds). With one transaction per write, a single hot user was capped at about
**320 writes/s**, and 50 clients on that user saw a p50 of 155 ms.

[`KeyedBatcher`](src/keyedBatcher.ts) runs **at most one batch per user at a time**. Writes that arrive
for that user while a batch is running queue up in memory, and the next batch takes **all** of them, up
to 64. The whole batch is sent as **one** `apply_movements` call, so **one commit covers many writes**:

| Hot user, 50 clients | Writes/s | p50 | p99 |
|---|---:|---:|---:|
| One transaction per write | ~320 | 155 ms | 280 ms |
| Batched, one round trip per statement | ~480 | 95 ms | 260 ms |
| **Batched in one `apply_movements` call** | **~1,430** | **32 ms** | **85 ms** |

What stays the same:
- **Order:** a batch applies writes in arrival order, so each debit sees the balance left by the writes
  before it, exactly as if they ran one by one.
- **Durability:** every caller gets its response only after the batch commits.
- **Atomicity:** a batch commits or rolls back as a whole. A deadlock or serialization failure retries
  the whole batch, which is safe because none of it was applied. A 404/409 is a normal *outcome* for
  that one movement, not an error, so it never fails the rest of the batch.
- **Fairness:** a lone write is just a batch of one, with no added delay. A hot user occupies at most one
  database connection per worker process, leaving the rest of the pool to other users.
- **Reads** are never queued: they take no locks (MVCC), so a balance read never waits behind writes.

### Multiple worker processes

Node runs JavaScript on one thread. Profiling showed a single process saturating one CPU core
(98%) while the database's connections sat idle. [`server.ts`](src/server.ts) forks
`WEB_CONCURRENCY` worker processes (4 by default) that share port 8080. Each has a pool of 16
connections, 64 in total, well under `max_connections = 200`. This doubled throughput. Measured at 4, 6
and 8 workers: above 4, extra workers only take CPU from PostgreSQL on the same machine.

Correctness doesn't depend on this, because all locking is in the database. The one effect: each
worker has its own batcher, so a hot user can have up to 4 batches in flight, one per worker.

### Atomicity and crashes

A write is one statement, so it's one transaction. If the process or the database dies before COMMIT,
PostgreSQL discards the whole transaction on restart. The response is sent only after COMMIT, and
`synchronous_commit` stays **on**, so a 200 means the write is on disk. A test runs a debit inside an open
transaction, checks that nobody else can see it, kills the connection, and checks that nothing was
written and the lock was released.

### Deadlocks and conflicts

Each transaction locks a single `balances` row, so a lock cycle can't form. As a safety net,
SQLSTATE `40P01` (deadlock) and `40001` (serialization failure) are retried up to 5 times with
jittered exponential backoff. Nothing else is retried. In particular, a lost connection is not
retried, because that write may already have committed.

### Authentication

- Runs in Fastify's `onRequest` hook, before the body is parsed and before any database access. Bad
  JSON without a token gets 401, not 400.
- Uses `crypto.timingSafeEqual` on SHA-256 digests of both tokens. Equal-length buffers avoid the length
  leak (and the exception) of comparing raw strings.
- `API_TOKEN` is read at startup, and the server refuses to start without it. The token is never in the
  source and never returned. The `authorization` header is redacted from logs, and per-request logging
  is off by default.

### Input validation

`JSON.parse` turns `1.0` into the integer `1`, so a naive check would accept it. The custom JSON
parser uses the reviver's `context.source` (the raw text of each number, Node 21+) and rejects any
number not written as a plain integer, such as `1.0`, `1e3` or `100.00`. The server checks at startup
that the runtime supports this.

---

## Alternatives considered and rejected

| Decision | Alternative | Why not |
|---|---|---|
| Balance | `SUM()` over the ledger on each read | Reads the user's whole history (up to 120k rows); latency grows with the table |
| Balance | Cache in Redis | A second source of truth that can drift; a mismatch fails the test outright |
| Balance | Materialized view | Stale between refreshes, which breaks read-your-writes |
| Balance | `balance_after` column on each ledger row | Also O(1) and valid, but a debit must then lock "the latest row of this user"; a dedicated row is simpler to lock |
| Concurrency | Read in the app, check, then write | Check-then-act race: two debits both read 100 and both succeed |
| Concurrency | `SELECT … FOR UPDATE` then `UPDATE` | Correct, but more round trips while holding the lock |
| Concurrency | Optimistic locking (version column + retry) | On a hot user nearly every attempt conflicts; retry storms hurt p99 |
| Concurrency | Advisory locks | A second lock system to reason about; the row lock already does the job |
| Concurrency | Mutex in Node | Breaks with more than one process or instance |
| Isolation | SERIALIZABLE / REPEATABLE READ | Writers to one row abort instead of waiting; constant retries on a hot user, no correctness gain here |
| Hot user | One transaction per write | Measured: ~320 writes/s cap, p50 155 ms (see table above) |
| Hot user | Larger connection pool | Hides the problem and makes PostgreSQL slower (memory, context switching) |
| Hot user | Split a user's balance into N sub-rows | Credits scale, but debits must check the total across sub-rows; complex and easy to get wrong |
| Write SQL | CTE statements sent from Node (the first version) | Fine for single writes, but a batch needed one round trip per write while holding the lock |
| Ledger id | UUID | Random inserts fragment the B-tree; a sequential bigint is smaller and faster |
| Speed | `synchronous_commit = off`, unlogged tables | Faster, but a 200 could be lost in a crash |
| Reads | Read replicas | Replication lag breaks read-your-writes |
| Seed | Through the API, or row by row | Hours instead of under a minute |

---

## Seed data

[`db/seed.sql`](db/seed.sql) generates everything inside PostgreSQL with `generate_series`, in one transaction:

| Users | Rows each | Rows |
|---|---|---|
| 20 | 120,000 | 2,400,000 |
| 980 | 2,000 | 1,960,000 |
| 9,000 | 400 | 3,600,000 |
| 90,000 | 10–40 | 2,250,049 |
| **100,000** | | **10,210,049** |

- **Never negative at any point.** Each user opens with a 1,000,000 credit. After that, every debit is
  paired with, and smaller than, the credit just before it, so the running balance never drops below
  the opening credit. `verify.sql` checks this with a running-sum window over all 10M rows.
- **Interleaved history.** Rows are inserted ordered by (step, user), so ids interleave users like real
  traffic while each user's history stays in order.
- **Fast bulk load.** The ledger index is dropped and rebuilt once at the end. `synchronous_commit` is off
  for the seed session only. `balances` is built with one `GROUP BY` over the ledger, so it matches by
  construction.

**Seed time** on the test machine (below):

| Seed | Rows | Total | Ledger insert | Index build | Balances |
|---|---:|---:|---:|---:|---:|
| `SEED_SCALE=1` | 10,210,049 | **53 s** | 38.5 s | 8.1 s | 3.1 s |
| `SEED_SCALE=0.1` | 1,039,874 | **7 s** | 3.8 s | 0.8 s | 1.1 s |

`verify.sql` on the 10M seed: 0 mismatches, 0 negative balances, 0 users ever negative, 0 invalid amounts.

---

## Query plans

From [`db/explain.sql`](db/explain.sql) on the 10.2M-row database. The target is `user_000001`, the user
with the longest history (120,000 rows), inside a rolled-back transaction. Writes run inside
`apply_movements`, so `auto_explain` prints the real plan of each statement inside it.

**get_balance**
```
Index Scan using balances_pkey on balances (actual time=0.037..0.038 rows=1 loops=1)
  Index Cond: (user_id = 'user_000001'::text)
  Buffers: shared hit=4
Execution Time: 0.060 ms
```

**debit (enough balance):** conditional update, then ledger insert
```
Update on balances b (actual time=0.090..0.091 rows=1 loops=1)
  ->  Index Scan using balances_pkey on balances b (actual time=0.022..0.023 rows=1 loops=1)
        Index Cond: (user_id = 'user_000001'::text)
        Filter: (balance >= '200'::bigint)
        Buffers: shared hit=4
Insert on ledger (actual time=0.018..0.018 rows=0 loops=1)
  Buffers: shared hit=7
```

**debit (insufficient funds):** the update matches nothing, an index-only existence check decides 409 vs 404, and nothing is written
```
Update on balances b (actual time=0.022..0.022 rows=0 loops=1)
  ->  Index Scan using balances_pkey on balances b
        Index Cond: (user_id = 'user_000001'::text)
        Filter: (balance >= '1000000000'::bigint)
        Rows Removed by Filter: 1
Result (actual time=0.032..0.032 rows=1 loops=1)
  InitPlan 1
    ->  Index Only Scan using balances_pkey on balances b
          Index Cond: (user_id = 'user_000001'::text)
```

**credit:** upsert through the primary key, then ledger insert
```
Insert on balances b (actual time=0.446..0.447 rows=1 loops=1)
  Conflict Resolution: UPDATE
  Conflict Arbiter Indexes: balances_pkey
  Conflicting Tuples: 1
  Buffers: shared hit=20
Insert on ledger (actual time=0.377..0.378 rows=0 loops=1)
  Buffers: shared hit=57 dirtied=1
```

Every access is through `balances_pkey`, and the ledger is only ever **inserted into**, never read, on
the request path. Nothing scans the ledger or a user's history, which is why latency doesn't change
between 1M and 10M rows.

---

## Load test results

**Machine:** Windows 11, Docker Desktop (WSL2) with 12 vCPUs and 16 GB; API, PostgreSQL and the load
generator all on the same machine. **Settings:** 100 concurrent clients, 5 s warm-up, 60 s measured,
generator inside the Docker network. Latency is measured client-side, per request.

### Mixed traffic (50% balance, 30% credit, 20% debit, random users of the seed)

| Endpoint | Rows | Requests | Req/s | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---:|---:|---:|---:|---:|---:|
| `GET /balance` | 1M | 316,443 | 5,274 | 6.32 | 11.77 | 15.84 | 0 |
| `GET /balance` | **10M** | 318,270 | 5,305 | **6.31** | 11.83 | **15.83** | 0 |
| `POST /credit` | 1M | 192,030 | 3,201 | 11.45 | 18.41 | 24.84 | 0 |
| `POST /credit` | **10M** | 190,633 | 3,177 | **11.58** | 18.47 | **24.64** | 0 |
| `POST /debit` | 1M | 126,653 | 2,111 | 11.53 | 18.41 | 24.66 | 0 |
| `POST /debit` | **10M** | 127,104 | 2,118 | **11.62** | 18.51 | **24.64** | 0 |

Total: about 10,600 requests/s. Latency is the same at 1M and 10M rows.

### Hot user (50 clients on one user + 50 clients of mixed traffic on other users)

| Endpoint | Rows | Requests | Req/s | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---:|---:|---:|---:|---:|---:|
| hot `POST /credit` | 10M | 51,469 | 858 | 32.27 | 62.12 | 85.11 | 0 |
| hot `POST /debit` | 10M | 34,325 | 572 | 31.84 | 60.51 | 82.35 | 0 |
| other `GET /balance` | 10M | 268,337 | 4,472 | 3.35 | 7.18 | 9.90 | 0 |
| other `POST /credit` | 10M | 161,122 | 2,685 | 7.01 | 11.64 | 15.11 | 0 |
| other `POST /debit` | 10M | 107,158 | 1,786 | 7.07 | 11.72 | 15.38 | 0 |

- **Other users stay fast** while one user takes 1,430 writes/s from 50 clients: balance p99 under 10 ms.
- **1M results are the same within noise.** Raw JSON for every run is in [`loadtest/results/`](loadtest/results/).
- **Integration test check:** with 150 concurrent writers on one user, other users' p99 went from 6.3 ms
  to 16.0 ms.
- **About the numbers:** writes are slower than reads by roughly one durable commit (WAL flush). With 100
  closed-loop clients, latency also includes queuing at full throughput. On this machine the API workers,
  PostgreSQL and the generator all share the same 12 cores.

---

## Known limits

- **One user's write rate has a ceiling.** It's bounded by one commit per batch per worker. Group commit
  raises it to about 1,430 writes/s on this machine (from about 320), but it can't scale with more hardware
  the way the rest can.
- **The batcher is per process.** With N processes or instances, a hot user can hold up to N
  connections. Correctness is unaffected.
- **Balances above 2^53 minor units** (about 90 trillion in currency units) can't be represented exactly
  as JSON numbers. The API returns 500 rather than a wrong value. Fixing it would mean returning balances
  as strings, which changes the contract.
- **There's no foreign key from `ledger` to `balances`.** Both are written in the same transaction by the
  only write path, and an FK check on every ledger insert would cost latency at this volume.

## What breaks first at 10× load

1. **CPU on the database host.** At about 10k req/s PostgreSQL already uses ~4 cores here. The first fix is
   to give the database its own machine, separate from the API.
2. **WAL flush throughput.** Every write is a durable commit. PostgreSQL already merges concurrent commits
   into one flush; `commit_delay` and faster disks help further.
3. **Connections.** More API instances × pool size exceeds `max_connections`. The fix is PgBouncer in
   transaction mode (`apply_movements` is a single statement, so it's compatible).
4. **Ledger size.** At billions of rows: partition `ledger` by time and archive old partitions. Reads stay
   O(1) because they never touch the ledger.
5. **A single extremely hot user.** Beyond what group commit gives: batch across processes (route each
   user to one process), or move to a design with per-user sharding.

## Running several API instances

- **Correctness doesn't change.** All locking and invariants live in PostgreSQL. This setup already runs
  4 processes.
- **Batching is per instance,** so a hot user gets up to one batch in flight per instance. Routing each
  user to one instance (consistent hashing at the load balancer) would restore a single batch per user.
- **Total connections** need a pooler (PgBouncer).
- **An `Idempotency-Key` store** must live in the database, not in memory.

## What I would do with more time

- `Idempotency-Key` on credit/debit, stored in the same transaction as the write and returning the saved
  response on retry.
- Metrics: latency histograms, pool wait time, batch sizes, lock waits.
- Run the load generator on a separate machine, and the database on dedicated hardware.
- Partition the ledger by time.
