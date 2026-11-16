// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Download leases: per-user parallel limit and bandwidth shared over all replicas.
 *
 * A lease is held for the life of one download response. It is keyed by
 * (user, file, device): the same file from the same device twice (a segmented
 * / range-resumed download) re-uses one slot via a refCount, a different device
 * or file takes another slot.
 *
 * ## Shared state
 *
 * Valkey (coordination instance), when connected:
 *   `dl:lease:{userId}`  hash, field `${fileId}|${deviceKey}`,
 *                        value `expiresAtMs|refCount|bytesSent|startedAt|bytesPerSec`
 *   `dl:users`           sorted set, member userId, score = latest lease expiry of that user
 * All reads and writes go through one Lua script per operation, so two replicas
 * racing for the last slot cannot both win. Expired fields are dropped inside
 * every script. Every key carries a TTL, so a crashed replica leaks nothing.
 * Time comes from the calling replica (`Date.now()`), not from Valkey; a few
 * seconds of skew against the 30 s TTL is harmless.
 *
 * Without Valkey (or when it errors) the same logic runs on a process-local Map:
 * each replica then enforces its own limits, a degradation rather than an outage.
 *
 * ## Rate
 *
 * With U = users holding at least one live lease and L = this user's live leases:
 *   min(per-download cap, user cap / L, total cap / U / L), ignoring caps that are 0.
 * The total is split per user first, so three parallel downloads do not get three
 * times the share of someone with one. Not work-conserving: bandwidth a capped
 * user leaves unused is not handed to others. Accepted.
 */

import crypto from 'node:crypto';
import { config } from '$lib/server/config.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream.js';
import { isNoScriptError } from '$lib/server/tasks/lua/loader.js';
import type { ValkeyLike } from '$lib/server/tasks/valkey-types.js';

const log = Logger.for('DownloadLeases');

/** A lease not refreshed for this long is dead (the stream is expected to refresh every 5 s). */
export const LEASE_TTL_MS = 30_000;
/** How often a stream should call `refresh()`. */
export const LEASE_REFRESH_INTERVAL_MS = 5_000;
/** Hint for a rejected client; a live download frees its slot at an unknown time. */
const RETRY_AFTER_SEC = 5;

const LEASE_KEY_PREFIX = 'dl:lease:';
const USERS_KEY = 'dl:users';

export type LeaseKey = { userId: string; fileId: string; deviceKey: string };
export type AcquireResult =
    { ok: true; lease: DownloadLease } | { ok: false; retryAfterSec: number };
export type ActiveDownload = LeaseKey & {
    bytesSent: number;
    startedAt: number;
    bytesPerSec: number;
};

export interface DownloadLease {
    /** Bytes/s for this stream as of the last acquire/refresh; 0 = unlimited. */
    rateBytesPerSec(): number;
    /** Called by the stream on each refresh tick with total bytes sent so far; returns the new rate. */
    refresh(bytesSent: number): Promise<number>;
    release(): Promise<void>;
}

/** Pure rate formula, see the file header. */
export function computeRate(liveLeases: number, liveUsers: number): number {
    const l = Math.max(1, liveLeases);
    const u = Math.max(1, liveUsers);
    const caps: number[] = [];
    const perDownload = kbpsToBytesPerSecond(config.DOWNLOAD_THROTTLE_KBPS);
    const user = kbpsToBytesPerSecond(config.DOWNLOAD_USER_BANDWIDTH_KBPS);
    const total = kbpsToBytesPerSecond(config.DOWNLOAD_TOTAL_BANDWIDTH_KBPS);
    if (perDownload > 0) caps.push(perDownload);
    if (user > 0) caps.push(user / l);
    if (total > 0) caps.push(total / u / l);
    if (caps.length === 0) return 0;
    return Math.max(1, Math.floor(Math.min(...caps)));
}

const fieldOf = (k: LeaseKey): string => `${k.fileId}|${k.deviceKey}`;

/** Backend operations; both implementations are interchangeable. */
interface Backend {
    acquire(key: LeaseKey, limit: number, now: number): Promise<{ l: number; u: number } | null>;
    refresh(
        key: LeaseKey,
        deltaBytes: number,
        bytesPerSec: number,
        now: number,
    ): Promise<{ l: number; u: number }>;
    release(key: LeaseKey, now: number): Promise<void>;
    list(now: number): Promise<ActiveDownload[]>;
}

// ── process-local backend ─────────────────────────────────────────────────────

interface MemEntry {
    expiresAt: number;
    refCount: number;
    bytesSent: number;
    startedAt: number;
    bytesPerSec: number;
}
const memory = new Map<string, Map<string, MemEntry>>();

function memSweep(userId: string, now: number): Map<string, MemEntry> | undefined {
    const m = memory.get(userId);
    if (!m) return undefined;
    for (const [f, e] of m) if (e.expiresAt <= now) m.delete(f);
    if (m.size === 0) {
        memory.delete(userId);
        return undefined;
    }
    return m;
}

function memCounts(userId: string, now: number): { l: number; u: number } {
    let u = 0;
    for (const id of [...memory.keys()]) if (memSweep(id, now)) u++;
    return { l: memory.get(userId)?.size ?? 0, u };
}

const memoryBackend: Backend = {
    async acquire(key, limit, now) {
        const field = fieldOf(key);
        const m = memSweep(key.userId, now);
        const existing = m?.get(field);
        if (existing) {
            existing.refCount += 1;
            existing.expiresAt = now + LEASE_TTL_MS;
        } else {
            if (limit > 0 && (m?.size ?? 0) >= limit) return null;
            const target = m ?? new Map<string, MemEntry>();
            target.set(field, {
                expiresAt: now + LEASE_TTL_MS,
                refCount: 1,
                bytesSent: 0,
                startedAt: now,
                bytesPerSec: 0,
            });
            memory.set(key.userId, target);
        }
        return memCounts(key.userId, now);
    },
    async refresh(key, deltaBytes, bytesPerSec, now) {
        const field = fieldOf(key);
        let m = memSweep(key.userId, now);
        let e = m?.get(field);
        if (!e) {
            // Lease lapsed while the stream was still alive: re-register it.
            e = { expiresAt: 0, refCount: 1, bytesSent: 0, startedAt: now, bytesPerSec: 0 };
            m = m ?? new Map();
            m.set(field, e);
            memory.set(key.userId, m);
        }
        e.expiresAt = now + LEASE_TTL_MS;
        e.bytesSent += deltaBytes;
        e.bytesPerSec = bytesPerSec;
        return memCounts(key.userId, now);
    },
    async release(key, now) {
        const m = memSweep(key.userId, now);
        const e = m?.get(fieldOf(key));
        if (!m || !e) return;
        e.refCount -= 1;
        if (e.refCount <= 0) m.delete(fieldOf(key));
        memSweep(key.userId, now);
    },
    async list(now) {
        const out: ActiveDownload[] = [];
        for (const userId of [...memory.keys()]) {
            const m = memSweep(userId, now);
            if (!m) continue;
            for (const [field, e] of m) {
                const sep = field.indexOf('|');
                out.push({
                    userId,
                    fileId: field.slice(0, sep),
                    deviceKey: field.slice(sep + 1),
                    bytesSent: e.bytesSent,
                    startedAt: e.startedAt,
                    bytesPerSec: e.bytesPerSec,
                });
            }
        }
        return out;
    },
};

/** Test hook: clear process-local state. */
export function resetDownloadLeasesForTests(): void {
    memory.clear();
}

// ── Valkey backend ────────────────────────────────────────────────────────────

// Shared Lua helpers. Value layout: expiresAtMs|refCount|bytesSent|startedAt|bytesPerSec.
const LUA_COMMON = `
local function parse(v)
    local t = {}
    for p in string.gmatch(v, '[^|]+') do t[#t + 1] = tonumber(p) end
    return t
end
local function fmt(n) return string.format('%.0f', n) end
local function pack(exp, ref, bytes, started, bps)
    return fmt(exp) .. '|' .. fmt(ref) .. '|' .. fmt(bytes) .. '|' .. fmt(started) .. '|' .. fmt(bps)
end
-- Drop expired fields; returns live count and the latest expiry.
local function sweep(key, now)
    local flat = redis.call('HGETALL', key)
    local live, maxExp = 0, 0
    for i = 1, #flat, 2 do
        local p = parse(flat[i + 1])
        if p[1] <= now then
            redis.call('HDEL', key, flat[i])
        else
            live = live + 1
            if p[1] > maxExp then maxExp = p[1] end
        end
    end
    return live, maxExp
end
-- Keep dl:users in step with the user's hash; returns U (users with a live lease).
local function syncUsers(usersKey, userId, live, maxExp, now, ttl)
    if live > 0 then
        redis.call('ZADD', usersKey, maxExp, userId)
        redis.call('PEXPIRE', usersKey, ttl * 4)
    else
        redis.call('ZREM', usersKey, userId)
    end
    redis.call('ZREMRANGEBYSCORE', usersKey, '-inf', now)
    return redis.call('ZCARD', usersKey)
end
`;

// KEYS[1]=lease hash, KEYS[2]=dl:users; ARGV: now, ttl, limit, field, userId
// Returns {0} rejected, or {1, L, U}.
const LUA_ACQUIRE =
    LUA_COMMON +
    `
local now, ttl, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local live = sweep(KEYS[1], now)
local v = redis.call('HGET', KEYS[1], ARGV[4])
if v then
    local p = parse(v)
    redis.call('HSET', KEYS[1], ARGV[4], pack(now + ttl, p[2] + 1, p[3], p[4], p[5]))
else
    if limit > 0 and live >= limit then
        syncUsers(KEYS[2], ARGV[5], live, 0, now, ttl)
        return {0}
    end
    redis.call('HSET', KEYS[1], ARGV[4], pack(now + ttl, 1, 0, now, 0))
end
redis.call('PEXPIRE', KEYS[1], ttl * 2)
local l, maxExp = sweep(KEYS[1], now)
return {1, l, syncUsers(KEYS[2], ARGV[5], l, maxExp, now, ttl)}
`;

// ARGV: now, ttl, field, userId, deltaBytes, bytesPerSec. Returns {L, U}.
const LUA_REFRESH =
    LUA_COMMON +
    `
local now, ttl = tonumber(ARGV[1]), tonumber(ARGV[2])
sweep(KEYS[1], now)
local v = redis.call('HGET', KEYS[1], ARGV[3])
local ref, bytes, started = 1, 0, now
if v then
    local p = parse(v)
    ref, bytes, started = p[2], p[3], p[4]
end
redis.call('HSET', KEYS[1], ARGV[3], pack(now + ttl, ref, bytes + tonumber(ARGV[5]), started, tonumber(ARGV[6])))
redis.call('PEXPIRE', KEYS[1], ttl * 2)
local l, maxExp = sweep(KEYS[1], now)
return {l, syncUsers(KEYS[2], ARGV[4], l, maxExp, now, ttl)}
`;

// ARGV: now, ttl, field, userId. Returns 1.
const LUA_RELEASE =
    LUA_COMMON +
    `
local now, ttl = tonumber(ARGV[1]), tonumber(ARGV[2])
sweep(KEYS[1], now)
local v = redis.call('HGET', KEYS[1], ARGV[3])
if v then
    local p = parse(v)
    if p[2] <= 1 then
        redis.call('HDEL', KEYS[1], ARGV[3])
    else
        redis.call('HSET', KEYS[1], ARGV[3], pack(p[1], p[2] - 1, p[3], p[4], p[5]))
    end
end
local l, maxExp = sweep(KEYS[1], now)
syncUsers(KEYS[2], ARGV[4], l, maxExp, now, ttl)
return 1
`;

// KEYS[1]=dl:users; ARGV: now. Returns flat [userId, field, value, ...].
const LUA_LIST = `
local now = tonumber(ARGV[1])
local out = {}
local users = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], '+inf')
for _, userId in ipairs(users) do
    local flat = redis.call('HGETALL', '${LEASE_KEY_PREFIX}' .. userId)
    for i = 1, #flat, 2 do
        local exp = tonumber(string.match(flat[i + 1], '^[^|]+'))
        if exp > now then
            out[#out + 1] = userId
            out[#out + 1] = flat[i]
            out[#out + 1] = flat[i + 1]
        end
    end
end
return out
`;

interface Script {
    src: string;
    sha: string;
    loaded: boolean;
}
const script = (src: string): Script => ({
    src,
    sha: crypto.createHash('sha1').update(src).digest('hex'),
    loaded: false,
});
const SCRIPTS = {
    acquire: script(LUA_ACQUIRE),
    refresh: script(LUA_REFRESH),
    release: script(LUA_RELEASE),
    list: script(LUA_LIST),
};

/** EVALSHA fast path, plain EVAL on first use and after NOSCRIPT (server restart / failover). */
async function run(
    client: ValkeyLike,
    s: Script,
    keys: string[],
    args: Array<string | number>,
): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args.map(String)];
    if (s.loaded) {
        try {
            return await client.customCommand(['EVALSHA', s.sha, ...tail]);
        } catch (err) {
            if (!isNoScriptError(err)) throw err;
            s.loaded = false;
        }
    }
    const result = await client.customCommand(['EVAL', s.src, ...tail]);
    s.loaded = true;
    return result;
}

const leaseKeyOf = (userId: string) => `${LEASE_KEY_PREFIX}${userId}`;

function lu(raw: unknown, offset: number): { l: number; u: number } {
    const arr = raw as unknown[];
    const l = Number(arr[offset]);
    const u = Number(arr[offset + 1]);
    if (!Number.isFinite(l) || !Number.isFinite(u))
        throw new Error('unexpected lease script result');
    return { l, u };
}

function valkeyBackend(client: ValkeyLike): Backend {
    return {
        async acquire(key, limit, now) {
            const raw = await run(
                client,
                SCRIPTS.acquire,
                [leaseKeyOf(key.userId), USERS_KEY],
                [now, LEASE_TTL_MS, limit, fieldOf(key), key.userId],
            );
            if (!Array.isArray(raw)) throw new Error('unexpected lease script result');
            return Number(raw[0]) === 1 ? lu(raw, 1) : null;
        },
        async refresh(key, deltaBytes, bytesPerSec, now) {
            const raw = await run(
                client,
                SCRIPTS.refresh,
                [leaseKeyOf(key.userId), USERS_KEY],
                [now, LEASE_TTL_MS, fieldOf(key), key.userId, deltaBytes, bytesPerSec],
            );
            if (!Array.isArray(raw)) throw new Error('unexpected lease script result');
            return lu(raw, 0);
        },
        async release(key, now) {
            await run(
                client,
                SCRIPTS.release,
                [leaseKeyOf(key.userId), USERS_KEY],
                [now, LEASE_TTL_MS, fieldOf(key), key.userId],
            );
        },
        async list(now) {
            const raw = await run(client, SCRIPTS.list, [USERS_KEY], [now]);
            const out: ActiveDownload[] = [];
            if (!Array.isArray(raw)) return out;
            for (let i = 0; i + 2 < raw.length; i += 3) {
                const field = String(raw[i + 1]);
                const sep = field.indexOf('|');
                const p = String(raw[i + 2])
                    .split('|')
                    .map(Number);
                out.push({
                    userId: String(raw[i]),
                    fileId: field.slice(0, sep),
                    deviceKey: field.slice(sep + 1),
                    bytesSent: p[2] ?? 0,
                    startedAt: p[3] ?? 0,
                    bytesPerSec: p[4] ?? 0,
                });
            }
            return out;
        },
    };
}

// ── public API ────────────────────────────────────────────────────────────────

function pickBackend(): Backend {
    const client = getCoordinationClient();
    return client ? valkeyBackend(client) : memoryBackend;
}

class Lease implements DownloadLease {
    private rate: number;
    private released = false;
    private lastBytes = 0;
    private lastAt: number;

    constructor(
        private readonly backend: Backend,
        private readonly key: LeaseKey,
        counts: { l: number; u: number },
        now: number,
    ) {
        this.rate = computeRate(counts.l, counts.u);
        this.lastAt = now;
    }

    rateBytesPerSec(): number {
        return this.rate;
    }

    async refresh(bytesSent: number): Promise<number> {
        if (this.released) return this.rate;
        const now = Date.now();
        const delta = Math.max(0, bytesSent - this.lastBytes);
        const dt = now - this.lastAt;
        const bytesPerSec = dt > 0 ? Math.round((delta * 1000) / dt) : 0;
        try {
            const counts = await this.backend.refresh(this.key, delta, bytesPerSec, now);
            this.lastBytes = bytesSent;
            this.lastAt = now;
            this.rate = computeRate(counts.l, counts.u);
        } catch (err) {
            // Keep streaming at the previous rate; the next tick retries.
            log.warn('lease refresh failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return this.rate;
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        try {
            await this.backend.release(this.key, Date.now());
        } catch (err) {
            // The lease expires on its own within LEASE_TTL_MS.
            log.warn('lease release failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Take a download slot for (user, file, device). Rejects when the user already
 * holds `DOWNLOAD_MAX_PARALLEL_PER_USER` live slots (0 = unlimited). If Valkey
 * errors, falls back to the process-local backend rather than blocking downloads.
 */
export async function acquireDownloadLease(key: LeaseKey): Promise<AcquireResult> {
    const limit = Math.max(0, Math.floor(config.DOWNLOAD_MAX_PARALLEL_PER_USER));
    const now = Date.now();
    let backend = pickBackend();
    let counts: { l: number; u: number } | null;
    try {
        counts = await backend.acquire(key, limit, now);
    } catch (err) {
        log.warn('shared lease acquire failed, using process-local leases', {
            err: err instanceof Error ? err.message : String(err),
        });
        backend = memoryBackend;
        counts = await backend.acquire(key, limit, now);
    }
    if (!counts) return { ok: false, retryAfterSec: RETRY_AFTER_SEC };
    return { ok: true, lease: new Lease(backend, key, counts, now) };
}

/** Live downloads across all replicas (process-local only without Valkey). */
export async function listActiveDownloads(): Promise<ActiveDownload[]> {
    const now = Date.now();
    try {
        return await pickBackend().list(now);
    } catch (err) {
        log.warn('listing shared leases failed, showing process-local leases', {
            err: err instanceof Error ? err.message : String(err),
        });
        return memoryBackend.list(now);
    }
}
