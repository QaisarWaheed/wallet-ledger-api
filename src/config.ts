import { availableParallelism } from 'node:os';

/** Runtime configuration, read once from environment variables at startup. */
export interface Config {
  readonly port: number;
  readonly host: string;
  /** The static bearer token. Never logged or returned. */
  readonly apiToken: string;
  readonly databaseUrl: string;
  /** Database connections per worker process. */
  readonly dbPoolSize: number;
  /** Number of API worker processes (Node runs JavaScript on one core per process). */
  readonly workers: number;
  readonly logLevel: string;
  /** Serve Swagger UI at /docs. */
  readonly enableDocs: boolean;
}

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    port: positiveInt(env, 'PORT', 8080),
    host: env['HOST'] ?? '0.0.0.0',
    apiToken: requireEnv(env, 'API_TOKEN'),
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    dbPoolSize: positiveInt(env, 'DB_POOL_SIZE', 16),
    workers: positiveInt(env, 'WEB_CONCURRENCY', Math.min(4, availableParallelism())),
    logLevel: env['LOG_LEVEL'] ?? 'info',
    enableDocs: env['ENABLE_DOCS'] === 'true',
  };
}
