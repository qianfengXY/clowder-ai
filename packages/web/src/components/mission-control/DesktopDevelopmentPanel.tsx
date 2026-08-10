'use client';

import type { DesktopDevelopmentResumePacket, ExternalProject, ProjectReviewHubView } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { apiFetch } from '@/utils/api-client';
import { buildDesktopAcceptanceRequest } from './desktop-development-form';

export function DesktopDevelopmentPanel({ project }: { project: ExternalProject }) {
  const router = useRouter();
  const setCurrentThread = useChatStore((state) => state.setCurrentThread);
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setThreads = useChatStore((state) => state.setThreads);
  const { projects, setProjects } = useExternalProjectStore();
  const [busy, setBusy] = useState(false);
  const [acceptingWorkId, setAcceptingWorkId] = useState<string | null>(null);
  const [works, setWorks] = useState<readonly DesktopDevelopmentResumePacket[]>([]);
  const [worksLoading, setWorksLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const binding = project.desktopDevelopment;

  const loadWorks = useCallback(async () => {
    if (!project.desktopDevelopment) {
      setWorks([]);
      return;
    }
    setWorksLoading(true);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works?protocolVersion=${project.desktopDevelopment.protocolVersion}`,
      );
      const body = (await response.json()) as { works?: DesktopDevelopmentResumePacket[]; error?: string };
      if (!response.ok || !body.works) throw new Error(body.error ?? '无法读取开发轮次');
      setWorks(body.works);
    } catch (error) {
      setWorks([]);
      setStatus(error instanceof Error ? error.message : '无法读取开发轮次');
    } finally {
      setWorksLoading(false);
    }
  }, [project.desktopDevelopment, project.id]);

  useEffect(() => {
    setStatus(null);
    void loadWorks();
  }, [loadWorks]);

  const openReviewHub = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const reviewHub = await ensureReviewHub(project.id);
      const refreshedThreads = await readCurrentThreads();
      if (refreshedThreads) setThreads(refreshedThreads);
      setCurrentProject(project.sourcePath);
      setCurrentThread(reviewHub.threadId);
      setStatus(reviewHub.status === 'restored' ? '已恢复原 Review Hub' : '已打开项目 Review Hub');
      router.push(`/thread/${encodeURIComponent(reviewHub.threadId)}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法打开 Review Hub');
    } finally {
      setBusy(false);
    }
  };

  const enableAutomaticMerge = async () => {
    if (!binding) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await apiFetch(`/api/external-projects/${project.id}/development-loop`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: binding.version, mergeMode: 'automatic' }),
      });
      const body = (await response.json()) as { project?: ExternalProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? '无法启用自动合入');
      setProjects(projects.map((item) => (item.id === body.project?.id ? body.project : item)));
      setStatus('此项目已启用自动合入；最终验收仍需你确认');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法启用自动合入');
    } finally {
      setBusy(false);
    }
  };

  const recordAcceptance = async (work: DesktopDevelopmentResumePacket, accepted: boolean) => {
    setAcceptingWorkId(work.workId);
    setStatus(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works/${work.workId}/acceptance`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildDesktopAcceptanceRequest(work, accepted)),
        },
      );
      const body = (await response.json()) as DesktopDevelopmentResumePacket & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? '无法记录最终验收');
      setWorks((current) => current.map((item) => (item.workId === body.workId ? body : item)));
      setStatus(
        accepted ? '最终验收已通过；本轮交付已闭环' : '最终验收未通过；证据已保留，请回到方案会话开启新交付轮次',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法记录最终验收');
    } finally {
      setAcceptingWorkId(null);
    }
  };

  if (!binding) {
    return (
      <section className="rounded-xl bg-[var(--console-card-bg)] p-5">
        <h3 className="text-sm font-semibold text-cafe">ChatGPT Desktop 开发闭环</h3>
        <p className="mt-2 text-xs leading-relaxed text-cafe-secondary">
          此项目尚未绑定开发闭环。重新导入或通过项目配置绑定 GitHub 仓库后，才会创建唯一 Review Hub。
        </p>
      </section>
    );
  }

  const pilotCount = binding.successfulManualPilotCount;
  return (
    <section className="space-y-4 rounded-xl bg-[var(--console-card-bg)] p-5">
      <div>
        <h3 className="text-sm font-semibold text-cafe">ChatGPT Desktop 开发闭环</h3>
        <p className="mt-1 text-xs text-cafe-secondary">一个项目只保留一个 Review Hub，所有实现轮次都在其中闭环。</p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Info label="Cat Café 项目 ID" value={project.id} />
        <Info label="GitHub 仓库" value={binding.repository.fullName} />
        <Info label="默认分支" value={binding.defaultBranch} />
        <Info label="合入方式" value={binding.mergeMode === 'automatic' ? '自动合入' : 'ChatGPT 会话中人工确认'} />
        <Info label="人工试点" value={`${pilotCount}/2 次成功`} />
        <Info
          label="Push / PR"
          value={`${binding.allowPush ? '允许' : '禁止'} / ${binding.allowPullRequest ? '允许' : '禁止'}`}
        />
        <Info label="协议" value={`v${binding.protocolVersion} · policy ${binding.version}`} />
      </dl>

      <div>
        <div className="text-xs font-medium text-cafe-secondary">默认 Review 猫猫</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {binding.defaultReviewers.map((reviewer) => (
            <span key={reviewer} className="rounded-full bg-[var(--console-hover-bg)] px-3 py-1 text-xs text-cafe">
              {reviewer}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-cafe-secondary">开发与验收轮次</div>
          <button
            type="button"
            onClick={() => void loadWorks()}
            disabled={worksLoading}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-micro font-medium text-cafe-secondary disabled:opacity-40"
          >
            {worksLoading ? '刷新中...' : '刷新状态'}
          </button>
        </div>
        {!worksLoading && works.length === 0 && (
          <p className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-3 text-xs text-cafe-secondary">
            尚无已连接的 ChatGPT Desktop 工作。Desktop 可用上方项目 ID，或仅用 GitHub 仓库地址识别此项目。
          </p>
        )}
        {works.map((work) => (
          <article key={work.workId} className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-cafe">{work.branch}</div>
                <div className="mt-1 text-micro text-cafe-secondary">
                  {work.workId} · {work.currentSha.slice(0, 12)} · {describeWorkState(work)}
                </div>
              </div>
              {work.sessionStatus === 'detached' && (
                <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-1 text-micro text-cafe-secondary">
                  等待新 ChatGPT 会话重新绑定
                </span>
              )}
            </div>
            {work.openFindings.length > 0 && (
              <p className="mt-2 text-xs text-cafe-secondary">待修复 findings：{work.openFindings.length}</p>
            )}
            {work.acceptancePending && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void recordAcceptance(work, true)}
                  disabled={acceptingWorkId === work.workId}
                  className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
                >
                  验收通过
                </button>
                <button
                  type="button"
                  onClick={() => void recordAcceptance(work, false)}
                  disabled={acceptingWorkId === work.workId}
                  className="rounded-lg bg-[var(--console-hover-bg)] px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-40"
                >
                  验收未通过
                </button>
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void openReviewHub()}
          disabled={busy}
          className="rounded-lg bg-[var(--mc-accent)] px-4 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
        >
          {busy ? '处理中...' : '打开 Review Hub'}
        </button>
        {pilotCount >= 2 && binding.mergeMode === 'manual_confirm_in_chatgpt' && (
          <button
            type="button"
            onClick={() => void enableAutomaticMerge()}
            disabled={busy}
            className="rounded-lg bg-[var(--console-shell-bg)] px-4 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-40"
          >
            为此项目启用自动合入
          </button>
        )}
      </div>
      {status && <p className="text-xs text-cafe-secondary">{status}</p>}
    </section>
  );
}

async function ensureReviewHub(projectId: string): Promise<ProjectReviewHubView> {
  const response = await apiFetch(`/api/external-projects/${projectId}/development-loop/review-hub`, {
    method: 'POST',
  });
  const body = (await response.json()) as { reviewHub?: ProjectReviewHubView; error?: string };
  if (!response.ok || !body.reviewHub) throw new Error(body.error ?? '无法打开 Review Hub');
  return body.reviewHub;
}

async function readCurrentThreads(): Promise<Thread[] | null> {
  const response = await apiFetch('/api/threads');
  if (!response.ok) return null;
  const body = (await response.json()) as { threads?: Thread[] };
  return body.threads ?? null;
}

function describeWorkState(work: DesktopDevelopmentResumePacket): string {
  switch (work.phase) {
    case 'accepted':
      return '已验收';
    case 'rejected':
      return '验收未通过';
    case 'acceptance_pending':
      return '等待最终验收';
    case 'approved_for_merge':
      return 'Review 已通过';
    case 'awaiting_manual_merge_confirmation':
      return '等待合入确认';
    case 'auto_merge_ready':
      return '可以合入';
    case 'fix_required':
      return '等待修复';
    case 'cross_review':
      return work.reviewPhase === 'consensus_ready' ? '等待共识' : '交叉检视中';
    case 'independent_review':
      return '独立检视中';
    case 'ready_for_desktop':
      return '等待 Desktop 恢复';
    case 'implementation_ready':
      return '等待提交 Review';
    case 'implementing':
      return '实现中';
  }
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-2">
      <dt className="text-micro text-cafe-secondary">{label}</dt>
      <dd className="mt-1 break-words text-xs font-medium text-cafe">{value}</dd>
    </div>
  );
}
