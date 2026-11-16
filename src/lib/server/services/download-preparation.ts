// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admission for the preparation of a ZIP download (listing every file and checking each one).
 *
 * Preparation is real work done BEFORE the response starts, for GET and HEAD alike, so it is
 * limited on its own: at most one running preparation per user and PREP_SERVER_MAX across the
 * server, each for at most PREP_DEADLINE_MS. Over the limit the caller answers 429.
 *
 * Shared in Valkey (one sorted set per scope, member = a random token, score = expiry, Valkey's
 * own clock) so replicas agree; without Valkey, or when it errors, the same check runs on a
 * process-local Map (each replica then enforces its own limits, as for download leases). Every
 * entry expires on its own, so a crashed replica leaks nothing.
 */

import crypto from 'node:crypto';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { isNoScriptError } from '$lib/server/tasks/lua/loader.js';
import type { ValkeyLike } from '$lib/server/tasks/valkey-types.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('DownloadPreparation');

/** A preparation that runs longer than this is abandoned (the request answers 503). */
export const PREP_DEADLINE_MS = 60_000;
export const PREP_PER_USER_MAX = 1;
export const PREP_SERVER_MAX = 4;
/**
 * Safety expiry only (a crashed replica leaks nothing). The caller releases the slot itself the
 * moment the work ends or is abandoned at the deadline, without waiting for hung I/O.
 */
const ENTRY_TTL_MS = PREP_DEADLINE_MS + 30_000;
const RETRY_AFTER_SEC = 5;
const VALKEY_TIMEOUT_MS = 2_000;

export type PreparationAdmission =
    { ok: true; release(): Promise<void> } | { ok: false; retryAfterSec: number };

const ALL_KEY = 'dl:v2:prep:all';
const userKeyOf = (userId: string) => `dl:v2:prep:user:${userId}`;

// ── process-local fallback ────────────────────────────────────────────────────

const local = new Map<string, { userId: string; expiresAt: number }>();

/** Test hook. */
export function resetDownloadPreparationForTests(): void {
    local.clear();
}

function localAcquire(userId: string, token: string): boolean {
    const now = Date.now();
    let all = 0;
    let mine = 0;
    for (const [t, e] of local) {
        if (e.expiresAt <= now) {
            local.delete(t);
            continue;
        }
        all += 1;
        if (e.userId === userId) mine += 1;
    }
    if (mine >= PREP_PER_USER_MAX || all >= PREP_SERVER_MAX) return false;
    local.set(token, { userId, expiresAt: now + ENTRY_TTL_MS });
    return true;
}

// ── Valkey ────────────────────────────────────────────────────────────────────

// KEYS[1]=all, KEYS[2]=user; ARGV: ttlMs, perUser, serverMax, token. Returns 1 admitted, 0 refused.
const LUA_ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) or redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
    return 0
end
local exp = string.format('%.0f', now + tonumber(ARGV[1]))
redis.call('ZADD', KEYS[1], exp, ARGV[4])
redis.call('ZADD', KEYS[2], exp, ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[1]) * 2)
return 1
`;
const LUA_RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

const sha = (src: string) => crypto.createHash('sha1').update(src).digest('hex');
const loaded = new Set<string>();

async function evalScript(
    client: ValkeyLike,
    src: string,
    keys: string[],
    args: Array<string | number>,
): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args.map(String)];
    const run = async (): Promise<unknown> => {
        const id = sha(src);
        if (loaded.has(id)) {
            try {
                return await client.customCommand(['EVALSHA', id, ...tail]);
            } catch (err) {
                if (!isNoScriptError(err)) throw err;
                loaded.delete(id);
            }
        }
        const r = await client.customCommand(['EVAL', src, ...tail]);
        loaded.add(id);
        return r;
    };
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Valkey call timed out')), VALKEY_TIMEOUT_MS);
    });
    return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Take a preparation slot for `userId`. `release()` is idempotent and never throws; call it
 * when the work really ended (also after a deadline, once the abandoned work settled).
 */
export async function acquirePreparation(userId: string): Promise<PreparationAdmission> {
    const token = crypto.randomUUID();
    const client = getCoordinationClient();
    if (client) {
        try {
            const r = await evalScript(
                client,
                LUA_ACQUIRE,
                [ALL_KEY, userKeyOf(userId)],
                [ENTRY_TTL_MS, PREP_PER_USER_MAX, PREP_SERVER_MAX, token],
            );
            if (Number(r) !== 1) return { ok: false, retryAfterSec: RETRY_AFTER_SEC };
            let released = false;
            return {
                ok: true,
                release: async () => {
                    if (released) return;
                    released = true;
                    try {
                        await evalScript(
                            client,
                            LUA_RELEASE,
                            [ALL_KEY, userKeyOf(userId)],
                            [token],
                        );
                    } catch (err) {
                        log.warn('preparation release failed', {
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                },
            };
        } catch (err) {
            log.warn('preparation admission fell back to process-local', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (!localAcquire(userId, token)) return { ok: false, retryAfterSec: RETRY_AFTER_SEC };
    return {
        ok: true,
        release: async () => {
            local.delete(token);
        },
    };
}
