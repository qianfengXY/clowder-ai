import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-client';

export type AgentHookHealthStatus = 'configured' | 'missing' | 'stale' | 'unsupported' | 'error';

export interface AgentHookDiffSummary {
  kind: 'text' | 'json';
  message: string;
  line?: number;
  fields?: string[];
}

export interface AgentHookTargetHealth {
  name: string;
  drifted: boolean;
  status: AgentHookHealthStatus;
  targetPath: string;
  reason: string;
  diff?: AgentHookDiffSummary;
}

export interface AgentHookStatusResponse {
  status: AgentHookHealthStatus;
  targets: AgentHookTargetHealth[];
  syncAllowed?: boolean;
  message?: string;
}

interface UseAgentHookHealthOptions {
  enabled?: boolean;
  /** When set, skill/MCP health targets the given project instead of the API server's cwd. */
  projectPath?: string;
}

interface UseAgentHookHealthResult {
  health: AgentHookStatusResponse | null;
  loading: boolean;
  syncing: boolean;
  synced: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
}

let cachedHealth: AgentHookStatusResponse | null = null;
let cachedProjectPath: string | undefined;
let hasCachedHealth = false;
let requestGeneration = 0;
let inFlightStatus: {
  projectPath: string | undefined;
  generation: number;
  promise: Promise<AgentHookStatusResponse>;
} | null = null;

function isAgentHookStatusResponse(value: unknown): value is AgentHookStatusResponse {
  const response = value as { status?: unknown; targets?: unknown; syncAllowed?: unknown; message?: unknown } | null;
  return (
    !!response &&
    typeof response === 'object' &&
    typeof response.status === 'string' &&
    Array.isArray(response.targets) &&
    (response.syncAllowed === undefined || typeof response.syncAllowed === 'boolean') &&
    (response.message === undefined || typeof response.message === 'string')
  );
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  } catch {
    return fallback;
  }
  return fallback;
}

async function clientErrorHealth(response: Response): Promise<AgentHookStatusResponse | null> {
  if (response.status !== 400 && response.status !== 403) return null;

  const serverMessage = await readApiErrorMessage(response, `agent hook status failed (${response.status})`);
  return {
    status: response.status === 403 ? 'unsupported' : 'error',
    targets: [],
    syncAllowed: false,
    message:
      response.status === 403
        ? '为保护本机 Agent 配置，环境检测和一键同步仅支持通过 localhost Hub 操作。'
        : serverMessage,
  };
}

function clearCachedHealth() {
  cachedHealth = null;
  cachedProjectPath = undefined;
  hasCachedHealth = false;
}

function cacheHealthIfCurrent(generation: number, projectPath: string | undefined, status: AgentHookStatusResponse) {
  if (generation !== requestGeneration) return;
  cachedHealth = status;
  cachedProjectPath = projectPath;
  hasCachedHealth = true;
}

async function readAgentHookStatus(projectPath?: string, force = false): Promise<AgentHookStatusResponse> {
  if (!force && hasCachedHealth && cachedHealth && cachedProjectPath === projectPath) return cachedHealth;
  if (!force && inFlightStatus && inFlightStatus.projectPath === projectPath) return inFlightStatus.promise;
  if (force) clearCachedHealth();

  const url = projectPath
    ? `/api/agent-hooks/status?projectPath=${encodeURIComponent(projectPath)}`
    : '/api/agent-hooks/status';

  const generation = ++requestGeneration;
  const promise = apiFetch(url)
    .then(async (res) => {
      if (!res.ok) {
        const blockedHealth = await clientErrorHealth(res);
        if (blockedHealth) return blockedHealth;
        throw new Error(await readApiErrorMessage(res, `agent hook status failed (${res.status})`));
      }
      const status = await res.json();
      if (!isAgentHookStatusResponse(status)) throw new Error('agent hook status response is invalid');
      return status;
    })
    .then((status) => {
      cacheHealthIfCurrent(generation, projectPath, status);
      return status;
    })
    .finally(() => {
      if (inFlightStatus?.generation === generation) inFlightStatus = null;
    });

  inFlightStatus = { projectPath, generation, promise };
  return promise;
}

async function postAgentHookSync(projectPath?: string): Promise<AgentHookStatusResponse> {
  clearCachedHealth();
  const generation = ++requestGeneration;
  inFlightStatus = null;
  const res = await apiFetch('/api/agent-hooks/sync', {
    method: 'POST',
    headers: projectPath ? { 'Content-Type': 'application/json' } : undefined,
    body: projectPath ? JSON.stringify({ projectPath }) : undefined,
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `agent hook sync failed (${res.status})`));
  const status = await res.json();
  if (!isAgentHookStatusResponse(status)) throw new Error('agent hook sync response is invalid');
  cacheHealthIfCurrent(generation, projectPath, status);
  return status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Agent Hook 检测失败';
}

export function resetAgentHookHealthCacheForTests() {
  clearCachedHealth();
  requestGeneration += 1;
  inFlightStatus = null;
}

export function useAgentHookHealth({
  enabled = true,
  projectPath,
}: UseAgentHookHealthOptions = {}): UseAgentHookHealthResult {
  const [health, setHealth] = useState<AgentHookStatusResponse | null>(() =>
    hasCachedHealth && cachedProjectPath === projectPath ? cachedHealth : null,
  );
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationGeneration = useRef(0);

  const applyStatus = useCallback(async (generation: number, readStatus: () => Promise<AgentHookStatusResponse>) => {
    try {
      const status = await readStatus();
      if (operationGeneration.current !== generation) return null;
      setHealth(status);
      return status;
    } catch (err) {
      if (operationGeneration.current === generation) setError(errorMessage(err));
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++operationGeneration.current;
    setLoading(true);
    setSyncing(false);
    setSynced(false);
    setError(null);
    await applyStatus(generation, () => readAgentHookStatus(projectPath, true));
    if (operationGeneration.current === generation) {
      setLoading(false);
    }
  }, [applyStatus, projectPath]);

  const sync = useCallback(async () => {
    const generation = ++operationGeneration.current;
    setLoading(false);
    setSyncing(true);
    setSynced(false);
    setError(null);
    const status = await applyStatus(generation, () => postAgentHookSync(projectPath));
    if (operationGeneration.current === generation) {
      setSynced(status?.status === 'configured');
      setSyncing(false);
    }
  }, [applyStatus, projectPath]);

  useEffect(() => {
    const generation = ++operationGeneration.current;
    const cancelPendingOperation = () => {
      operationGeneration.current += 1;
    };
    setSynced(false);
    if (!enabled) return cancelPendingOperation;

    if (hasCachedHealth && cachedProjectPath === projectPath) {
      setHealth(cachedHealth);
      setLoading(false);
      return cancelPendingOperation;
    }

    setLoading(true);
    setSyncing(false);
    setError(null);
    setHealth(null);
    readAgentHookStatus(projectPath)
      .then(
        (status) => {
          if (operationGeneration.current === generation) setHealth(status);
        },
        (err) => {
          if (operationGeneration.current === generation) setError(errorMessage(err));
        },
      )
      .finally(() => {
        if (operationGeneration.current === generation) setLoading(false);
      });

    return cancelPendingOperation;
  }, [enabled, projectPath]);

  return { health, loading, syncing, synced, error, refresh, sync };
}
