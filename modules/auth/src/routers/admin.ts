import { idSchema, okSchema, pageOf, paginationInputSchema } from '@template/shared/vocabulary';
import { z } from 'zod';
import {
  newToken,
  publicSiteUrl,
  requireCsrf,
  verifiedAdmin,
  type AdminAwareContext,
  type Logger,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';
import { adminIdentitySchema, authAuditEntrySchema } from '../schemas.js';

/**
 * Whether this identity is an active owner of the admin panel.
 *
 * Ownership is Admin's fact and Auth needs it for one rule, so Auth declares what it needs and is
 * handed an implementation. The direction of the call is a decision of the wiring, the only place
 * that knows about both.
 */
export type IsActiveOwner = (userId: string) => Promise<boolean>;

export interface AdminRpcContext extends AdminAwareContext {
  repo: AuthRepository;
  notifier: Notifier;
  logger: Logger;
  /**
   * Required, never optional and never defaulted: a default of "assume not an owner" would turn one
   * forgotten line in the wiring into a rule that silently stops running, and that rule is what
   * keeps the panel from being left with no owner at all.
   */
  isActiveOwner: IsActiveOwner;
}

const RESET_TTL_SECONDS = 60 * 60;
const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

const t = initTRPC.context<AdminRpcContext>().create();

/**
 * Every admin mutation checks the verified context and the CSRF token: together they mean a request
 * must come through Gateway's admin route *and* originate from the admin panel itself. The scope is
 * `'auth'` and not `'panel'` — each surface issues its own cookie, and a token from the shell is
 * refused here on purpose.
 */
const adminProcedure = t.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

const adminMutation = adminProcedure.use(({ ctx, next }) => {
  requireCsrf(ctx, 'auth');
  return next();
});

async function loadIdentity(repo: AuthRepository, id: string): Promise<IdentityRow> {
  const row = await repo.findIdentityById(id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
  return row;
}

async function adminIdentityOf(repo: AuthRepository, row: IdentityRow) {
  const sessions = await repo.listSessions(row.id);
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    blockedAt: row.blocked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    activeSessionCount: sessions.length,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

/**
 * The service admin surface, by name, reachable only after Gateway verified the grant on Auth:
 * `setBlocked` ends every session a person has and `sendRecovery` mails them a reset link, and on
 * the public surface either would lock people out of their own accounts.
 */
type AdminName =
  | 'listIdentities'
  | 'getIdentity'
  | 'sendRecovery'
  | 'resendVerification'
  | 'revokeSessions'
  | 'setBlocked'
  | 'listAudit';

export const adminRouter = t.router({
  listIdentities: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(adminIdentitySchema))
    .query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listIdentities(input.query, input.limit, input.offset);

      return {
        items: rows.map((row) => ({
          id: row.id,
          email: row.email,
          emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
          blockedAt: row.blocked_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          activeSessionCount: Number(row.active_session_count),
          lastLoginAt: row.last_login_at?.toISOString() ?? null,
        })),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    },
  ),

  getIdentity: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(z.object({ identity: adminIdentitySchema }))
    .query(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);
      return { identity: await adminIdentityOf(ctx.repo, row) };
    },
  ),

  /**
   * Sends the ordinary user-facing recovery link through Notifications and Email. The administrator
   * never sets, sees or receives the token: it is the same time-limited single-use flow the user
   * would start themselves.
   */
  sendRecovery: adminMutation
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);

      const token = newToken(32);
      await ctx.repo.issueToken(row.id, 'password-reset', token, RESET_TTL_SECONDS);
      await ctx.repo.audit({
        identityId: row.id,
        action: 'admin.recovery.sent',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
      });

      await ctx.notifier.emit(
        {
          type: 'auth.password.reset_requested',
          recipient: {
            identityId: row.id,
            email: row.email,
          },
          payload: {
            resetUrl: `${publicSiteUrl()}/app/reset-password/confirm?token=${encodeURIComponent(token)}`,
          },
        },
        `auth.password.reset_requested:${row.id}:${Date.now()}`,
      );

      return { ok: true as const };
    },
  ),

  resendVerification: adminMutation
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);
      if (row.email_verified_at !== null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Адрес уже подтверждён' });
      }

      const token = newToken(32);
      await ctx.repo.issueToken(row.id, 'email-verification', token, VERIFICATION_TTL_SECONDS);
      await ctx.repo.audit({
        identityId: row.id,
        action: 'admin.verification.resent',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
      });

      await ctx.notifier.emit(
        {
          type: 'auth.email.verification_requested',
          recipient: {
            identityId: row.id,
            email: row.email,
          },
          payload: {
            verificationUrl: `${publicSiteUrl()}/app/verify-email?token=${encodeURIComponent(token)}`,
          },
        },
        `auth.email.verification_requested:${row.id}:${Date.now()}`,
      );

      return { ok: true as const };
    },
  ),

  revokeSessions: adminMutation
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);

      const revoked = await ctx.repo.revokeAllSessions(row.id);
      await ctx.repo.audit({
        identityId: row.id,
        action: 'admin.sessions.revoked',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
        details: { revoked },
      });

      return { ok: true as const };
    },
  ),

  /** Owner-only, and no owner's identity can be blocked while they hold the rights. */
  setBlocked: adminMutation
    .input(z.object({ id: idSchema, blocked: z.boolean() }))
    .output(z.object({ ok: z.literal(true), identity: adminIdentitySchema }))
    .mutation(
    async ({ input, ctx }) => {
      if (ctx.admin.role !== 'owner') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Блокировать может только владелец' });
      }
      if (input.blocked && ctx.admin.userId === input.id) {
        // Otherwise the last working owner session could be removed by the owner themselves.
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Нельзя заблокировать самого себя' });
      }

      /*
       * Blocking takes away every session and every token, so a blocked owner is an owner the panel
       * can no longer let in. The registry counts owners by its `enabled` flag and cannot see that,
       * so two owners could be reduced to none: block one here, remove the other there. Auth asks
       * before it acts and refuses outright — rights come off in Administrators first.
       */
      if (input.blocked) {
        if (await ctx.isActiveOwner(input.id)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Сначала снимите права владельца в разделе «Администраторы»',
          });
        }
      }

      const row = await loadIdentity(ctx.repo, input.id);
      const updated = await ctx.repo.setBlocked(row.id, input.blocked);
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });

      if (input.blocked) {
        // Blocking takes effect immediately: sessions and outstanding auth tokens are revoked.
        await ctx.repo.revokeAllSessions(row.id);
        await ctx.repo.revokeTokens(row.id);
      }

      await ctx.repo.audit({
        identityId: row.id,
        action: input.blocked ? 'admin.identity.blocked' : 'admin.identity.unblocked',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
      });

      return { ok: true as const, identity: await adminIdentityOf(ctx.repo, updated) };
    },
  ),

  listAudit: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(authAuditEntrySchema))
    .query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listAudit(input.query, input.limit, input.offset);

      return {
        items: rows.map((row) => ({
          id: String(row.id),
          identityId: (row.identity_id as string | null) ?? null,
          action: String(row.action),
          actorUserId: (row.actor_user_id as string | null) ?? null,
          actorRole: (row.actor_role as string | null) ?? null,
          details: (row.details as Record<string, unknown>) ?? {},
          createdAt: (row.created_at as Date).toISOString(),
        })),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    },
  ),
} satisfies Record<AdminName, unknown>);


/** Auth's own service admin is typed from this, and from nothing else. */
export type AuthAdminRouter = typeof adminRouter;
