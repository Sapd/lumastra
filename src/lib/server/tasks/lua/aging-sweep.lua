-- aging-sweep.lua — bump priority of long-waiting jobs in a BullMQ
-- prioritized ZSET so strict-priority FIFO doesn't starve them forever.
-- @version 2
--
-- BullMQ 5.x encodes the prioritized-ZSET score as `priority * 2^32 + sequence`
-- (see bullmq's `addPriorityMarkerIfNeeded`/`getPriorityScore`:
-- `priority * 0x100000000 + counter % 0x100000000`). v1 used 2^39, which is
-- 128× too large — bumping subtracted 128 priority levels' worth and corrupted
-- the score, so starvation promotion never worked. Lower score = popped sooner;
-- to bump a job by one priority level subtract 2^32. The lower 32 bits (the
-- sequence) are preserved, so within-priority FIFO ordering is maintained.
--
-- KEYS[1] — `bull:<queue>:prioritized` ZSET to sweep
-- KEYS[2] — `bull:<queue>` BullMQ key prefix (to read job hashes)
-- ARGV[1] — now_ms (current epoch ms, passed by caller so the script is
--           deterministic / testable; also avoids Redis time skew)
-- ARGV[2] — age_threshold_ms (jobs older than this are eligible for bumping)
-- ARGV[3] — max_jobs_per_sweep (cap to bound this script's work)
--
-- Returns: { bumped_count, oldest_age_ms_observed }
--
-- Strategy: ZRANGE the TOP of the ZSET (highest scores = lowest priority
-- = back of queue), which is where starved jobs accumulate. For each,
-- HGET its `timestamp` field. If older than threshold and not already
-- priority 1, ZADD with score - PRIORITY_STEP. One pass; converges over
-- multiple sweep ticks for very-old backlogs.

local prioritized_key = KEYS[1]
local queue_prefix    = KEYS[2]
local now_ms          = tonumber(ARGV[1])
local threshold_ms    = tonumber(ARGV[2])
local max_jobs        = tonumber(ARGV[3]) or 100

-- 2^32 = 4294967296 — the BullMQ 5.x priority step (`0x100000000`). Same
-- magic number as BullMQ's own scripts (`addStandardJob`/`addPrioritizedJob`:
-- `priority * 0x100000000`).
local PRIORITY_STEP = 4294967296

-- Read the top of the ZSET (back of queue — highest scores).
-- ZRANGE with REV gets them in descending score order.
local entries = redis.call('ZRANGE', prioritized_key, 0, max_jobs - 1, 'REV', 'WITHSCORES')

local bumped = 0
local oldest_age = 0

local i = 1
while i <= #entries do
    local job_id = entries[i]
    local score  = tonumber(entries[i + 1])
    i = i + 2

    if not score then
        -- Defensive: malformed ZSET entry, skip.
    else
        -- Read the job's enqueue timestamp from its hash. BullMQ stores
        -- it as a string field `timestamp` (epoch ms).
        local ts_str = redis.call('HGET', queue_prefix .. ':' .. job_id, 'timestamp')
        if ts_str then
            local ts = tonumber(ts_str)
            if ts then
                local age_ms = now_ms - ts
                if age_ms > oldest_age then oldest_age = age_ms end

                if age_ms >= threshold_ms then
                    -- Compute current priority bucket from score.
                    -- score = priority * STEP + sequence  ⇒  priority = floor(score / STEP)
                    local current_priority = math.floor(score / PRIORITY_STEP)

                    -- Bump if not already at priority 1 (highest). Subtract
                    -- one STEP from the score; sequence bits preserved.
                    if current_priority > 1 then
                        local new_score = score - PRIORITY_STEP
                        redis.call('ZADD', prioritized_key, new_score, job_id)
                        bumped = bumped + 1
                    end
                end
            end
        end
    end
end

return { bumped, oldest_age }
