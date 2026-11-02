-- @version 2
-- Atomic stage progress increment with optional auto-complete.
-- KEYS[1] = task:run:active:<runId>
-- ARGV[1] = stageId
-- ARGV[2] = increment (default 1)
-- ARGV[3] = total (0 = unknown, no auto-complete)
-- ARGV[4] = activeTtlMs
--
-- Failure shape: {'err', '<message>'}. See transition-stage.lua / claim-run.lua
-- for the rationale — this positional form decodes as a normal multi-bulk
-- array everywhere (unlike a table keyed `{err=...}`, which valkey-glide
-- treats as a RESP error reply and throws on the calling side).

local stageId   = ARGV[1]
local increment = tonumber(ARGV[2]) or 1
local total     = tonumber(ARGV[3]) or 0
local ttl       = ARGV[4]

local exists = redis.call('HEXISTS', KEYS[1], 'state')
if exists == 0 then
    return {'err', 'run not found'}
end

local processedKey = 'stage:' .. stageId .. ':processed'

local n = redis.call('HINCRBY', KEYS[1], processedKey, increment)

local completed = 0
if total > 0 and n >= total then
    local t = redis.call('TIME')
local nowMs = tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
    redis.call('HSET', KEYS[1],
        'stage:' .. stageId .. ':state',       'completed',
        'stage:' .. stageId .. ':completedAt', nowMs)
    completed = 1
end

redis.call('PEXPIRE', KEYS[1], ttl)

return {n, completed}
