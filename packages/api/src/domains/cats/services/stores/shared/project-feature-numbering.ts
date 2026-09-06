import type { BacklogItem, CreateBacklogItemInput } from '@cat-cafe/shared';

export class ProjectFeatureNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFeatureNumberError';
  }
}

export interface AssignProjectFeatureIdInput {
  readonly userId: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly featureId: string;
  readonly reservedFeatureIds: readonly string[];
  readonly reason: string;
}

export function featureNumber(featureId: string): number | undefined {
  return /^F\d{3}$/i.test(featureId) ? Number(featureId.slice(1)) : undefined;
}

/** Reserve both representations of legacy records, even if they disagree. */
export function itemFeatureNumbers(item: Pick<BacklogItem, 'title' | 'tags'>): number[] {
  const titleId = /^\[(F\d{3})\]/i.exec(item.title)?.[1];
  return [titleId, ...item.tags.map((tag) => /^feature:(F\d{3})$/i.exec(tag)?.[1])]
    .filter((id): id is string => id !== undefined)
    .map((id) => Number(id.slice(1)));
}

export function requestedFeatureId(item: Pick<BacklogItem, 'title' | 'tags'>): string | undefined {
  const tagged = item.tags.filter((tag) => /^feature:/i.test(tag));
  const numberLabel = /^\[((?:F\d+|EXT-\d+))\]/i.exec(item.title)?.[1];
  if (numberLabel && !/^(?:F\d{3}|EXT-\d{3})$/i.test(numberLabel)) {
    throw new ProjectFeatureNumberError('Feature numbers must use three digits');
  }
  const titleId = /^\[((?:F\d{3}|EXT-\d{3}))\]/i.exec(item.title)?.[1]?.toUpperCase();
  const tagId = tagged[0]?.slice(8).toUpperCase();
  if (
    tagged.length > 1 ||
    (tagId && !/^(?:F\d{3}|EXT-\d{3})$/.test(tagId)) ||
    (titleId && tagId && titleId !== tagId)
  ) {
    throw new ProjectFeatureNumberError('Feature title and tag must identify one matching feature');
  }
  return tagId ?? titleId;
}

export function withFeatureId<T extends Pick<BacklogItem, 'title' | 'tags'>>(item: T, featureId: string): T {
  return {
    ...item,
    title: `[${featureId}] ${item.title.replace(/^\[(?:F\d{3}|EXT-\d{3})\]\s*/i, '')}`,
    tags: [...item.tags.filter((tag) => !/^feature:/i.test(tag)), `feature:${featureId.toLowerCase()}`],
  };
}

export function numberedCreate(input: CreateBacklogItemInput): boolean {
  return Boolean(input.projectId && (input.projectFeatureNumbering || itemFeatureNumbers(input).length));
}

export function selectFeatureNumber(
  requested: string | undefined,
  used: ReadonlySet<number>,
  reserved: readonly string[],
  highWater: number,
): number {
  const maximum = Math.max(highWater, 0, ...used, ...reserved.map((id) => featureNumber(id) ?? 0));
  const number = requested ? featureNumber(requested) : maximum + 1;
  if (number === undefined || number < 1 || number > 999 || used.has(number)) {
    throw new ProjectFeatureNumberError('Project feature number is occupied or exhausted');
  }
  return number;
}

export function validateAssignment(input: AssignProjectFeatureIdInput): string {
  const id = input.featureId.toUpperCase();
  if (
    !/^F\d{3}$/.test(id) ||
    id === 'F000' ||
    !input.projectId ||
    !input.userId ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !input.reason.trim()
  ) {
    throw new ProjectFeatureNumberError('A valid feature ID, revision, owner, project and reason are required');
  }
  return id;
}
