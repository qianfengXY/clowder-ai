import type { TranscriptReader } from '../../cats/services/session/transcript/TranscriptReader.js';
import { resolveSignalPaths } from '../config/sources-loader.js';
import { readArticleDocument } from './article-document.js';
import { readInboxRecords } from './inbox-records.js';
import { StudyMetaService } from './study-meta-service.js';

export interface DiscussionSnippet {
  readonly sessionId: string;
  readonly snippet: string;
  readonly score: number;
}

export interface ActiveSignalArticle {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly tier: number;
  readonly contentSnippet: string;
  readonly note?: string | undefined;
  readonly relatedDiscussions?: readonly DiscussionSnippet[] | undefined;
}

const MAX_ACTIVE_SIGNALS = 3;
const CONTENT_SNIPPET_LENGTH = 1500;
const MAX_DISCUSSION_HITS = 3;

export interface SignalLookupDeps {
  readonly transcriptReader?: TranscriptReader | undefined;
}

/**
 * F091: Creates a lookup function that finds signal articles linked to a thread.
 * Used by route-serial/parallel to inject activeSignals into InvocationContext.
 *
 * AC-10: When transcriptReader is provided, searches session history for
 * related discussions ("先搜后聊" — our own memory architecture, not hindsight).
 */
export function createSignalArticleLookup(
  deps?: SignalLookupDeps,
): (threadId: string) => Promise<readonly ActiveSignalArticle[]> {
  const paths = resolveSignalPaths();
  const studyMeta = new StudyMetaService();

  return async (threadId: string): Promise<readonly ActiveSignalArticle[]> => {
    const allRecords = await readInboxRecords(paths, undefined);
    const matched: ActiveSignalArticle[] = [];

    for (const record of allRecords) {
      if (matched.length >= MAX_ACTIVE_SIGNALS) break;
      const meta = await studyMeta.readMeta(record.id, record.filePath);
      const hasThread = meta.threads.some((t) => t.threadId === threadId && !t.stale);
      if (!hasThread) continue;

      try {
        const detail = await readArticleDocument(record);
        if (!detail) continue;
        const article = detail.article;
        if (article.deletedAt) continue;

        // AC-10: Search session history for related discussions
        let relatedDiscussions: DiscussionSnippet[] | undefined;
        if (deps?.transcriptReader) {
          try {
            const hits = await deps.transcriptReader.search(threadId, article.title, {
              limit: MAX_DISCUSSION_HITS,
              scope: 'digests',
            });
            if (hits.length > 0) {
              relatedDiscussions = hits.map((h) => ({
                sessionId: h.sessionId,
                snippet: h.snippet,
                score: h.score,
              }));
            }
          } catch {
            // Best-effort: memory search failure doesn't block context injection
          }
        }

        matched.push({
          id: article.id,
          title: article.title,
          source: article.source,
          tier: article.tier,
          contentSnippet: detail.content.slice(0, CONTENT_SNIPPET_LENGTH),
          note: article.note,
          ...(relatedDiscussions ? { relatedDiscussions } : {}),
        });
      } catch {
        // Skip unreadable articles
      }
    }

    return matched;
  };
}
