/** KEYS: item, owner index, persistent project sequence. All validation precedes writes. */
const PROJECT_NUMBER_SCAN = `
local key = KEYS[1]
local p = cjson.decode(ARGV[1])
local prefix = string.sub(key, 1, #key - #p.id)
local high = tonumber(redis.call('GET', KEYS[3]) or '0')
if not high then return 'Invalid project sequence' end
local used = {}
local function reserve(n)
  if n then used[n] = true; high = math.max(high, n) end
end
for _, id in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  local other = prefix .. id
  if id ~= p.id and redis.call('HGET', other, 'userId') == p.userId and
    redis.call('HGET', other, 'projectId') == p.projectId then
    local title = string.upper(redis.call('HGET', other, 'title') or '')
    reserve(tonumber(string.match(title, '^%[F(%d%d%d)%]')))
    local tags = cjson.decode(redis.call('HGET', other, 'tags') or '[]')
    for _, tag in ipairs(tags) do reserve(tonumber(string.match(string.upper(tag), '^FEATURE:F(%d%d%d)$'))) end
  end
end
local reserved = {}
for _, id in ipairs(p.reservedFeatureIds) do
  local n = tonumber(string.match(string.upper(id), '^F(%d%d%d)$'))
  if n then high = math.max(high, n); reserved[n] = true end
end
local n = p.number or (high + 1)
if n < 1 or n > 999 or used[n] or (p.allocate and reserved[n]) then
  return 'Project feature number is occupied or exhausted'
end
local featureId = string.format('F%03d', n)
local function numberMetadata(title, tags)
  local kept = {}
  for _, tag in ipairs(tags) do
    if not string.match(string.upper(tag), '^FEATURE:') then table.insert(kept, tag) end
  end
  table.insert(kept, 'feature:' .. string.lower(featureId))
  title = string.gsub(title, '^%[[Ff]%d%d%d%]%s*', '')
  return '[' .. featureId .. '] ' .. title, cjson.encode(kept)
end
`;

export const CREATE_NUMBERED_PROJECT_ITEM_LUA = `${PROJECT_NUMBER_SCAN}
if redis.call('EXISTS', key) == 1 then return 'Backlog item already exists' end
local fields = p.fields
if p.allocate then
  fields.title, fields.tags = numberMetadata(fields.title, cjson.decode(fields.tags))
  local audit = cjson.decode(fields.audit)
  audit[1].detail = fields.title
  fields.audit = cjson.encode(audit)
end
for field, value in pairs(fields) do redis.call('HSET', key, field, value) end
redis.call('HSET', key, 'revision', '1')
redis.call('ZADD', KEYS[2], fields.createdAt, p.id)
redis.call('SET', KEYS[3], math.max(high, n))
if p.ttl > 0 then
  redis.call('EXPIRE', key, p.ttl)
  redis.call('EXPIRE', KEYS[2], p.ttl)
end
return ''
`;

export const ASSIGN_PROJECT_FEATURE_ID_LUA = `${PROJECT_NUMBER_SCAN}
if redis.call('HGET', key, 'userId') ~= p.userId or redis.call('HGET', key, 'projectId') ~= p.projectId then
  return 'Backlog item missing or outside the requested scope'
end
local audit = cjson.decode(redis.call('HGET', key, 'audit') or '[]')
local revision = tonumber(redis.call('HGET', key, 'revision')) or math.max(1, #audit)
if revision ~= p.expectedRevision then return 'Backlog item changed before feature assignment' end
local title = redis.call('HGET', key, 'title') or ''
local tags = cjson.decode(redis.call('HGET', key, 'tags') or '[]')
local titleId = string.match(string.upper(title), '^%[(F%d%d%d)%]') or
  string.match(string.upper(title), '^%[(EXT%-%d%d%d)%]')
local tagId = nil
local tagCount = 0
for _, tag in ipairs(tags) do
  if string.match(string.upper(tag), '^FEATURE:') then tagCount = tagCount + 1; tagId = string.sub(tag, 9) end
end
if titleId == featureId and tagCount == 1 and tagId == string.lower(featureId) and
  string.sub(title, 1, #featureId + 3) == '[' .. featureId .. '] ' then return '' end
if titleId or tagCount > 0 or redis.call('HEXISTS', key, 'importOrigin') == 1 or reserved[n] then
  return 'Only unnumbered manual tasks can receive an unreserved feature ID'
end
local newTitle, newTags = numberMetadata(title, tags)
table.insert(audit, p.audit)
local encodedAudit = cjson.encode(audit)
redis.call('HSET', key, 'title', newTitle, 'tags', newTags, 'audit', encodedAudit,
  'updatedAt', p.now, 'revision', revision + 1)
redis.call('SET', KEYS[3], math.max(high, n))
return ''
`;
