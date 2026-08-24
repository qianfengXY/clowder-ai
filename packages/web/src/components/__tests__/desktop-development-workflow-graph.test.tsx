import type {
  DesktopDevelopmentResumePacket,
  DesktopDevelopmentWorkflowNode,
  DesktopDevelopmentWorkflowNodeId,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopDevelopmentWorkflowGraph } from '../mission-control/DesktopDevelopmentWorkflowGraph';

const SHA = 'a'.repeat(40);

function workflowNode(
  id: DesktopDevelopmentWorkflowNodeId,
  status: DesktopDevelopmentWorkflowNode['status'],
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
    manualAction: status === 'active' && id === 'implementation' ? 'wake_desktop' : null,
  };
}

function packet(overrides: Partial<DesktopDevelopmentResumePacket> = {}): DesktopDevelopmentResumePacket {
  return {
    protocolVersion: 1,
    projectId: 'project-traqen',
    repository: { host: 'github.com', owner: 'owner', name: 'traqen', fullName: 'owner/traqen' },
    defaultBranch: 'main',
    designBranch: 'design/shared-specs',
    designExactSha: SHA,
    designDocuments: ['docs/design/f006.md'],
    reviewDesignExactSha: null,
    reviewDesignDocuments: [],
    workId: 'work-f006',
    attemptId: 'attempt-f006-1',
    attemptNumber: 1,
    deliveryCycleNumber: 1,
    deliveryCycleEntryMode: 'design_change',
    phase: 'implementing',
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
    reviewRoundId: null,
    reviewPhase: null,
    reviewRoundVersion: null,
    reviewCurrentForWork: false,
    openFindings: [],
    reviewAttemptLimit: 15,
    reviewContinuationApprovedThroughAttempt: 15,
    reviewContinuationPending: false,
    architectureDecisionPending: false,
    nextLegalActions: ['implement_and_report_committed_sha'],
    workflowNodes: [
      workflowNode('design', 'completed'),
      workflowNode('implementation', 'active'),
      workflowNode('independent_review', 'pending'),
      workflowNode('cross_review', 'pending'),
      workflowNode('consensus', 'pending'),
      workflowNode('handoff', 'pending'),
      workflowNode('merge', 'pending'),
      workflowNode('acceptance', 'pending'),
    ],
    ...overrides,
  };
}

describe('DesktopDevelopmentWorkflowGraph', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
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

  it('shows both entries, the implementation/Review loop, and the active server node', () => {
    act(() =>
      root.render(
        <DesktopDevelopmentWorkflowGraph
          work={packet()}
          retrying={false}
          onRetry={() => {}}
          defaultCollapsed={false}
        />,
      ),
    );

    expect(container.textContent).toContain('本轮入口：方案新增 / 变更');
    expect(container.textContent).toContain('方案新增 / 方案变更');
    expect(container.textContent).toContain('验收未通过 / 返工');
    expect(container.textContent).toContain('仍有检视意见：回到 ChatGPT 修复，再次进入 Review');
    expect(container.querySelector('[data-testid="workflow-swimlane-graph"]')).not.toBeNull();
    expect(container.textContent).toContain('ChatGPT 持球');
    expect(container.textContent).toContain('多猫检视');
    expect(container.textContent).toContain('协调与门控');
    expect(
      container.querySelector('[data-testid="workflow-graph-node-implementation"]')?.getAttribute('data-status'),
    ).toBe('active');
    expect(
      container.querySelector('[data-testid="workflow-graph-node-design-entry"]')?.getAttribute('data-status'),
    ).toBe('completed');
    expect(container.querySelector('[data-testid="workflow-swimlane-graph"]')?.tagName).toBe('SECTION');
    expect(
      container
        .querySelector('[data-testid="workflow-graph-node-implementation"]')
        ?.querySelector('[data-testid="workflow-active-pulse"]'),
    ).not.toBeNull();
  });

  it('uses measured return rails and keeps inactive route text readable', () => {
    act(() =>
      root.render(
        <DesktopDevelopmentWorkflowGraph
          work={packet()}
          retrying={false}
          onRetry={() => {}}
          defaultCollapsed={false}
        />,
      ),
    );

    const rails = container.querySelector('[data-testid="workflow-return-rails"]');
    expect(rails?.getAttribute('preserveAspectRatio')).toBeNull();
    expect(rails?.getAttribute('viewBox')).toBeNull();
    expect(rails?.querySelector('marker')?.getAttribute('markerUnits')).toBe('userSpaceOnUse');
    const inactiveRoute = Array.from(container.querySelectorAll('li[data-active="false"]')).find((item) =>
      item.textContent?.includes('仍有检视意见'),
    );
    expect(inactiveRoute?.className).not.toContain('opacity-');
    const transitionLabel = Array.from(container.querySelectorAll('span')).find((item) =>
      item.textContent?.includes('提交精确 commit'),
    );
    expect(transitionLabel?.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('previews a node on focus and opens a persistent detail dialog on click', () => {
    act(() =>
      root.render(
        <DesktopDevelopmentWorkflowGraph
          work={packet()}
          retrying={false}
          onRetry={() => {}}
          defaultCollapsed={false}
        />,
      ),
    );

    const implementation = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-graph-node-implementation"]',
    );
    act(() => implementation?.focus());
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('负责人：ChatGPT Desktop');

    act(() => implementation?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const inspector = container.querySelector('[data-testid="workflow-node-inspector"]');
    expect(inspector?.getAttribute('role')).toBe('dialog');
    expect(inspector?.textContent).toContain('实现 #1 · 绑定代次 1');
    expect(inspector?.textContent).toContain('实现并报告精确提交');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[data-testid="workflow-node-inspector"]')).toBeNull();
    expect(document.activeElement).toBe(implementation);
  });

  it('shows Review findings and opens the bound feature Review thread', () => {
    const openReview = vi.fn();
    act(() =>
      root.render(
        <DesktopDevelopmentWorkflowGraph
          work={packet({
            reviewRoundId: 'review-round-1',
            reviewPhase: 'consensus_ready',
            openFindings: [
              {
                findingId: 'finding-1',
                severity: 'P2',
                summary: '移动端流程过长',
                evidenceRefs: ['git:test'],
                designRefs: ['git:design'],
                scope: 'plan_conformance',
                architectureDecisionRecorded: false,
                status: 'open',
              },
            ],
          })}
          retrying={false}
          onRetry={() => {}}
          onOpenReview={openReview}
          defaultCollapsed={false}
        />,
      ),
    );

    const stages = container.querySelector('[data-testid="workflow-review-stages"]');
    expect(stages?.className).toContain('overflow-x-auto');
    expect(stages?.getAttribute('aria-label')).toBe('Review 三阶段，可横向滚动');
    const consensus = container.querySelector<HTMLButtonElement>('[data-testid="workflow-graph-node-consensus"]');
    expect(consensus?.className).toContain('shrink-0');
    expect(consensus?.className).toContain('w-[148px]');
    act(() => consensus?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-testid="workflow-node-inspector"]')?.textContent).toContain('移动端流程过长');
    const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('打开 Review 会话'),
    );
    act(() => openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(openReview).toHaveBeenCalledTimes(1);
  });

  it('starts collapsed by default with the current-stage summary, and expands on demand', () => {
    act(() => root.render(<DesktopDevelopmentWorkflowGraph work={packet()} retrying={false} onRetry={() => {}} />));

    expect(container.querySelector('[data-testid="workflow-graph-body"]')).toBeNull();
    expect(container.textContent).toContain('当前停在：ChatGPT 实现 / 修复 · 等待ChatGPT Desktop');
    const expandButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('展开流程'),
    );
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');

    act(() => expandButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('[data-testid="workflow-graph-body"]')).not.toBeNull();
    expect(container.textContent).toContain('收起流程');

    const collapseButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('收起流程'),
    );
    act(() => collapseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('[data-testid="workflow-graph-body"]')).toBeNull();
    expect(container.textContent).toContain('展开流程');
  });

  it('marks rejection rework as the selected entry and highlights the clearing gate', () => {
    const nodes = packet().workflowNodes.map((node) =>
      node.id === 'handoff'
        ? {
            ...node,
            status: 'active' as const,
            actor: 'chatgpt_desktop' as const,
            manualAction: 'wake_desktop' as const,
          }
        : { ...node, status: node.id === 'implementation' ? ('completed' as const) : node.status },
    );
    act(() =>
      root.render(
        <DesktopDevelopmentWorkflowGraph
          defaultCollapsed={false}
          work={packet({
            deliveryCycleNumber: 2,
            deliveryCycleEntryMode: 'acceptance_rework',
            phase: 'fix_required',
            openFindings: [
              {
                findingId: 'finding-1',
                severity: 'P1',
                summary: '真实用户旅程未通过',
                evidenceRefs: [],
                designRefs: [],
                scope: 'plan_conformance',
                architectureDecisionRecorded: false,
                status: 'open',
              },
            ],
            workflowNodes: nodes,
          })}
          retrying={false}
          onRetry={() => {}}
        />,
      ),
    );

    expect(container.textContent).toContain('本轮入口：验收未通过返工');
    expect(
      container
        .querySelector('[data-testid="workflow-graph-node-acceptance-rework-entry"]')
        ?.getAttribute('data-status'),
    ).toBe('completed');
    expect(
      container.querySelector('[data-testid="workflow-graph-node-review-gate"]')?.getAttribute('data-status'),
    ).toBe('active');
    expect(container.textContent).toContain('1 项意见待修复');
  });

  it('activates the accepted end node after final acceptance', () => {
    act(() =>
      root.render(
        <DesktopDevelopmentWorkflowGraph
          work={packet({ phase: 'accepted', workLifecycle: 'accepted' })}
          retrying={false}
          onRetry={() => {}}
          defaultCollapsed={false}
        />,
      ),
    );

    expect(container.textContent).toContain('当前停在：验收通过 · 本轮结束');
    expect(
      container.querySelector('[data-testid="workflow-graph-node-accepted-end"]')?.getAttribute('data-status'),
    ).toBe('active');
  });
});
