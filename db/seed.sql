-- Seed: 10M+ ledger rows across 100,000 users with an uneven spread.
--
-- Run:   docker compose --profile seed run --rm seed                 (10.2M rows)
--        SEED_SCALE=0.1 docker compose --profile seed run --rm seed  (~1M rows)
--
-- Guarantees:
--   * No user's balance is below 0 at ANY point in their history: each user
--     starts with a 1,000,000 credit, and every later debit is paired with,
--     and smaller than, the credit just before it. The running balance never
--     drops below the opening credit.
--   * balances is computed FROM the ledger, so the two match by construction.
--   * Everything runs in one transaction: a failed seed leaves no partial data.
--
-- User tiers (at scale 1):
--   user_000001..user_000020   20 users x 120,000 rows   = 2,400,000
--   user_000021..user_001000  980 users x   2,000 rows   = 1,960,000
--   user_001001..user_010000 9,000 users x    400 rows   = 3,600,000
--   user_010001..user_100000 90,000 users x 10-40 rows   ~ 2,250,000
--                                                 total  ~ 10,210,000

\set ON_ERROR_STOP on
\if :{?scale}
\else
  \set scale 1
\endif
\timing on

SELECT clock_timestamp() AS seed_started_at \gset

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM ledger) OR EXISTS (SELECT 1 FROM balances) THEN
        RAISE EXCEPTION 'Database already has data. Reset with: docker compose down -v && docker compose up';
    END IF;
END
$$;

-- Bulk-load settings for THIS session only. Skipping the commit flush is safe
-- here: the seed is one transaction that is simply re-run if it is lost. The
-- API keeps synchronous_commit = on.
SET synchronous_commit = off;
SET maintenance_work_mem = '1GB';
SET work_mem = '256MB';

BEGIN;

-- Loading into an unindexed table and building the index once at the end is
-- far faster than maintaining the index on every one of 10M inserts.
DROP INDEX ledger_user_id_id_idx;

CREATE TEMP TABLE seed_users ON COMMIT DROP AS
SELECT
    n,
    'user_' || lpad(n::text, 6, '0') AS user_id,
    greatest(2, round(
        CASE
            WHEN n <= 20    THEN 120000
            WHEN n <= 1000  THEN 2000
            WHEN n <= 10000 THEN 400
            ELSE 10 + n % 31
        END * :scale
    ))::int AS entries
FROM generate_series(1, 100000) AS n;

-- Step k of user n:
--   k = 1          opening credit of 1,000,000
--   k even         credit  c(n, k)        where c is in [100, 100000]
--   k odd, k >= 3  debit   c(n, k-1) - d  where d is in [0, 99], so 1 <= debit <= preceding credit
-- Rows are ordered by (step, user) so ids interleave users like real traffic
-- while each user's own history stays in order.
INSERT INTO ledger (user_id, type, amount, created_at)
SELECT
    u.user_id,
    CASE WHEN s.k = 1 OR s.k % 2 = 0 THEN 'credit' ELSE 'debit' END::ledger_entry_type,
    CASE
        WHEN s.k = 1     THEN 1000000
        WHEN s.k % 2 = 0 THEN 100 + (u.n::bigint * 7919 + s.k::bigint * 104729) % 99901
        ELSE 100 + (u.n::bigint * 7919 + (s.k - 1)::bigint * 104729) % 99901 - (u.n + s.k) % 100
    END,
    timestamptz '2025-01-01 00:00:00+00' + s.k * interval '1 minute'
FROM seed_users AS u
CROSS JOIN LATERAL generate_series(1, u.entries) AS s(k)
ORDER BY s.k, u.n;

CREATE INDEX ledger_user_id_id_idx ON ledger (user_id, id);

INSERT INTO balances (user_id, balance, created_at, updated_at)
SELECT
    user_id,
    sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END),
    min(created_at),
    max(created_at)
FROM ledger
GROUP BY user_id;

COMMIT;

-- Refresh planner statistics and the visibility map (enables index-only scans).
VACUUM (ANALYZE) ledger;
VACUUM (ANALYZE) balances;

-- Quick consistency check. db/verify.sql runs the full check, including the
-- "never negative at any point" rule.
SELECT count(*) AS mismatched_balances
FROM balances AS b
JOIN (
    SELECT user_id, sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS ledger_balance
    FROM ledger
    GROUP BY user_id
) AS l USING (user_id)
WHERE b.balance <> l.ledger_balance;

\timing off
SELECT
    (SELECT count(*) FROM ledger)                  AS ledger_rows,
    (SELECT count(*) FROM balances)                AS users,
    (SELECT max(entries) FROM (SELECT count(*) AS entries FROM ledger GROUP BY user_id) AS t) AS max_rows_per_user,
    round(extract(epoch FROM clock_timestamp() - :'seed_started_at'::timestamptz)) AS total_seconds;
