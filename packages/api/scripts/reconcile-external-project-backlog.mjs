#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const FEATURE_ID_PATTERN = /^(?:F\d{3}|EXT-\d{3})$/;

function requiredFlag(argv, name) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1]?.trim() : '';
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function parseFeatureIds(value, label) {
  const ids = [
    ...new Set(
      value
        .split(',')
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0 || ids.some((id) => !FEATURE_ID_PATTERN.test(id))) {
    throw new Error(`${label} must be a comma-separated list of F### or EXT-### IDs`);
  }
  return ids;
}

export function parseReconcileArguments(argv) {
  const apiUrl = requiredFlag(argv, '--api-url').replace(/\/$/, '');
  const userId = requiredFlag(argv, '--user-id');
  const projectId = requiredFlag(argv, '--project-id');
  const retireFeatureIds = parseFeatureIds(requiredFlag(argv, '--retire'), '--retire');
  const expectedActiveFeatureIds = parseFeatureIds(requiredFlag(argv, '--expect-active'), '--expect-active');
  if (!/^https?:\/\//.test(apiUrl)) throw new Error('--api-url must use http or https');
  return { apiUrl, userId, projectId, retireFeatureIds, expectedActiveFeatureIds };
}

function featureIdOf(item) {
  const tag = item.tags?.find((candidate) => /^feature:/i.test(candidate));
  return tag?.slice('feature:'.length).toUpperCase() ?? null;
}

async function requestJson(options, path, init = {}) {
  const response = await options.fetchImpl(`${options.apiUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'x-cat-cafe-user': options.userId,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${body?.error ?? text}`);
  }
  return body;
}

async function listItems(options) {
  const result = await requestJson(options, `/api/backlog/items?projectId=${encodeURIComponent(options.projectId)}`);
  if (!Array.isArray(result?.items)) throw new Error('Backlog list returned an invalid response');
  return result.items;
}

/**
 * One-shot, idempotent post-deploy reconciliation. Import refreshes active source
 * metadata; permanent removals still require an explicit feature allowlist.
 */
export async function reconcileExternalProjectBacklog(input) {
  const options = { ...input, fetchImpl: input.fetchImpl ?? fetch };
  const imported = await requestJson(
    options,
    `/api/external-projects/${encodeURIComponent(options.projectId)}/import-backlog`,
    {
      method: 'POST',
    },
  );

  let items = await listItems(options);
  const removed = [];
  for (const featureId of options.retireFeatureIds) {
    const matches = items.filter((item) => featureIdOf(item) === featureId);
    if (matches.length > 1) throw new Error(`Refusing to delete duplicate ${featureId} backlog records`);
    const item = matches[0];
    if (!item) continue;
    await requestJson(
      options,
      `/api/external-projects/${encodeURIComponent(options.projectId)}/backlog/items/${encodeURIComponent(item.id)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          expectedFeatureId: featureId,
          expectedUpdatedAt: item.updatedAt,
          reason: `Explicit post-deploy retirement reconciliation for ${featureId}`,
        }),
      },
    );
    removed.push(featureId);
    items = await listItems(options);
  }

  const finalFeatureIds = items.map(featureIdOf).filter(Boolean).sort();
  const expectedFeatureIds = [...options.expectedActiveFeatureIds].sort();
  if (finalFeatureIds.join(',') !== expectedFeatureIds.join(',')) {
    throw new Error(
      `Final feature set mismatch: expected ${expectedFeatureIds.join(',')}, got ${finalFeatureIds.join(',') || '(empty)'}`,
    );
  }
  for (const featureId of options.retireFeatureIds) {
    if (finalFeatureIds.includes(featureId)) throw new Error(`${featureId} remains after reconciliation`);
  }

  return {
    imported,
    removed,
    finalItems: items.map((item) => ({
      id: item.id,
      featureId: featureIdOf(item),
      title: item.title,
      priority: item.priority,
      status: item.status,
    })),
  };
}

async function main() {
  const result = await reconcileExternalProjectBacklog(parseReconcileArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
