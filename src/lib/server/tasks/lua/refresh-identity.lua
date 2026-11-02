-- @version 1
-- Renew only this run's identity mutex, never a successor's claim.
-- KEYS[1] = identity key; ARGV[1] = runId; ARGV[2] = full TTL in ms.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
