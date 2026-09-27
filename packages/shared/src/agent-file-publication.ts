/** Document formats admitted by the agent attachment publisher; active web content is excluded. */
export const AGENT_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
};
export const MAX_AGENT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_AGENT_FILE_BASE64_LENGTH = 4 * Math.ceil(MAX_AGENT_FILE_BYTES / 3);

export function agentFileMime(fileName: string): string | undefined {
  const extension = /\.[a-z0-9]+$/i.exec(fileName)?.[0].toLowerCase();
  return extension && Object.hasOwn(AGENT_FILE_MIME_BY_EXTENSION, extension)
    ? AGENT_FILE_MIME_BY_EXTENSION[extension]
    : undefined;
}
