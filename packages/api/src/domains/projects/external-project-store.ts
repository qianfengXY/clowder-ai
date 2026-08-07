/**
 * F076: ExternalProjectStore — Redis-backed store for external projects
 * Falls back to in-memory Map when Redis is not available.
 */

import { resolve } from 'node:path';
import {
  applyDesktopDevelopmentPolicyUpdate,
  createDesktopDevelopmentProjectBinding,
  recordAcceptedManualPilot,
  type CreateExternalProjectInput,
  type DesktopDevelopmentPolicyUpdate,
  type DesktopDevelopmentProjectBinding,
  type ExternalProject,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../cats/services/stores/ports/MessageStore.js';
import { ExternalProjectKeys } from '../cats/services/stores/redis-keys/community/external-project-keys.js';

export class ExternalProjectStore {
  private readonly redis: RedisClient | undefined;
  private readonly fallbackProjects = new Map<string, ExternalProject>();

  constructor(redis?: RedisClient) {
    this.redis = redis;
  }

  async create(userId: string, input: CreateExternalProjectInput): Promise<ExternalProject> {
    if (!input.sourcePath) {
      throw new Error('sourcePath is required');
    }
    // P2-1: Prevent path traversal — resolved backlogPath must stay within sourcePath
    const backlogPath = input.backlogPath ?? 'docs/ROADMAP.md';
    const resolvedBacklog = resolve(input.sourcePath, backlogPath);
    const resolvedSource = resolve(input.sourcePath);
    if (!resolvedBacklog.startsWith(`${resolvedSource}/`) && resolvedBacklog !== resolvedSource) {
      throw new Error('backlogPath must not escape sourcePath');
    }
    const now = Date.now();
    const project: ExternalProject = {
      id: `ep-${generateSortableId(now)}`,
      userId,
      name: input.name,
      description: input.description,
      sourcePath: input.sourcePath,
      backlogPath,
      ...(input.desktopDevelopment
        ? { desktopDevelopment: createDesktopDevelopmentProjectBinding(input.desktopDevelopment) }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (this.redis) {
      const pipeline = this.redis.multi();
      pipeline.hset(ExternalProjectKeys.detail(project.id), this.serializeProject(project));
      pipeline.zadd(ExternalProjectKeys.userList(userId), String(now), project.id);
      await pipeline.exec();
    } else {
      this.fallbackProjects.set(project.id, project);
    }
    return project;
  }

  async listByUser(userId: string): Promise<ExternalProject[]> {
    if (this.redis) {
      const ids = await this.redis.zrevrange(ExternalProjectKeys.userList(userId), 0, -1);
      if (ids.length === 0) return [];

      const pipeline = this.redis.multi();
      for (const id of ids) {
        pipeline.hgetall(ExternalProjectKeys.detail(id));
      }
      const rows = await pipeline.exec();
      if (!rows) return [];

      const result: ExternalProject[] = [];
      for (const [err, data] of rows) {
        if (err || !data || typeof data !== 'object') continue;
        const row = data as Record<string, string>;
        if (!row.id) continue;
        result.push(this.hydrateProject(row));
      }
      return result;
    }
    return [...this.fallbackProjects.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  async getById(id: string): Promise<ExternalProject | null> {
    if (this.redis) {
      const data = await this.redis.hgetall(ExternalProjectKeys.detail(id));
      if (!data || !data.id) return null;
      return this.hydrateProject(data as Record<string, string>);
    }
    return this.fallbackProjects.get(id) ?? null;
  }

  async update(id: string, patch: Partial<CreateExternalProjectInput>): Promise<ExternalProject | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const updated: ExternalProject = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.sourcePath !== undefined ? { sourcePath: patch.sourcePath } : {}),
      ...(patch.backlogPath !== undefined ? { backlogPath: patch.backlogPath } : {}),
      updatedAt: Date.now(),
    };
    if (this.redis) {
      await this.redis.hset(ExternalProjectKeys.detail(id), this.serializeProject(updated));
    } else {
      this.fallbackProjects.set(id, updated);
    }
    return updated;
  }

  async updateDesktopDevelopment(
    id: string,
    patch: DesktopDevelopmentPolicyUpdate,
  ): Promise<ExternalProject | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    if (!existing.desktopDevelopment) {
      throw new Error('Desktop development loop is not configured for this project');
    }
    const binding = applyDesktopDevelopmentPolicyUpdate(existing.desktopDevelopment, patch);
    return this.persistDesktopDevelopment(existing, binding, patch.expectedVersion);
  }

  async recordAcceptedManualPilot(id: string, workId: string): Promise<ExternalProject | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.getById(id);
      if (!existing) return null;
      if (!existing.desktopDevelopment) {
        throw new Error('Desktop development loop is not configured for this project');
      }
      const binding = recordAcceptedManualPilot(existing.desktopDevelopment, workId);
      if (binding === existing.desktopDevelopment) return existing;
      try {
        return await this.persistDesktopDevelopment(existing, binding, existing.desktopDevelopment.version);
      } catch (error) {
        if (!(error instanceof Error) || !/version conflict/i.test(error.message) || attempt === 2) throw error;
      }
    }
    throw new Error('Desktop development binding version conflict');
  }

  async delete(id: string): Promise<boolean> {
    const project = await this.getById(id);
    if (!project) return false;
    if (this.redis) {
      const pipeline = this.redis.multi();
      pipeline.del(ExternalProjectKeys.detail(id));
      pipeline.zrem(ExternalProjectKeys.userList(project.userId), id);
      await pipeline.exec();
    } else {
      this.fallbackProjects.delete(id);
    }
    return true;
  }

  private serializeProject(project: ExternalProject): Record<string, string> {
    return {
      id: project.id,
      userId: project.userId,
      name: project.name,
      description: project.description,
      sourcePath: project.sourcePath,
      backlogPath: project.backlogPath,
      ...(project.desktopDevelopment
        ? {
            desktopDevelopment: JSON.stringify(project.desktopDevelopment),
            desktopDevelopmentVersion: String(project.desktopDevelopment.version),
          }
        : {}),
      createdAt: String(project.createdAt),
      updatedAt: String(project.updatedAt),
    };
  }

  private hydrateProject(data: Record<string, string>): ExternalProject {
    const desktopDevelopment = this.hydrateDesktopDevelopment(data.desktopDevelopment);
    return {
      id: data.id ?? '',
      userId: data.userId ?? '',
      name: data.name ?? '',
      description: data.description ?? '',
      sourcePath: data.sourcePath ?? '',
      backlogPath: data.backlogPath ?? 'docs/ROADMAP.md',
      ...(desktopDevelopment ? { desktopDevelopment } : {}),
      createdAt: Number.parseInt(data.createdAt ?? '0', 10),
      updatedAt: Number.parseInt(data.updatedAt ?? '0', 10),
    };
  }

  private hydrateDesktopDevelopment(value: string | undefined): DesktopDevelopmentProjectBinding | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as DesktopDevelopmentProjectBinding;
      if (parsed.protocolVersion !== 1 || !parsed.repository?.fullName || !Number.isInteger(parsed.version)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async persistDesktopDevelopment(
    existing: ExternalProject,
    binding: DesktopDevelopmentProjectBinding,
    expectedVersion: number,
  ): Promise<ExternalProject> {
    const updated: ExternalProject = {
      ...existing,
      desktopDevelopment: binding,
      updatedAt: Date.now(),
    };
    if (!this.redis) {
      const current = this.fallbackProjects.get(existing.id);
      if (current?.desktopDevelopment?.version !== expectedVersion) {
        throw new Error(`Desktop development binding version conflict: expected ${expectedVersion}`);
      }
      this.fallbackProjects.set(existing.id, updated);
      return updated;
    }

    const result = await this.redis.eval(
      `
        local current = redis.call('HGET', KEYS[1], 'desktopDevelopmentVersion')
        if not current then return -1 end
        if tonumber(current) ~= tonumber(ARGV[1]) then return 0 end
        redis.call('HSET', KEYS[1],
          'desktopDevelopment', ARGV[2],
          'desktopDevelopmentVersion', ARGV[3],
          'updatedAt', ARGV[4])
        return 1
      `,
      1,
      ExternalProjectKeys.detail(existing.id),
      String(expectedVersion),
      JSON.stringify(binding),
      String(binding.version),
      String(updated.updatedAt),
    );
    if (Number(result) !== 1) {
      throw new Error(`Desktop development binding version conflict: expected ${expectedVersion}`);
    }
    return updated;
  }
}
