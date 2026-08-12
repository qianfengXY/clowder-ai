import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';

export type ReviewRoundDispatchStage = 'independent' | 'cross_review' | 'consensus';

export interface ReviewRoundDispatchInput {
  readonly stage: ReviewRoundDispatchStage;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly reviewHubThreadId: string;
  readonly roundId: string;
  readonly exactSha: string;
  readonly reviewerCatIds: readonly CatId[];
  readonly recorderCatId: CatId;
}

export interface IReviewRoundStageDispatcher {
  dispatch(input: ReviewRoundDispatchInput): Promise<void>;
}

interface MessageIngressRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: {
    readonly content: string;
    readonly threadId: string;
    readonly idempotencyKey: string;
    readonly messageDisposition: 'next_work';
  };
}

interface MessageIngressResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface ReviewRoundStageDispatcherDeps {
  readonly sendMessage: (request: MessageIngressRequest) => Promise<MessageIngressResponse>;
  readonly resolveMentionHandle: (catId: string) => string | null;
}

/**
 * Sends server-authored review work through the same canonical message ingress
 * used by a human-authored Review Hub turn. Invocation records, callback
 * credentials, queueing, and per-cat execution remain owned by that pipeline.
 */
export class ReviewRoundStageDispatcher implements IReviewRoundStageDispatcher {
  constructor(private readonly deps: ReviewRoundStageDispatcherDeps) {}

  async dispatch(input: ReviewRoundDispatchInput): Promise<void> {
    const targetCatIds = input.stage === 'consensus' ? [input.recorderCatId] : input.reviewerCatIds;
    const handles = targetCatIds.map((catId) => {
      const handle = this.deps.resolveMentionHandle(catId);
      if (!handle) throw new Error(`Review dispatcher has no mention handle for reviewer ${catId}`);
      return handle;
    });
    const response = await this.deps.sendMessage({
      headers: { 'x-cat-cafe-user': input.ownerUserId },
      payload: {
        content: buildStageMessage(input, handles),
        threadId: input.reviewHubThreadId,
        idempotencyKey: deterministicMessageId(input.roundId, input.stage),
        messageDisposition: 'next_work',
      },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Review dispatcher message ingress failed (${response.statusCode}): ${response.body}`);
    }
  }
}

function buildStageMessage(input: ReviewRoundDispatchInput, handles: readonly string[]): string {
  const routing = handles.join('\n');
  const identity = `Project: ${input.projectId}\nReviewRound: ${input.roundId}\nExact SHA: ${input.exactSha}`;
  if (input.stage === 'independent') {
    return `${routing}\nF289 automatic review — independent stage.\n${identity}\nIndependently inspect this exact SHA. Do not read or infer another reviewer's draft before the barrier opens. Submit your private draft with cat_cafe_review_draft_submit, then fence it with cat_cafe_review_independent_finish. Do not publish an Issue, merge, push, or deploy.`;
  }
  if (input.stage === 'cross_review') {
    return `${routing}\nF289 automatic review — cross-review stage; the independent barrier is open.\n${identity}\nRead all barrier-safe drafts with cat_cafe_review_barrier_drafts_read, corroborate or challenge the findings against this exact SHA, then call cat_cafe_review_cross_finish. Do not publish an Issue, merge, push, or deploy.`;
  }
  return `${routing}\nF289 automatic review — consensus stage.\n${identity}\nYou are the server-designated recorder. Read the barrier-safe round and drafts, consolidate one exact-SHA verdict, and publish it with cat_cafe_review_consensus_publish. Do not publish an Issue, merge, push, or deploy.`;
}

function deterministicMessageId(roundId: string, stage: ReviewRoundDispatchStage): string {
  const hex = createHash('sha256')
    .update(`f289-review-dispatch:${roundId}:${stage}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4] ?? '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
