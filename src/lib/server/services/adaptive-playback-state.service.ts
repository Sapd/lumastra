// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adaptive-bitrate (ABR) state of play sessions, for Active Streams and Admin → Sessions.
 *
 * Two sources, both display-only and short-lived in Valkey:
 *
 * 1. Server inference (Live TV). Every adaptive segment fetch names its rung in the
 *    URL (`stream/a/<rung>/segment-N.ts`), so the rung a viewer fetched last is the
 *    one it plays — for every client, without app changes. One hash per channel:
 *    `v1:abr:livetv:<channelId>`, a field per viewer key, plus `__ladder`, the ladder
 *    the channel's adaptive group encodes (one group per channel, so one ladder).
 * 2. Client reports. The play-session heartbeat may carry an `adaptive` block
 *    (`SessionAdaptiveReportSchema`): measured bandwidth, stalls, and — for adaptive
 *    VOD, where the server has no rung in the URL — the variant and the ladder.
 *    Stored per session: `v1:abr:session:<playSessionId>`.
 *
 * Losing either key only blanks the badge; nothing reads this state for decisions.
 */

import { cacheGet, del, expire, hGet, hGetAll, hSet, setEx } from '$lib/server/cache/valkey';
import { LIVETV_RUNGS, getLiveTvRung } from '$lib/shared/livetv-rungs.js';
import type {
    AdaptiveTier,
    AdaptiveVariant,
    SessionAdaptive,
    SessionAdaptiveReport,
} from '$lib/schemas/session-adaptive.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdaptivePlaybackState');

const LADDER_FIELD = '__ladder';
/** Hash lifetime, refreshed by every write. Viewers who leave age out of it. */
const CHANNEL_TTL_SECONDS = 180;
/** A viewer whose last segment is older than this no longer counts as watching. */
export const SERVER_FRESH_MS = 45_000;
/** Client reports live one heartbeat gap and then some (web heartbeats every 10 s). */
const CLIENT_TTL_SECONDS = 60;
/** Same-rung segment fetches within this window skip the Valkey write. */
const WRITE_THROTTLE_MS = 10_000;
const RECENT_SWITCHES = 5;

function channelKey(channelId: string): string {
    return `v1:abr:livetv:${channelId}`;
}
function sessionKey(sessionId: string): string {
    return `v1:abr:session:${sessionId}`;
}

/** Per-viewer record in the channel hash. Short field names: it is rewritten often. */
export interface ServerViewerRecord {
    /** Login handle of the viewer. */
    u: string;
    /** Rung id fetched last, or 'original'. */
    rung: string;
    /** Unix ms the viewer moved to `rung`. */
    since: number;
    /** Unix ms of the latest segment fetch. */
    last: number;
    /** Switches counted so far. */
    sw: number;
    /** Latest switches, newest first. */
    recent: Array<{ f: string; t: string; at: number }>;
}

export interface ChannelLadderRecord {
    rungs: Array<{ id: string; height: number; maxBitrate: number }>;
    includesOriginal: boolean;
}

export interface ClientReportRecord extends SessionAdaptiveReport {
    at: number;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Where a variant sits in its ladder; the same colouring the web player's badge uses. */
export function adaptiveTier(index: number, count: number): AdaptiveTier | undefined {
    if (index < 0 || count <= 0) return undefined;
    if (index === 0) return 'top';
    if (index === count - 1) return 'bottom';
    return index / (count - 1) <= 0.5 ? 'high' : 'low';
}

/** The next record after a segment fetch on `rung` at `now`. */
export function nextViewerRecord(
    previous: ServerViewerRecord | null,
    username: string,
    rung: string,
    now: number,
): ServerViewerRecord {
    // A viewer that went quiet (paused, left and came back) starts over: counting
    // the gap as a switch would invent quality changes nobody saw.
    if (!previous || now - previous.last > SERVER_FRESH_MS * 2) {
        return { u: username, rung, since: now, last: now, sw: 0, recent: [] };
    }
    if (previous.rung === rung) return { ...previous, u: username, last: now };
    return {
        u: username,
        rung,
        since: now,
        last: now,
        sw: previous.sw + 1,
        recent: [{ f: previous.rung, t: rung, at: now }, ...previous.recent].slice(
            0,
            RECENT_SWITCHES,
        ),
    };
}

const ORIGINAL_VARIANT: AdaptiveVariant = { id: 'original', original: true };

function rungVariant(id: string): AdaptiveVariant {
    if (id === 'original') return ORIGINAL_VARIANT;
    const rung = getLiveTvRung(id);
    return rung ? { id, height: rung.height, bitrate: rung.maxBitrate } : { id };
}

function serverLadder(ladder: ChannelLadderRecord | null, rung: string): AdaptiveVariant[] {
    // Highest first, Original on top — the order the player's tooltip lists them in.
    if (ladder && ladder.rungs.length > 0) {
        const rungs = ladder.rungs.map((r) => ({
            id: r.id,
            height: r.height,
            bitrate: r.maxBitrate,
        }));
        return ladder.includesOriginal ? [ORIGINAL_VARIANT, ...rungs] : rungs;
    }
    // No ladder recorded (the master was fetched before this replica started
    // recording, or the key aged out): the fixed v1 ladder is the best guess.
    const rungs = LIVETV_RUNGS.map((r) => rungVariant(r.id));
    return rung === 'original' ? [ORIGINAL_VARIANT, ...rungs] : rungs;
}

function clientLadder(report: SessionAdaptiveReport): AdaptiveVariant[] {
    const seen = new Set<string>();
    const ladder: AdaptiveVariant[] = [];
    for (const entry of report.ladder ?? []) {
        const id = entry.id ?? (entry.height ? `${entry.height}p` : undefined);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ladder.push({
            id,
            ...(entry.height ? { height: entry.height } : {}),
            ...(entry.bitrate ? { bitrate: entry.bitrate } : {}),
            ...(id === 'original' ? { original: true } : {}),
        });
    }
    // Highest first, whatever order the client sent. Original (no bitrate) stays on top.
    return ladder.sort(
        (a, b) =>
            (b.bitrate ?? Number.MAX_SAFE_INTEGER) - (a.bitrate ?? Number.MAX_SAFE_INTEGER) ||
            (b.height ?? 0) - (a.height ?? 0),
    );
}

function clientCurrent(
    report: SessionAdaptiveReport,
    ladder: AdaptiveVariant[],
): AdaptiveVariant | undefined {
    if (report.variant_id) {
        const byId = ladder.find((v) => v.id === report.variant_id);
        if (byId) return byId;
    }
    if (report.height) {
        const byHeight = ladder.find((v) => v.height === report.height);
        if (byHeight) return byHeight;
    }
    if (report.variant_id) return { id: report.variant_id };
    if (report.height) {
        return {
            id: `${report.height}p`,
            height: report.height,
            ...(report.indicated_bitrate ? { bitrate: report.indicated_bitrate } : {}),
        };
    }
    return undefined;
}

/**
 * The adaptive state of one session from whatever is known about it, or undefined
 * when it is not adaptive (no fresh server record and no client ladder of 2+ variants).
 */
export function buildSessionAdaptive(input: {
    server: ServerViewerRecord | null;
    ladder: ChannelLadderRecord | null;
    client: ClientReportRecord | null;
    now: number;
}): SessionAdaptive | undefined {
    const { client, now } = input;
    const server = input.server && now - input.server.last <= SERVER_FRESH_MS ? input.server : null;

    let ladder: AdaptiveVariant[];
    let current: AdaptiveVariant | undefined;
    if (server) {
        ladder = serverLadder(input.ladder, server.rung);
        current = ladder.find((v) => v.id === server.rung) ?? rungVariant(server.rung);
    } else if (client) {
        ladder = clientLadder(client);
        current = clientCurrent(client, ladder);
        // A Live TV viewer reporting a rung id before its first segment fetch was
        // seen still plays the channel ladder.
        if (ladder.length === 0 && input.ladder && current) {
            ladder = serverLadder(input.ladder, current.id);
            current = ladder.find((v) => v.id === current?.id) ?? current;
        }
        if (ladder.length < 2) return undefined;
    } else {
        return undefined;
    }

    const index = current ? ladder.findIndex((v) => v.id === current?.id) : -1;
    const tier = adaptiveTier(index, ladder.length);
    const switches = server ? server.sw : client?.switches;

    return {
        source: server ? 'server' : 'client',
        ...(current ? { current } : {}),
        ...(server ? { currentSince: new Date(server.since).toISOString() } : {}),
        ladder,
        ...(tier ? { tier } : {}),
        ...(switches !== undefined ? { switches } : {}),
        ...(server && server.recent.length > 0
            ? {
                  recentSwitches: server.recent.map((s) => ({
                      from: s.f,
                      to: s.t,
                      at: new Date(s.at).toISOString(),
                  })),
              }
            : {}),
        ...(server ? { lastSegmentAt: new Date(server.last).toISOString() } : {}),
        ...(client?.measured_bandwidth ? { measuredBandwidth: client.measured_bandwidth } : {}),
        ...(client?.indicated_bitrate ? { indicatedBitrate: client.indicated_bitrate } : {}),
        ...(client?.rebuffers !== undefined ? { rebuffers: client.rebuffers } : {}),
        ...(client ? { clientReportedAt: new Date(client.at).toISOString() } : {}),
    };
}

export interface AdaptiveSessionRef {
    sessionId: string;
    /** Internal exact Live TV viewer identity; never serialized to clients. */
    viewerKey?: string;
    username: string;
    mediaType?: string | null;
    /** For Live TV rows: the channel id. */
    mediaId?: string | null;
    deviceId?: string | null;
}

/**
 * Which server record belongs to which session.
 *
 * Viewer keys are `<username>:<discriminator>` and play sessions carry no viewer key,
 * so the join is by user + channel. One fresh record and one session for that pair
 * is unambiguous. When a user watches the same channel twice (two devices), a
 * discriminator naming the session's device (`jf-device:<id>`, `device:<id>`) settles
 * it; otherwise those sessions get no server record and fall back to client reports.
 */
export function matchServerRecords(
    sessions: readonly AdaptiveSessionRef[],
    recordsByChannel: ReadonlyMap<string, ReadonlyMap<string, ServerViewerRecord>>,
    now: number,
): Map<string, ServerViewerRecord> {
    const out = new Map<string, ServerViewerRecord>();
    const sessionsPerPair = new Map<string, number>();
    for (const session of sessions) {
        if (!session.mediaId) continue;
        const pair = `${session.mediaId}|${session.username.toLowerCase()}`;
        sessionsPerPair.set(pair, (sessionsPerPair.get(pair) ?? 0) + 1);
    }

    for (const session of sessions) {
        if (!session.mediaId) continue;
        const records = recordsByChannel.get(session.mediaId);
        if (!records) continue;
        const username = session.username.toLowerCase();
        const candidates = [...records.entries()].filter(
            ([, record]) =>
                record.u.toLowerCase() === username && now - record.last <= SERVER_FRESH_MS,
        );
        if (candidates.length === 0) continue;

        if (session.viewerKey) {
            const exact = candidates.find(([key]) => key === session.viewerKey);
            if (exact) out.set(session.sessionId, exact[1]);
            continue;
        }
        const deviceId = session.deviceId;
        const byDevice = deviceId
            ? candidates.find(
                  ([viewerKey]) =>
                      viewerKey.endsWith(`:jf-device:${deviceId}`) ||
                      viewerKey.endsWith(`:device:${deviceId}`),
              )
            : undefined;
        if (byDevice) {
            out.set(session.sessionId, byDevice[1]);
            continue;
        }
        const pairCount = sessionsPerPair.get(`${session.mediaId}|${username}`) ?? 0;
        if (pairCount !== 1) continue;
        // One session, several fresh records: a reload or a second tab left a record
        // behind. The viewer fetching most recently is the one playing.
        const newest = candidates.reduce((a, b) => (b[1].last > a[1].last ? b : a));
        out.set(session.sessionId, newest[1]);
    }
    return out;
}

function parseJson<T>(raw: string | null | undefined): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/**
 * What another (non-admin) viewer may see of someone's adaptive state: the variant and
 * the ladder, as the quality badge needs. The connection telemetry — measured
 * bandwidth, stalls, switch times — stays with the owner and admins.
 */
export function redactSessionAdaptive(adaptive: SessionAdaptive): SessionAdaptive {
    return {
        source: adaptive.source,
        ...(adaptive.current ? { current: adaptive.current } : {}),
        ladder: adaptive.ladder,
        ...(adaptive.tier ? { tier: adaptive.tier } : {}),
    };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Last write per channel|viewer in this process, so steady playback costs no Valkey I/O. */
const lastWrites = new Map<string, { rung: string; at: number }>();

function pruneLastWrites(now: number): void {
    if (lastWrites.size < 2000) return;
    for (const [key, entry] of lastWrites) {
        if (now - entry.at > SERVER_FRESH_MS * 2) lastWrites.delete(key);
    }
}

/** Record that `viewerKey` fetched an adaptive segment of `rung` on `channelId`. */
export async function recordAdaptiveSegment(
    channelId: string,
    viewerKey: string,
    username: string,
    rung: string,
    now = Date.now(),
): Promise<void> {
    const throttleKey = `${channelId}|${viewerKey}`;
    const previousWrite = lastWrites.get(throttleKey);
    if (previousWrite && previousWrite.rung === rung && now - previousWrite.at < WRITE_THROTTLE_MS)
        return;
    lastWrites.set(throttleKey, { rung, at: now });
    pruneLastWrites(now);

    try {
        const key = channelKey(channelId);
        const previous = parseJson<ServerViewerRecord>(await hGet(key, viewerKey));
        const next = nextViewerRecord(previous, username, rung, now);
        await hSet(key, viewerKey, JSON.stringify(next));
        await expire(key, CHANNEL_TTL_SECONDS);
    } catch (error) {
        logger.debug('Adaptive segment record failed', {
            channelId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Record the ladder the channel's adaptive group encodes (from the master join). */
export async function recordAdaptiveLadder(
    channelId: string,
    ladder: ChannelLadderRecord,
): Promise<void> {
    try {
        const record: ChannelLadderRecord = {
            rungs: ladder.rungs.map((r) => ({
                id: r.id,
                height: r.height,
                maxBitrate: r.maxBitrate,
            })),
            includesOriginal: ladder.includesOriginal,
        };
        const key = channelKey(channelId);
        await hSet(key, LADDER_FIELD, JSON.stringify(record));
        await expire(key, CHANNEL_TTL_SECONDS);
    } catch (error) {
        logger.debug('Adaptive ladder record failed', {
            channelId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Store the player's own adaptive report from a heartbeat. */
export async function recordClientAdaptiveReport(
    sessionId: string,
    report: SessionAdaptiveReport,
    now = Date.now(),
): Promise<void> {
    const record: ClientReportRecord = { ...report, at: now };
    await setEx(sessionKey(sessionId), CLIENT_TTL_SECONDS, JSON.stringify(record));
}

export async function clearClientAdaptiveReport(sessionId: string): Promise<void> {
    await del(sessionKey(sessionId));
}

// ─── Read ────────────────────────────────────────────────────────────────────

const LIVE_TV_MEDIA_TYPES: ReadonlySet<string> = new Set(['tvchannel', 'livetv', 'channel']);

/** Adaptive state for every session that has one, keyed by session id. */
export async function resolveSessionAdaptive(
    sessions: readonly AdaptiveSessionRef[],
    now = Date.now(),
): Promise<Map<string, SessionAdaptive>> {
    const result = new Map<string, SessionAdaptive>();
    if (sessions.length === 0) return result;

    const liveSessions = sessions.filter(
        (s) => !!s.mediaId && LIVE_TV_MEDIA_TYPES.has((s.mediaType ?? '').toLowerCase()),
    );
    const channelIds = [...new Set(liveSessions.map((s) => s.mediaId as string))];

    try {
        const [channelHashes, clientRaw] = await Promise.all([
            Promise.all(channelIds.map((id) => hGetAll(channelKey(id)))),
            Promise.all(sessions.map((s) => cacheGet(sessionKey(s.sessionId)))),
        ]);

        const recordsByChannel = new Map<string, Map<string, ServerViewerRecord>>();
        const laddersByChannel = new Map<string, ChannelLadderRecord>();
        channelIds.forEach((channelId, i) => {
            const records = new Map<string, ServerViewerRecord>();
            for (const [field, raw] of Object.entries(channelHashes[i] ?? {})) {
                if (field === LADDER_FIELD) {
                    const ladder = parseJson<ChannelLadderRecord>(raw);
                    if (ladder && Array.isArray(ladder.rungs))
                        laddersByChannel.set(channelId, ladder);
                    continue;
                }
                const record = parseJson<ServerViewerRecord>(raw);
                if (record && typeof record.rung === 'string' && typeof record.u === 'string') {
                    records.set(field, { ...record, recent: record.recent ?? [] });
                }
            }
            recordsByChannel.set(channelId, records);
        });

        const serverBySession = matchServerRecords(liveSessions, recordsByChannel, now);

        sessions.forEach((session, i) => {
            // One malformed record must not blank every other session's badge.
            try {
                const isLive = liveSessions.includes(session);
                const adaptive = buildSessionAdaptive({
                    server: serverBySession.get(session.sessionId) ?? null,
                    ladder: isLive
                        ? (laddersByChannel.get(session.mediaId as string) ?? null)
                        : null,
                    client: parseJson<ClientReportRecord>(clientRaw[i]),
                    now,
                });
                if (adaptive) result.set(session.sessionId, adaptive);
            } catch (error) {
                logger.debug('Adaptive state build failed', {
                    sessionId: session.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
    } catch (error) {
        logger.debug('Adaptive state lookup failed', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return result;
}

/** Test hook: forget the in-process write throttle. */
export function _resetAdaptiveWriteThrottleForTests(): void {
    lastWrites.clear();
}
