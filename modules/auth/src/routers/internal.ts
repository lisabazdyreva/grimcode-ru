import { authInternalContract } from '@template/contracts';
import { contractCoverage, fromContract, type RpcContext } from '@template/shared';
import { initTRPC } from '@trpc/server';

import { toIdentity, type AuthRepository } from '../repository.js';

export interface InternalContext extends RpcContext {
  repo: AuthRepository;
}

/**
 * Reachable only on `/internal/rpc`, which Gateway never proxies, so these procedures stay inside
 * the Docker network. Admin depends on them to resolve the current user and to bootstrap the very
 * first owner.
 */
const t = initTRPC.context<InternalContext>().create();

export const internalRouter = t.router({
  resolveSession: fromContract(authInternalContract.resolveSession, t.procedure).query(
    async ({ input, ctx }) => {
      const resolved = await ctx.repo.resolveSession(input.sessionToken);
      // A blocked identity has no usable session, even if the row itself has not expired yet.
      if (!resolved || resolved.identity.blocked_at !== null) return { identity: null };
      return { identity: toIdentity(resolved.identity) };
    },
  ),

  /**
   * The same revocation the public `logout` performs, without the cookie: whoever calls this owns
   * the response the browser sees and clears the cookie there.
   */
  revokeSessionByToken: fromContract(
    authInternalContract.revokeSessionByToken,
    t.procedure,
  ).mutation(async ({ input, ctx }) => {
    await ctx.repo.revokeSessionByToken(input.sessionToken);
    return { ok: true as const };
  }),

  getFirstIdentity: fromContract(authInternalContract.getFirstIdentity, t.procedure).query(
    async ({ ctx }) => {
      const row = await ctx.repo.findFirstIdentity();
      return { identity: row ? toIdentity(row) : null };
    },
  ),

  getIdentitiesByIds: fromContract(authInternalContract.getIdentitiesByIds, t.procedure).query(
    async ({ input, ctx }) => {
      const rows = await ctx.repo.findIdentitiesByIds(input.ids);
      return { identities: rows.map(toIdentity) };
    },
  ),

  searchIdentities: fromContract(authInternalContract.searchIdentities, t.procedure).query(
    async ({ input, ctx }) => {
      const rows = await ctx.repo.searchIdentities(input.query, input.limit);
      return { identities: rows.map(toIdentity) };
    },
  ),

  getIdentityByEmail: fromContract(authInternalContract.getIdentityByEmail, t.procedure).query(
    async ({ input, ctx }) => {
      const row = await ctx.repo.findIdentityByEmail(input.email);
      return { identity: row ? toIdentity(row) : null };
    },
  ),
});

const internalCoverage: 'ok' = contractCoverage(authInternalContract, internalRouter);
void internalCoverage;

/** Admin, Users and the composer are typed from this, and from nothing else. */
export type AuthInternalRouter = typeof internalRouter;
