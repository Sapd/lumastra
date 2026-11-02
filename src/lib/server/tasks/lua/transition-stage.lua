-- @version 2
-- Atomic Stage state machine transition within a run hash.
-- KEYS[1] = task:run:active:<runId>
-- ARGV[1] = stageId
-- ARGV[2] = expectedFromState
-- ARGV[3] = toState
-- ARGV[4] = activeTtlMs
-- ARGV[5..] = additional stage:<id>:<field> / value pairs
--
-- Failure shape: {'err', '<message>'}.
-- Success shape: {fromState, toState} (already positional).
-- See claim-run.lua / transition-run.lua for the rationale — valkey-glide
-- treats the `err` magic key as a RESP error reply and throws on the
-- calling side, bypassing the state-machine.ts parsers.

local LEGAL = {
    ['waiting'] = { active=true, skipped=true },
    ['active']  = { completed=true, failed=true },
}

local stageId = ARGV[1]
local from    = ARGV[2]
local to      = ARGV[3]

local stateKey = 'stage:' .. stageId .. ':state'

local exists = redis.call('HEXISTS', KEYS[1], 'state')
if exists == 0 then
    return {'err', 'run not found'}
end

local current = redis.call('HGET', KEYS[1], stateKey)
if not current then
    return {'err', 'stage not found: ' .. stageId}
end

if current ~= from then
    return {'err', 'stage state mismatch: expected ' .. from .. ' got ' .. current}
end

if not (LEGAL[from] and LEGAL[from][to]) then
    return {'err', 'invalid stage transition: ' .. from .. ' -> ' .. to}
end

local t = redis.call('TIME')
local nowMs = tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))

local fields = {stateKey, to, 'stage:' .. stageId .. ':updatedAt', nowMs}
local i = 5
while i <= #ARGV do
    fields[#fields + 1] = ARGV[i]
    fields[#fields + 1] = ARGV[i + 1]
    i = i + 2
end

redis.call('HSET', KEYS[1], unpack(fields))
redis.call('PEXPIRE', KEYS[1], ARGV[4])

return {from, to}
