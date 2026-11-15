import cluster from 'node:cluster';
import pg from 'pg';
import { buildApp } from './app.js';
import { createTokenVerifier } from './auth.js';
import { type Config, loadConfig } from './config.js';
import { assertJsonSourceTextSupport } from './json.js';
import { PostgresLedgerStore } from './ledgerRepository.js';
import { WalletService } from './walletService.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Node runs JavaScript on one thread, so a single process saturates one CPU
 * core long before PostgreSQL is busy. The primary process forks
 * `config.workers` copies of the API; they share port 8080 and the OS spreads
 * connections across them.
 *
 * Correctness is unaffected: all locking and invariants live in PostgreSQL.
 * The only thing that becomes per-worker is the per-user write queue, so a
 * hot user can hold up to `workers` connections instead of one.
 */
function startPrimary(config: Config): void {
  let shuttingDown = false;

  const fork = (): void => {
    cluster.fork();
  };
  for (let i = 0; i < config.workers; i += 1) fork();

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    console.error(`Worker ${worker.process.pid} exited (code ${code}, signal ${signal}); starting a replacement`);
    fork();
  });

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill('SIGTERM');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function startWorker(config: Config): Promise<void> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Safety net against a stuck query holding a connection forever.
    statement_timeout: 15_000,
    application_name: 'wallet-ledger-api',
  });

  const app = buildApp({
    verifyToken: createTokenVerifier(config.apiToken),
    wallet: new WalletService(new PostgresLedgerStore(pool)),
    logLevel: config.logLevel,
    enableDocs: config.enableDocs,
  });

  // An idle client can error (e.g. database restart); log it instead of crashing.
  pool.on('error', (error) => app.log.error({ err: error }, 'Idle database client error'));

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then close the pool. Data stays consistent even on a hard kill
  // (every write is a single transaction); this just avoids cut-off responses.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.warn({ signal }, 'Shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
  app.log.warn({ port: config.port, pid: process.pid }, 'Wallet ledger API worker listening');
}

function main(): void {
  assertJsonSourceTextSupport();
  const config = loadConfig();

  if (cluster.isPrimary && config.workers > 1) {
    startPrimary(config);
  } else {
    startWorker(config).catch(fail);
  }
}

function fail(error: unknown): never {
  // Config errors never contain the token value, only variable names.
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  main();
} catch (error) {
  fail(error);
}
