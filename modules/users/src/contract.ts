/**
 * What a neighbour may see of this module: `@template/users` resolves to `createApp` and `migrations`,
 * `@template/users/contract` to here, `dist/repository.js` to nothing at all. Types and only
 * types — one value and the `exports` key becomes a formality while the whole module leaks through.
 *
 * A projection of the implementation, not an agreement: what keeps the type honest is `.output()` on
 * every procedure and the `satisfies` line pinning each router to the names it may hold.
 */
export type { UsersAdminRouter, UsersPublicRouter } from './routers.js';

/**
 * The shapes themselves, for the two bundles that render them. A Zod object is a value and must not
 * travel through this file, so what crosses is the inferred type and never the schema.
 */
export type { AdminUserProfile, UserProfile } from './schemas.js';
