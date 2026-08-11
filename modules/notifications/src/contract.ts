/**
 * What a neighbour may see of this module: `@template/notifications` resolves to `createApp`,
 * `@template/notifications/contract` to here, `dist/repository.js` to nothing at all. Types and
 * only types — one value and the `exports` key becomes a formality while the module leaks through.
 *
 * A projection of the implementation, not an agreement: what keeps the type honest is `.output()` on
 * every procedure and the `satisfies` line pinning each router to the names it may hold.
 */
export type { NotificationsAdminRouter, NotificationsInternalRouter } from './routers.js';

/**
 * The event Auth builds and the row the admin screen renders, both inferred from `schemas.ts`: a
 * Zod object is a value, and a value must not travel through this file.
 */
export type { NotificationEvent, StoredNotificationEvent } from './schemas.js';
