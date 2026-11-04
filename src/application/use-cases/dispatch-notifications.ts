import { RateLimitedError } from '../../domain/errors';
import type { Clock } from '../../shared/clock';
import type { Logger } from '../../shared/logger';
import { errorMessage } from '../dev-alert';
import type { NotifierPort } from '../ports/notifier.port';
import type { OutboxRepository } from '../ports/repositories';

export const MAX_NOTIFICATION_ATTEMPTS = 5;
const BATCH_LIMIT = 50;
const RETRY_BASE_MS = 60_000;

export interface DispatchDeps {
  notifier: NotifierPort;
  outbox: OutboxRepository;
  clock: Clock;
  logger: Logger;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  rateLimited: boolean;
}

/** The only place that talks to the notifier for outbox entries. */
export class DispatchNotifications {
  constructor(private readonly deps: DispatchDeps) {}

  async execute(): Promise<DispatchResult> {
    const { outbox, notifier, clock, logger } = this.deps;
    const messages = await outbox.findDispatchable(clock.now(), BATCH_LIMIT);
    const result: DispatchResult = { sent: 0, failed: 0, rateLimited: false };

    for (const message of messages) {
      try {
        await notifier.send(message.entry);
        await outbox.markSent(message.id, clock.now());
        result.sent += 1;
      } catch (error) {
        if (error instanceof RateLimitedError) {
          const retryAt = new Date(clock.now().getTime() + error.retryAfterSeconds * 1000);
          await outbox.postpone(message.id, retryAt);
          result.rateLimited = true;
          logger.warn({ retryAfter: error.retryAfterSeconds }, 'notifier rate limited, stopping run');
          break;
        }
        await this.recordFailure(message.id, message.attempts, error);
        result.failed += 1;
      }
    }
    return result;
  }

  private async recordFailure(id: string, previousAttempts: number, error: unknown): Promise<void> {
    const { outbox, clock, logger } = this.deps;
    const attempts = previousAttempts + 1;
    const giveUp = attempts >= MAX_NOTIFICATION_ATTEMPTS;
    const delay = RETRY_BASE_MS * 2 ** (attempts - 1);
    const nextAttemptAt = new Date(clock.now().getTime() + delay);
    await outbox.markAttemptFailed(id, errorMessage(error), nextAttemptAt, giveUp);
    logger.warn({ id, attempts, giveUp, err: errorMessage(error) }, 'notification delivery failed');
  }
}
