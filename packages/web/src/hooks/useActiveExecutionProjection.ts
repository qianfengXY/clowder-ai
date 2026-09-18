'use client';

import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { startSerialPolling } from '@/utils/serial-polling';

const ACTIVE_EXECUTION_REFRESH_MS = 10_000;

function activeExecutionResource(projectPath: string): string {
  return `/api/executions/active?projectPath=${encodeURIComponent(projectPath)}`;
}

export async function refreshActiveExecutionProjection(
  anchorThreadId: string,
  projectPath: string,
  signal?: AbortSignal,
  afterCurrentGet = false,
): Promise<boolean> {
  const store = useActiveExecutionStore.getState();
  const requestVersion = store.beginHydration(anchorThreadId);
  try {
    const resource = activeExecutionResource(projectPath);
    const response = afterCurrentGet
      ? await apiFetch(resource, { signal }, { afterCurrentGet: true })
      : await apiFetch(resource, { signal });
    if (!response.ok) throw new Error(`Execution hydration failed (${response.status})`);
    const body = (await response.json()) as ActiveExecutionListResponse;
    if (signal?.aborted) return false;
    useActiveExecutionStore.getState().applySnapshot(anchorThreadId, requestVersion, body);
    return true;
  } catch (error) {
    if (signal?.aborted) return false;
    useActiveExecutionStore.getState().failHydration(anchorThreadId, requestVersion, error);
    return false;
  }
}

export async function cancelProjectedExecution(execution: ActiveExecutionProjection): Promise<void> {
  if (execution.cancelability.state !== 'cancelable') {
    throw new Error('This execution is not cancelable');
  }
  const executionStore = useActiveExecutionStore.getState();
  if (!executionStore.beginCancellation(execution)) return;
  const target = execution.cancelability.target;
  try {
    const response =
      target.kind === 'live_invocation'
        ? await apiFetch(
            `/api/threads/${encodeURIComponent(target.threadId)}/executions/live/${encodeURIComponent(target.executionId)}/cancel`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ catId: target.catId }),
            },
          )
        : await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(target.taskId)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 409) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `Cancel failed (${response.status})`);
    }
    useActiveExecutionStore.getState().settleCancellation(execution);
    const { anchorThreadId, projectPath } = useActiveExecutionStore.getState();
    if (anchorThreadId && projectPath)
      await refreshActiveExecutionProjection(anchorThreadId, projectPath, undefined, true);
  } catch (error) {
    useActiveExecutionStore.getState().releaseCancellation(execution);
    throw error;
  }
}

/**
 * Hydrate project-wide execution truth on first mount/navigation/reconnect, then
 * poll narrowly so a background start that emitted no local socket event is
 * still discovered. The store retains the last good snapshot on transient error.
 */
export function useActiveExecutionProjection(anchorThreadId: string, socketConnected: boolean | null): void {
  const pollerRef = useRef<ReturnType<typeof startSerialPolling> | null>(null);
  const canonicalProjectPath = useSidebarProjectionStore(
    (state) => state.rows.find((row) => row.id === anchorThreadId)?.projectPath,
  );
  const compatibilityProjectPath = useChatStore(
    (state) => state.threads.find((thread) => thread.id === anchorThreadId)?.projectPath,
  );
  const projectPath = canonicalProjectPath ?? compatibilityProjectPath;

  useEffect(() => {
    if (!projectPath) return;
    const poller = startSerialPolling(
      (signal) => refreshActiveExecutionProjection(anchorThreadId, projectPath, signal),
      ACTIVE_EXECUTION_REFRESH_MS,
    );
    pollerRef.current = poller;
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [anchorThreadId, projectPath]);

  useEffect(() => {
    if (socketConnected !== true || !projectPath) return;
    pollerRef.current?.refresh();
  }, [projectPath, socketConnected]);
}
