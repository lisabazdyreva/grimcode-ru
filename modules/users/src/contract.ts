/**
 * What a neighbour may see of this module.
 *
 * With tRPC a client is typed from the server's router, so the type has to cross the boundary —
 * and that is a door the boundary did not have before. This file is the door: `@template/users`
 * resolves to `createApp` and nothing else, `@template/users/contract` resolves to here, and
 * `dist/repository.js` resolves to nothing at all.
 *
 * It re-exports types and only types. Nothing here may pull in the repository, the transport or
 * anything else from the implementation — the `exports` key would then be a formality while the
 * whole module leaked through it.
 *
 * Worth being honest about what this is not: `/contract` is a projection of the implementation,
 * not an agreement. It limits which files are visible, not what ends up in the type. What keeps
 * the type honest is the mandatory `.output()` that `fromContract` bakes in, and the
 * `contractCoverage` check next to each router.
 */
export type { UsersAdminRouter, UsersPublicRouter } from './routers.js';
