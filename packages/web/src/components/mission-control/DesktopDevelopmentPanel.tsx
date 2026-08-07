'use client';

import type { ExternalProject, ProjectReviewHubView } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { apiFetch } from '@/utils/api-client';

export function DesktopDevelopmentPanel({ project }: { project: ExternalProject }) {
  const router = useRouter();
  const setCurrentThread = useChatStore((state) => state.setCurrentThread);
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setThreads = useChatStore((state) => state.setThreads);
  const { projects, setProjects } = useExternalProjectStore();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const binding = project.desktopDevelopment;

  const openReviewHub = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await apiFetch(`/api/external-projects/${project.id}/development-loop/review-hub`, {
        method: 'POST',
      });
      const body = (await response.json()) as { reviewHub?: ProjectReviewHubView; error?: string };
      if (!response.ok || !body.reviewHub) throw new Error(body.error ?? '无法打开 Review Hub');
      const threadsResponse = await apiFetch('/api/threads');
      if (threadsResponse.ok) {
        const threadsBody = (await threadsResponse.json()) as { threads?: Parameters<typeof setThreads>[0] };
        if (threadsBody.threads) setThreads(threadsBody.threads);
      }
      setCurrentProject(project.sourcePath);
      setCurrentThread(body.reviewHub.threadId);
      setStatus(body.reviewHub.status === 'restored' ? '已恢复原 Review Hub' : '已打开项目 Review Hub');
      router.push(`/thread/${encodeURIComponent(body.reviewHub.threadId)}`);
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
        <Info label="GitHub 仓库" value={binding.repository.fullName} />
        <Info label="默认分支" value={binding.defaultBranch} />
        <Info label="合入方式" value={binding.mergeMode === 'automatic' ? '自动合入' : 'ChatGPT 会话中人工确认'} />
        <Info label="人工试点" value={`${pilotCount}/2 次成功`} />
        <Info label="Push / PR" value={`${binding.allowPush ? '允许' : '禁止'} / ${binding.allowPullRequest ? '允许' : '禁止'}`} />
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

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-2">
      <dt className="text-micro text-cafe-secondary">{label}</dt>
      <dd className="mt-1 break-words text-xs font-medium text-cafe">{value}</dd>
    </div>
  );
}
