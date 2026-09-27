import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { agentFileMime, MAX_AGENT_FILE_BASE64_LENGTH, MAX_AGENT_FILE_BYTES, type RichBlock } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { stampVisibleTurn } from '../domains/cats/services/agents/invocation/visible-turn.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { saveFileBufferToUploadDir } from '../utils/file-storage.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';

const inputSchema = z
  .object({
    fileName: z
      .string()
      .min(1)
      .max(200)
      .refine((name) => !/[\p{Cc}/\\]/u.test(name) && name !== '.' && name !== '..'),
    mimeType: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string().min(4).max(MAX_AGENT_FILE_BASE64_LENGTH),
  })
  .strict();
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function decodePublication(body: unknown) {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return { error: 'Invalid attachment payload' };
  const input = parsed.data;
  if (agentFileMime(input.fileName) !== input.mimeType) return { error: 'Unsupported filename / MIME type pair' };
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (
    !bytes.length ||
    bytes.length > MAX_AGENT_FILE_BYTES ||
    bytes.toString('base64') !== input.dataBase64 ||
    digest(bytes) !== input.sha256
  )
    return { error: 'Attachment byte length, encoding or SHA256 mismatch' };
  return { input, bytes };
}

export function registerCallbackFilePublication(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    socketManager: SocketManager;
    messageStore?: Pick<IMessageStore, 'appendIdempotent'>;
    threadStore?: Pick<IThreadStore, 'get'>;
    uploadDir?: string;
  },
): void {
  app.post(
    '/api/callbacks/publish-file',
    { bodyLimit: MAX_AGENT_FILE_BASE64_LENGTH + 4096 },
    async (request, reply) => {
      const actor = requireCallbackAuth(request, reply);
      if (!actor) return;
      if (!deps.messageStore) return reply.code(503).send({ error: 'Durable attachment publisher unavailable' });
      const decoded = decodePublication(request.body);
      if ('error' in decoded) return reply.code(400).send({ error: decoded.error });
      const { input, bytes } = decoded;
      const guard = await getDeletedCallbackThreadGuard(deps.threadStore, actor.threadId);
      if (guard) return reply.code(guard.statusCode).send(guard.body);
      if (!(await deps.registry.isLatest(actor.invocationId)))
        return reply.code(409).send({ error: 'Stale invocation' });

      // No server-local path, actor or target thread is accepted from the caller.
      // Include the authenticated invocation in the key: retries are idempotent,
      // while another principal cannot attach to this invocation's publication.
      const publicationId = digest(JSON.stringify([actor.invocationId, input.fileName, input.mimeType, input.sha256]));
      const saved = await saveFileBufferToUploadDir({
        buffer: bytes,
        mimeType: input.mimeType,
        originalFilename: input.fileName,
        uploadDir: getDefaultUploadDir(deps.uploadDir ?? process.env.UPLOAD_DIR),
        filenameStem: `agent-${publicationId}`,
      });
      const stored = await readFile(saved.absPath);
      if (stored.length !== bytes.length || digest(stored) !== input.sha256) {
        return reply.code(409).send({ error: 'Stored attachment does not match this publication' });
      }
      // Saved bytes follow the existing upload retention policy (no TTL). A later
      // rejection may leave an unreferenced file. Do not unlink here: an identical
      // concurrent retry can already have attached this same deterministic path.
      // Cleanup requires operator-authorized, reference-aware storage maintenance.
      const afterSave = await getDeletedCallbackThreadGuard(deps.threadStore, actor.threadId);
      if (afterSave) return reply.code(afterSave.statusCode).send(afterSave.body);
      if (!(await deps.registry.isLatest(actor.invocationId)))
        return reply.code(409).send({ error: 'Stale invocation' });

      const block: RichBlock = {
        id: `file-${publicationId}`,
        kind: 'file',
        v: 1,
        url: saved.urlPath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: stored.length,
      };
      // Publication is durable before acknowledgement. It must survive buffer
      // expiry, a long invocation, and a lost HTTP or websocket acknowledgement.
      const { message } = await deps.messageStore.appendIdempotent({
        userId: actor.userId,
        catId: actor.catId,
        threadId: actor.threadId,
        origin: 'callback',
        content: input.fileName,
        mentions: [],
        timestamp: Date.now(),
        idempotencyKey: `agent-file:${publicationId}`,
        extra: {
          isExplicitPost: true,
          stream: stampVisibleTurn(actor.parentInvocationId ?? actor.invocationId, actor.invocationId),
          rich: { v: 1, blocks: [block] },
        },
      });
      if (message.deletedAt || message._tombstone)
        return reply.code(409).send({ error: 'Attachment message was removed' });
      deps.socketManager.broadcastToRoom([`thread:${actor.threadId}`, `user:${actor.userId}`], 'connector_message', {
        threadId: actor.threadId,
        message: {
          id: message.id,
          type: 'cat',
          catId: actor.catId,
          origin: 'callback',
          content: message.content,
          timestamp: message.timestamp,
          extra: message.extra,
        },
      });
      return {
        status: 'ok',
        url: saved.urlPath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: stored.length,
        sha256: input.sha256,
        blockId: block.id,
        messageId: message.id,
      };
    },
  );
}
