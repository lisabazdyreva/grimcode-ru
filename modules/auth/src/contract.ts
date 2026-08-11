/**
 * What a neighbour may see of this module.
 *
 * With tRPC a client is typed from the server's router, so the type has to cross the boundary —
 * and that is a door the boundary did not have before. This file is the door: `@template/auth`
 * resolves to `createApp` and nothing else, `@template/auth/contract` resolves to here, and
 * `dist/repository.js` resolves to nothing at all.
 *
 * Auth is the module with the most callers — Admin, Users twice over, and the application's own
 * browser bundle — and the one holding password hashes, session rows and one-time tokens. All three
 * live behind `repository.ts`, which no specifier reaches; what crosses is the shape of the
 * questions, and nothing else.
 *
 * Worth being honest about what this is not: `/contract` is a projection of the implementation,
 * not an agreement. It limits which files are visible, not what ends up in the type. What keeps
 * the type honest is the mandatory `.output()` that `fromContract` bakes in, and the
 * `contractCoverage` check next to each router.
 */
export type { AuthAdminRouter } from './routers/admin.js';
export type { AuthInternalRouter } from './routers/internal.js';
export type { AuthPublicRouter } from './routers/public.js';
