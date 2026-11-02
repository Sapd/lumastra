-- @version 3
-- Atomic re-seed of the active run hash for a BullMQ retry attempt.
--
-- Replaces the former non-atomic HGET-then-HSET in state-machine.ts. Two bugs
-- it closes:
--   (C1) A cancelled run that reached terminal state had its active hash DEL'd
--        by transition-run.lua and its fields copied into the terminal hash.
--        The old probe only looked at the active hash; finding it missing it
--        re-seeded 'pending' and the worker re-executed cancelled work. We now
--        also inspect the terminal hash for state='cancelled' and refuse.
--   (H2) The HGET/HSET gap let a cancel arriving mid-retry (active hash flipped
--        to 'cancelling') be clobbered back to 'pending'. Running the read and
--        the conditional write inside one script removes that window.
--
-- KEYS[1] = task:run:active:<runId>
-- KEYS[2] = task:run:terminal:<runId>
-- KEYS[3] = BullMQ lock key (optional, redelivered attempt only)
-- ARGV[3] = current BullMQ lock token (optional)
-- ARGV[1] = activeTtlMs
-- ARGV[2] = nowMs
--
-- Returns a positional [status, value] array in every branch:
--   {'ok', 'reseeded'}    — hash was missing or in a non-cancelled terminal
--                           state (failed/completed); now re-seeded 'pending'.
--   {'ok', 'skipped'}     — a cancel won: active hash is 'cancelling', OR the
--                           terminal hash records state='cancelled'. Caller
--                           must abort the retry and let the cancel flow finish.
--   {'ok', 'kept-active'} — active hash is already 'pending'/'active'; no-op.

local activeKey   = KEYS[1]
local terminalKey = KEYS[2]
local activeTtlMs = ARGV[1]
local nowMs       = ARGV[2]

-- A cancelled run reached terminal state: its fields live in the terminal hash
-- (transition-run.lua DEL's the active hash on any terminal transition). Refuse
-- to resurrect it regardless of whether a stale active hash also lingers.
local terminalState = redis.call('HGET', terminalKey, 'state')
if terminalState == 'cancelled' or (ARGV[3] and terminalState == 'completed') then
    return {'ok', 'skipped'}
end

local current = redis.call('HGET', activeKey, 'state')

-- A cancel arrived between attempts and is still in flight — it must win.
if current == 'cancelling' then
    return {'ok', 'skipped'}
end

-- Only a redelivered attempt holding the current BullMQ lock may reset active.
-- A new queue token alone is not proof that the old executor has stopped.
-- The caller checks PG liveness too; retain a fresh Valkey heartbeat here.
local ownsRedelivery = KEYS[3] and ARGV[3] and redis.call('GET', KEYS[3]) == ARGV[3]
local heartbeat = tonumber(redis.call('HGET', activeKey, 'heartbeatAt') or '0')
local fresh = heartbeat > tonumber(nowMs) - 60000
if current == 'pending' or (current == 'active' and (not ownsRedelivery or fresh)) then
    return {'ok', 'kept-active'}
end

-- Active hash missing, or holds a non-cancelled terminal state
-- (failed/completed) on an alternative path. Safe to re-seed for the retry.
redis.call('HSET', activeKey,
    'state', 'pending',
    'ownerInstanceId', '',
    'ownerBootId', '',
    'heartbeatAt', '0',
    'updatedAt', nowMs)
redis.call('PEXPIRE', activeKey, activeTtlMs)

return {'ok', 'reseeded'}
