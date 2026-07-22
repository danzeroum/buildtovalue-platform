import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { PROBLEM_TYPES, type Problem } from '@platform/api-contracts';
import { InvalidTokenError, verifyAccessToken, type AccessClaims, type Permission } from '@platform/auth';
import { hasPermission } from '@platform/auth';
import type { AppConfig } from '@platform/config';
import type { PlatformRegistry, PlatformRuntime, RefreshTokenRepository, UserRepository } from '@platform/db';
import { createLogger, createMetrics, type Logger } from '@platform/observability';
import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerDefinitionRoutes } from './routes/definitions.js';
import { registerRuntimeRoutes } from './routes/runtime.js';
import { registerOperateRoutes } from './routes/operate.js';
import { registerUserTaskRoutes } from './routes/userTasks.js';

/**
 * Dependências injetadas (DIP, G-COD-1): a API depende de interfaces de
 * repositório — testes usam fakes em memória; produção usa @platform/db.
 */
export interface ApiDeps {
  config: AppConfig;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  /** Checagem de prontidão do banco (SELECT 1); injetada para o /ready. */
  dbReady: () => Promise<boolean>;
  /** Runtime do walking skeleton (instances/jobs); ausente em testes de auth puros. */
  runtime?: PlatformRuntime;
  registry?: PlatformRegistry;
  logger?: Logger;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessClaims;
  }
}

/** O tipo concreto da app (zod type provider) — usado pelos registradores de rota. */
export type ZodApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

function problem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply
    .status(p.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(p);
}

export async function buildApp(deps: ApiDeps): Promise<ZodApp> {
  const { config } = deps;
  const logger = deps.logger ?? createLogger({ service: 'api', level: config.LOG_LEVEL });
  const metrics = createMetrics();

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    disableRequestLogging: config.NODE_ENV === 'test',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Toda resposta ecoa o X-Request-Id (plano §6) e alimenta as métricas HTTP.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    metrics.httpRequestsTotal.inc(labels);
    metrics.httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  // Rate limit por TENANT autenticado; sem auth, por IP (plano §6 / F1.5).
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => req.auth?.tenantId ?? req.ip,
    errorResponseBuilder: (req, context) => ({
      type: PROBLEM_TYPES.rateLimited,
      title: 'Limite de requisições excedido',
      status: 429,
      detail: `Máximo de ${context.max} requisições por ${context.after}.`,
      requestId: String(req.id),
    }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'BuildToValue Platform API',
        version: '0.1.0',
        description:
          'API /v1 da plataforma BuildToValue. Erros seguem problem+json (RFC 9457); ' +
          'listagens usam items+nextCursor; mutações aceitam Idempotency-Key.',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  // Autenticação Bearer (decorators consumidos pelas rotas /v1 protegidas).
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return problem(reply, {
        type: PROBLEM_TYPES.unauthorized,
        title: 'Autenticação necessária',
        status: 401,
        requestId: String(req.id),
      });
    }
    try {
      req.auth = await verifyAccessToken(header.slice(7), {
        secret: config.JWT_SECRET,
        accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS,
      });
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return problem(reply, {
          type: PROBLEM_TYPES.unauthorized,
          title: 'Token inválido ou expirado',
          status: 401,
          requestId: String(req.id),
        });
      }
      throw error;
    }
  });

  app.decorate('requirePermission', (permission: Permission) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = req.auth;
      if (!auth || !hasPermission(auth.role, permission)) {
        return problem(reply, {
          type: PROBLEM_TYPES.forbidden,
          title: 'Sem permissão para esta operação',
          status: 403,
          detail: `Permissão exigida: ${permission}`,
          requestId: String(req.id),
        });
      }
    };
  });

  // problem+json em TODOS os erros (G-API-1): validação zod → 400 com campos;
  // rate limit → 429 (montado pelo builder acima); resto → 500 sem vazar stack.
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return problem(reply, {
        type: PROBLEM_TYPES.validation,
        title: 'Requisição inválida',
        status: 400,
        detail: error.validation.map((v) => `${v.instancePath || 'body'}: ${v.message}`).join('; '),
        requestId: String(req.id),
      });
    }
    const status = error.statusCode ?? (error as { status?: number }).status;
    if (status === 429) {
      return reply
        .status(429)
        .header('content-type', 'application/problem+json; charset=utf-8')
        .send(error);
    }
    req.log.error({ err: error }, 'erro não tratado');
    return problem(reply, {
      type: PROBLEM_TYPES.internal,
      title: 'Erro interno',
      status: 500,
      requestId: String(req.id),
    });
  });

  app.setNotFoundHandler((req, reply) =>
    problem(reply, {
      type: PROBLEM_TYPES.notFound,
      title: 'Recurso não encontrado',
      status: 404,
      instance: req.url,
      requestId: String(req.id),
    }),
  );

  registerHealthRoutes(app, deps, metrics);
  registerAuthRoutes(app, deps);
  registerRuntimeRoutes(app, deps);
  registerDefinitionRoutes(app, deps);
  registerUserTaskRoutes(app, deps);
  registerOperateRoutes(app, deps);

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requirePermission: (
      permission: Permission,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}
