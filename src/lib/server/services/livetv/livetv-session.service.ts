// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type { LiveTvStreamInfo } from '$lib/schemas/livetv.js';
import { TimeUnit } from '@valkey/valkey-glide';
import { scanKeysOrThrow } from '$lib/server/cache/valkey';
import { getCoordinationClient } from '$lib/server/cache/valkey';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger.js';
import type { LiveTvFeedTried } from '$lib/server/api/problem.js';
import type { LiveTvFailureReason } from '../../../../shared/livetv-failure-reason.js';

const logger = Logger.for('LiveTvSessionService');

export interface LiveTvSessionEntry {
    viewerKey: string;
    username: string;
    channelId: string;
    sourceId: string;
    priority: 'high' | 'low';
    startedAt: number; // unix ms
}

function sessionKey(viewerKey: string): string {
    return `livetv:v2:session:${viewerKey}`;
}
function sourceSetKey(sourceId: string): string {
    return `livetv:v2:source:${sourceId}:sessions`;
}
function legacySessionKey(username: string): string {
    return `livetv:v1:session:${username}`;
}
function legacySourceSetKey(sourceId: string): string {
    return `livetv:v1:source:${sourceId}:sessions`;
}
function kickedKey(viewerKey: string): string {
    return `livetv:v2:kicked:${viewerKey}`;
}
function sessionTtl(): number {
    return config.LIVETV_VIEWER_TIMEOUT_SECONDS + config.LIVETV_GRACE_PERIOD_SECONDS + 60;
}

export type PlaybackEndReason = 'evicted' | 'superseded' | 'left' | 'expired' | 'failed';

/** Why a session ended with `failed`. `feedsTried` is shown to admins only. */
export interface PlaybackFailure {
    code: LiveTvFailureReason;
    retryable: boolean;
    retryAfterMs?: number;
    /** ISO 8601 */
    at: string;
    feedsTried?: LiveTvFeedTried[];
}

export interface LiveTvPlaybackSession {
    sessionId: string;
    viewerKey: string;
    username: string;
    userId?: string;
    deviceId?: string;
    deviceSessionId?: string;
    deviceName?: string;
    clientName?: string;
    userAgent?: string;
    stationId: string;
    feedId: string;
    sourceId: string;
    startedAt: number;
    state: 'active' | 'ended';
    endReason?: PlaybackEndReason;
    /** Set when endReason is `failed`. */
    failure?: PlaybackFailure;
    /** A hover preview is its own viewer and not a playback session in any now-playing list. */
    kind?: 'playback' | 'preview';
    /**
     * The station's feeds (id + name) in the order their URLs were sent to the proxy, so a
     * heartbeat failure's `feedsTried` indexes can be translated. Never sent to a client.
     */
    feeds?: Array<{ id: string; name: string }>;
    adaptive?: LiveTvStreamInfo['adaptive'];
    variant?: LiveTvStreamInfo['variant'];
    rungId?: string | null;
    appliedMaxHeight?: number | null;
    appliedMaxBitrateBps?: number | null;
}

function playbackKey(id: string): string {
    return `livetv:v2:psess:${id}`;
}
function playbackPointer(viewerKey: string): string {
    return `livetv:v2:viewer-psess:${viewerKey}`;
}

// Flips the state with a string replace, not cjson decode/encode: cjson turns an empty
// array (adaptive.rungs) into `{}`, which would corrupt the stored record.
const LUA_END_PLAYBACK = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if string.find(raw, '"state":"ended"', 1, true) then return 0 end
local ended = '"state":"ended","endReason":"' .. ARGV[1] .. '"'
if ARGV[3] and ARGV[3] ~= '' then ended = ended .. ',"failure":' .. ARGV[3] end
local replaced, n = string.gsub(raw, '"state":"active"', (string.gsub(ended, '%%', '%%%%')), 1)
if n == 0 then return 0 end
redis.call('SET', KEYS[1], replaced, 'EX', ARGV[2])
return 1
`;
const LUA_DELETE_POINTER = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

export interface LiveTvSessionService {
    startPlaybackSession(
        entry: Omit<LiveTvPlaybackSession, 'sessionId' | 'startedAt' | 'state'>,
    ): Promise<LiveTvPlaybackSession>;
    getPlaybackSession(sessionId: string): Promise<LiveTvPlaybackSession | null>;
    /** Read-only liveness view: never ends a session or revokes grants. Throws when the store is down. */
    peekPlaybackSession(sessionId: string): Promise<LiveTvPlaybackSession | null>;
    getViewerPlaybackSession(viewerKey: string): Promise<LiveTvPlaybackSession | null>;
    endPlaybackSession(
        sessionId: string,
        reason: PlaybackEndReason,
        failure?: PlaybackFailure,
    ): Promise<void>;
    endViewerPlaybackSession(
        viewerKey: string,
        feedId: string,
        reason: PlaybackEndReason,
    ): Promise<void>;
    releasePlaybackSession(session: LiveTvPlaybackSession): Promise<boolean>;
    refreshPlaybackSession(session: LiveTvPlaybackSession): Promise<void>;

    registerSession(
        viewerKey: string,
        username: string,
        channelId: string,
        sourceId: string,
        priority: 'high' | 'low',
    ): Promise<void>;
    refreshSession(viewerKey: string): Promise<boolean>;
    removeSession(viewerKey: string, sourceId: string): Promise<void>;
    /**
     * Removes the viewer's session only when it is for `channelId` (atomic compare and
     * delete). A delayed leave for channel A must not delete the live session the same
     * viewer has since registered for channel B.
     */
    removeSessionIfChannel(
        viewerKey: string,
        sourceId: string,
        channelId: string,
    ): Promise<boolean>;
    getSession(viewerKey: string): Promise<LiveTvSessionEntry | null>;
    getSourceViewers(sourceId: string): Promise<LiveTvSessionEntry[]>;
    /** `channelId`: the channel the viewer was evicted from; the flag applies to that channel only. */
    markKicked(viewerKey: string, reason: string, channelId?: string): Promise<void>;
    /** A flag with a channel only applies to joins of that channel; one without applies to all. */
    checkKicked(viewerKey: string, channelId?: string): Promise<KickedStatus>;
    /** Atomically takes the flag (GETDEL): exactly one concurrent caller sees `kicked: true`. */
    consumeKicked(viewerKey: string, channelId?: string): Promise<KickedStatus>;
    clearKicked(viewerKey: string): Promise<void>;
}

export type KickedStatus = { kicked: true; reason: string } | { kicked: false };

interface KickedFlag {
    reason: string;
    kickedAt: number;
    channelId?: string;
}

function parseKickedFlag(raw: unknown): KickedFlag | null {
    if (!raw) return null;
    try {
        const data = JSON.parse(String(raw)) as KickedFlag;
        return typeof data?.reason === 'string' ? data : null;
    } catch {
        return null;
    }
}

function kickedAppliesTo(flag: KickedFlag, channelId: string | undefined): boolean {
    return !flag.channelId || channelId === undefined || flag.channelId === channelId;
}

// Single key, so it is safe on a clustered Valkey. Returns 1 when the session is gone
// afterwards (deleted or already absent) and 0 when it belongs to another channel.
const LUA_REMOVE_IF_CHANNEL = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 1 end
local ok, entry = pcall(cjson.decode, raw)
if ok and type(entry) == 'table' and entry.channelId ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

export function createLiveTvSessionService(): LiveTvSessionService {
    return {
        async startPlaybackSession(input) {
            const client = getCoordinationClient();
            if (!client) throw new Error('Live TV session store unavailable');
            const entry: LiveTvPlaybackSession = {
                ...input,
                sessionId: randomUUID(),
                startedAt: Date.now(),
                state: 'active',
            };
            await client.set(playbackKey(entry.sessionId), JSON.stringify(entry), {
                expiry: { type: TimeUnit.Seconds, count: sessionTtl() },
            });
            // SET GET with EX swaps the pointer and its TTL atomically (one key).
            const previous = await client.customCommand([
                'SET',
                playbackPointer(entry.viewerKey),
                entry.sessionId,
                'GET',
                'EX',
                String(sessionTtl()),
            ]);
            if (previous)
                await this.endPlaybackSession(String(previous), 'superseded').catch(
                    (error: unknown) => {
                        logger.warn(
                            'Failed to persist superseded session; pointer remains authoritative',
                            { error: String(error) },
                        );
                    },
                );
            return entry;
        },
        async getViewerPlaybackSession(viewerKey) {
            const client = getCoordinationClient();
            if (!client) return null;
            const id = await client.get(playbackPointer(viewerKey));
            return id ? this.getPlaybackSession(String(id)) : null;
        },
        async peekPlaybackSession(id) {
            const client = getCoordinationClient();
            if (!client) throw new Error('Live TV session store unavailable');
            const raw = await client.get(playbackKey(id));
            if (!raw) return null;
            const entry = JSON.parse(String(raw)) as LiveTvPlaybackSession;
            if (entry.state === 'active') {
                const current = await client.get(playbackPointer(entry.viewerKey));
                if (String(current ?? '') !== id) {
                    return {
                        ...entry,
                        state: 'ended',
                        endReason: current ? 'superseded' : 'expired',
                    };
                }
            }
            return entry;
        },
        async getPlaybackSession(id) {
            const client = getCoordinationClient();
            if (!client) throw new Error('Live TV session store unavailable');
            const raw = await client.get(playbackKey(id));
            if (!raw) {
                await this.endPlaybackSession(id, 'expired');
                return null;
            }
            const entry = JSON.parse(String(raw)) as LiveTvPlaybackSession;
            if (entry.state === 'active') {
                const current = await client.get(playbackPointer(entry.viewerKey));
                if (String(current ?? '') !== id) {
                    const endReason = current ? 'superseded' : 'expired';
                    await this.endPlaybackSession(id, endReason);
                    return { ...entry, state: 'ended', endReason };
                }
            }
            return entry;
        },
        async endPlaybackSession(id, reason, failure) {
            const client = getCoordinationClient();
            if (!client) throw new Error('Live TV session store unavailable');
            await client.customCommand([
                'EVAL',
                LUA_END_PLAYBACK,
                '1',
                playbackKey(id),
                reason,
                String(sessionTtl()),
                ...(failure ? [JSON.stringify(failure)] : []),
            ]);
            // All explicit lifecycle paths converge here, including pointer expiry.
            const { revokeGrantsForPlaySession } = await import('../playback-grant.js');
            const grantReason = {
                left: 'stopped',
                superseded: 'superseded',
                evicted: 'admin_kill',
                expired: 'reaped',
                failed: 'reaped',
            } as const;
            await revokeGrantsForPlaySession(id, undefined, grantReason[reason]);
        },
        async endViewerPlaybackSession(viewerKey, feedId, reason) {
            const client = getCoordinationClient();
            if (!client) return;
            const id = await client.get(playbackPointer(viewerKey));
            if (!id) return;
            const entry = await this.getPlaybackSession(String(id));
            if (entry?.feedId === feedId) await this.endPlaybackSession(entry.sessionId, reason);
        },
        async releasePlaybackSession(entry) {
            const client = getCoordinationClient();
            if (!client) throw new Error('Live TV session store unavailable');
            await this.endPlaybackSession(entry.sessionId, 'left');
            const released = await client.customCommand([
                'EVAL',
                LUA_DELETE_POINTER,
                '1',
                playbackPointer(entry.viewerKey),
                entry.sessionId,
            ]);
            return Number(released) === 1;
        },
        async refreshPlaybackSession(entry) {
            const client = getCoordinationClient();
            if (!client) return;
            const current = await client.get(playbackPointer(entry.viewerKey));
            if (String(current ?? '') !== entry.sessionId) return;
            await Promise.all([
                client.expire(playbackKey(entry.sessionId), sessionTtl()),
                client.expire(playbackPointer(entry.viewerKey), sessionTtl()),
                this.refreshSession(entry.viewerKey),
            ]);
        },
        async registerSession(viewerKey, username, channelId, sourceId, priority) {
            try {
                const client = getCoordinationClient();
                if (!client) return;
                // Every join re-registers (the /stream call, then the master playlist, then
                // any reload), so keep the original start on the same channel: the kick
                // policy orders viewers by how long they have been watching.
                const previousRaw = await client.get(sessionKey(viewerKey)).catch(() => null);
                let startedAt = Date.now();
                if (previousRaw) {
                    try {
                        const previous = JSON.parse(String(previousRaw)) as LiveTvSessionEntry;
                        if (
                            previous.channelId === channelId &&
                            previous.sourceId === sourceId &&
                            Number.isFinite(previous.startedAt) &&
                            previous.startedAt <= Date.now()
                        ) {
                            startedAt = previous.startedAt;
                        }
                    } catch {
                        // Unreadable entry: start fresh.
                    }
                }
                const entry: LiveTvSessionEntry = {
                    viewerKey,
                    username,
                    channelId,
                    sourceId,
                    priority,
                    startedAt,
                };
                const ttl = sessionTtl();
                await Promise.all([
                    client.set(sessionKey(viewerKey), JSON.stringify(entry), {
                        expiry: { type: TimeUnit.Seconds, count: ttl },
                    }),
                    client.sadd(sourceSetKey(sourceId), [viewerKey]),
                ]);
            } catch (err) {
                logger.warn('livetv-session: failed to register session', {
                    err,
                    viewerKey,
                    username,
                    channelId,
                });
            }
        },

        async refreshSession(viewerKey) {
            try {
                const client = getCoordinationClient();
                if (!client) return true; // fail open
                const result = await client.expire(sessionKey(viewerKey), sessionTtl());
                return result === true; // true = key exists and TTL was set
            } catch (err) {
                logger.warn('livetv-session: failed to refresh session', {
                    err,
                    viewerKey,
                });
                return true; // fail open — proxy is source of truth
            }
        },

        async removeSession(viewerKey, sourceId) {
            try {
                const client = getCoordinationClient();
                if (!client) return;
                await Promise.all([
                    client.del([sessionKey(viewerKey)]),
                    client.srem(sourceSetKey(sourceId), [viewerKey]),
                ]);
            } catch (err) {
                logger.warn('livetv-session: failed to remove session', {
                    err,
                    viewerKey,
                });
            }
        },

        async removeSessionIfChannel(viewerKey, sourceId, channelId) {
            try {
                const client = getCoordinationClient();
                if (!client) return false;
                const removed = await client.customCommand([
                    'EVAL',
                    LUA_REMOVE_IF_CHANNEL,
                    '1',
                    sessionKey(viewerKey),
                    channelId,
                ]);
                if (Number(removed) !== 1) {
                    // Legacy play-token viewers use the username as their viewer key.
                    if (!(await client.get(legacySessionKey(viewerKey)))) return false;
                    const legacyRemoved = await client.customCommand([
                        'EVAL',
                        LUA_REMOVE_IF_CHANNEL,
                        '1',
                        legacySessionKey(viewerKey),
                        channelId,
                    ]);
                    if (Number(legacyRemoved) !== 1) return false;
                    await client.srem(legacySourceSetKey(sourceId), [viewerKey]);
                    return true;
                }
                await client.srem(sourceSetKey(sourceId), [viewerKey]);
                return true;
            } catch (err) {
                logger.warn('livetv-session: failed to conditionally remove session', {
                    err,
                    viewerKey,
                });
                return false;
            }
        },

        async getSession(viewerKey) {
            try {
                const client = getCoordinationClient();
                if (!client) return null;
                const raw = await client.get(sessionKey(viewerKey));
                if (!raw) return null;
                return JSON.parse(raw as string) as LiveTvSessionEntry;
            } catch (err) {
                logger.warn('livetv-session: failed to get session', {
                    err,
                    viewerKey,
                });
                return null;
            }
        },

        async getSourceViewers(sourceId) {
            try {
                const client = getCoordinationClient();
                if (!client) return [];
                const [viewerKeyValues, legacyUsernameValues] = await Promise.all([
                    client.smembers(sourceSetKey(sourceId)),
                    client.smembers(legacySourceSetKey(sourceId)),
                ]);
                const viewerKeys = Array.from(viewerKeyValues).map((v) => v.toString());
                const legacyUsernames = Array.from(legacyUsernameValues).map((v) => v.toString());
                if (!viewerKeys.length && !legacyUsernames.length) return [];

                const [sessionData, legacySessionData] = await Promise.all([
                    Promise.all(viewerKeys.map((viewerKey) => client.get(sessionKey(viewerKey)))),
                    Promise.all(
                        legacyUsernames.map((username) => client.get(legacySessionKey(username))),
                    ),
                ]);

                const stale: string[] = [];
                const entries: LiveTvSessionEntry[] = [];
                for (let i = 0; i < viewerKeys.length; i++) {
                    const raw = sessionData[i];
                    if (!raw) {
                        stale.push(viewerKeys[i]);
                    } else {
                        try {
                            const entry = JSON.parse(raw as string) as LiveTvSessionEntry;
                            // A viewer can switch sources before the old source-set
                            // membership is removed. Do not let that stale index entry
                            // count the viewer against, or evict them from, the old source.
                            if (entry.sourceId === sourceId && entry.viewerKey === viewerKeys[i]) {
                                entries.push(entry);
                            } else {
                                stale.push(viewerKeys[i]);
                            }
                        } catch {
                            stale.push(viewerKeys[i]);
                        }
                    }
                }
                // Clean up stale set entries (pass as array, not spread)
                if (stale.length) {
                    await client.srem(sourceSetKey(sourceId), stale).catch(() => {});
                }

                // Rolling-upgrade bridge: v1 entries were keyed by username and can
                // remain live for one session TTL while app instances update. Preserve
                // the old viewer id so eviction still addresses the matching proxy
                // session, then remove stale v1 index members as they expire.
                const staleLegacy: string[] = [];
                for (let i = 0; i < legacyUsernames.length; i++) {
                    const raw = legacySessionData[i];
                    if (!raw) {
                        staleLegacy.push(legacyUsernames[i]);
                        continue;
                    }
                    try {
                        const entry = JSON.parse(raw as string) as Omit<
                            LiveTvSessionEntry,
                            'viewerKey'
                        >;
                        if (entry.sourceId === sourceId && entry.username === legacyUsernames[i]) {
                            entries.push({ ...entry, viewerKey: legacyUsernames[i] });
                        } else {
                            staleLegacy.push(legacyUsernames[i]);
                        }
                    } catch {
                        staleLegacy.push(legacyUsernames[i]);
                    }
                }
                if (staleLegacy.length) {
                    await client.srem(legacySourceSetKey(sourceId), staleLegacy).catch(() => {});
                }
                return entries;
            } catch (err) {
                logger.warn('livetv-session: failed to get source viewers', {
                    err,
                    sourceId,
                });
                return [];
            }
        },

        async markKicked(viewerKey, reason, channelId) {
            try {
                const client = getCoordinationClient();
                if (!client) return;
                const flag: KickedFlag = { reason, kickedAt: Date.now(), channelId };
                await client.set(kickedKey(viewerKey), JSON.stringify(flag), {
                    expiry: { type: TimeUnit.Seconds, count: 120 },
                });
            } catch (err) {
                logger.warn('livetv-session: failed to mark kicked', {
                    err,
                    viewerKey,
                });
            }
        },

        async checkKicked(viewerKey, channelId) {
            try {
                const client = getCoordinationClient();
                if (!client) return { kicked: false };
                const flag = parseKickedFlag(await client.get(kickedKey(viewerKey)));
                if (!flag || !kickedAppliesTo(flag, channelId)) return { kicked: false };
                return { kicked: true, reason: flag.reason };
            } catch (err) {
                logger.warn('livetv-session: failed to check kicked', {
                    err,
                    viewerKey,
                });
                return { kicked: false };
            }
        },

        async consumeKicked(viewerKey, channelId) {
            try {
                const client = getCoordinationClient();
                if (!client) return { kicked: false };
                const peeked = parseKickedFlag(await client.get(kickedKey(viewerKey)));
                if (!peeked || !kickedAppliesTo(peeked, channelId)) return { kicked: false };
                // GETDEL: of several concurrent keepalives only one takes the flag.
                const taken = parseKickedFlag(await client.getdel(kickedKey(viewerKey)));
                if (!taken) return { kicked: false };
                return { kicked: true, reason: taken.reason };
            } catch (err) {
                logger.warn('livetv-session: failed to consume kicked', {
                    err,
                    viewerKey,
                });
                return { kicked: false };
            }
        },

        async clearKicked(viewerKey) {
            try {
                const client = getCoordinationClient();
                if (!client) return;
                await client.del([kickedKey(viewerKey)]);
            } catch (err) {
                logger.warn('livetv-session: failed to clear kicked', {
                    err,
                    viewerKey,
                });
            }
        },
    };
}

// Singleton
let _instance: LiveTvSessionService | null = null;
export function getLiveTvSessionService(): LiveTvSessionService {
    _instance ??= createLiveTvSessionService();
    return _instance;
}

/** Read-only inventory: pointer ownership and heartbeat TTL exclude ended/orphaned viewers. */
export async function listActiveLiveTvPlaybackSessions(): Promise<LiveTvPlaybackSession[]> {
    const client = getCoordinationClient();
    if (!client) throw new Error('Live TV session store unavailable');
    // Scan current pointers, not retained history. SCAN may repeat keys, and its
    // raw-key limit must not let previews/ended records crowd out active viewers.
    const keys = [...new Set(await scanKeysOrThrow('livetv:v2:viewer-psess:*', Infinity))];
    let failures = 0;
    const rows: Array<LiveTvPlaybackSession | null> = [];
    for (let offset = 0; offset < keys.length; offset += 32) {
        rows.push(
            ...(await Promise.all(
                keys.slice(offset, offset + 32).map(async (key) => {
                    try {
                        const id = await client.get(key);
                        if (!id) return null;
                        const session = await getLiveTvSessionService().peekPlaybackSession(
                            String(id),
                        );
                        if (!session || session.state !== 'active' || session.kind === 'preview')
                            return null;
                        if (
                            typeof session.sessionId !== 'string' ||
                            typeof session.username !== 'string' ||
                            typeof session.stationId !== 'string' ||
                            typeof session.feedId !== 'string'
                        )
                            return null;
                        const ttl = await client.ttl(playbackKey(session.sessionId));
                        if (ttl < 60) return null;
                        return session;
                    } catch {
                        failures++;
                        return null;
                    }
                }),
            )),
        );
    }
    if (failures) {
        logger.warn('Some Live TV inventory records could not be read', { failures });
        // Preserve the display fallback for a store-wide outage.
        if (failures === keys.length) throw new Error('Live TV inventory unavailable');
    }
    const active = rows.filter((row): row is LiveTvPlaybackSession => row !== null);
    const unique = [...new Map(active.map((row) => [row.sessionId, row])).values()];
    if (unique.length > 1000)
        logger.warn('Live TV active inventory truncated', { count: unique.length });
    return unique.slice(0, 1000);
}

/** Revocation inventory includes previews and legacy streams, with no display TTL/cap. */
export async function listUserLiveTvResources(username: string): Promise<{
    playback: LiveTvPlaybackSession[];
    viewers: LiveTvSessionEntry[];
}> {
    const client = getCoordinationClient();
    if (!client) throw new Error('Live TV session store unavailable');
    const [playbackKeys, viewerKeys] = await Promise.all([
        scanKeysOrThrow('livetv:v2:psess:*', Infinity),
        scanKeysOrThrow('livetv:v2:session:*', Infinity),
    ]);
    const playback: LiveTvPlaybackSession[] = [];
    const viewers: LiveTvSessionEntry[] = [];
    const keys = [...new Set([...playbackKeys, ...viewerKeys, legacySessionKey(username)])];
    for (let offset = 0; offset < keys.length; offset += 32) {
        await Promise.all(
            keys.slice(offset, offset + 32).map(async (key) => {
                const raw = await client.get(key);
                if (!raw) return;
                if (key.startsWith('livetv:v2:psess:')) {
                    const entry = JSON.parse(String(raw)) as LiveTvPlaybackSession;
                    if (entry.username === username && entry.state === 'active')
                        playback.push(entry);
                } else {
                    const entry = JSON.parse(String(raw)) as LiveTvSessionEntry;
                    if (entry.username === username)
                        viewers.push({ ...entry, viewerKey: entry.viewerKey ?? username });
                }
            }),
        );
    }
    return { playback, viewers };
}
