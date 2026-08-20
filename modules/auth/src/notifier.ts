import type { NotificationEvent } from '@template/notifications/contract';
import type { NotificationsInternalCaller } from '@template/notifications/contract';
import type { Logger } from '@template/shared';

/**
 * Auth's outgoing side.
 *
 * Auth owns no templates and no delivery. It only reports typed events; Notifications routes them,
 * and Email renders and sends them.
 */
export class Notifier {
  constructor(
    private readonly logger: Logger,
    private readonly requestIdOf: () => string,
    private readonly callNotifications: (call: { requestId: string }) => NotificationsInternalCaller,
  ) {}

  /**
   * Emitting must never fail a security flow: the token a reset consumed is gone either way, so a
   * failed hand-off is logged and nothing more. What makes that `catch` reachable is the deadline
   * Notifications puts on its own caller — nothing here honours an abort signal.
   */
  async emit(event: NotificationEvent, dedupeKey: string): Promise<void> {
    try {
      const notifications = this.callNotifications({ requestId: this.requestIdOf() });

      await notifications.emit({ event, dedupeKey });
    } catch (error) {
      this.logger.error('notification could not be handed to notifications', {
        type: event.type,
        error,
      });
    }
  }
}
