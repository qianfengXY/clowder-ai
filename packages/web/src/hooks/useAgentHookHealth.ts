import { useCallback, useEffect, useState } from 'react';
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
let inFlightProjectPath: string | undefined;
let inFlightStatus: Promise<AgentHookStatusResponse> | null = null;

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

async function readAgentHookStatus(projectPath?: string): Promise<AgentHookStatusResponse> {
  if (hasCachedHealth && cachedHealth && cachedProjectPath === projectPath) return cachedHealth;
  if (inFlightStatus && inFlightProjectPath === projectPath) return inFlightStatus;

  const url = projectPath
    ? `/api/agent-hooks/status?projectPath=${encodeURIComponent(projectPath)}`
    : '/api/agent-hooks/status';

  inFlightProjectPath = projectPath;
  inFlightStatus = apiFetch(url)
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
      cachedHealth = status;
      cachedProjectPath = projectPath;
      hasCachedHealth = true;
      return status;
    })
    .finally(() => {
      inFlightStatus = null;
    });

  return inFlightStatus;
}

async function postAgentHookSync(projectPath?: string): Promise<AgentHookStatusResponse> {
  const res = await apiFetch('/api/agent-hooks/sync', {
    method: 'POST',
    headers: projectPath ? { 'Content-Type': 'application/json' } : undefined,
    body: projectPath ? JSON.stringify({ projectPath }) : undefined,
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `agent hook sync failed (${res.status})`));
  const status = await res.json();
  if (!isAgentHookStatusResponse(status)) throw new Error('agent hook sync response is invalid');
  cachedHealth = status;
  cachedProjectPath = projectPath;
  hasCachedHealth = true;
  return status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Agent Hook 检测失败';
}

export function resetAgentHookHealthCacheForTests() {
  cachedHealth = null;
  hasCachedHealth = false;
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

  const applyStatus = useCallback(async (readStatus: () => Promise<AgentHookStatusResponse>) => {
    try {
      const status = await readStatus();
      setHealth(status);
      return status;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    cachedHealth = null;
    hasCachedHealth = false;
    await applyStatus(() => readAgentHookStatus(projectPath));
    setLoading(false);
  }, [applyStatus, projectPath]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSynced(false);
    setError(null);
    const status = await applyStatus(() => postAgentHookSync(projectPath));
    setSynced(status?.status === 'configured');
    setSyncing(false);
  }, [applyStatus, projectPath]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    if (hasCachedHealth && cachedProjectPath === projectPath) {
      setHealth(cachedHealth);
      return;
    }

    setLoading(true);
    setError(null);
    setHealth(null);
    readAgentHookStatus(projectPath)
      .then(
        (status) => {
          if (!cancelled) setHealth(status);
        },
        (err) => {
          if (!cancelled) setError(errorMessage(err));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath]);

  return { health, loading, syncing, synced, error, refresh, sync };
}
