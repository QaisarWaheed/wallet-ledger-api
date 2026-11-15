import Fastify, { type FastifyError, type FastifyInstance, LogController } from 'fastify';
import type { TokenVerifier } from './auth.js';
import { balanceSchema, creditSchema, debitSchema, healthSchema, isDocsRoute, registerDocs } from './docs.js';
import { ApiError, type ErrorBody, invalidRequest, unauthorized } from './errors.js';
import { parseJson } from './json.js';
import { parseMovement, parseUserId } from './validation.js';
import type { Wallet } from './walletService.js';

export interface AppDependencies {
  readonly verifyToken: TokenVerifier;
  readonly wallet: Wallet;
  readonly logLevel?: string;
  /** Serve Swagger UI at /docs (off by default: every endpoint must require the token). */
  readonly enableDocs?: boolean;
}

interface BalanceResponse {
  readonly user_id: string;
  readonly balance: number;
}

const MAX_BODY_BYTES = 16 * 1024;

const internalError: ErrorBody = { error: 'internal_error', message: 'Internal server error' };

/** Builds the HTTP app. Kept free of process/env concerns so tests can inject fakes. */
export function buildApp({ verifyToken, wallet, logLevel = 'info', enableDocs = false }: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: logLevel,
      // Defence in depth: the token must never reach the logs.
      redact: ['req.headers.authorization'],
    },
    // Per-request log lines cost latency under load; only emit them when debugging.
    logController: new LogController({ disableRequestLogging: logLevel !== 'debug' && logLevel !== 'trace' }),
    bodyLimit: MAX_BODY_BYTES,
    // Long ids must reach validation (400), not fail routing (404).
    routerOptions: { maxParamLength: 512 },
  });

  // 1. Authentication runs in onRequest: before the body is read and before
  //    any database access, so a bad token always gets 401. The only
  //    exception is the Swagger UI pages, and only when docs are enabled.
  //    routeOptions.url is the matched route PATTERN (e.g. "/docs/static/*"),
  //    not the raw URL, so path tricks like "/docs/../credit" cannot bypass it.
  app.addHook('onRequest', async (request) => {
    if (enableDocs && isDocsRoute(request.routeOptions.url)) return;
    if (!verifyToken(request.headers.authorization)) throw unauthorized();
  });

  // 2. Strict JSON parser: rejects decimals such as 1.0 (see json.ts).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseJson(body as string));
    } catch {
      done(invalidRequest('Malformed JSON body'), undefined);
    }
  });

  // 3. One error shape for everything: {"error": "<code>", "message": "<text>"}.
  app.setErrorHandler<FastifyError | ApiError>((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(error.toBody());
    }
    // Framework-level client errors (unsupported content type, empty or
    // oversized body, ...) are all malformed requests in this API.
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(400).send(invalidRequest('Malformed request').toBody());
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send(internalError);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'Route not found' } satisfies ErrorBody),
  );

  // 4. Route schemas are documentation only (see docs.ts): Fastify's own
  //    validator would coerce "100" into 100, so it is switched off and
  //    validation.ts stays the single source of truth for input rules.
  app.setValidatorCompiler(() => () => true);

  // 5. Swagger must be registered before the routes so it can see them;
  //    plugins load in registration order.
  if (enableDocs) registerDocs(app);

  app.register(async (routes) => {
    routes.post('/credit', { schema: creditSchema }, async (request): Promise<BalanceResponse> => {
      const { userId, amount } = parseMovement(request.body);
      const balance = await wallet.credit(userId, amount);
      return { user_id: userId, balance };
    });

    routes.post('/debit', { schema: debitSchema }, async (request): Promise<BalanceResponse> => {
      const { userId, amount } = parseMovement(request.body);
      const balance = await wallet.debit(userId, amount);
      return { user_id: userId, balance };
    });

    routes.get<{ Params: { user_id: string } }>(
      '/balance/:user_id',
      { schema: balanceSchema },
      async (request): Promise<BalanceResponse> => {
        const userId = parseUserId(request.params.user_id);
        const balance = await wallet.getBalance(userId);
        return { user_id: userId, balance };
      },
    );

    routes.get('/health', { schema: healthSchema }, async () => {
      await wallet.checkHealth();
      return { status: 'ok' };
    });
  });

  return app;
}
