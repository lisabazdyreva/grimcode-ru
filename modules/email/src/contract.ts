/**
 * What a neighbour may see of this module: `@template/email` resolves to `createModule` and its
 * types, `/contract` to here, `dist/repository.js` to nothing at all. A leak would hurt most
 * here: `@maily-to/render` is the one CPU-bound dependency in the process, and a neighbour must
 * not reach it by following a type.
 *
 * A projection of the implementation, not an agreement: `.output()` on every procedure is what
 * keeps it honest.
 */
export type { EmailAdminRouter } from './routers.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { EmailInternalCaller } from './index.js';

/** The document the editor stores. A Zod object is a value, so the inferred type crosses instead. */
export type { EditorDocument } from './schemas.js';
