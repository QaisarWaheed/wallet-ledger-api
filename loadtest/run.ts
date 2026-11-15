/**
 * Load test: p50/p95/p99 latency per endpoint against the running API.
 *
 * Recommended (inside the Docker network, no host port-forwarding in the path):
 *   docker compose --profile loadtest run --rm loadtest --scenario mixed
 *   docker compose --profile loadtest run --rm loadtest --scenario hot
 * From the host (Node 22.18+ runs this TypeScript file directly):
 *   node loadtest/run.ts --scenario mixed --concurrency 100 --duration 60
 *
 * mixed : clients send 50% balance reads, 30% credits, 20% debits across the
 *         seeded users (user_000001..user_100000).
 * hot   : half the clients write to ONE user, the other half send the mixed
 *         traffic; reported separately to show hot-user isolation.
 *
 * Clients are spread over several worker threads so the generator itself is
 * not the bottleneck. Only Node built-ins are used.
 *
 * Any status other than the expected ones (200, plus 409 for debits) counts
 * as an error. Results are printed and saved to loadtest/results/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

interface Settings {
  readonly baseUrl: string;
  readonly token: string;
  readonly scenario: 'mixed' | 'hot';
  readonly concurrency: number;
  readonly threads: number;
  readonly durationMs: number;
  readonly warmupMs: number;
  readonly seededUsers: number;
  readonly label: string;
}

interface ThreadTask {
  readonly settings: Settings;
  readonly clients: number;
  readonly hotClients: number;
  readonly hotUser: string;
  readonly startAt: number;
}

/** Latencies (ms) and status counts per endpoint name, sent from threads to main. */
type ThreadResult = Record<string, { latencies: number[]; statuses: Record<number, number>; errors: number }>;

// ---------------------------------------------------------------- HTTP client

function createClient(settings: Settings) {
  const url = new URL(settings.baseUrl);
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const authorization = `Bearer ${settings.token}`;

  return (method: 'GET' | 'POST', path: string, body?: unknown): Promise<number> =>
    new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          method,
          path,
          agent,
          headers: {
            authorization,
            ...(payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          },
        },
        (res) => {
          res.resume(); // drain the body
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', () => resolve(0));
        },
      );
      req.on('error', () => resolve(0)); // network failure counts as an error
      req.end(payload);
    });
}

// ---------------------------------------------------------------- worker side

async function runThread(task: ThreadTask): Promise<ThreadResult> {
  const { settings, clients, hotClients, hotUser, startAt } = task;
  const send = createClient(settings);
  const result: ThreadResult = {};
  const recordFrom = startAt + settings.warmupMs;
  const deadline = recordFrom + settings.durationMs;

  const measure = async (name: string, expected: readonly number[], call: () => Promise<number>): Promise<void> => {
    const started = performance.now();
    const status = await call();
    const latency = performance.now() - started;
    if (Date.now() < recordFrom) return; // warm-up
    const bucket = (result[name] ??= { latencies: [], statuses: {}, errors: 0 });
    bucket.latencies.push(latency);
    bucket.statuses[status] = (bucket.statuses[status] ?? 0) + 1;
    if (!expected.includes(status)) bucket.errors += 1;
  };

  const randomInt = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));
  const seededUser = (): string => `user_${String(randomInt(1, settings.seededUsers)).padStart(6, '0')}`;
  const prefix = settings.scenario === 'hot' ? 'other ' : '';

  const mixedRequest = (): Promise<void> => {
    const roll = Math.random();
    if (roll < 0.5) return measure(`${prefix}GET /balance`, [200], () => send('GET', `/balance/${seededUser()}`));
    if (roll < 0.8) {
      return measure(`${prefix}POST /credit`, [200], () =>
        send('POST', '/credit', { user_id: seededUser(), amount: randomInt(1, 10_000) }),
      );
    }
    return measure(`${prefix}POST /debit`, [200, 409], () =>
      send('POST', '/debit', { user_id: seededUser(), amount: randomInt(1, 10_000) }),
    );
  };

  const hotRequest = (): Promise<void> =>
    Math.random() < 0.6
      ? measure('hot POST /credit', [200], () => send('POST', '/credit', { user_id: hotUser, amount: randomInt(1, 1_000) }))
      : measure('hot POST /debit', [200, 409], () => send('POST', '/debit', { user_id: hotUser, amount: randomInt(1, 1_000) }));

  while (Date.now() < startAt) await new Promise((resolve) => setTimeout(resolve, 5));

  await Promise.all(
    Array.from({ length: clients }, async (_, client) => {
      const isHot = client < hotClients;
      while (Date.now() < deadline) await (isHot ? hotRequest() : mixedRequest());
    }),
  );
  return result;
}

// ------------------------------------------------------------------ main side

function readSettings(): Settings {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'mixed' },
      concurrency: { type: 'string', default: '100' },
      threads: { type: 'string', default: String(Math.min(4, availableParallelism())) },
      duration: { type: 'string', default: '60' },
      warmup: { type: 'string', default: '5' },
      users: { type: 'string', default: '100000' },
      label: { type: 'string', default: '' },
    },
  });
  if (values.scenario !== 'mixed' && values.scenario !== 'hot') throw new Error('--scenario must be "mixed" or "hot"');
  return {
    baseUrl: process.env['API_URL'] || 'http://localhost:8080',
    token: process.env['API_TOKEN'] || 'recruitment-test-token',
    scenario: values.scenario,
    concurrency: Number(values.concurrency),
    threads: Number(values.threads),
    durationMs: Number(values.duration) * 1000,
    warmupMs: Number(values.warmup) * 1000,
    seededUsers: Number(values.users),
    label: values.label,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

/** Splits `total` into `parts` near-equal integers. */
const split = (total: number, parts: number): number[] =>
  Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));

async function main(): Promise<void> {
  const settings = readSettings();
  const hotUser = `hot_${Date.now().toString(36)}`;
  if (settings.scenario === 'hot') {
    const status = await createClient(settings)('POST', '/credit', { user_id: hotUser, amount: 1_000_000_000 });
    if (status !== 200) throw new Error(`Could not create the hot user (HTTP ${status}). Is the API up and the token right?`);
  }

  const hotTotal = settings.scenario === 'hot' ? Math.floor(settings.concurrency / 2) : 0;
  const clientsPerThread = split(settings.concurrency, settings.threads);
  const hotPerThread = split(hotTotal, settings.threads);
  const startAt = Date.now() + 500;

  console.log(
    `Scenario "${settings.scenario}": ${settings.concurrency} clients (${hotTotal} on one hot user) over ` +
      `${settings.threads} threads, ${settings.warmupMs / 1000}s warm-up + ${settings.durationMs / 1000}s measured, ` +
      `against ${settings.baseUrl}`,
  );

  const results = await Promise.all(
    clientsPerThread.map(
      (clients, i) =>
        new Promise<ThreadResult>((resolve, reject) => {
          const task: ThreadTask = { settings, clients, hotClients: hotPerThread[i] ?? 0, hotUser, startAt };
          const worker = new Worker(new URL(import.meta.url), { workerData: task });
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
    ),
  );

  const merged = new Map<string, { latencies: number[]; statuses: Record<number, number>; errors: number }>();
  for (const result of results) {
    for (const [name, bucket] of Object.entries(result)) {
      const target = merged.get(name) ?? { latencies: [], statuses: {}, errors: 0 };
      target.latencies.push(...bucket.latencies);
      target.errors += bucket.errors;
      for (const [status, count] of Object.entries(bucket.statuses)) {
        target.statuses[Number(status)] = (target.statuses[Number(status)] ?? 0) + count;
      }
      merged.set(name, target);
    }
  }

  const seconds = settings.durationMs / 1000;
  const rows = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([endpoint, bucket]) => {
      const sorted = bucket.latencies.sort((a, b) => a - b);
      return {
        endpoint,
        requests: sorted.length,
        rps: Math.round(sorted.length / seconds),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? Number.NaN,
        errors: bucket.errors,
        statuses: bucket.statuses,
      };
    });

  const ms = (value: number): string => value.toFixed(2);
  console.log('\n| Endpoint | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Errors | Statuses |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const row of rows) {
    console.log(
      `| ${row.endpoint} | ${row.requests} | ${row.rps} | ${ms(row.p50)} | ${ms(row.p95)} | ${ms(row.p99)} | ` +
        `${ms(row.max)} | ${row.errors} | ${JSON.stringify(row.statuses)} |`,
    );
  }

  const directory = new URL('./results/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const name = `${settings.scenario}${settings.label ? `-${settings.label}` : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(new URL(name, directory), JSON.stringify({ ...settings, token: undefined, rows }, null, 2));
  console.log(`\nSaved loadtest/results/${name}`);

  const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);
  if (totalErrors > 0) {
    console.error(`${totalErrors} unexpected responses`);
    process.exitCode = 1;
  }
}

if (isMainThread) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else {
  runThread(workerData as ThreadTask).then(
    (result) => parentPort?.postMessage(result),
    (error: unknown) => {
      throw error;
    },
  );
}
