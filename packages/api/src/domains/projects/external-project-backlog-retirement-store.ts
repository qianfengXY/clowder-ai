import type { BacklogImportOrigin, WorkflowSop } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { BacklogKeys } from '../cats/services/stores/redis-keys/backlog-keys.js';
import { ThreadKeys } from '../cats/services/stores/redis-keys/thread-keys.js';
import { WorkflowSopKeys } from '../cats/services/stores/redis-keys/workflow-sop-keys.js';

export interface ExternalProjectBacklogRetirementInput {
  readonly itemId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly expectedUpdatedAt: number;
  readonly requiredImportOrigin?: BacklogImportOrigin;
  readonly expectedWorkflowSop: WorkflowSop | null;
  readonly candidateThreadIds: readonly string[];
}

export type ExternalProjectBacklogRetirementResult =
  | 'deleted'
  | 'missing'
  | 'backlog_conflict'
  | 'provenance_mismatch'
  | 'workflow_conflict'
  | 'dispatch_in_progress';

export interface IExternalProjectBacklogRetirementStore {
  retire(input: ExternalProjectBacklogRetirementInput): Promise<ExternalProjectBacklogRetirementResult>;
}

/**
 * One Redis transaction owns the terminal retirement boundary. Validation,
 * reverse-link cleanup, SOP cleanup, and backlog deletion cannot be separated
 * by a process crash or another Redis writer.
 */
const RETIRE_IMPORTED_BACKLOG_ITEM_LUA = `
local backlogKey = KEYS[1]
if redis.call('HGET', backlogKey, 'id') == false then return -1 end
if redis.call('HGET', backlogKey, 'userId') ~= ARGV[1] then return -2 end
if redis.call('HGET', backlogKey, 'projectId') ~= ARGV[2] then return -2 end
if redis.call('HGET', backlogKey, 'updatedAt') ~= ARGV[3] then return -2 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -5 end

local requiredOriginRaw = ARGV[5]
if requiredOriginRaw ~= '' then
  local storedOriginRaw = redis.call('HGET', backlogKey, 'importOrigin')
  if not storedOriginRaw then return -3 end
  local storedOk, storedOrigin = pcall(cjson.decode, storedOriginRaw)
  local requiredOk, requiredOrigin = pcall(cjson.decode, requiredOriginRaw)
  if not storedOk or not requiredOk
    or storedOrigin.kind ~= requiredOrigin.kind
    or storedOrigin.projectId ~= requiredOrigin.projectId
    or storedOrigin.featureId ~= requiredOrigin.featureId
    or storedOrigin.source ~= requiredOrigin.source then
    return -3
  end
end

local sopRaw = redis.call('GET', KEYS[4])
local expectedSopState = ARGV[6]
if expectedSopState == 'absent' then
  if sopRaw then return -4 end
else
  if not sopRaw then return -4 end
  local sopOk, sop = pcall(cjson.decode, sopRaw)
  if not sopOk or tostring(sop.version) ~= ARGV[7] or tostring(sop.updatedAt) ~= ARGV[8] then
    return -4
  end
end

local threadIds = redis.call('ZRANGE', KEYS[5], 0, -1)
local explicitThreadIds = cjson.decode(ARGV[9])
for _, threadId in ipairs(explicitThreadIds) do table.insert(threadIds, threadId) end
for _, threadId in ipairs(threadIds) do
  local threadKey = KEYS[6] .. threadId
  if redis.call('HGET', threadKey, 'backlogItemId') == ARGV[4] then
    redis.call('HDEL', threadKey, 'backlogItemId')
  end
end

if sopRaw then redis.call('DEL', KEYS[4]) end
redis.call('DEL', backlogKey)
redis.call('ZREM', KEYS[2], ARGV[4])
redis.call('DEL', KEYS[3])
return 1
`;

export class RedisExternalProjectBacklogRetirementStore implements IExternalProjectBacklogRetirementStore {
  constructor(private readonly redis: RedisClient) {}

  async retire(input: ExternalProjectBacklogRetirementInput): Promise<ExternalProjectBacklogRetirementResult> {
    const expectedSop = input.expectedWorkflowSop;
    const result = Number(
      await this.redis.eval(
        RETIRE_IMPORTED_BACKLOG_ITEM_LUA,
        6,
        BacklogKeys.detail(input.itemId),
        BacklogKeys.userList(input.userId),
        BacklogKeys.dispatchLock(input.itemId),
        WorkflowSopKeys.detail(input.itemId),
        ThreadKeys.userList(input.userId),
        ThreadKeys.detail(''),
        input.userId,
        input.projectId,
        String(input.expectedUpdatedAt),
        input.itemId,
        input.requiredImportOrigin ? JSON.stringify(input.requiredImportOrigin) : '',
        expectedSop ? 'present' : 'absent',
        expectedSop ? String(expectedSop.version) : '',
        expectedSop ? String(expectedSop.updatedAt) : '',
        JSON.stringify([...new Set(input.candidateThreadIds)]),
      ),
    );
    switch (result) {
      case 1:
        return 'deleted';
      case -1:
        return 'missing';
      case -3:
        return 'provenance_mismatch';
      case -4:
        return 'workflow_conflict';
      case -5:
        return 'dispatch_in_progress';
      default:
        return 'backlog_conflict';
    }
  }
}
