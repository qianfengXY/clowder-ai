import type { DesktopDevelopmentResumePacket, DesktopDevelopmentWorkflowNode } from '@cat-cafe/shared';

/** EXT-001 泳道图（时间轴版）共享类型与纯函数 — 从 DesktopDevelopmentWorkflowGraph 拆出（350 行限制） */

export type GraphStatus = DesktopDevelopmentWorkflowNode['status'] | 'inactive';

export type WorkflowInspectionId =
  | 'design-entry'
  | 'acceptance-rework-entry'
  | 'implementation'
  | 'independent_review'
  | 'cross_review'
  | 'consensus'
  | 'handoff'
  | 'merge'
  | 'acceptance'
  | 'accepted-end';

export interface WorkflowInspectionSelection {
  readonly id: WorkflowInspectionId;
  readonly title: string;
  readonly owner: string;
  readonly status: GraphStatus;
}

export interface WorkflowHoverState {
  readonly selection: WorkflowInspectionSelection;
  readonly top: number;
}

export type ActorTone = 'desktop' | 'review' | 'catcafe' | 'user';

export function aggregateStatus(nodes: readonly (DesktopDevelopmentWorkflowNode | undefined)[]): GraphStatus {
  if (nodes.some((node) => node?.status === 'blocked')) return 'blocked';
  if (nodes.some((node) => node?.status === 'active')) return 'active';
  if (nodes.length > 0 && nodes.every((node) => node?.status === 'completed')) return 'completed';
  return 'pending';
}

export function handoffDetail(work: DesktopDevelopmentResumePacket): string {
  if (work.architectureDecisionPending) return '方案分歧，等待你的决策';
  if (work.reviewContinuationPending) return `达到 ${work.reviewAttemptLimit} 次上限，等待批准`;
  if (work.phase === 'fix_required') return `${work.openFindings.length} 项意见待修复`;
  if (work.phase === 'approved_for_merge' || work.merged || work.acceptancePending) return '检视意见已清零';
  return '判断返工或进入合入';
}

export function workflowNodeForInspection(
  work: DesktopDevelopmentResumePacket,
  id: WorkflowInspectionId,
): DesktopDevelopmentWorkflowNode | undefined {
  const nodeId =
    id === 'design-entry' ? 'design' : id === 'acceptance-rework-entry' || id === 'accepted-end' ? null : id;
  return nodeId ? work.workflowNodes.find((node) => node.id === nodeId) : undefined;
}

export function inspectionShaLine(work: DesktopDevelopmentResumePacket, id: WorkflowInspectionId): string {
  if (id === 'design-entry') {
    return `方案 ${work.designBranch ?? '未配置'}@${shortSha(work.designExactSha)}`;
  }
  if (isReviewInspection(id) && work.reviewDesignExactSha) {
    return `实现 ${shortSha(work.currentSha)} · 方案 ${shortSha(work.reviewDesignExactSha)}`;
  }
  return `实现 ${work.branch}@${shortSha(work.currentSha)}`;
}

export function inspectionDetailLine(work: DesktopDevelopmentResumePacket, id: WorkflowInspectionId): string {
  switch (id) {
    case 'design-entry':
      return work.designDocuments.length > 0 ? `${work.designDocuments.length} 份中文设计文档` : '尚未选择设计文档';
    case 'acceptance-rework-entry':
      return `交付 #${work.deliveryCycleNumber} · 验收返工入口`;
    case 'implementation':
      return `实现 #${work.attemptNumber} · 绑定代次 ${work.bindingEpoch} · ${work.sessionStatus}`;
    case 'independent_review':
    case 'cross_review':
    case 'consensus':
      return `Review ${work.reviewPhase ?? '未开始'} · 开放意见 ${work.openFindings.length}`;
    case 'handoff':
      return `${handoffDetail(work)} · 开放意见 ${work.openFindings.length}`;
    case 'merge':
      return work.merged ? '已经合入 main' : `合入方式：${mergeModeLabel(work.mergeMode)}`;
    case 'acceptance':
      return work.acceptancePending ? '等待你的最终体验验收' : '尚未进入最终验收';
    case 'accepted-end':
      return work.phase === 'accepted' ? '本交付轮次已经结束' : '验收通过后结束本交付轮次';
  }
}

export function isReviewInspection(id: WorkflowInspectionId): boolean {
  return id === 'independent_review' || id === 'cross_review' || id === 'consensus' || id === 'handoff';
}

export function formatWorkflowTime(value: number | null | undefined): string {
  if (!value) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

export function mergeModeLabel(mode: DesktopDevelopmentResumePacket['mergeMode']): string {
  return mode === 'manual_confirm_in_chatgpt' ? 'ChatGPT 窗口人工确认' : '自动合入';
}

export function findingScopeLabel(scope: DesktopDevelopmentResumePacket['openFindings'][number]['scope']): string {
  return scope === 'architecture_decision' ? '架构决策' : '方案符合性';
}

export function legalActionLabel(action: string): string {
  switch (action) {
    case 'configure_design_branch':
      return '配置方案分支';
    case 'rebind_session':
      return '重新绑定 Desktop 窗口';
    case 'rebuild_worktree_from_last_committed_sha':
      return '从最后提交恢复工作区';
    case 'commit_changes_before_report':
      return '先提交当前改动';
    case 'implement_and_report_committed_sha':
      return '实现并报告精确提交';
    case 'report_new_committed_sha':
      return '报告新的精确提交';
    case 'fix_open_findings':
      return '修复开放检视意见';
    case 'wait_for_independent_review':
      return '等待独立检视';
    case 'wait_for_cross_review':
      return '等待交叉检视';
    case 'wait_for_review_evidence':
      return '等待检视证据';
    case 'wait_for_consensus':
      return '等待形成共识';
    case 'authorize_review_consensus':
      return '授权提交最终共识';
    case 'wait_for_authorized_consensus':
      return '等待已授权共识';
    case 'start_fix_attempt':
      return '开启下一次修复';
    case 'request_user_architecture_decision':
      return '请求你的架构决策';
    case 'request_review_continuation_approval':
      return '请求继续 Review';
    case 'request_merge_confirmation':
      return '请求合入确认';
    case 'merge_with_native_git':
      return '使用原生 Git 合入';
    case 'wait_for_final_acceptance':
      return '等待最终体验验收';
    default:
      return action;
  }
}

export function entryModeLabel(mode: DesktopDevelopmentResumePacket['deliveryCycleEntryMode']): string {
  return mode === 'acceptance_rework' ? '验收未通过返工' : '方案新增 / 变更';
}

export function workflowNodeLabel(id: DesktopDevelopmentWorkflowNode['id']): string {
  switch (id) {
    case 'design':
      return '方案分支';
    case 'implementation':
      return 'ChatGPT 实现 / 修复';
    case 'independent_review':
      return '独立检视';
    case 'cross_review':
      return '交叉检视';
    case 'consensus':
      return '共识整理';
    case 'handoff':
      return '检视结果 / 清零门';
    case 'merge':
      return '合入 main';
    case 'acceptance':
      return '最终验收';
  }
}

export function workflowActorLabel(actor: DesktopDevelopmentWorkflowNode['actor']): string {
  switch (actor) {
    case 'chatgpt_desktop':
      return 'ChatGPT Desktop';
    case 'reviewers':
      return 'Review 猫猫';
    case 'review_recorder':
      return '共识记录猫猫';
    case 'catcafe':
      return 'CatCafe 协调器';
    case 'user':
      return '你';
  }
}

export function workflowActionLabel(action: NonNullable<DesktopDevelopmentWorkflowNode['manualAction']>): string {
  switch (action) {
    case 'configure_design_branch':
      return '请到功能列表配置方案分支';
    case 'wake_desktop':
      return '再次触发 ChatGPT';
    case 'replay_review_stage':
      return '再次触发本阶段 Review';
    case 'record_architecture_decision':
      return '请在下方处理方案分歧';
    case 'approve_review_continuation':
      return '请在下方批准继续 Review';
    case 'record_acceptance':
      return '请在下方完成最终验收';
  }
}

export function graphStatusLabel(status: GraphStatus): string {
  switch (status) {
    case 'pending':
      return '未到达';
    case 'inactive':
      return '本轮未选';
    case 'active':
      return '当前';
    case 'blocked':
      return '等待处理';
    case 'completed':
      return '已经过';
  }
}

export function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : '等待 commit';
}

export function statusDotClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'bg-[var(--mc-accent)] ring-2 ring-[var(--console-card-bg)]';
    case 'blocked':
      return 'bg-[var(--semantic-warning)]';
    case 'completed':
      return 'bg-[var(--semantic-success)]';
    case 'pending':
      return 'bg-[var(--console-border-strong)]';
    case 'inactive':
      return 'bg-[var(--console-border-soft)]';
  }
}

export function actorDotClass(tone: ActorTone): string {
  switch (tone) {
    case 'desktop':
      return 'bg-[var(--semantic-info)]';
    case 'review':
      return 'bg-[var(--mc-slice-hardening)]';
    case 'catcafe':
      return 'bg-[var(--semantic-warning)]';
    case 'user':
      return 'bg-[var(--semantic-success)]';
  }
}
