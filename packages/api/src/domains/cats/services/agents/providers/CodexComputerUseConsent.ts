import type { RuntimeInteractionDecision, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { z } from 'zod';

const nonBlank = z.string().trim().min(1);
const metadataSchema = z
  .object({
    codex_approval_kind: z.literal('mcp_tool_call'),
    connector_id: z.literal('computer-use'),
    connector_name: z.literal('Computer Use'),
    persist: z
      .array(z.enum(['session', 'always']))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length),
    riskLevel: z.enum(['low', 'medium', 'high']),
    subtitle: nonBlank.optional(),
    tool_call_id: nonBlank,
    tool_name: nonBlank,
    tool_params: z.object({ app: nonBlank }).strict(),
    tool_params_display: z
      .array(z.object({ name: nonBlank, display_name: nonBlank, value: nonBlank }).strict())
      .optional(),
    codex_request_type: z.literal('approval_request').optional(),
  })
  .strict();

/** Classify only the installed native app-consent protocol; never turn it into a generic accept form. */
export function computerUseConsent(params: Record<string, unknown>) {
  const raw = params._meta;
  if (raw == null) return null;
  const record = z.record(z.string(), z.unknown()).parse(raw);
  if (
    !Object.hasOwn(record, 'codex_approval_kind') &&
    record.connector_id !== 'computer-use' &&
    !Object.hasOwn(record, 'persist')
  )
    return null;
  const meta = metadataSchema.parse(record);
  if (params.serverName !== 'cua_repl' || params.mode !== 'form') throw new Error('unsupported app consent source');
  const schema = z
    .object({
      type: z.literal('object'),
      properties: z.object({}).strict(),
      required: z.array(z.never()).optional(),
      additionalProperties: z.literal(false).optional(),
      $schema: z.string().optional(),
    })
    .strict()
    .parse(params.requestedSchema);
  const decisions: RuntimeInteractionDecision[] = meta.persist.map((persist) => ({
    id: `accept:${persist}`,
    label: persist === 'session' ? '本次会话允许' : '始终允许此应用',
    outcome: 'accept',
  }));
  decisions.push(
    { id: 'decline', label: '拒绝', outcome: 'decline' },
    { id: 'cancel', label: '取消', outcome: 'cancel' },
  );
  return {
    title: 'Computer Use 应用授权',
    description: [`应用：${meta.tool_params.app}`, `操作：${meta.tool_name}`, `风险：${meta.riskLevel}`, meta.subtitle]
      .filter(Boolean)
      .join('\n'),
    requestedSchema: { ...schema, additionalProperties: false as const },
    decisions,
    toolCallId: meta.tool_call_id,
    toProviderResponse(response: RuntimeInteractionResponse): Record<string, unknown> {
      if (response.kind !== 'decision' || !decisions.some((d) => d.id === response.decisionId)) {
        throw new Error('unsupported app consent decision');
      }
      if (response.decisionId === 'decline' || response.decisionId === 'cancel') {
        if (response.content !== undefined) throw new Error('rejected consent must not contain content');
        return { action: response.decisionId };
      }
      if (!response.content || Object.keys(response.content).length !== 0) throw new Error('invalid consent content');
      // Persistence is owned by the upstream grant authority. The host only
      // returns the current user's exact choice; it never caches/replays grants.
      return { action: 'accept', content: {}, _meta: { persist: response.decisionId.slice('accept:'.length) } };
    },
  };
}
