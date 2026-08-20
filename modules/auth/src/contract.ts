/**
 * What a neighbour may see of this module: `@template/auth` resolves to `createModule` and its
 * types, `@template/auth/contract` to here, `dist/repository.js` to nothing at all. Auth has the
 * most callers and holds password hashes, session rows and one-time tokens — all behind
 * `repository.ts`, which no specifier reaches.
 *
 * A projection of the implementation, not an agreement: `.output()` on every procedure and the
 * `satisfies` line pinning each router to the names it may hold are what keep it honest.
 */
export type { AuthAdminRouter } from './routers/admin.js';
export type { AuthPublicRouter } from './routers/public.js';

/** What a neighbour holds to call this module: the caller, not the router. */
export type { AuthInternalCaller } from './index.js';

/**
 * The shapes neighbours and browsers name — an `Identity` in Users and Admin, a session list in
 * the App, identities and the audit log in this module's own panel. All inferred from
 * `schemas.ts`: a Zod object is a value, and a value must not travel through this file.
 */
export type {
  AdminIdentity,
  AuthAuditEntry,
  Identity,
  SessionSummary,
} from './schemas.js';
