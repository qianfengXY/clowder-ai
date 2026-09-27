import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { agentFileMime, MAX_AGENT_FILE_BASE64_LENGTH, MAX_AGENT_FILE_BYTES, type RichBlock } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { stampVisibleTurn } from '../domains/cats/services/agents/invocation/visible-turn.js';
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
      const buffer = getRichBlockBuffer();
      if (buffer.add(actor.threadId, actor.catId, block, actor.invocationId)) {
        deps.socketManager.broadcastAgentMessage(
          {
            type: 'system_info',
            catId: actor.catId,
            content: JSON.stringify({ type: 'rich_block', block }),
            ...stampVisibleTurn(actor.parentInvocationId ?? actor.invocationId, actor.invocationId),
            timestamp: Date.now(),
          },
          actor.threadId,
        );
      } else if (!buffer.hasBlock(actor.threadId, actor.catId, actor.invocationId, block.id)) {
        return reply.code(409).send({ error: 'Invocation no longer accepts attachments' });
      }
      return {
        status: 'ok',
        url: saved.urlPath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: stored.length,
        sha256: input.sha256,
        blockId: block.id,
      };
    },
  );
}
