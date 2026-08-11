import type { NotificationEvent } from '@template/notifications/contract';
import type { NotificationsInternalRouter } from '@template/notifications/contract';
import {
  createTrpcClient,
  internalServiceUrl,
  REQUEST_ID_HEADER,
  type FetchLike,
  type Logger,
} from '@template/shared';

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
    private readonly callNotifications: FetchLike,
  ) {}

  /**
   * Emitting a notification must never fail a security flow: a password reset the user asked for
   * still consumed its token, and a failed hand-off is logged. The client is built per call because
   * the request id belongs to the request, and the deadline `createTrpcClient` puts around the wait
   * is what makes the `catch` mean anything — `app.fetch` ignores an abort signal.
   */
  async emit(event: NotificationEvent, dedupeKey: string): Promise<void> {
    try {
      const notifications = createTrpcClient<NotificationsInternalRouter>({
        url: `${internalServiceUrl('notifications')}/internal/rpc`,
        headers: { [REQUEST_ID_HEADER]: this.requestIdOf() },
        fetch: this.callNotifications,
      });

      await notifications.emit.mutate({ event, dedupeKey });
    } catch (error) {
      this.logger.error('notification could not be handed to notifications', {
        type: event.type,
        error,
      });
    }
  }
}
