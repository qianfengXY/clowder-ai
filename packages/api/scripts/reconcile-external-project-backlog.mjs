#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const FEATURE_ID_PATTERN = /^(?:F\d{3}|EXT-\d{3})$/;

function requiredFlag(argv, name) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1]?.trim() : '';
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function optionalFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = argv[index + 1]?.trim() ?? '';
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseFeatureIds(value, label, options = {}) {
  if (options.allowNone && value.trim().toLowerCase() === 'none') return [];
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
  const expectedActiveFeatureIds = parseFeatureIds(requiredFlag(argv, '--expect-active'), '--expect-active', {
    allowNone: true,
  });
  const confirmedLegacyValue = optionalFlag(argv, '--confirm-legacy-retire');
  const operatorConfirmedLegacyFeatureIds = confirmedLegacyValue
    ? parseFeatureIds(confirmedLegacyValue, '--confirm-legacy-retire')
    : [];
  const confirmedAdoptionValue = optionalFlag(argv, '--confirm-legacy-adopt');
  const operatorConfirmedLegacyAdoptionFeatureIds = confirmedAdoptionValue
    ? parseFeatureIds(confirmedAdoptionValue, '--confirm-legacy-adopt')
    : [];
  if (operatorConfirmedLegacyFeatureIds.some((featureId) => !retireFeatureIds.includes(featureId))) {
    throw new Error('--confirm-legacy-retire must be a subset of --retire');
  }
  if (operatorConfirmedLegacyAdoptionFeatureIds.some((featureId) => !expectedActiveFeatureIds.includes(featureId))) {
    throw new Error('--confirm-legacy-adopt must be a subset of --expect-active');
  }
  if (!/^https?:\/\//.test(apiUrl)) throw new Error('--api-url must use http or https');
  return {
    apiUrl,
    userId,
    projectId,
    retireFeatureIds,
    expectedActiveFeatureIds,
    operatorConfirmedLegacyFeatureIds,
    operatorConfirmedLegacyAdoptionFeatureIds,
  };
}

function featureIdOf(item) {
  const tag = item.tags?.find((candidate) => /^feature:/i.test(candidate));
  return tag?.slice('feature:'.length).toUpperCase() ?? null;
}

function isManagedImportItem(item, projectId, featureId) {
  return (
    item.importOrigin?.kind === 'external-project-catalog' &&
    item.importOrigin.projectId === projectId &&
    item.importOrigin.featureId === featureId &&
    (item.importOrigin.source === 'docs-backlog' || item.importOrigin.source === 'extension-catalog')
  );
}

function revisionOf(item) {
  if (!Number.isSafeInteger(item.revision) || item.revision < 1) {
    throw new Error(`Backlog item ${item.id} has no server-owned mutation revision`);
  }
  return item.revision;
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

function buildRetirementRequest(options, items, featureId, confirmedLegacyIds) {
  const matches = items.filter((item) => featureIdOf(item) === featureId);
  if (matches.length > 1) throw new Error(`Refusing to delete duplicate ${featureId} backlog records`);
  const item = matches[0];
  if (!item) return null;

  const importerManaged = isManagedImportItem(item, options.projectId, featureId);
  const operatorConfirmedLegacy = confirmedLegacyIds.has(featureId);
  if (!importerManaged && !operatorConfirmedLegacy) {
    throw new Error(`Refusing to delete ${featureId}: matching backlog item has no immutable importer provenance`);
  }
  return {
    item,
    payload: {
      expectedFeatureId: featureId,
      expectedUpdatedAt: item.updatedAt,
      expectedRevision: revisionOf(item),
      reason: `Explicit post-deploy retirement reconciliation for ${featureId}`,
      mode: importerManaged ? 'import-reconciliation' : 'operator-confirmed',
      ...(!importerManaged && operatorConfirmedLegacy
        ? { confirmation: `PERMANENTLY DELETE ${featureId} ${item.id}` }
        : {}),
    },
  };
}

async function adoptLegacyImportOrigins(options, items) {
  const adopted = [];
  for (const featureId of options.operatorConfirmedLegacyAdoptionFeatureIds ?? []) {
    const matches = items.filter((item) => featureIdOf(item) === featureId);
    if (matches.length > 1) throw new Error(`Refusing to adopt duplicate ${featureId} backlog records`);
    const item = matches[0];
    if (!item) continue;
    if (isManagedImportItem(item, options.projectId, featureId)) continue;
    if (item.importOrigin) {
      throw new Error(`Refusing to adopt ${featureId}: backlog item already has different immutable provenance`);
    }
    const result = await requestJson(
      options,
      `/api/external-projects/${encodeURIComponent(options.projectId)}/backlog/items/${encodeURIComponent(item.id)}/adopt-import-origin`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedFeatureId: featureId,
          expectedUpdatedAt: item.updatedAt,
          expectedRevision: revisionOf(item),
          reason: `Explicit post-deploy legacy import adoption for ${featureId}`,
          confirmation: `ADOPT LEGACY IMPORT ${featureId} ${item.id}`,
        }),
      },
    );
    const adoptedItem = result?.item;
    if (!adoptedItem || !isManagedImportItem(adoptedItem, options.projectId, featureId)) {
      throw new Error(`Legacy adoption for ${featureId} returned invalid importer provenance`);
    }
    adopted.push(featureId);
    items = items.map((candidate) => (candidate.id === adoptedItem.id ? adoptedItem : candidate));
  }
  return adopted;
}

/**
 * One-shot, idempotent post-deploy reconciliation. Import refreshes active source
 * metadata; permanent removals still require an explicit feature allowlist.
 */
export async function reconcileExternalProjectBacklog(input) {
  const options = { ...input, fetchImpl: input.fetchImpl ?? fetch };
  const confirmedLegacyIds = new Set(options.operatorConfirmedLegacyFeatureIds ?? []);
  const initialItems = await listItems(options);
  const adopted = await adoptLegacyImportOrigins(options, initialItems);
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
    const retirement = buildRetirementRequest(options, items, featureId, confirmedLegacyIds);
    if (!retirement) continue;
    await requestJson(
      options,
      `/api/external-projects/${encodeURIComponent(options.projectId)}/backlog/items/${encodeURIComponent(retirement.item.id)}`,
      {
        method: 'DELETE',
        body: JSON.stringify(retirement.payload),
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
    adopted,
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
