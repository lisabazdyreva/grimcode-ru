import {
  EVENT_TEMPLATE_KEYS,
  notificationsAdminContract,
  notificationsInternalContract,
  type NotificationEvent,
} from '@template/contracts';
import type { EmailInternalRouter } from '@template/email/contract';
import {
  contractCoverage,
  createTrpcClient,
  fromContract,
  internalServiceUrl,
  REQUEST_ID_HEADER,
  verifiedAdmin,
  type AdminAwareContext,
  type FetchLike,
  type Logger,
  type RpcContext,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import type { EventRow, NotificationsRepository } from './repository.js';

export interface InternalContext extends RpcContext {
  repo: NotificationsRepository;
  logger: Logger;
  requestId: string;
  /** Answers Email's internal surface. */
  callEmail: FetchLike;
}

export interface AdminRpcContext extends AdminAwareContext {
  repo: NotificationsRepository;
}

function toStored(row: EventRow) {
  return {
    id: row.id,
    type: row.type as keyof typeof EVENT_TEMPLATE_KEYS,
    dedupeKey: row.dedupe_key,
    recipientEmail: row.recipient_email,
    status: row.status,
    error: row.error,
    deliveryId: row.delivery_id,
    createdAt: row.created_at.toISOString(),
    routedAt: row.routed_at?.toISOString() ?? null,
  };
}

/** Variables handed to the email template. Only the event's own payload is exposed. */
export function variablesOf(event: NotificationEvent): Record<string, string> {
  const variables: Record<string, string> = { email: event.recipient.email };
  for (const [key, value] of Object.entries(event.payload)) variables[key] = String(value);
  return variables;
}

// --- internal surface ---------------------------------------------------------------------------

const internalT = initTRPC.context<InternalContext>().create();

export const internalRouter = internalT.router({
  /**
   * Accepts one typed event and routes it to Email.
   *
   * The contract's discriminated union already rejects anything that is not a known event type,
   * so an unknown event never reaches storage. `dedupeKey` makes a repeated delivery harmless.
   */
  emit: fromContract(notificationsInternalContract.emit, internalT.procedure).mutation(
    async ({ input, ctx }) => {
      const { event, dedupeKey } = input;

      const { row, created } = await ctx.repo.accept(
        event.type,
        dedupeKey,
        event.recipient.email,
        event.payload,
      );

      if (!created) {
        ctx.logger.info('event already accepted, not routed again', { dedupeKey });
        return { ok: true as const, eventId: row.id, deduplicated: true };
      }

      const templateKey = EVENT_TEMPLATE_KEYS[event.type];

      try {
        /*
         * The deadline around this call is the whole reason the `catch` below means anything:
         * `app.fetch` ignores an abort signal, so without the bound `createTrpcClient` puts on the
         * wait, an Email that hung would hang the event with it — and the event would never reach
         * the `failed` state that makes the trouble visible in the service admin.
         */
        const email = createTrpcClient<EmailInternalRouter>({
          url: `${internalServiceUrl('email')}/internal/rpc`,
          headers: { [REQUEST_ID_HEADER]: ctx.requestId },
          fetch: ctx.callEmail,
        });

        const result = await email.send.mutate({
          templateKey,
          to: event.recipient.email,
          variables: variablesOf(event),
          // Email deduplicates on its own side too, so a retried routing cannot send twice.
          dedupeKey: `notification:${row.id}`,
        });

        /*
         * Email answers with the delivery it stored even when the transport refused it. Recording
         * that as `routed` would put a green row in the log for a message nobody received.
         */
        if (result.status === 'failed') {
          await ctx.repo.markFailed(row.id, 'Email accepted the message but could not send it.');
        } else {
          await ctx.repo.markRouted(row.id, result.deliveryId);
        }
      } catch (error) {
        // The event stays stored as `failed`, so the failure is visible in the service admin
        // instead of disappearing.
        await ctx.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
        ctx.logger.error('event could not be routed to email', { type: event.type, error });
      }

      return { ok: true as const, eventId: row.id, deduplicated: false };
    },
  ),
});

const internalCoverage: 'ok' = contractCoverage(notificationsInternalContract, internalRouter);
void internalCoverage;

// --- admin surface ------------------------------------------------------------------------------

const adminT = initTRPC.context<AdminRpcContext>().create();

/**
 * No admin operation here changes anything, so there is no `adminMutation`: an event is a record of
 * what happened, and a log that can be edited is not a record.
 */
const adminProcedure = adminT.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

export const adminRouter = adminT.router({
  listEvents: fromContract(notificationsAdminContract.listEvents, adminProcedure).query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.list(
        { query: input.query, type: input.type, status: input.status },
        input.limit,
        input.offset,
      );
      return { items: rows.map(toStored), total, limit: input.limit, offset: input.offset };
    },
  ),

  getEvent: fromContract(notificationsAdminContract.getEvent, adminProcedure).query(
    async ({ input, ctx }) => {
      const row = await ctx.repo.findById(input.id);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Событие не найдено' });
      return { event: toStored(row) };
    },
  ),
});

const adminCoverage: 'ok' = contractCoverage(notificationsAdminContract, adminRouter);
void adminCoverage;

/** The browser client and Auth are typed from these, and from nothing else. */
export type NotificationsInternalRouter = typeof internalRouter;
export type NotificationsAdminRouter = typeof adminRouter;
