import type { NotifierPort } from '../../application/ports/notifier.port';
import type { Notification } from '../../domain/notification';
import type { Logger } from '../../shared/logger';

/** Development fallback when no Telegram token is configured: notifications are just logged. */
export class LogNotifier implements NotifierPort {
  constructor(private readonly logger: Logger) {}

  async send(notification: Notification): Promise<void> {
    this.logger.info({ notification }, 'notification (telegram disabled)');
  }
}
