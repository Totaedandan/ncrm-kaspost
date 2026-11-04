import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { webhookCallback, type Bot } from 'grammy';
import type { CheckHealth } from '../../application/check-health';
import type { Logger } from '../../shared/logger';

export interface TelegramWebhookConfig {
  bot: Bot;
  secret: string;
}

export interface ServerDeps {
  logger: Logger;
  checkHealth: CheckHealth;
  telegram?: TelegramWebhookConfig;
}

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger as unknown as FastifyBaseLogger });

  app.get('/health', async (_request, reply) => {
    const report = await deps.checkHealth.execute();
    return reply.code(report.ok ? 200 : 503).send(report);
  });

  if (deps.telegram) {
    const { bot, secret } = deps.telegram;
    const handle = webhookCallback(bot, 'fastify', { secretToken: secret });

    app.post<{ Params: { secret: string } }>('/telegram/webhook/:secret', async (request, reply) => {
      const header = request.headers[TELEGRAM_SECRET_HEADER];
      const headerValue = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
      if (!safeEqual(request.params.secret, secret) || !safeEqual(headerValue, secret)) {
        return reply.code(404).send();
      }
      return handle(request, reply);
    });
  }

  return app;
}
