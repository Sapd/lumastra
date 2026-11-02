-- @version 3
-- Atomic owner claim with instanceId + bootId.
-- KEYS[1] = task:run:active:<runId>
-- ARGV[1] = expectedState (e.g. 'active')
-- ARGV[2] = instanceId
-- ARGV[3] = bootId
-- ARGV[4] = nowMs
--
-- Returns a plain positional array [status, value] in every branch.
-- The earlier {err='...'}/{ok='...'} table form triggered valkey-glide's
-- RESP error-reply decoding (the `err` key is a Redis Lua magic key) which
-- *throws* on the calling side, bypassing the state-machine.ts parsers.
-- Native Redis Lua also drops the second element of a table containing
-- the `ok` key, so the value would be lost on any RESP3 client. Positional
-- arrays decode identically everywhere.

local expectedState = ARGV[1]
local instanceId    = ARGV[2]
local bootId        = ARGV[3]
local nowMs         = ARGV[4]

local exists = redis.call('HEXISTS', KEYS[1], 'state')
if exists == 0 then
    return {'err', 'run not found'}
end

local state = redis.call('HGET', KEYS[1], 'state')
if state ~= expectedState then
    return {'err', 'state mismatch: expected ' .. expectedState .. ' got ' .. state}
end

local owner = redis.call('HGET', KEYS[1], 'ownerInstanceId')
if owner and owner ~= '' and owner ~= instanceId then
    return {'err', 'already claimed by ' .. owner}
end

-- Same instanceId but a different bootId means a different process (restart or
-- recycled INSTANCE_ID). Treat it as a foreign claim — the prior owner's boot-
-- recovery + watchdog will rescue the run after its heartbeat lapses. This is
-- deliberately conservative: no liveness window is checked here because the
-- caller cannot safely take over without the stale process's full context.
if owner and owner ~= '' then
    local storedBootId = redis.call('HGET', KEYS[1], 'ownerBootId')
    if storedBootId and storedBootId ~= '' and storedBootId ~= bootId then
        return {'err', 'already claimed by ' .. owner .. ' (different boot)'}
    end
end

redis.call('HSET', KEYS[1],
    'ownerInstanceId', instanceId,
    'ownerBootId',     bootId,
    'claimedAt',       nowMs)

return {'ok', 'claimed'}
