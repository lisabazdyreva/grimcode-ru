import { z } from 'zod';

import {
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  okSchema,
  pageOf,
  paginationInputSchema,
} from './common.js';

/** Minimal identity Auth owns. It is never a product profile — Users owns that. */
export const identitySchema = z.object({
  id: idSchema,
  email: emailSchema,
  emailVerifiedAt: isoDateTimeSchema.nullable(),
  blockedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export type Identity = z.infer<typeof identitySchema>;

export const sessionSummarySchema = z.object({
  id: idSchema,
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  userAgent: z.string().max(400).nullable(),
  current: z.boolean(),
});

export const adminIdentitySchema = identitySchema.extend({
  activeSessionCount: z.number().int().min(0),
  lastLoginAt: isoDateTimeSchema.nullable(),
});

/** Identity as an administrator sees it, with the counters the admin list shows. */
export type AdminIdentity = z.infer<typeof adminIdentitySchema>;

export const authAuditEntrySchema = z.object({
  id: idSchema,
  identityId: idSchema.nullable(),
  action: z.string().max(80),
  actorUserId: idSchema.nullable(),
  actorRole: z.string().max(20).nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
});

const passwordSchema = z.string().min(12, 'Password must contain at least 12 characters').max(200);

/**
 * Public Auth surface. Reachable through Gateway as `/service/auth/rpc`.
 * Gateway performs no authorization here: securing these endpoints is Auth's own responsibility.
 */
export const authPublicContract = {
  register: {
    input: z.object({ email: emailSchema, password: passwordSchema }),
    output: z.object({ ok: z.literal(true), identity: identitySchema }),
  },

  login: {
    input: z.object({ email: emailSchema, password: z.string().min(1).max(200) }),
    output: z.object({ ok: z.literal(true), identity: identitySchema }),
  },

  /** Server-side logout: the session row is invalidated before the cookie is cleared. */
  logout: { input: z.object({}), output: okSchema },

  currentSession: {
    input: z.object({}),
    output: z.object({ identity: identitySchema.nullable() }),
  },

  listOwnSessions: {
    input: z.object({}),
    output: z.object({ sessions: z.array(sessionSummarySchema) }),
  },

  /** Revokes every session of the caller, including the current one. */
  revokeOwnSessions: { input: z.object({}), output: okSchema },

  /** Always answers `ok` so that the flow never reveals whether the email exists. */
  requestPasswordReset: { input: z.object({ email: emailSchema }), output: okSchema },

  resetPassword: {
    input: z.object({ token: z.string().min(20).max(200), password: passwordSchema }),
    output: okSchema,
  },

  changePassword: {
    input: z.object({ currentPassword: z.string().min(1).max(200), password: passwordSchema }),
    output: okSchema,
  },

  verifyEmail: { input: z.object({ token: z.string().min(20).max(200) }), output: okSchema },

  resendOwnVerification: { input: z.object({}), output: okSchema },

  requestEmailChange: { input: z.object({ email: emailSchema }), output: okSchema },

  confirmEmailChange: { input: z.object({ token: z.string().min(20).max(200) }), output: okSchema },
};

/**
 * Internal Auth surface. Mounted on the internal RPC path only and never proxied by Gateway,
 * so it stays reachable exclusively from inside the Docker network.
 */
export const authInternalContract = {
  resolveSession: {
    input: z.object({ sessionToken: z.string().min(1).max(400) }),
    output: z.object({ identity: identitySchema.nullable() }),
  },

  /**
   * Invalidates one session, named by the token the browser holds.
   *
   * Signing out of the admin panel is the same operation as signing out of the application, but it
   * arrives at Admin rather than at Auth, and a module never touches a neighbour's database. The
   * name says exactly which session goes: `revokeOwnSessions` on the public surface and
   * `revokeSessions` on the admin one are already taken, and both take all of them.
   *
   * The caller clears the cookie itself — the answer carries no header, only the fact that the row
   * is gone. Doing it in the other order, or not at all, leaves a session that still works.
   */
  revokeSessionByToken: {
    input: z.object({ sessionToken: z.string().min(1).max(400) }),
    output: okSchema,
  },

  /**
   * Earliest registered identity in a deterministic order. Admin uses it to bootstrap the very
   * first owner; ownership follows registration order, not who opened the admin panel first.
   */
  getFirstIdentity: {
    input: z.object({}),
    output: z.object({ identity: identitySchema.nullable() }),
  },

  /**
   * Several identities at once.
   *
   * Users needs the address for a page of profiles; asking one at a time would be a request per
   * row. Unknown ids are simply absent from the answer.
   */
  getIdentitiesByIds: {
    input: z.object({ ids: z.array(idSchema).max(200) }),
    output: z.object({ identities: z.array(identitySchema) }),
  },

  /**
   * Identities matching a fragment of an address.
   *
   * Admin needs it to let an owner pick a person instead of typing an address exactly right. It is
   * internal: the search itself is not something a client may reach.
   */
  searchIdentities: {
    input: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    output: z.object({ identities: z.array(identitySchema) }),
  },

  getIdentityByEmail: {
    input: z.object({ email: emailSchema }),
    output: z.object({ identity: identitySchema.nullable() }),
  },
};

/**
 * Auth service admin surface. Reachable as `/admin/embed/service/auth/rpc` only after Gateway has
 * verified the session, the admin role and the grant on Auth.
 */
export const authAdminContract = {
  listIdentities: { input: paginationInputSchema, output: pageOf(adminIdentitySchema) },

  getIdentity: {
    input: z.object({ id: idSchema }),
    output: z.object({ identity: adminIdentitySchema }),
  },

  /** Sends the ordinary time-limited one-time recovery link. The token is never shown to admins. */
  sendRecovery: { input: z.object({ id: idSchema }), output: okSchema },

  resendVerification: { input: z.object({ id: idSchema }), output: okSchema },

  revokeSessions: { input: z.object({ id: idSchema }), output: okSchema },

  /** Owner-only. An owner can never block their own identity. */
  setBlocked: {
    input: z.object({ id: idSchema, blocked: z.boolean() }),
    output: z.object({ ok: z.literal(true), identity: adminIdentitySchema }),
  },

  listAudit: { input: paginationInputSchema, output: pageOf(authAuditEntrySchema) },
};

export const authContract = {
  public: authPublicContract,
  internal: authInternalContract,
  admin: authAdminContract,
};
