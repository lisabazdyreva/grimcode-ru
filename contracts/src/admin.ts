import { z } from 'zod';

import {
  adminRoleSchema,
  adminServiceIdSchema,
  adminTargetSchema,
  assignableServiceIdSchema,
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  okSchema,
  pageOf,
  paginationInputSchema,
} from './common.js';

export const administratorSchema = z.object({
  id: idSchema,
  userId: idSchema,
  email: emailSchema,
  role: adminRoleSchema,
  enabled: z.boolean(),
  grants: z.array(assignableServiceIdSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Administrator = z.infer<typeof administratorSchema>;

export const adminAuditEntrySchema = z.object({
  id: idSchema,
  action: z.string().max(80),
  actorUserId: idSchema.nullable(),
  subjectUserId: idSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
});

/**
 * Result of the single authorization method Gateway calls on every `/admin/**` request.
 *
 * `state` is deliberately explicit so Gateway never has to interpret an error: it either denies,
 * or forwards a verified administrator context it did not compute itself.
 */
export const authorizationResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('allowed'),
    userId: idSchema,
    email: emailSchema,
    role: adminRoleSchema,
  }),
  z.object({
    state: z.literal('denied'),
    reason: z.enum([
      'no-session',
      'not-an-administrator',
      'disabled',
      'no-grant',
      'owner-only',
      'unknown-service',
    ]),
  }),
  /** Auth has no users yet, so no owner can be bootstrapped. */
  z.object({ state: z.literal('awaiting-first-user') }),
]);

export type AuthorizationResult = z.infer<typeof authorizationResultSchema>;

/**
 * Internal Admin surface. Gateway is its only caller and it is never proxied outwards.
 */
export const adminInternalContract = {
  /**
   * Whether this account is one of the owners the project still has.
   *
   * Auth asks before blocking someone: blocking removes every session and every token, so blocking
   * the last owner locks the project out of its own panel — the thing the registry's own last-owner
   * rule exists to prevent. Ownership is Admin's fact, blocking is Auth's, and neither can see the
   * whole rule alone.
   */
  isActiveOwner: {
    input: z.object({ userId: idSchema }),
    output: z.object({ activeOwner: z.boolean() }),
  },

  /**
   * Resolves the current user through Auth, bootstraps the first owner when the registry is still
   * empty and answers with a decision. Gateway computes nothing, caches nothing and keeps no copy
   * of the rights, so a changed grant takes effect on the next request.
   */
  authorize: {
    input: z.object({
      sessionToken: z.string().min(1).max(400).nullable(),
      /** What is being opened; Gateway works it out from the URL. */
      target: adminTargetSchema,
    }),
    output: authorizationResultSchema,
  },
};

/**
 * Central Admin surface. Reachable as `/admin/rpc` after Gateway verified the admin session.
 */
export const adminContract = {
  internal: adminInternalContract,

  admin: {
    /** Current administrator plus the admin services their role and grants allow. */
    session: {
      input: z.object({}),
      output: z.object({
        userId: idSchema,
        email: emailSchema,
        role: adminRoleSchema,
        services: z.array(adminServiceIdSchema),
        /** Whether this administrator may open the panel's database browser. Owners only. */
        database: z.boolean(),
      }),
    },

    /** Owner-only registry of administrators. Product users from Users are never listed here. */
    listAdministrators: { input: paginationInputSchema, output: pageOf(administratorSchema) },

    /**
     * People who could be made administrators, matched by address. Owner-only.
     *
     * Being an administrator starts from an account that already exists, so this is how an owner
     * finds that account instead of having to know the address by heart.
     */
    searchUsers: {
      input: z.object({ query: z.string().min(1).max(200) }),
      output: z.object({
        users: z.array(
          z.object({
            userId: idSchema,
            email: emailSchema,
            /** Already in the registry, so adding them again would be refused. */
            isAdministrator: z.boolean(),
          }),
        ),
      }),
    },

    /** Adds an already registered user by email. Owner-only. */
    addAdministrator: {
      input: z.object({
        email: emailSchema,
        role: adminRoleSchema,
        grants: z.array(assignableServiceIdSchema).default([]),
      }),
      output: z.object({ ok: z.literal(true), administrator: administratorSchema }),
    },

    /** Owner-only. The last active owner can neither be demoted nor disabled. */
    updateAdministrator: {
      input: z.object({
        userId: idSchema,
        role: adminRoleSchema.optional(),
        enabled: z.boolean().optional(),
        grants: z.array(assignableServiceIdSchema).optional(),
      }),
      output: z.object({ ok: z.literal(true), administrator: administratorSchema }),
    },

    listAudit: { input: paginationInputSchema, output: pageOf(adminAuditEntrySchema) },

    /** Server-side logout through Auth, followed by clearing the HttpOnly cookie. */
    logout: { input: z.object({}), output: okSchema },
  },
};
