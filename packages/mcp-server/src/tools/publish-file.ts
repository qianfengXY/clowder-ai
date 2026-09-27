import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { agentFileMime, MAX_AGENT_FILE_BYTES } from '@cat-cafe/shared';
import { z } from 'zod';

export const publishFileInputSchema = {
  sourcePath: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the existing document the user asked to receive. Regular files only; the final path component must not be a symlink. Parent directory symlinks are followed.',
    ),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe('Optional expected lowercase SHA256; reject a changed file instead of publishing different bytes.'),
};
const inputSchema = z.object(publishFileInputSchema).strict();

export async function prepareFilePublication(input: unknown) {
  const { sourcePath, expectedSha256 } = inputSchema.parse(input);
  if (!isAbsolute(sourcePath)) throw new Error('sourcePath must be absolute');
  const fileName = basename(sourcePath);
  const mimeType = agentFileMime(fileName);
  if (!mimeType)
    throw new Error('Unsupported document extension; use PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, MD or CSV');
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_AGENT_FILE_BYTES) {
      throw new Error('sourcePath must be a non-empty regular file no larger than 50 MiB');
    }
    // Bound reads even if the source grows after stat; never read a pipe/device.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== stat.size)
      throw new Error('File changed while preparing attachment; retry with the intended SHA256');
    const bytes = buffer.subarray(0, length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 && expectedSha256 !== sha256) throw new Error('File SHA256 does not match expectedSha256');
    return { fileName, mimeType, sha256, dataBase64: bytes.toString('base64') };
  } finally {
    await file.close();
  }
}
