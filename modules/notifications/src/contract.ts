/**
 * What a neighbour may see of this module: `@template/notifications` resolves to `createModule` and
 * its types, `/contract` to here, `dist/repository.js` to nothing at all. One value here and the
 * `exports` key becomes a formality.
 *
 * A projection of the implementation, not an agreement: `.output()` on every procedure and the
 * `satisfies` line are what keep it honest.
 */
export type { NotificationsAdminRouter } from './routers.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { NotificationsInternalCaller } from './index.js';

/** Inferred from `schemas.ts`: a Zod object is a value, and values must not cross this file. */
export type { NotificationEvent, StoredNotificationEvent } from './schemas.js';
