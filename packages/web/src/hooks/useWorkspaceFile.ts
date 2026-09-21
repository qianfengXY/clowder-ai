'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, apiFetch } from '@/utils/api-client';
import { CHAT_SOCKET_TRANSPORTS } from '@/utils/socket-polling-transport';
import type { FileData } from './useWorkspace';

/** One mounted file owner, scoped to its descriptor rather than ambient navigation. */
export function useWorkspaceFile(worktreeId: string, path: string, openRequest: object) {
  const [file, setFile] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingExternalSha, setPendingExternalSha] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const fileRef = useRef<FileData | null>(null);
  const dirtyRef = useRef(false);
  const editRevision = useRef(0);
  const requestSeq = useRef(0);

  const acceptFile = useCallback((nextFile: FileData, replaceDraft: boolean, revision: number) => {
    if (dirtyRef.current && (!replaceDraft || revision !== editRevision.current)) {
      setPendingExternalSha(nextFile.sha256 === fileRef.current?.sha256 ? null : nextFile.sha256);
      return false;
    }
    setPendingExternalSha(null);
    fileRef.current = nextFile;
    setFile(nextFile);
    return true;
  }, []);

  const readFile = useCallback(
    async (replaceDraft = false) => {
      const seq = ++requestSeq.current;
      const revision = editRevision.current;
      try {
        const params = new URLSearchParams({ worktreeId, path });
        // An invalidation can arrive during a GET. Joining that same generation
        // would consume the event while displaying the pre-change response.
        const response = await apiFetch(
          `/api/workspace/file?${params}`,
          { cache: 'no-store' },
          { afterCurrentGet: true },
        );
        if (!response.ok) throw new Error(`File read failed: ${response.status}`);
        const nextFile = (await response.json()) as FileData;
        if (seq !== requestSeq.current) return false;
        setError(null);
        return acceptFile(nextFile, replaceDraft, revision);
      } catch {
        if (seq === requestSeq.current) setError('暂时无法读取最新文件内容，请重新打开文件重试');
        return false;
      }
    },
    [acceptFile, path, worktreeId],
  );

  const refresh = useCallback(() => readFile(), [readFile]);
  // A new descriptor is an explicit open/refresh even when its path is unchanged.
  useEffect(() => {
    void openRequest;
    void refresh();
    return () => {
      // Invalidate the latest request generation; this ref is a counter, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      requestSeq.current++;
    };
  }, [openRequest, refresh]);

  useEffect(() => {
    const socket = io(API_URL, { transports: CHAT_SOCKET_TRANSPORTS, tryAllTransports: true, forceNew: true });
    socket.on('connect', () => {
      socket.emit('workspace:watch-file', { worktreeId, path, sha256: fileRef.current?.sha256 ?? null });
      // Resubscription also checks the sha server-side. Re-read here to cover
      // recovery independently of notification delivery (including half-open tabs).
      void refresh();
    });
    socket.on('workspace:file-changed', (data: { worktreeId: string; path: string; sha256: string }) => {
      if (data.worktreeId !== worktreeId || data.path !== path || data.sha256 === fileRef.current?.sha256) return;
      if (dirtyRef.current) setPendingExternalSha(data.sha256);
      else void refresh();
    });
    const recover = () => {
      if (!socket.connected) socket.connect();
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recover();
    };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      socket.emit('workspace:unwatch-file');
      socket.disconnect();
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [path, refresh, worktreeId]);

  const setEditDirty = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty;
      if (dirty) editRevision.current++;
      else if (pendingExternalSha) void refresh();
    },
    [pendingExternalSha, refresh],
  );
  const applyExternalChange = useCallback(async () => {
    // Explicit discard must reset the editor even if disk reverted to the old
    // base content. Failed/stale reads must leave the current draft mounted.
    if (await readFile(true)) setReloadVersion((version) => version + 1);
  }, [readFile]);
  const dismissExternalChange = useCallback(() => setPendingExternalSha(null), []);
  // useFileEditing calls this only after a successful save, with the same owner path.
  const fetchFile = useCallback(async () => {
    await readFile(true);
  }, [readFile]);

  return {
    file,
    reloadVersion,
    error,
    refresh,
    fetchFile,
    setEditDirty,
    pendingExternalSha,
    applyExternalChange,
    dismissExternalChange,
  };
}
