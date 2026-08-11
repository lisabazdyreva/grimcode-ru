import type { AuthInternalRouter } from '@template/auth/contract';
import { usersAdminContract, usersPublicContract, type Identity } from '@template/contracts';
import {
  contractCoverage,
  createTrpcClient,
  fromContract,
  internalServiceUrl,
  verifiedAdmin,
  type AdminAwareContext,
  type FetchLike,
  type RpcContext,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import { toProfile, type ProfileRow, type UsersRepository } from './repository.js';

/**
 * Fills in the sign-in address for a page of profiles.
 *
 * Users does not store it, so it is fetched per request, in one call for the whole page. An id Auth
 * does not know stays `null`, which is how a profile left by a deleted account is visible as one.
 * The `catch` below is why the deadline in `createTrpcClient` matters.
 */
async function withEmails(rows: ProfileRow[], callAuth: FetchLike) {
  const profiles = rows.map((row) => ({ ...toProfile(row), email: null as string | null }));
  if (profiles.length === 0) return profiles;

  try {
    const auth = createTrpcClient<AuthInternalRouter>({
      url: `${internalServiceUrl('auth')}/internal/rpc`,
      fetch: callAuth,
    });

    const { identities } = await auth.getIdentitiesByIds.query({
      ids: [...new Set(rows.map((row) => row.identity_id))],
    });

    const byId = new Map(identities.map((identity) => [identity.id, identity.email]));
    for (const profile of profiles) profile.email = byId.get(profile.identityId) ?? null;
  } catch {
    // Auth being briefly unreachable is not a reason to refuse the whole page: the profiles are
    // still worth showing, and a missing address reads as missing.
  }

  return profiles;
}

export interface PublicContext extends RpcContext {
  repo: UsersRepository;
  /** Resolved through Auth on every call; `null` means no valid session. */
  identity: Identity | null;
}

export interface AdminRpcContext extends AdminAwareContext {
  repo: UsersRepository;
  /** Answers Auth's internal surface; the profile list needs the sign-in address from it. */
  callAuth: FetchLike;
}

// --- public surface ---------------------------------------------------------------------------

const publicT = initTRPC.context<PublicContext>().create();

/**
 * A session is required, and this is where that requirement lives.
 *
 * The route guard in the SPA is for the user flow; this is what actually protects the data.
 */
const withIdentity = publicT.procedure.use(({ ctx, next }) => {
  if (!ctx.identity) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });
  return next({ ctx: { identity: ctx.identity } });
});

export const publicRouter = publicT.router({
  getOwnProfile: fromContract(usersPublicContract.getOwnProfile, withIdentity).query(
    async ({ ctx }) => {
      // The profile is created lazily on first access, so Auth never has to know about Users.
      return { profile: toProfile(await ctx.repo.ensure(ctx.identity.id)) };
    },
  ),

  updateOwnProfile: fromContract(usersPublicContract.updateOwnProfile, withIdentity).mutation(
    async ({ input, ctx }) => {
      await ctx.repo.ensure(ctx.identity.id);
      const row = await ctx.repo.updateProfile(ctx.identity.id, input.displayName);
      return { ok: true as const, profile: toProfile(row) };
    },
  ),
});

/** The router implements the contract exactly: nothing missing, nothing extra, no other schemas. */
const publicCoverage: 'ok' = contractCoverage(usersPublicContract, publicRouter);
void publicCoverage;

// --- admin surface ----------------------------------------------------------------------------

const adminT = initTRPC.context<AdminRpcContext>().create();

const adminProcedure = adminT.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

/**
 * Users has no admin operation that changes anything — a profile belongs to the person it
 * describes, and this screen only reads it — so there is no `adminMutation` here. The CSRF half of
 * the pair lives in `shared` and is used by the modules that do change something.
 */
export const adminRouter = adminT.router({
  listProfiles: fromContract(usersAdminContract.listProfiles, adminProcedure).query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.list(input.query, input.limit, input.offset);
      return {
        items: await withEmails(rows, ctx.callAuth),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    },
  ),

  getProfile: fromContract(usersAdminContract.getProfile, adminProcedure).query(
    async ({ input, ctx }) => {
      const row = await ctx.repo.findById(input.id);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Профиль не найден' });

      const [profile] = await withEmails([row], ctx.callAuth);
      return { profile: profile! };
    },
  ),
});

const adminCoverage: 'ok' = contractCoverage(usersAdminContract, adminRouter);
void adminCoverage;

/** The browser client is typed from these, and from nothing else. */
export type UsersPublicRouter = typeof publicRouter;
export type UsersAdminRouter = typeof adminRouter;
