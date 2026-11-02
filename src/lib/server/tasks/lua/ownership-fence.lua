-- @version 1
-- This prefix runs inside the same invocation as the protected mutation.
-- The final two keys and final four arguments are private to the wrapper.
-- A non-TTL managed marker is distinct from the expiring authority lease:
-- missing/expired authority must never turn a managed partition into legacy.
local managed_key = table.remove(KEYS)
local authority_key = table.remove(KEYS)
local allow_draining = table.remove(ARGV)
local owner_id = table.remove(ARGV)
local generation = table.remove(ARGV)
local partition = table.remove(ARGV)
local managed = redis.call('GET', managed_key)
local fence_exists = redis.call('EXISTS', authority_key)
if partition == '' then
    if managed or fence_exists == 1 then
        return redis.error_reply('TASK_AUTHORITY_REQUIRED')
    end
else
    if partition ~= 'tasks' or managed ~= '1' or fence_exists == 0 then
        return redis.error_reply('TASK_AUTHORITY_MISSING')
    end
    local fence = redis.call('HMGET', authority_key,
        'partition', 'generation', 'ownerId', 'phase', 'leaseUntilMs')
    if fence[1] ~= partition or fence[2] ~= generation or fence[3] ~= owner_id then
        return redis.error_reply('TASK_AUTHORITY_STALE')
    end
    if fence[4] == 'draining' and allow_draining ~= '1' then
        return redis.error_reply('TASK_AUTHORITY_DRAINING')
    end
    if fence[4] ~= 'active' and fence[4] ~= 'draining' then
        return redis.error_reply('TASK_AUTHORITY_QUARANTINED')
    end
    local clock = redis.call('TIME')
    local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
    local lease_until = tonumber(fence[5])
    if not string.match(fence[5] or '', '^%d+$') or not lease_until
        or lease_until > 9007199254740991 or lease_until <= now_ms then
        return redis.error_reply('TASK_AUTHORITY_EXPIRED')
    end
end
