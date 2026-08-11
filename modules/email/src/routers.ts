import { EDITOR_FORMAT, emailAdminContract, emailInternalContract } from '@template/contracts';
import {
  contractCoverage,
  fromContract,
  requireCsrf,
  verifiedAdmin,
  type AdminAwareContext,
  type Logger,
  type RpcContext,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import { sendTemplate, UnknownTemplateError } from './delivery.js';
import type { EmailRepository, TemplateRow, VersionRow } from './repository.js';
import {
  assertDeclaredVariables,
  redactOneTimeTokens,
  renderMessage,
  TemplateRenderError,
  type VariableValue,
} from './render.js';
import type { Transport } from './transport.js';

export interface InternalContext extends RpcContext {
  repo: EmailRepository;
  transport: Transport;
  logger: Logger;
}

export interface AdminRpcContext extends AdminAwareContext {
  repo: EmailRepository;
  transport: Transport;
  logger: Logger;
}

function toTemplate(row: TemplateRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    variables: row.variables ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVersion(row: VersionRow) {
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    status: row.status,
    subject: row.subject,
    editorFormat: EDITOR_FORMAT,
    editorDocument: row.editor_document,
    compiledHtml: row.compiled_html,
    compiledText: row.compiled_text,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadVersion(repo: EmailRepository, id: string): Promise<VersionRow> {
  const row = await repo.findVersion(id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия шаблона не найдена' });
  return row;
}

function renderFailure(error: unknown): never {
  if (error instanceof TemplateRenderError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw error;
}

// --- internal surface -------------------------------------------------------------------------

const internalT = initTRPC.context<InternalContext>().create();

export const internalRouter = internalT.router({
  send: fromContract(emailInternalContract.send, internalT.procedure).mutation(
    async ({ input, ctx }) => {
      try {
        const result = await sendTemplate(input, ctx);
        return { ok: true as const, ...result };
      } catch (error) {
        if (error instanceof UnknownTemplateError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    },
  ),
});

const internalCoverage: 'ok' = contractCoverage(emailInternalContract, internalRouter);
void internalCoverage;

// --- admin surface ----------------------------------------------------------------------------

const adminT = initTRPC.context<AdminRpcContext>().create();

/**
 * The two builders every admin surface in this template is made of.
 *
 * Email is where the difference earns its keep: fourteen procedures, eight of which change
 * something. Said by hand as the first line of each body, a forgotten line left a procedure open
 * with nothing to catch it — not the types, not the tests, not the boundary check. Now it is which
 * builder the procedure is written on, and one written on neither does not exist.
 */
const adminProcedure = adminT.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

const adminMutation = adminProcedure.use(({ ctx, next }) => {
  requireCsrf(ctx, 'email');
  return next();
});

export const adminRouter = adminT.router({
  listTemplates: fromContract(emailAdminContract.listTemplates, adminProcedure).query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listTemplates(input.query, input.limit, input.offset);
      return { items: rows.map(toTemplate), total, limit: input.limit, offset: input.offset };
    },
  ),

  getTemplate: fromContract(emailAdminContract.getTemplate, adminProcedure).query(
    async ({ input, ctx }) => {
      const template = await ctx.repo.findTemplateById(input.id);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      const versions = await ctx.repo.listVersions(template.id);
      return {
        template: toTemplate(template),
        // The list omits the editor document; it is fetched per version when the editor opens.
        versions: versions.map((row) => {
          const { editorDocument: _editorDocument, ...rest } = toVersion(row);
          return rest;
        }),
      };
    },
  ),

  createTemplate: fromContract(emailAdminContract.createTemplate, adminMutation).mutation(
    async ({ input, ctx }) => {
      if (await ctx.repo.findTemplateByKey(input.key)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Шаблон с таким ключом уже есть' });
      }

      const row = await ctx.repo.createTemplate(
        input.key,
        input.name,
        input.description,
        input.variables,
      );
      await ctx.repo.audit({
        action: 'template.created',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
        details: { key: input.key },
      });

      return { ok: true as const, template: toTemplate(row) };
    },
  ),

  updateTemplate: fromContract(emailAdminContract.updateTemplate, adminMutation).mutation(
    async ({ input, ctx }) => {
      const row = await ctx.repo.updateTemplate(input.id, input);
      await ctx.repo.audit({
        action: 'template.updated',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
        details: { key: row.key },
      });
      return { ok: true as const, template: toTemplate(row) };
    },
  ),

  getVersion: fromContract(emailAdminContract.getVersion, adminProcedure).query(
    async ({ input, ctx }) => ({ version: toVersion(await loadVersion(ctx.repo, input.id)) }),
  ),

  createDraft: fromContract(emailAdminContract.createDraft, adminMutation).mutation(
    async ({ input, ctx }) => {
      const template = await ctx.repo.findTemplateById(input.templateId);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      const row = await ctx.repo.createDraft(template.id, {
        subject: template.name,
        document: { type: 'doc', content: [] },
      });
      await ctx.repo.audit({
        action: 'version.draft.created',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
        details: { templateKey: template.key, version: row.version },
      });

      return { ok: true as const, version: toVersion(row) };
    },
  ),

  saveDraft: fromContract(emailAdminContract.saveDraft, adminMutation).mutation(
    async ({ input, ctx }) => {
      try {
        const row = await ctx.repo.saveDraft(input.id, input.subject, input.editorDocument);
        return { ok: true as const, version: toVersion(row) };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Draft could not be saved',
        });
      }
    },
  ),

  /**
   * Publishing is where the server takes over: it validates the document's variables, renders it,
   * sanitizes the HTML and derives the plain text from that HTML. Runtime delivery then only ever
   * sends this stored result.
   */
  publishDraft: fromContract(emailAdminContract.publishDraft, adminMutation).mutation(
    async ({ input, ctx }) => {
      const draft = await loadVersion(ctx.repo, input.id);

      const template = await ctx.repo.findTemplateById(draft.template_id);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      let compiled;
      try {
        assertDeclaredVariables(draft.editor_document, template.variables ?? []);
        compiled = await renderMessage(draft.editor_document, draft.subject);
      } catch (error) {
        renderFailure(error);
      }

      const row = await ctx.repo.publish(draft.id, {
        html: compiled.html,
        text: compiled.text,
      });

      await ctx.repo.audit({
        action: 'version.published',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
        details: { templateKey: template.key, version: row.version },
      });

      return { ok: true as const, version: toVersion(row) };
    },
  ),

  previewVersion: fromContract(emailAdminContract.previewVersion, adminProcedure).query(
    async ({ input, ctx }) => {
      const version = await loadVersion(ctx.repo, input.id);

      try {
        return await renderMessage(
          version.editor_document,
          version.subject,
          input.variables as Record<string, VariableValue>,
        );
      } catch (error) {
        renderFailure(error);
      }
    },
  ),

  testSend: fromContract(emailAdminContract.testSend, adminMutation).mutation(
    async ({ input, ctx }) => {
      const version = await loadVersion(ctx.repo, input.id);
      const template = await ctx.repo.findTemplateById(version.template_id);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      let rendered;
      try {
        rendered = await renderMessage(
          version.editor_document,
          version.subject,
          input.variables as Record<string, VariableValue>,
        );
      } catch (error) {
        renderFailure(error);
      }

      // A test send is a real send: it goes through the transport and is recorded in the log with
      // the exact content that left the system.
      const dedupeKey = `test:${version.id}:${input.to}:${Date.now()}`;
      const { row } = await ctx.repo.openDelivery({
        dedupeKey,
        templateKey: template.key,
        templateVersionId: version.id,
        recipientEmail: input.to,
        subject: rendered.subject,
        html: redactOneTimeTokens(rendered.html),
        text: redactOneTimeTokens(rendered.text),
        transport: ctx.transport.name,
      });

      try {
        const result = await ctx.transport.send({ dedupeKey, to: input.to, ...rendered });
        await ctx.repo.markSent(row.id, result);
      } catch (error) {
        await ctx.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
      }

      await ctx.repo.audit({
        action: 'version.test-sent',
        actorUserId: ctx.admin.userId,
        actorRole: ctx.admin.role,
        details: { templateKey: template.key, to: input.to },
      });

      return { ok: true as const, deliveryId: row.id };
    },
  ),

  listDeliveries: fromContract(emailAdminContract.listDeliveries, adminProcedure).query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listDeliveries(
        { query: input.query, status: input.status },
        input.limit,
        input.offset,
      );

      return {
        // The list never carries message bodies; they are fetched one at a time.
        items: rows.map((row) => ({
          id: row.id,
          templateKey: row.template_key,
          templateVersionId: row.template_version_id,
          recipientEmail: row.recipient_email,
          subject: row.subject,
          transport: row.transport,
          status: row.status,
          providerMessageId: row.provider_message_id,
          providerStatus: row.provider_status,
          error: row.error,
          createdAt: row.created_at.toISOString(),
          sentAt: row.sent_at?.toISOString() ?? null,
        })),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    },
  ),

  /** The immutable snapshot of one actually sent message, body included. */
  getDelivery: fromContract(emailAdminContract.getDelivery, adminProcedure).query(
    async ({ input, ctx }) => {
      const row = await ctx.repo.findDelivery(input.id);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Отправка не найдена' });

      return {
        delivery: {
          id: row.id,
          templateKey: row.template_key,
          templateVersionId: row.template_version_id,
          recipientEmail: row.recipient_email,
          subject: row.subject,
          html: row.html,
          text: row.text,
          transport: row.transport,
          status: row.status,
          providerMessageId: row.provider_message_id,
          providerStatus: row.provider_status,
          error: row.error,
          createdAt: row.created_at.toISOString(),
          sentAt: row.sent_at?.toISOString() ?? null,
        },
      };
    },
  ),

  uploadImage: fromContract(emailAdminContract.uploadImage, adminMutation).mutation(
    ({ input }) => {
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.length > 2_000_000) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Изображение не больше 2 МБ' });
      }

      // The template stores images inline in the document, so nothing has to be hosted or served,
      // and a published message never depends on an asset that might later disappear.
      return {
        ok: true as const,
        url: `data:${input.contentType};base64,${bytes.toString('base64')}`,
      };
    },
  ),

  reindexSeedTemplates: fromContract(
    emailAdminContract.reindexSeedTemplates,
    adminMutation,
  ).mutation(async ({ ctx }) => {
    const created = await ctx.repo.ensureSeedTemplates((document, subject) =>
      renderMessage(document, subject).then(({ html, text }) => ({ html, text })),
    );
    await ctx.repo.audit({
      action: 'seed.reindexed',
      actorUserId: ctx.admin.userId,
      actorRole: ctx.admin.role,
      details: { created },
    });
    return { ok: true as const };
  }),
});

const adminCoverage: 'ok' = contractCoverage(emailAdminContract, adminRouter);
void adminCoverage;

/** The browser client and Notifications are typed from these, and from nothing else. */
export type EmailInternalRouter = typeof internalRouter;
export type EmailAdminRouter = typeof adminRouter;
