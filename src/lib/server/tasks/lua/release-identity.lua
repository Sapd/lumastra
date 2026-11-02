-- @version 1
-- Compare-and-delete release of an exclusiveWith identity key.
-- DELs the key ONLY when it still holds THIS run's value (its runId, as stored
-- by enqueue-with-identity.lua's SETNX). A blind DEL would steal a SUCCESSOR's
-- lock: if this run's key TTL expired mid-run (ttl < runtime) and another run
-- re-claimed the same identity, deleting it unconditionally on this run's
-- terminal/rollback would free the successor's mutex and let a duplicate run
-- concurrently.
--
-- KEYS[1] = task:identity:<formula>
-- ARGV[1] = expected value (this run's runId)
-- Returns 1 if deleted (value matched), 0 otherwise (mismatch / absent).

if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
