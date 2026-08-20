/**
 * What a neighbour may see of this module: `@template/email` resolves to `createModule`, `migrations` and `seedTemplates`,
 * `@template/email/contract` to here, `dist/repository.js` to nothing at all. Types and only
 * types, and Email is where a leak would hurt most: `@maily-to/render` is the one CPU-bound
 * dependency in the process, and a neighbour must not reach it by following a type.
 *
 * A projection of the implementation, not an agreement: what keeps the type honest is `.output()` on
 * every procedure and the `satisfies` line pinning each router to the names it may hold.
 */
export type { EmailAdminRouter, EmailInternalRouter } from './routers.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { EmailInternalCaller } from './index.js';

/**
 * The editor document this module stores, for the screen that edits it. A Zod object is a value and
 * must not travel through this file, so what crosses is the inferred type.
 */
export type { EditorDocument } from './schemas.js';
