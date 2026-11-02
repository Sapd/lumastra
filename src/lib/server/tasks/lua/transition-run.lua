-- @version 4
-- Atomic Run state machine transition.
-- KEYS[1] = task:run:active:<runId>
-- KEYS[2] = task:run:terminal:<runId>
-- ARGV[1] = expectedFromState
-- ARGV[2] = toState
-- ARGV[3] = activeTtlMs
-- ARGV[4] = terminalTtlMs
-- ARGV[5..] = additional key/value pairs to set on the hash
--
-- Failure shape: {'err', '<message>'}.
-- Success shape: {fromState, toState} (already positional).
-- The earlier {err='...'} form was decoded by valkey-glide as a RESP
-- error reply (the `err` key is a Redis Lua magic key), causing the
-- client to *throw* on the calling side and bypass the state-machine.ts
-- parsers entirely.

local LEGAL = {
    ['pending']    = { active=true, cancelling=true, cancelled=true },
    ['active']     = { pending=true, completed=true, failed=true, cancelling=true },
    ['cancelling'] = { cancelled=true },
}

local TERMINAL = { completed=true, failed=true, cancelled=true }

local from = ARGV[1]
local to   = ARGV[2]

local exists = redis.call('HEXISTS', KEYS[1], 'state')
if exists == 0 then
    return {'err', 'run not found'}
end

-- Queue failure notifications cannot settle a run whose managed hard-kill
-- cleanup has an unknown queue outcome. Only acknowledged cleanup clears this
-- marker; the guard shares the atomic transition boundary.
if TERMINAL[to] and redis.call('HGET', KEYS[1], 'hardKillQueuePending') == '1' then
    return {'err', 'hard kill queue cleanup pending'}
end

local current = redis.call('HGET', KEYS[1], 'state')
if current ~= from then
    return {'err', 'state mismatch: expected ' .. from .. ' got ' .. current}
end

if not (LEGAL[from] and LEGAL[from][to]) then
    return {'err', 'invalid transition: ' .. from .. ' -> ' .. to}
end

local t = redis.call('TIME')
local nowMs = tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))

local fields = {'state', to, 'updatedAt', nowMs}
local i = 5
while i <= #ARGV do
    fields[#fields + 1] = ARGV[i]
    fields[#fields + 1] = ARGV[i + 1]
    i = i + 2
end

redis.call('HSET', KEYS[1], unpack(fields))

if TERMINAL[to] then
    local all = redis.call('HGETALL', KEYS[1])
    redis.call('DEL', KEYS[1])
    redis.call('HSET', KEYS[2], unpack(all))
    redis.call('PEXPIRE', KEYS[2], ARGV[4])
else
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
end

return {from, to}
