import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { BacklogFeatureRow } from './backlog-doc-import.js';

export const EXTENSION_FEATURE_ID_PATTERN = /^EXT-\d{3}$/;
export const DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH = 'docs/extensions/catalog.json';

export interface ExtensionFeatureEntry {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly owner: string;
  readonly specPath: string;
  readonly designPath?: string;
  readonly planPath?: string;
  readonly legacyIds: readonly string[];
}

interface ExtensionFeatureCatalogDocument {
  readonly schemaVersion: 1;
  readonly extensions: readonly ExtensionFeatureEntry[];
}

export function findExtensionCatalogRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export async function readExtensionFeatureCatalog(catalogPath?: string): Promise<ExtensionFeatureEntry[]> {
  const resolvedPath = catalogPath ?? join(findExtensionCatalogRoot(), DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH);
  if (!existsSync(resolvedPath)) return [];

  const raw = await readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.extensions)) {
    throw new Error('Extension feature catalog must contain schemaVersion=1 and an extensions array');
  }

  const seen = new Set<string>();
  return parsed.extensions.map((value, index) => {
    const entry = parseExtensionEntry(value, index);
    if (seen.has(entry.id)) throw new Error(`Duplicate extension feature ID: ${entry.id}`);
    seen.add(entry.id);
    return entry;
  });
}

export function extensionEntriesToBacklogRows(entries: readonly ExtensionFeatureEntry[]): BacklogFeatureRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    status: entry.status,
    owner: entry.owner,
    link: entry.specPath,
    kind: 'extension',
    legacyIds: entry.legacyIds,
  }));
}

export async function readExtensionFeatureRows(catalogPath?: string): Promise<BacklogFeatureRow[]> {
  return extensionEntriesToBacklogRows(await readExtensionFeatureCatalog(catalogPath));
}

export async function readExtensionFeatureDocContent(featureId: string): Promise<string | null> {
  const root = findExtensionCatalogRoot();
  const entries = await readExtensionFeatureCatalog(join(root, DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH));
  const entry = entries.find((candidate) => candidate.id === featureId.trim().toUpperCase());
  if (!entry) return null;
  try {
    return await readFile(resolveCatalogDocumentPath(root, entry.specPath), 'utf8');
  } catch {
    return null;
  }
}

function parseExtensionEntry(value: unknown, index: number): ExtensionFeatureEntry {
  if (!isRecord(value)) throw new Error(`Invalid extension feature entry at index ${index}`);
  const id = requiredString(value.id, `extensions[${index}].id`).toUpperCase();
  if (!EXTENSION_FEATURE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid extension feature ID at extensions[${index}].id: ${id}`);
  }
  const specPath = validateDocumentPath(requiredString(value.specPath, `extensions[${index}].specPath`));
  const legacyIds = Array.isArray(value.legacyIds)
    ? value.legacyIds.map((legacyId, legacyIndex) => {
        const normalized = requiredString(legacyId, `extensions[${index}].legacyIds[${legacyIndex}]`).toUpperCase();
        if (!/^F\d{3}$/.test(normalized)) {
          throw new Error(`Invalid legacy feature ID: ${normalized}`);
        }
        return normalized;
      })
    : [];

  const designPath = optionalDocumentPath(value.designPath, `extensions[${index}].designPath`);
  const planPath = optionalDocumentPath(value.planPath, `extensions[${index}].planPath`);
  return {
    id,
    name: requiredString(value.name, `extensions[${index}].name`),
    status: requiredString(value.status, `extensions[${index}].status`),
    owner: requiredString(value.owner, `extensions[${index}].owner`),
    specPath,
    ...(designPath ? { designPath } : {}),
    ...(planPath ? { planPath } : {}),
    legacyIds: [...new Set(legacyIds)],
  };
}

function optionalDocumentPath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return validateDocumentPath(requiredString(value, label));
}

function validateDocumentPath(value: string): string {
  const normalizedPath = normalize(value);
  if (
    isAbsolute(value) ||
    normalizedPath === '..' ||
    normalizedPath.startsWith(`..${sep}`) ||
    !normalizedPath.startsWith(`docs${sep}`) ||
    !normalizedPath.endsWith('.md')
  ) {
    throw new Error(`Extension document path must be a repository-relative docs/*.md path: ${value}`);
  }
  return value.replaceAll('\\', '/');
}

function resolveCatalogDocumentPath(root: string, relativePath: string): string {
  const resolved = resolve(root, relativePath);
  const docsRoot = `${resolve(root, 'docs')}${sep}`;
  if (!resolved.startsWith(docsRoot)) throw new Error(`Extension document path escapes docs/: ${relativePath}`);
  return resolved;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export type { ExtensionFeatureCatalogDocument };
