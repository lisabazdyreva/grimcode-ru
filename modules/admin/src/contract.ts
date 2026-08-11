/**
 * What a neighbour may see of this module.
 *
 * With tRPC a client is typed from the server's router, so the type has to cross the boundary —
 * and that is a door the boundary did not have before. This file is the door: `@template/admin`
 * resolves to `createApp` and nothing else, `@template/admin/contract` resolves to here, and
 * `dist/repository.js` resolves to nothing at all.
 *
 * It matters more here than anywhere else in the template. This module is the registry of who may
 * do what: the rights themselves, the last-owner rule and the audit log all live behind
 * `repository.ts`, and the one thing a neighbour is allowed to have of it is the shape of the two
 * questions it may ask.
 *
 * Worth being honest about what this is not: `/contract` is a projection of the implementation,
 * not an agreement. It limits which files are visible, not what ends up in the type. What keeps
 * the type honest is the mandatory `.output()` that `fromContract` bakes in, and the
 * `contractCoverage` check next to each router.
 */
export type { AdminInternalRouter, AdminPanelRouter } from './routers.js';
