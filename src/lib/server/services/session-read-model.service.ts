// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/session-read-model.service.ts
import type postgres from 'postgres';
import {
    getActiveSessionsView,
    type ActiveSessionViewRow,
    type PlaySessionSource,
    type SessionViewFilter as QueryFilter,
} from '../database/queries/play-sessions.queries.js';
import { Logger } from '../utils/logger.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

const logger = Logger.for('SessionReadModel');

// ─── Freshness thresholds ─────────────────────────────────────────────────────

/**
 * The two LUMASTRA_* windows apply to every FIRST-PARTY session — a row one of
 * our own players reports, which since audiobooks includes source
 * 'audiobookshelf'. See `isFirstParty` in `toView`.
 */

/** Lumastra ACTIVE sessions are fresh if heartbeat is younger than this. */
export const LUMASTRA_ACTIVE_FRESH_MS = 30_000; // 30 seconds

/** Lumastra PAUSED sessions are fresh if heartbeat is younger than this. */
export const LUMASTRA_PAUSED_FRESH_MS = 5 * 60_000; // 5 minutes

/** External ACTIVE sessions are fresh if last_seen is younger than this. */
const EXTERNAL_ACTIVE_FRESH_MS = 15_000; // 15 seconds — roughly 2× typical poll cadence

/** External PAUSED sessions are fresh if last_seen is younger than this. */
const EXTERNAL_PAUSED_FRESH_MS = 5 * 60_000; // 5 minutes

// ─── Public types ─────────────────────────────────────────────────────────────

export type SessionLiveStatus = 'ACTIVE' | 'PAUSED';

export interface ActiveSessionView {
    sessionId: string;
    source: PlaySessionSource;
    sourceSessionId: string | null;
    /** The stable users.id UUID — the data key (privacy/ownership comparisons). */
    userId: UserId;
    /** DISPLAY login handle, re-hydrated from users (JOIN). Never a data key. */
    username: string;
    /** DISPLAY name override (users.display_name), or null. */
    displayName: string | null;
    mediaId: string;
    hasFiles: boolean;
    seriesId: string | null;
    mediaType: string;
    positionMs: number;
    runtimeMs: number | null;
    status: SessionLiveStatus;
    isPlaying: boolean;
    startedAt: Date;
    lastHeartbeatAt: Date;
    lastSeenAt: Date;
    device?: { name?: string; client?: string; version?: string; deviceId?: string };
    /** Delivery method ('direct' | 'remux' | 'audio_transcode' | 'full_transcode'), if known. */
    playMethod?: string;
    bitrateKbps?: number;
    resolution?: string;
    heartbeatAgeMs: number;
    isFresh: boolean;
    /** True when the session was created but no heartbeat has reported a real position yet. */
    isBuffering: boolean;
    /** Title of the live media item (episode title or movie title). */
    title?: string;
    /** Season number of the live episode (undefined for non-episode media). */
    seasonNumber?: number;
    /** Episode number of the live episode (undefined for non-episode media). */
    episodeNumber?: number;
    /** Series name resolved from the grandparent (or parent) media_items row. */
    seriesName?: string;
}

export interface ReadFilter {
    userId?: UserId;
    mediaId?: string;
    seriesId?: string;
    source?: PlaySessionSource | PlaySessionSource[];
    includeStale?: boolean;
    admin?: boolean;
}

// ─── Transform ────────────────────────────────────────────────────────────────

/**
 * Media types where position progression isn't meaningful — continuous live
 * streams, radio, music tracks, etc. The `isBuffering` signal (which keys off
 * `last_event_seq === 0`) doesn't apply to these because their lifecycle
 * doesn't advance the seq the way the Lumastra player heartbeat does for
 * positional media.
 */
const NON_POSITIONAL_MEDIA_TYPES: ReadonlySet<string> = new Set([
    'radio',
    'music',
    'audio',
    'track',
    'channel',
    'tvchannel',
    'livetv',
    'live',
]);

function toView(row: ActiveSessionViewRow): ActiveSessionView {
    const status = row.status as SessionLiveStatus;
    const isActive = status === 'ACTIVE';
    const mediaType = (row.media_type ?? '').toLowerCase();
    const isPositional = !NON_POSITIONAL_MEDIA_TYPES.has(mediaType);

    // For Lumastra rows use last_heartbeat_at age; for external use last_seen_at age.
    const isLumastra = row.source === 'lumastra';
    const heartbeatAgeMs = isLumastra ? Number(row.heartbeat_age_ms) : Number(row.seen_age_ms);

    // The EXTERNAL windows are sized for a POLLER: we learn about a Jellyfin or
    // Subsonic session by asking that server, roughly twice per window. An
    // audiobook session is not polled — our own web and iOS players report it,
    // on THEIR cadence (web: heartbeat every 10s; iOS: a progress report every
    // 20s, and no heartbeat at all until the v1 route existed). Graded as
    // external, a 20s-cadence iOS listen spent most of its life "not fresh" —
    // it was live for 15 of every 20 seconds and stale whenever the rail
    // happened to render in the other 5. So it takes the first-party windows.
    // 'local' joins for the same reason audiobookshelf did: it is OUR player
    // reporting on ITS cadence, not something we poll. Graded as external, a
    // 30 s-heartbeat local session would read as stale for half its life and
    // flicker in and out of the Active Streams rail.
    const isFirstParty = isLumastra || row.source === 'audiobookshelf' || row.source === 'local';

    const freshnessThreshold = isFirstParty
        ? isActive
            ? LUMASTRA_ACTIVE_FRESH_MS
            : LUMASTRA_PAUSED_FRESH_MS
        : isActive
          ? EXTERNAL_ACTIVE_FRESH_MS
          : EXTERNAL_PAUSED_FRESH_MS;

    const device: ActiveSessionView['device'] =
        row.user_agent != null ||
        row.client_name != null ||
        row.client_version != null ||
        row.device_id
            ? {
                  name: row.user_agent ?? undefined,
                  client: row.client_name ?? undefined,
                  version: row.client_version ?? undefined,
                  deviceId: row.device_id,
              }
            : undefined;

    return {
        sessionId: row.id,
        source: row.source,
        sourceSessionId: row.source_session_id,
        userId: toUserId(row.user_id),
        // Display name re-hydrated from the JOINed users row; fall back to the
        // UUID only if the user row is somehow missing (FK guarantees it won't be).
        username: row.username ?? row.user_id,
        displayName: row.display_name,
        mediaId: row.media_id,
        hasFiles: row.has_files,
        seriesId: row.series_id,
        mediaType,
        positionMs: Number(row.position_ms),
        runtimeMs: row.runtime_ms != null ? Number(row.runtime_ms) : null,
        status,
        isPlaying: isActive,
        startedAt: row.started_at,
        lastHeartbeatAt: row.last_heartbeat_at,
        lastSeenAt: row.last_seen_at,
        device,
        playMethod: row.play_method ?? undefined,
        bitrateKbps: row.bitrate_kbps ?? undefined,
        resolution: row.resolution ?? undefined,
        heartbeatAgeMs,
        isFresh: heartbeatAgeMs < freshnessThreshold,
        // Stays strictly `isLumastra`, unlike the freshness grading above: an
        // audiobook session never advances `last_event_seq` (it has no player
        // event stream), so an hour into a book the row still reads 0 and this
        // would call it "buffering" forever.
        isBuffering: isLumastra && isPositional && isActive && Number(row.last_event_seq) === 0,
        title: row.media_title ?? undefined,
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        seriesName: row.series_title ?? undefined,
    };
}

/**
 * Pick the freshest effective session from a candidate list. Prefers ACTIVE
 * over PAUSED, then smallest source-aware age. Returns null when no row is
 * fresh by its own source's threshold. Used by the single-media resolver so
 * a fresh external (last_seen_at-based) row beats a stale Lumastra row even
 * when SQL ORDER BY would have ranked the Lumastra row first.
 */
function pickFreshest(sessions: ActiveSessionView[]): ActiveSessionView | null {
    const fresh = sessions.filter((s) => s.isFresh);
    if (fresh.length === 0) return null;
    const active = fresh.filter((s) => s.isPlaying);
    const pool = active.length > 0 ? active : fresh;
    return pool.reduce((best, s) => (s.heartbeatAgeMs < best.heartbeatAgeMs ? s : best));
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface SessionReadModelDeps {
    getSql: () => postgres.Sql | null;
    query: (sql: postgres.Sql, filter: QueryFilter) => Promise<ActiveSessionViewRow[]>;
}

export class SessionReadModel {
    constructor(private readonly deps: SessionReadModelDeps) {}

    private async fetch(filter: QueryFilter): Promise<ActiveSessionView[]> {
        const sql = this.deps.getSql();
        if (!sql) {
            logger.warn('Database unavailable — returning empty session list');
            return [];
        }
        try {
            const rows = await this.deps.query(sql, filter);
            return rows.map(toView);
        } catch (err) {
            logger.error('Failed to fetch sessions from DB', err as Error);
            return [];
        }
    }

    async getActiveSessionsForUser(userId: UserId): Promise<ActiveSessionView[]> {
        return this.fetch({ userId, includeStale: false });
    }

    async getActiveSessionForMedia(
        userId: UserId,
        mediaId: string,
    ): Promise<ActiveSessionView | null> {
        const rows = await this.fetch({
            userId,
            mediaId,
            includeStale: false,
        });
        return pickFreshest(rows);
    }

    async getActiveSessionsForSeries(
        userId: UserId,
        seriesId: string,
    ): Promise<ActiveSessionView[]> {
        return this.fetch({ userId, seriesId, includeStale: false });
    }

    async getAllActive(filter: ReadFilter = {}): Promise<ActiveSessionView[]> {
        const { admin, userId, ...rest } = filter;
        const queryFilter: QueryFilter = {
            ...rest,
            userId: admin ? undefined : userId,
        };
        return this.fetch(queryFilter);
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

import { getDb } from '../database/connection.js';

let _instance: SessionReadModel | null = null;

export function getSessionReadModel(): SessionReadModel {
    if (!_instance) {
        _instance = new SessionReadModel({
            getSql: getDb,
            query: getActiveSessionsView,
        });
    }
    return _instance;
}
