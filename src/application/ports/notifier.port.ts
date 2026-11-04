import type { Notification } from '../../domain/notification';

export interface NotifierPort {
  /**
   * Delivers one notification (at-least-once: a retry may re-deliver to recipients that already got it).
   * @throws RateLimitedError when the channel asks to slow down
   */
  send(notification: Notification): Promise<void>;
}
