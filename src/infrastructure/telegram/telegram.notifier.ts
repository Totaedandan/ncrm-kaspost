import { GrammyError } from 'grammy';
import type { NotifierPort } from '../../application/ports/notifier.port';
import { RateLimitedError } from '../../domain/errors';
import type { Notification } from '../../domain/notification';
import type { Logger } from '../../shared/logger';
import { renderNotification } from './templates';

export interface TelegramSender {
  sendMessage(
    chatId: string | number,
    text: string,
    other: { parse_mode: 'HTML'; link_preview_options: { is_disabled: boolean } },
  ): Promise<unknown>;
}

export interface TelegramNotifierOptions {
  sender: TelegramSender;
  reportChatIds: readonly string[];
  devChatId: string;
  timeZone: string;
  logger: Logger;
}

/** 403 (user never started / blocked the bot) and 400 (chat not found) will not fix themselves on a retry. */
function isPermanentChatError(error: unknown): error is GrammyError {
  return error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400);
}

/**
 * Delivers rendered notifications. DEV_ALERT goes to the developer chat, everything else to the report chats.
 * Delivery is at-least-once: if a chat fails transiently, a retry re-sends to all of them. A chat that is
 * permanently unreachable is skipped (logged); only when no chat could be reached the notification fails.
 */
export class TelegramNotifier implements NotifierPort {
  constructor(private readonly options: TelegramNotifierOptions) {}

  async send(notification: Notification): Promise<void> {
    const { logger, timeZone } = this.options;
    const chats = this.recipientsFor(notification);
    if (chats.length === 0) {
      logger.warn({ type: notification.type }, 'no telegram recipients configured, notification dropped');
      return;
    }

    const text = renderNotification(notification, timeZone);
    let delivered = 0;
    let permanentError: unknown = null;
    for (const chatId of chats) {
      try {
        await this.deliver(chatId, text);
        delivered += 1;
      } catch (error) {
        if (!isPermanentChatError(error)) throw error;
        // One unreachable recipient must not fail the others (a retry would re-send to everybody).
        permanentError = error;
        logger.warn({ chatId, err: error.description }, 'telegram chat unreachable (has the user pressed /start?), skipped');
      }
    }
    if (delivered === 0 && permanentError !== null) throw permanentError;
  }

  private recipientsFor(notification: Notification): readonly string[] {
    if (notification.type === 'DEV_ALERT') {
      return this.options.devChatId === '' ? [] : [this.options.devChatId];
    }
    return this.options.reportChatIds;
  }

  private async deliver(chatId: string, text: string): Promise<void> {
    try {
      await this.options.sender.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        throw new RateLimitedError(error.parameters.retry_after ?? 30);
      }
      throw error;
    }
  }
}
