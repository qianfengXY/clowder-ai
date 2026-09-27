/** Connection names and MCP metadata are not native connector identity. */
export class UnverifiedComputerUseConsentError extends Error {
  constructor() {
    super('Computer Use consent unavailable: native connector provenance has not been verified');
  }
}

/**
 * Workspace capabilities can register the name cua_repl, including duplicates.
 * Until the provider exposes a verified per-invocation connector identity, no
 * such request may acquire native approval semantics or fall back to a generic
 * accept form. Do not add a name/metadata allowlist or a caller-supplied flag.
 */
export function rejectUnverifiedComputerUseConsent(params: Record<string, unknown>): void {
  const meta = params._meta;
  const record = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  if (
    params.serverName === 'cua_repl' ||
    Object.hasOwn(record, 'codex_approval_kind') ||
    ('connector_id' in record && record.connector_id === 'computer-use') ||
    Object.hasOwn(record, 'persist')
  ) {
    throw new UnverifiedComputerUseConsentError();
  }
}
