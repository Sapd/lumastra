// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detects /j clients that fetch PlaybackInfo and then never request a stream —
 * the silent failure mode of a Jellyfin app whose SDK cannot decode our answer.
 *
 * Arm (PlaybackInfo, POST with DeviceProfile, session auth): jfss:p:<playSessionId>
 * hash + jfss:ui:<username>:<itemId> → playSessionId + jfss:due zset (score = due ms).
 * jfss:dev:<userId>:<deviceId> set of the device's pending arms.
 * Disarm (any stream/HLS/download/Sessions/Playing[/Progress]): delete + zrem every
 * pending arm of the device, reset its miss streak. Sweep (every replica, 15 s):
 * one Lua call pops due members atomically, so each is claimed once across
 * replicas. A device reaching SILENT_START_STREAK misses within
 * SILENT_START_STREAK_WINDOW_S of the first (no start in between) — or one miss
 * whose response violated the SDK contract — writes one compat_incident per
 * (device, client version) per day.
 */
import crypto from 'node:crypto';
import type postgres from 'postgres';
import { getCoordinationClient } from '$lib/server/cache/valkey';
import { isNoScriptError } from '$lib/server/tasks/lua/loader';
import { insertClientDiagnostics } from '$lib/server/database/queries/client-diagnostics.queries';
import { deterministicUuidFrom } from '$lib/server/services/client-diagnostics/ingest.service';
import { Logger } from '$lib/server/utils/logger';
import { validateJellyfinResponse } from './contract/validate';

const logger = Logger.for('JellyfinCompat:SilentStart');
export const SILENT_START_DELAY_MS = 45_000;
export const SILENT_START_STREAK = 2;
const ARM_TTL_S = 600;
/**
 * Two misses count as a streak only within this window: the streak (and the misses
 * list) get their TTL when created and are never refreshed, so a miss today and one
 * next week on the same device are not "consecutive".
 */
export const SILENT_START_STREAK_WINDOW_S = 600;
let streakWindowS = SILENT_START_STREAK_WINDOW_S;
/** Once per (device, client version) per day. */
const REPORTED_TTL_S = 86_400;
const SWEEP_INTERVAL_MS = 15_000;
const SWEEP_BATCH = 100;
const MAX_MISSES_KEPT = 5;
const MAX_DEVICE_ARMS = 50;
const INCIDENT_NAMESPACE = 'b8e0f2a4-3c71-4d9e-9f26-5a1c0e7b3d48';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kArm = (ps: string): string => `jfss:p:${ps}`;
const kUi = (username: string, itemId: string): string => `jfss:ui:${username}:${itemId}`;
const kOwner = (ps: string): string => `jfss:o:${ps}`;
const K_DUE = 'jfss:due';
/** Every pending arm of one device: a start clears them all, not just the last PlaybackInfo's. */
const kDev = (userId: string, deviceId: string): string => `jfss:dev:${userId}:${deviceId}`;
const kStreak = (userId: string, deviceId: string): string => `jfss:streak:${userId}:${deviceId}`;
const kMisses = (userId: string, deviceId: string): string => `jfss:misses:${userId}:${deviceId}`;
const kReported = (userId: string, deviceId: string, client: string, version: string): string =>
    `jfss:reported:${userId}:${deviceId}:${client}|${version}`;

export interface StreamShape {
    type: string;
    codec: string | null;
    external: boolean;
    text: boolean;
}
export interface PlaybackShape {
    container: string | null;
    streams: StreamShape[];
}
export interface ArmInput {
    playSessionId: string;
    userId: string;
    username: string;
    deviceId: string;
    deviceName: string | null;
    clientName: string;
    clientVersion: string | null;
    itemId: string;
    response: unknown;
}
export interface MissRecord {
    itemId: string;
    armedAt: number;
    shape: PlaybackShape;
    violations: { pointer: string; property: string; kind: string; versions: string[] }[];
}

/** Structural, title-free description of the first media source (≤ 2 KB). */
export function shapeOf(response: unknown): PlaybackShape {
    const src = (response as { MediaSources?: Record<string, unknown>[] })?.MediaSources?.[0] ?? {};
    const streams = ((src.MediaStreams as Record<string, unknown>[] | undefined) ?? [])
        .slice(0, 24)
        .map((s) => ({
            type: String(s.Type ?? '?'),
            codec: typeof s.Codec === 'string' ? s.Codec.slice(0, 24) : null,
            external: s.IsExternal === true,
            text: s.IsTextSubtitleStream === true,
        }));
    return {
        container: typeof src.Container === 'string' ? src.Container.slice(0, 24) : null,
        streams,
    };
}

// Pops up to ARGV[2] members with score <= ARGV[1] — atomically, so concurrent
// sweepers on different replicas never claim the same member.
const LUA_CLAIM = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due > 0 then redis.call('ZREM', KEYS[1], unpack(due)) end
return due
`;
const LUA_CLAIM_SHA = crypto.createHash('sha1').update(LUA_CLAIM).digest('hex');
let claimLoaded = false;

// Streak + misses update in ONE script: a separate SET NX / INCR / LPUSH could straddle
// the key's expiry and re-create it without a TTL, so a device's streak never expired.
// KEYS = streak, misses; ARGV = window s, miss JSON, max misses kept. Returns the streak.
const LUA_MISS = `
if redis.call('SET', KEYS[1], 0, 'NX', 'EX', tonumber(ARGV[1])) then redis.call('DEL', KEYS[2]) end
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
redis.call('LPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[3]) - 1)
if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1])) end
return n
`;
const LUA_MISS_SHA = crypto.createHash('sha1').update(LUA_MISS).digest('hex');
let missLoaded = false;

type Client = NonNullable<ReturnType<typeof getCoordinationClient>>;

async function claimDue(client: Client, now: number): Promise<string[]> {
    const args = [K_DUE, String(now), String(SWEEP_BATCH)];
    if (claimLoaded) {
        try {
            return (
                ((await client.customCommand(['EVALSHA', LUA_CLAIM_SHA, '1', ...args])) as
                    string[] | null) ?? []
            );
        } catch (err) {
            if (!isNoScriptError(err)) throw err;
            claimLoaded = false;
        }
    }
    const res =
        ((await client.customCommand(['EVAL', LUA_CLAIM, '1', ...args])) as string[] | null) ?? [];
    claimLoaded = true;
    return res;
}

async function recordMiss(
    client: Client,
    streakKey: string,
    missesKey: string,
    miss: MissRecord,
): Promise<number> {
    const args = [
        '2',
        streakKey,
        missesKey,
        String(streakWindowS),
        JSON.stringify(miss),
        String(MAX_MISSES_KEPT),
    ];
    if (missLoaded) {
        try {
            return Number(await client.customCommand(['EVALSHA', LUA_MISS_SHA, ...args]));
        } catch (err) {
            if (!isNoScriptError(err)) throw err;
            missLoaded = false;
        }
    }
    const res = Number(await client.customCommand(['EVAL', LUA_MISS, ...args]));
    missLoaded = true;
    return res;
}

export async function armSilentStart(input: ArmInput): Promise<void> {
    try {
        const client = getCoordinationClient();
        if (!client) return;
        const errors = validateJellyfinResponse('POST', '/j/Items/x/PlaybackInfo', input.response, {
            clientName: input.clientName,
        })
            .violations.filter((v) => v.severity === 'error')
            .slice(0, 10)
            .map((v) => ({
                pointer: v.pointer,
                property: v.property,
                kind: v.kind,
                versions: v.versions,
            }));
        // Raw jfDevice.clientVersion (≤96 graphemes, may end in '…'); same rule as client-log-bundle.ts.
        const clientVersion = (input.clientVersion ?? '').replace(/…$/, '').slice(0, 32);
        const fields = {
            userId: input.userId,
            username: input.username,
            deviceId: input.deviceId,
            deviceName: input.deviceName ?? '',
            clientName: input.clientName,
            clientVersion,
            itemId: input.itemId,
            armedAt: String(Date.now()),
            shape: JSON.stringify(shapeOf(input.response)),
            violations: JSON.stringify(errors),
        };
        const key = kArm(input.playSessionId);
        await client.customCommand(['HSET', key, ...Object.entries(fields).flat()]);
        await client.customCommand(['EXPIRE', key, String(ARM_TTL_S)]);
        await client.customCommand([
            'SET',
            kUi(input.username, input.itemId),
            input.playSessionId,
            'EX',
            String(ARM_TTL_S),
        ]);
        await client.customCommand([
            'SET',
            kOwner(input.playSessionId),
            `${input.userId}|${input.deviceId}`,
            'EX',
            String(ARM_TTL_S),
        ]);
        const devKey = kDev(input.userId, input.deviceId);
        await client.customCommand(['SADD', devKey, input.playSessionId]);
        await client.customCommand(['EXPIRE', devKey, String(ARM_TTL_S)]);
        // Bound the set (a client can fetch PlaybackInfo in a loop): drop random excess
        // members. A dropped arm is still cleared by its own PlaySessionId / (user, item).
        const over = Number(await client.customCommand(['SCARD', devKey])) - MAX_DEVICE_ARMS;
        if (over > 0) await client.customCommand(['SPOP', devKey, String(over)]);
        await client.customCommand([
            'ZADD',
            K_DUE,
            String(Date.now() + SILENT_START_DELAY_MS),
            input.playSessionId,
        ]);
    } catch (err) {
        logger.debug('arm failed', { error: String(err) });
    }
}

/**
 * A start (stream / HLS / download / Sessions/Playing). Resolves the device from
 * the explicit `userId`+`deviceId`, else from the PlaySessionId, else from
 * (username, itemId) — via owner/ui records that outlive the sweeper's claim for
 * ARM_TTL_S, so a late start (after the miss was counted) still resets the streak.
 */
export async function disarmSilentStart(k: {
    playSessionId?: string | null;
    username?: string | null;
    itemId?: string | null;
    userId?: string | null;
    deviceId?: string | null;
}): Promise<void> {
    try {
        const client = getCoordinationClient();
        if (!client) return;
        let ps = k.playSessionId ?? null;
        let owner: string | null = null;
        if (ps)
            owner = ((await client.customCommand(['GET', kOwner(ps)])) as string | null) ?? null;
        if (!owner && k.username && k.itemId) {
            ps =
                ((await client.customCommand(['GET', kUi(k.username, k.itemId)])) as
                    string | null) ?? null;
            if (ps)
                owner =
                    ((await client.customCommand(['GET', kOwner(ps)])) as string | null) ?? null;
        }
        let userId = k.userId ?? null;
        let deviceId = k.deviceId ?? null;
        if ((!userId || !deviceId) && owner) {
            const i = owner.indexOf('|');
            userId = owner.slice(0, i);
            deviceId = owner.slice(i + 1);
        }
        const pending = new Set<string>(ps ? [ps] : []);
        if (userId && deviceId) {
            // A client often fetches PlaybackInfo more than once per play (each
            // overwrites jfss:ui), so earlier arms would otherwise be orphaned and
            // each count as a miss. A start proves the device works: clear them all.
            const devKey = kDev(userId, deviceId);
            const members =
                ((await client.customCommand(['SMEMBERS', devKey])) as string[] | null) ?? [];
            for (const m of members) pending.add(String(m));
            await client.customCommand(['DEL', devKey]);
        }
        if (pending.size > 0) {
            const ids = [...pending];
            await client.customCommand(['DEL', ...ids.map(kArm)]);
            await client.customCommand(['ZREM', K_DUE, ...ids]);
        }
        if (userId && deviceId)
            await client.customCommand([
                'DEL',
                kStreak(userId, deviceId),
                kMisses(userId, deviceId),
            ]);
    } catch (err) {
        logger.debug('disarm failed', { error: String(err) });
    }
}

export async function sweepSilentStarts(
    sql: postgres.Sql,
    now: number = Date.now(),
): Promise<number> {
    const client = getCoordinationClient();
    if (!client) return 0;
    const claimed = await claimDue(client, now);
    for (const ps of claimed) {
        try {
            await handleMiss(sql, client, ps);
        } catch (err) {
            logger.warn('silent-start miss handling failed', { error: String(err) });
        }
    }
    return claimed.length;
}

async function handleMiss(sql: postgres.Sql, client: Client, ps: string): Promise<void> {
    // Glide returns HGETALL as [{ key, value }, …]; tolerate a plain object / flat array too.
    const flat = (await client.customCommand(['HGETALL', kArm(ps)])) as
        { key: string; value: string }[] | Record<string, string> | string[] | null;
    await client.customCommand(['DEL', kArm(ps)]);
    let h: Record<string, string> = {};
    if (Array.isArray(flat)) {
        if (flat.length > 0 && typeof flat[0] === 'object') {
            h = Object.fromEntries(
                (flat as { key: string; value: string }[]).map((e) => [
                    String(e.key),
                    String(e.value),
                ]),
            );
        } else {
            const f = flat as string[];
            h = Object.fromEntries(
                Array.from({ length: f.length / 2 }, (_, i) => [f[2 * i], f[2 * i + 1]]),
            );
        }
    } else if (flat) {
        h = flat;
    }
    if (!h.userId || !h.deviceId) return; // expired between claim and read
    // The arm is claimed: it no longer belongs in the device's pending set.
    await client.customCommand(['SREM', kDev(h.userId, h.deviceId), ps]);
    const miss: MissRecord = {
        itemId: h.itemId,
        armedAt: Number(h.armedAt),
        shape: JSON.parse(h.shape),
        violations: JSON.parse(h.violations),
    };
    logger.info('PlaybackInfo was not followed by playback', {
        client: h.clientName,
        clientVersion: h.clientVersion,
        deviceId: h.deviceId,
        itemId: h.itemId,
        shape: miss.shape,
        violations: miss.violations.length,
    });
    // The window starts at the first miss and is never extended (no re-EXPIRE).
    const streakKey = kStreak(h.userId, h.deviceId);
    const missesKey = kMisses(h.userId, h.deviceId);
    const streak = await recordMiss(client, streakKey, missesKey, miss);
    if (streak < SILENT_START_STREAK && miss.violations.length === 0) return;

    const set = await client.customCommand([
        'SET',
        kReported(h.userId, h.deviceId, h.clientName, h.clientVersion),
        '1',
        'NX',
        'EX',
        String(REPORTED_TTL_S),
    ]);
    if (set !== 'OK') return;
    const misses = (
        ((await client.customCommand(['LRANGE', kMisses(h.userId, h.deviceId), '0', '-1'])) as
            string[] | null) ?? []
    ).map((m) => JSON.parse(m) as MissRecord);
    const payload = {
        source: 'jellyfin_compat',
        reason: 'silent_start',
        clientName: h.clientName,
        clientVersion: h.clientVersion,
        deviceName: h.deviceName,
        misses,
    };
    const day = new Date().toISOString().slice(0, 10);
    try {
        await insertClientDiagnostics(sql, [
            {
                eventId: deterministicUuidFrom(
                    INCIDENT_NAMESPACE,
                    `${h.userId}:${h.deviceId}:${h.clientName}|${h.clientVersion}:${day}`,
                ),
                kind: 'compat_incident',
                userId: h.userId,
                deviceId: h.deviceId,
                platform: 'other',
                appVersion: h.clientVersion ? h.clientVersion.slice(0, 32) : null,
                appBuild: null,
                osVersion: null,
                deviceModel: null,
                playSessionId: ps,
                attemptId: null,
                mediaId: UUID_RE.test(miss.itemId) ? miss.itemId : null,
                occurredAt: new Date(miss.armedAt),
                fingerprint: null,
                occurrences: misses.length,
                summary:
                    `Jellyfin ${h.clientName} ${h.clientVersion}: playback never started after PlaybackInfo (${misses.length}×)`.slice(
                        0,
                        200,
                    ),
                payload,
                payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
            },
        ]);
    } catch (err) {
        // The once-a-day marker must not outlive a failed write, or the day's
        // incident is lost: the next miss gets to try again.
        await client
            .customCommand(['DEL', kReported(h.userId, h.deviceId, h.clientName, h.clientVersion)])
            .catch(() => undefined);
        throw err;
    }
}

/** Tests only: shrink the streak window so expiry can be observed without waiting 10 min. */
export function __setSilentStartStreakWindowForTests(seconds: number | null): void {
    streakWindowS = seconds ?? SILENT_START_STREAK_WINDOW_S;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startSilentStartSweeper(getSql: () => Promise<postgres.Sql | null>): void {
    if (timer) return;
    timer = setInterval(() => {
        if (running) return;
        running = true;
        void (async () => {
            try {
                const sql = await getSql();
                if (sql) await sweepSilentStarts(sql);
            } catch (err) {
                logger.warn('silent-start sweep failed', { error: String(err) });
            } finally {
                running = false;
            }
        })();
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
}

export function stopSilentStartSweeper(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
