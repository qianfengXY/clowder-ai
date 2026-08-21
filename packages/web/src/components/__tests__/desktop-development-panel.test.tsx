import type {
  CatId,
  DesktopDevelopmentResumePacket,
  DesktopDevelopmentWorkflowNode,
  DesktopDevelopmentWorkflowNodeId,
  ExternalProject,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));

const { DesktopDevelopmentPanel } = await import('../mission-control/DesktopDevelopmentPanel');

const SHA = 'a'.repeat(40);

function workflowNode(
  id: DesktopDevelopmentWorkflowNodeId,
  status: DesktopDevelopmentWorkflowNode['status'],
  manualAction: DesktopDevelopmentWorkflowNode['manualAction'] = null,
): DesktopDevelopmentWorkflowNode {
  const actorByNode: Record<DesktopDevelopmentWorkflowNodeId, DesktopDevelopmentWorkflowNode['actor']> = {
    design: 'user',
    implementation: 'chatgpt_desktop',
    independent_review: 'reviewers',
    cross_review: 'reviewers',
    consensus: 'review_recorder',
    handoff: 'catcafe',
    merge: 'chatgpt_desktop',
    acceptance: 'user',
  };
  return {
    id,
    status,
    actor: actorByNode[id],
    startedAt: null,
    completedAt: status === 'completed' ? 1 : null,
    manualAction,
  };
}

function packet(reviewActive = false): DesktopDevelopmentResumePacket {
  return {
    protocolVersion: 1,
    projectId: 'project-traqen',
    repository: { host: 'github.com', owner: 'owner', name: 'traqen', fullName: 'owner/traqen' },
    defaultBranch: 'main',
    designBranch: 'design/specs',
    designExactSha: SHA,
    designDocuments: ['docs/design/f006.md'],
    reviewDesignExactSha: reviewActive ? SHA : null,
    reviewDesignDocuments: reviewActive ? ['docs/design/f006.md'] : [],
    workId: 'work-f006',
    attemptId: 'attempt-f006-1',
    attemptNumber: 1,
    deliveryCycleNumber: 1,
    deliveryCycleEntryMode: 'design_change',
    phase: reviewActive ? 'independent_review' : 'implementing',
    workLifecycle: 'active',
    managedWorkVersion: 2,
    bindingEpoch: 1,
    chatRef: 'chat-f006',
    sessionStatus: 'active',
    sessionVersion: 1,
    branch: 'feat/f006',
    currentSha: SHA,
    lastCommittedSha: SHA,
    worktreePresent: true,
    mergeMode: 'manual_confirm_in_chatgpt',
    successfulManualPilotCount: 0,
    autoMergeAvailable: false,
    mergeConfirmed: false,
    merged: false,
    acceptancePending: false,
    reviewRoundId: reviewActive ? 'round-f006' : null,
    reviewPhase: reviewActive ? 'independent' : null,
    reviewRoundVersion: reviewActive ? 1 : null,
    reviewCurrentForWork: reviewActive,
    openFindings: [],
    reviewAttemptLimit: 15,
    reviewContinuationApprovedThroughAttempt: 15,
    reviewContinuationPending: false,
    architectureDecisionPending: false,
    nextLegalActions: [reviewActive ? 'wait_for_independent_review' : 'implement_and_report_committed_sha'],
    workflowNodes: [
      workflowNode('design', 'completed'),
      workflowNode('implementation', reviewActive ? 'completed' : 'active', reviewActive ? null : 'wake_desktop'),
      workflowNode(
        'independent_review',
        reviewActive ? 'active' : 'pending',
        reviewActive ? 'replay_review_stage' : null,
      ),
      workflowNode('cross_review', 'pending'),
      workflowNode('consensus', 'pending'),
      workflowNode('handoff', 'pending'),
      workflowNode('merge', 'pending'),
      workflowNode('acceptance', 'pending'),
    ],
  };
}

const project: ExternalProject = {
  id: 'project-traqen',
  userId: 'owner-1',
  name: 'Traqen',
  description: '',
  sourcePath: '/work/Traqen',
  backlogPath: 'docs/ROADMAP.md',
  desktopDevelopment: {
    protocolVersion: 1,
    repository: { host: 'github.com', owner: 'owner', name: 'traqen', fullName: 'owner/traqen' },
    defaultBranch: 'main',
    developmentActor: 'chatgpt-desktop-dev',
    defaultReviewers: ['cat-codex' as CatId, 'cat-kimi' as CatId],
    defaultReviewRecorder: 'cat-codex' as CatId,
    mergeMode: 'manual_confirm_in_chatgpt',
    successfulManualPilotCount: 0,
    successfulManualPilotWorkIds: [],
    allowPush: true,
    allowPullRequest: true,
    requireFinalAcceptance: true,
    version: 1,
  },
  createdAt: 1,
  updatedAt: 1,
};

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('DesktopDevelopmentPanel node feedback', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('refreshes a stale 409 node and reports the result beside the same work graph', async () => {
    let workReads = 0;
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes('/development-loop/works?')) {
        workReads += 1;
        return Promise.resolve(response(200, { works: [packet(workReads > 1)] }));
      }
      if (path.includes('/development-loop/launch-states?')) {
        return Promise.resolve(
          response(200, {
            states: [
              {
                backlogItemId: 'item-f006',
                featureId: 'F006',
                title: '[F006] Test feature',
                status: 'managed_by_catcafe',
                managedWork: {
                  workId: 'work-f006',
                  attemptId: 'attempt-f006-1',
                  attemptNumber: 1,
                  deliveryCycleNumber: 1,
                  deliveryCycleEntryMode: 'design_change',
                  lifecycle: 'active',
                },
                desktopBinding: { chatRef: 'chat-f006', bindingEpoch: 1, status: 'active' },
              },
            ],
          }),
        );
      }
      if (path.endsWith('/retry-current-stage') && init?.method === 'POST') {
        return Promise.resolve(response(409, { error: 'Workflow node trigger conflict' }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => root.render(<DesktopDevelopmentPanel project={project} />));
    await flush();
    const implementation = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-graph-node-implementation"]',
    );
    act(() => implementation?.click());
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="workflow-trigger-node-implementation"]');
    await act(async () => trigger?.click());
    await flush();

    expect(workReads).toBe(2);
    expect(container.querySelector('[data-testid="workflow-node-inspector"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workflow-graph-node-independent_review"]')?.getAttribute('data-status'),
    ).toBe('active');
    const feedback = container.querySelector('[data-testid="workflow-node-feedback-work-f006"]');
    expect(feedback?.textContent).toContain('已刷新到最新流程');
  });
});
