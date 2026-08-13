/**
 * What a neighbour may see of this module: `@template/admin` resolves to `createApp` and `migrations`,
 * `@template/admin/contract` to here, `dist/repository.js` to nothing at all. It matters more here
 * than anywhere else — this module is the registry of who may do what, and the one thing a neighbour
 * is allowed to have of it is the shape of the two questions it may ask.
 *
 * A projection of the implementation, not an agreement: what keeps the type honest is `.output()` on
 * every procedure and the `satisfies` line pinning each router to the names it may hold.
 */
export type { AdminInternalRouter, AdminPanelRouter } from './routers.js';

/**
 * The decision Gateway acts on. It is a discriminated union rather than a boolean because Gateway
 * must never interpret a failure: every refusal names itself, and the one that is not a refusal —
 * `awaiting-first-user` — is a page, not a 403.
 */
export type { AuthorizationResult } from './schemas.js';
