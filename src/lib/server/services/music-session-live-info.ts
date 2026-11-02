// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live, heartbeat-fed extras for music play sessions: the client's next
 * queued track and a crossfade in progress. Both live in Valkey keyed by
 * play_sessions.id — they change every few seconds and would only churn the
 * row. Written by the music session heartbeat
 * (`api/defs/play-sessions/[id].ts`), read by both Active Streams builders
 * (`MediaAggregationService.getActiveSessions` and the admin play-sessions
 * def) so the home card and the admin panel cannot drift apart.
 *
 * @module server/services/music-session-live-info
 */

import type postgres from 'postgres';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { getTracksByIds } from '../database/queries/music.queries.js';
import { checkMediaAccess, userNeedsMediaAccessCheck } from '../middleware/media-access.js';
import type { UserContext } from '../types.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('MusicSessionLiveInfo');

export type CrossfadeRole = 'incoming' | 'outgoing';

/** What a client reports in the heartbeat's `crossfade` field. */
export interface MusicCrossfadeReport {
    /** The track on the OTHER side of the fade. */
    otherTrackId: string;
    /** Which side of the fade the reporting session's own track is on. */
    role: CrossfadeRole;
    /** Fade time left, measured by the client. */
    remainingMs: number;
    /** Total fade length. */
    durationMs: number;
}

export interface MusicTrackRef {
    mediaId: string;
    title: string;
    artistName?: string;
    albumName?: string;
}

export interface MusicCrossfadeInfo {
    role: CrossfadeRole;
    otherTrack: MusicTrackRef;
    /** Fade time left at the moment the server built this response. */
    remainingMs: number;
    durationMs: number;
}

export interface MusicSessionLiveInfo {
    nextTrack?: MusicTrackRef;
    crossfade?: MusicCrossfadeInfo;
}

/**
 * Stored form. The client's `remainingMs` is turned into an end time on the
 * SERVER clock at receipt, so a phone whose clock is off never skews it.
 */
interface StoredCrossfade {
    otherTrackId: string;
    role: CrossfadeRole;
    endsAtMs: number;
    durationMs: number;
}

const nextTrackCache = cacheManager.for(CACHE_NAMESPACES.musicNextTrack);
const crossfadeCache = cacheManager.for(CACHE_NAMESPACES.musicCrossfade);

/** Record (or with `null`, clear) the crossfade a session reported. */
export async function recordMusicCrossfade(
    sessionId: string,
    report: MusicCrossfadeReport | null,
    now: number = Date.now(),
): Promise<void> {
    if (report === null || report.remainingMs <= 0) {
        await crossfadeCache.delete(sessionId);
        return;
    }
    const stored: StoredCrossfade = {
        otherTrackId: report.otherTrackId,
        role: report.role,
        // A fade cannot have more left than its length.
        endsAtMs: now + Math.min(report.remainingMs, report.durationMs),
        durationMs: report.durationMs,
    };
    await crossfadeCache.set(sessionId, stored);
}

export async function recordMusicNextTrack(sessionId: string, trackId: string): Promise<void> {
    await nextTrackCache.set(sessionId, trackId);
}

/**
 * Apply what one music heartbeat (PUT or beacon) says about the extras.
 *
 * - COMPLETED clears both: a finished session has no next track or fade.
 * - ACTIVE with `crossfade` omitted leaves the stored fade alone; `null` clears it.
 * - PAUSED always clears a stored fade, including when `crossfade` is omitted.
 * - Track ids are client-supplied and are shown to everyone who can see this
 *   stream, so an id the session's owner may not access is never stored.
 *
 * Never throws: these are display extras, and a cache or DB hiccup must not
 * fail the heartbeat that carried them.
 */
export async function applyMusicHeartbeatLiveInfo(
    sql: postgres.Sql,
    sessionId: string,
    user: UserContext | undefined,
    body: {
        status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
        nextTrackId?: string;
        crossfade?: MusicCrossfadeReport | null;
    },
): Promise<void> {
    try {
        if (body.status === 'COMPLETED') {
            await clearMusicSessionLiveInfo(sessionId);
            return;
        }
        const restricted = await userNeedsMediaAccessCheck(sql, user);
        const mayShow = async (trackId: string): Promise<boolean> =>
            !restricted || (await checkMediaAccess(sql, trackId, user));

        if (body.nextTrackId && (await mayShow(body.nextTrackId))) {
            await recordMusicNextTrack(sessionId, body.nextTrackId);
        }
        if (body.status === 'PAUSED' || body.crossfade !== undefined) {
            const report =
                body.crossfade &&
                body.status === 'ACTIVE' &&
                (await mayShow(body.crossfade.otherTrackId))
                    ? body.crossfade
                    : null;
            await recordMusicCrossfade(sessionId, report);
        }
    } catch (err) {
        logger.debug('Music session live info not recorded', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/** A finished session has neither a next track nor a fade. */
export async function clearMusicSessionLiveInfo(sessionId: string): Promise<void> {
    await Promise.allSettled([nextTrackCache.delete(sessionId), crossfadeCache.delete(sessionId)]);
}

function isStoredCrossfade(value: unknown): value is StoredCrossfade {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.otherTrackId === 'string' &&
        (v.role === 'incoming' || v.role === 'outgoing') &&
        Number.isFinite(v.endsAtMs) &&
        Number.isFinite(v.durationMs)
    );
}

/**
 * Resolve next-track and crossfade extras for the given music session ids.
 * Sessions with neither are absent from the map. Cache or DB failures
 * degrade to "no extras" — a card without "Next:" beats a failed list.
 */
export async function resolveMusicSessionLiveInfo(
    sql: postgres.Sql,
    sessionIds: readonly string[],
    now: number = Date.now(),
): Promise<Map<string, MusicSessionLiveInfo>> {
    const result = new Map<string, MusicSessionLiveInfo>();
    if (sessionIds.length === 0) return result;

    const [nextReads, fadeReads] = await Promise.all([
        Promise.allSettled(sessionIds.map((id) => nextTrackCache.get(id))),
        Promise.allSettled(sessionIds.map((id) => crossfadeCache.get(id))),
    ]);

    const nextIdBySession = new Map<string, string>();
    const fadeBySession = new Map<string, StoredCrossfade>();
    sessionIds.forEach((id, i) => {
        const next = nextReads[i];
        if (next.status === 'fulfilled' && typeof next.value === 'string') {
            nextIdBySession.set(id, next.value);
        }
        const fade = fadeReads[i];
        if (
            fade.status === 'fulfilled' &&
            isStoredCrossfade(fade.value) &&
            fade.value.endsAtMs > now
        ) {
            fadeBySession.set(id, fade.value);
        }
    });

    const trackIds = [
        ...new Set([
            ...nextIdBySession.values(),
            ...[...fadeBySession.values()].map((f) => f.otherTrackId),
        ]),
    ];
    if (trackIds.length === 0) return result;

    const rows = await getTracksByIds(sql, trackIds).catch(() => []);
    const trackById = new Map<string, MusicTrackRef>(
        rows.map((row) => [
            row.id,
            {
                mediaId: row.id,
                title: row.title,
                // `artist_title` is already the resolved display artist
                // (trackDisplayArtistSql): the track's own ARTIST tag first,
                // the album-artist row only as a fallback, so a compilation
                // track never shows "VA".
                artistName: row.artist_title ?? undefined,
                albumName: row.album_title ?? undefined,
            },
        ]),
    );

    for (const id of sessionIds) {
        const info: MusicSessionLiveInfo = {};
        const nextId = nextIdBySession.get(id);
        const nextTrack = nextId ? trackById.get(nextId) : undefined;
        if (nextTrack) info.nextTrack = nextTrack;
        const fade = fadeBySession.get(id);
        const otherTrack = fade ? trackById.get(fade.otherTrackId) : undefined;
        if (fade && otherTrack) {
            info.crossfade = {
                role: fade.role,
                otherTrack,
                remainingMs: Math.max(0, Math.round(fade.endsAtMs - now)),
                durationMs: fade.durationMs,
            };
        }
        if (info.nextTrack || info.crossfade) result.set(id, info);
    }
    return result;
}
