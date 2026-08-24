import type { BacklogItem } from '@cat-cafe/shared';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IWorkflowSopStore } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { type BacklogFeatureRow, buildBacklogInputFromFeature, getFeatureTagId } from './backlog-doc-import.js';

type WorkflowSopMigrationStore = Pick<IWorkflowSopStore, 'get' | 'upsert'>;

export interface LegacyExtensionMigrationResult {
  readonly items: readonly BacklogItem[];
  readonly migratedItemIds: readonly string[];
}

/**
 * Rename only legacy records whose ID and exact imported title both identify an
 * extension catalog entry. This deliberately does not install a global F289
 * alias: upstream now owns F289 for Canonical Data Root.
 */
export async function migrateLegacyExtensionItems(input: {
  readonly items: readonly BacklogItem[];
  readonly extensionRows: readonly BacklogFeatureRow[];
  readonly backlogStore: IBacklogStore;
  readonly workflowSopStore?: WorkflowSopMigrationStore;
  readonly userId: string;
}): Promise<LegacyExtensionMigrationResult> {
  const rowsByLegacyId = indexExtensionRowsByLegacyId(input.extensionRows);
  if (rowsByLegacyId.size === 0) return { items: input.items, migratedItemIds: [] };

  const items = [...input.items];
  const migratedItemIds: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const legacyId = getFeatureTagId(item.tags);
    if (!legacyId) continue;
    const extension = rowsByLegacyId.get(legacyId);
    if (!extension || !hasExactLegacyImportedTitle(item, legacyId, extension.name)) continue;

    const refreshed = await migrateLegacyExtensionItem({ ...input, item, legacyId, extension });
    items[index] = refreshed;
    migratedItemIds.push(refreshed.id);
  }

  return { items, migratedItemIds };
}

function indexExtensionRowsByLegacyId(rows: readonly BacklogFeatureRow[]): Map<string, BacklogFeatureRow> {
  const indexed = new Map<string, BacklogFeatureRow>();
  for (const row of rows) {
    if (row.kind !== 'extension') continue;
    for (const legacyId of row.legacyIds ?? []) indexed.set(legacyId.toLowerCase(), row);
  }
  return indexed;
}

async function migrateLegacyExtensionItem(input: {
  readonly item: BacklogItem;
  readonly legacyId: string;
  readonly extension: BacklogFeatureRow;
  readonly backlogStore: IBacklogStore;
  readonly workflowSopStore?: WorkflowSopMigrationStore;
  readonly userId: string;
}): Promise<BacklogItem> {
  // Migrate the SOP label first. If the backlog write then flakes, a retry
  // still sees the legacy tag and can safely finish the idempotent migration.
  const sop = await input.workflowSopStore?.get(input.item.id);
  if (sop?.featureId.toLowerCase() === input.legacyId) {
    await input.workflowSopStore?.upsert(
      input.item.id,
      input.extension.id,
      { expectedVersion: sop.version },
      input.userId,
      input.userId,
    );
  }

  const canonicalInput = buildBacklogInputFromFeature(input.extension, input.item.userId, input.item.dependencies);
  const refreshed = await input.backlogStore.refreshMetadata(input.item.id, {
    title: canonicalInput.title,
    summary: canonicalInput.summary,
    priority: canonicalInput.priority,
    tags: canonicalInput.tags,
    ...(input.item.dependencies ? { dependencies: input.item.dependencies } : {}),
    refreshedBy: input.userId,
  });
  if (!refreshed) throw new Error(`Legacy extension backlog item disappeared during migration: ${input.item.id}`);
  return refreshed;
}

function hasExactLegacyImportedTitle(item: BacklogItem, legacyId: string, extensionName: string): boolean {
  return item.title.trim().toLowerCase() === `[${legacyId}] ${extensionName}`.toLowerCase();
}
