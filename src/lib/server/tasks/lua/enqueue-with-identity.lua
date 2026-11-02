-- @version 2
-- SETNX dedup: claim an identity key or return the existing runId.
-- KEYS[1] = task:identity:<formula>
-- ARGV[1] = runId
-- ARGV[2] = ttlMs
--
-- Returns a plain positional array [status, value] in both branches.
-- The earlier {ok='...', value} shape relied on valkey-glide decoding
-- the Lua status-reply table as a JS array — a client-library leak.
-- Native Redis Lua semantics drop the second element when `ok` is set,
-- and any other client would lose the runId silently. Positional
-- arrays are decoded the same way by every RESP client.

local result = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])

if result then
    return {'enqueued', ARGV[1]}
else
    local existing = redis.call('GET', KEYS[1])
    return {'duplicate', existing or ''}
end
