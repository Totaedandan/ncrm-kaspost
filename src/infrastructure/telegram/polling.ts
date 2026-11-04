import { GrammyError, type Bot } from 'grammy';
import { errorMessage } from '../../application/dev-alert';
import type { Logger } from '../../shared/logger';
import { sleep } from '../../shared/concurrency';

const RETRY_DELAY_MS = 30_000;

export interface PollingHandle {
  stop(): Promise<void>;
}

export interface PollingOptions {
  logger: Logger;
  /** Called for errors that retrying cannot fix: a bad token (401) or another instance polling (409). */
  onFatal: (error: unknown) => void;
  retryDelayMs?: number;
}

/** 401 = the token is wrong, 409 = a webhook or another polling instance owns this bot. */
export function isFatalTelegramError(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 401 || error.error_code === 409);
}

/**
 * Long polling: works behind NAT and needs no public URL or TLS, so it suits both a laptop and a VPS.
 * grammY already retries transient errors while polling; this only covers the initial connection
 * (e.g. Telegram unreachable at boot) and turns unrecoverable errors into `onFatal`.
 */
export function startPolling(bot: Bot, options: PollingOptions): PollingHandle {
  const { logger, onFatal, retryDelayMs = RETRY_DELAY_MS } = options;
  let stopped = false;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        await bot.start({
          allowed_updates: ['message'],
          onStart: (me) => logger.info({ bot: me.username }, 'telegram polling started'),
        });
        return;
      } catch (error) {
        if (stopped) return;
        if (isFatalTelegramError(error)) return onFatal(error);
        logger.warn({ err: errorMessage(error), retryInMs: retryDelayMs }, 'telegram polling failed, retrying');
        await sleep(retryDelayMs);
      }
    }
  };
  void run();

  return {
    stop: async () => {
      stopped = true;
      if (bot.isRunning()) await bot.stop();
    },
  };
}
