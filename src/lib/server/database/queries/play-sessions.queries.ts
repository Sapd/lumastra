// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/database/queries/play-sessions.queries.ts
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { PlaySurface } from '$lib/server/api/play-surface.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import type { PlayMethod } from '$lib/schemas/play-sessions';
import { UNLIMITED_CONCURRENT_STREAMS } from '$lib/schemas/play-sessions';
import { trackArtistIdSql, trackDisplayArtistSql } from './fragments/music-artist.fragments.js';
import { hasSessionCompletion } from './user-media-events.queries.js';
import { withTx } from '../with-tx.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateSessionParams {
    /**
     * Which API surface the client spoke to reach us. REQUIRED and with no
     * default, deliberately: this is the one field every new session-creating
     * call site must consciously decide, because a wrong value is permanent
     * (the column is forward-only — nothing can re-derive it later) and a
     * missing one silently inflates 'unknown' on the admin stats card. Making
     * it optional would turn both mistakes into a compile-clean no-op.
     *
     * Pass 'unknown' explicitly for paths with no request behind them.
     */
    surface: PlaySurface;
    /**
     * A hover preview (`purpose: 'preview'` on the start request), not playback.
     * Stored in `is_preview`; every "who is playing right now" read and the
     * stream-limit count skips these rows, the reaper and stop paths do not.
     */
    is_preview?: boolean;
    purpose?: 'play' | 'prefetch';
    /** Pre-generated session ID — when provided, enables ON CONFLICT merge
     *  with the transcode stub row that may already exist for this playback. */
    id?: string;
    media_id: string;
    user_id: UserId;
    device_id: string;
    user_agent?: string;
    client_name?: string;
    client_version?: string;
    /**
     * UI features the client announced it can render — see
     * `$lib/shared/client-features.ts`. Already normalised by the inlet;
     * omit (leaving the column NULL) for a client that announced nothing,
     * which is not the same claim as an empty array.
     */
    client_features?: string[];
    ip_address: string;
    play_method: PlayMethod;
    transcode_mode?: string;
    audio_codec?: string;
    video_codec?: string;
    container?: string;
    bitrate_kbps?: number;
    resolution?: string;
    position_ms: number;
    runtime_ms?: number;
    device_capabilities?: unknown;
    requested_format?: unknown;
    jellyfin_media_source_id?: string;
    /** Client PlaySessionId on the /j surface; distinct from this row's id. */
    jellyfin_play_session_id?: string;
    audio_stream_index?: number;
    subtitle_stream_index?: number;
    audio_language?: string;
    subtitle_language?: string;
    plan_id?: string;
    file_id?: string;
    plan_mode?: string;
    plan_reasons?: string[];
    subtitle_method?: string;
    transcode_codec?: string;
    delivery_path?: string;
    /**
     * Row provenance. Omit for an ordinary first-party session — the column
     * DEFAULTs to 'lumastra' and every existing caller relies on that.
     *
     * The only value a request-driven caller sets today is 'local', mapped by
     * `startPlaySession` from `is_local_playback`. It is NOT accepted from a
     * client verbatim: `source` decides stream-limit accounting, so letting a
     * caller name it would let any client opt itself out of the limit.
     */
    source?: PlaySessionSource;
    /**
     * How the client opened this playback (`continue`, `next_up`, `autoplay`,
     * `resume`, `explicit`). Null when the client named none. `explicit` keeps
     * the session out of every resume-handoff chain.
     */
    entry_mode?: PlaySessionEntryMode;
}

export type PlaySessionEntryMode = 'continue' | 'next_up' | 'autoplay' | 'resume' | 'explicit';

export interface HeartbeatParams {
    position_ms: number;
    status: 'ACTIVE' | 'PAUSED';
    bitrate_kbps?: number;
    resolution?: string;
    play_method?: PlayMethod;
    audio_stream_index?: number;
    subtitle_stream_index?: number;
    audio_language?: string;
    subtitle_language?: string;
    /**
     * Client-reported subtitle method — must NOT be 'burn_in'. Burn-in is a
     * server decision owned by the HLS planner. The SQL gate below preserves
     * an existing 'burn_in' value regardless of what a client reports.
     */
    subtitle_method?: 'external_vtt' | 'client_render' | 'none';
    buffer_health_sec?: number;
    /**
     * Monotonic per-session sequence from the client. Heartbeats with a seq
     * less than or equal to the row's last_event_seq are silently ignored to
     * prevent reordered deliveries from clobbering newer state. Required —
     * the session-update schema enforces presence, and the heartbeat UPDATE
     * treats seq=0 as always-stale (never advances `last_event_seq` past 0).
     */
    event_seq: number;
}

/**
 * Origin of a `play_sessions` row. CHECK-constrained on the table — see
 * migration 12.55.0 (and the later migration that dropped 'abs'). 'lumastra'
 * rows are written by the in-process SessionManager; the rest are upserted by
 * external pollers using `(source, source_session_id)` as the conflict key.
 *
 * 'audiobookshelf' (widened into the CHECK by migration 16.178.0) marks a book
 * Lumastra STREAMS from a remote AudiobookShelf server. It is first-party
 * playback — we proxy the bytes — and its `source_session_id` holds the
 * upstream ABS session id we opened on the listener's behalf, which is what
 * lets the Active Streams merge tell our own listeners apart from people using
 * the AudiobookShelf app directly.
 */
export type PlaySessionSource =
    | 'lumastra'
    | 'jellyfin'
    | 'livetv'
    | 'music'
    | 'subsonic'
    | 'audiobookshelf'
    /**
     * Playback of a file the CLIENT already holds — an iOS download played back
     * off the device, whether or not it is online. First-party (our player, our
     * heartbeat cadence), but the bytes never leave this server, so it is
     * neither bandwidth nor transcode nor something we could stop. Set by the
     * server from `is_local_playback` on POST /play-sessions; never writable by
     * a client directly. See {@link UNMETERED_SOURCES}.
     */
    | 'local';

/**
 * Sources whose `play_sessions` rows must NOT count toward per-user stream
 * limits, because the stream they describe is not one this server is serving.
 *
 * Two kinds now live here, which is why this is no longer called
 * EXTERNAL_MIRROR_SOURCES — 'local' is first-party, so "external mirror" had
 * become false of the set's own contents.
 *
 * MIRRORS of playback on a separate media server (native Jellyfin, Subsonic)
 * that Lumastra polls but does not control:
 *
 *  - Lumastra never runs `enforceStreamPolicy` for them — a native Jellyfin
 *    stream streams straight off the Jellyfin server and never hits
 *    `POST /api/play-sessions` or the HLS manifest.
 *  - Killing one only soft-terminates the mirror row (status='KILLED'); the
 *    upstream server keeps streaming regardless — Lumastra can't stop it.
 *    `upsertExternalSession`'s ON CONFLICT is guarded against reviving a
 *    KILLED row, so the ~5s sessions-cache poller re-observing the same
 *    still-playing upstream session does NOT resurrect it to ACTIVE.
 *  - Counting them would let a native Jellyfin (or Subsonic) stream 429 the
 *    user's next Lumastra or `/j` stream — a slot consumed by something we can
 *    neither enforce nor terminate.
 *
 * LOCAL playback of a file the client already downloaded. Same three properties
 * for a different reason: no bytes leave this server, so there is nothing to
 * meter; a KILL cannot stop a file playing off a phone's own disk; and counting
 * it would let someone watching an offline download lock a household member out
 * of a real stream.
 *
 * ⚠️ `'local'` is a CLAIM, and an unverifiable one — the server sees no bytes
 * either way. Membership here is therefore NOT unconditional: enforcement sites
 * must go through {@link unmeteredSources}, which includes it only when the
 * operator has set TRUST_CLIENT_LOCAL_PLAYBACK. Do not inline this array at an
 * enforcement site.
 *
 * Legacy `NULL` source rows are first-party (pre-`source` Lumastra sessions)
 * and are intentionally NOT in this list. Enforcement sites filter with
 * `COALESCE(source, 'lumastra')` / an `includes` guard so `NULL` counts.
 *
 * 'audiobookshelf' is also NOT in this list, despite naming a remote server:
 * Lumastra proxies those bytes itself, so the stream IS ours to count and to
 * kill. The rows this list is about are the ones we only observe — including
 * the direct AudiobookShelf app listeners merged into Active Streams, which
 * never become `play_sessions` rows at all.
 */
export const UNMETERED_SOURCES: PlaySessionSource[] = ['jellyfin', 'subsonic'];

/**
 * The unmetered set as it applies to THIS request, given operator trust.
 *
 * Split from {@link UNMETERED_SOURCES} rather than folded into it because the
 * two have different truth conditions: a Jellyfin mirror is unmeterable as a
 * matter of fact, while a local session is unmetered only as a matter of
 * policy. Collapsing them would make a config change silently rewrite what the
 * constant "means".
 */
export function unmeteredSources(trustLocalPlayback: boolean): PlaySessionSource[] {
    return trustLocalPlayback ? [...UNMETERED_SOURCES, 'local'] : UNMETERED_SOURCES;
}

export interface SessionRow {
    /**
     * 'play' is a listener/viewer stream; 'prefetch' a prepared music deck;
     * 'download' an offline audiobook transfer (no reports, no stream slot,
     * never listed as "playing" — see {@link DOWNLOAD_SESSION_HARD_CAP_HOURS}).
     */
    purpose: 'play' | 'prefetch' | 'download';
    id: string;
    media_id: string;
    user_id: string;
    device_id: string;
    user_agent: string | null;
    client_name: string | null;
    client_version: string | null;
    /**
     * UI features the client announced it renders (`admin_message`,
     * `maintenance_notice`, …). NULL = never announced (every pre-column
     * build, and every mirror row that has no client to ask); `[]` = the
     * client announced an empty list. Both read as "announces nothing".
     */
    client_features: string[] | null;
    ip_address: string;
    play_method: string;
    transcode_mode: string | null;
    transcode_job_id: string | null;
    audio_codec: string | null;
    video_codec: string | null;
    container: string | null;
    bitrate_kbps: number | null;
    resolution: string | null;
    status: string;
    stop_reason: string | null;
    position_ms: number;
    runtime_ms: number | null;
    started_at: Date;
    last_heartbeat_at: Date;
    paused_at: Date | null;
    stopped_at: Date | null;
    jellyfin_session_id: string | null;
    device_capabilities: unknown | null;
    requested_format: unknown | null;
    jellyfin_media_source_id: string | null;
    audio_stream_index: number | null;
    subtitle_stream_index: number | null;
    audio_language: string | null;
    subtitle_language: string | null;
    buffer_health_sec: number | null;
    last_jellyfin_report_at: Date | null;
    media_type: string | null;
    plan_id: string | null;
    file_id: string | null;
    plan_mode: string | null;
    plan_reasons: string[] | null;
    subtitle_method: string | null;
    transcode_codec: string | null;
    delivery_path: string | null;
    last_event_seq: number;
    /** Origin of this row — see `PlaySessionSource`. NOT NULL in DB. */
    source: PlaySessionSource;
    /**
     * Source system's session id (e.g. Jellyfin SessionInfo.Id). NULL for
     * Lumastra rows (Lumastra uses its own `id`). Upsert key for external
     * pollers via UNIQUE (source, source_session_id) WHERE source_session_id
     * IS NOT NULL.
     */
    source_session_id: string | null;
    /**
     * Refreshed every poll for external sources / every heartbeat for
     * Lumastra. The external-source reaper expires rows when this is stale.
     */
    last_seen_at: Date;
    /**
     * Opaque JSON extras from external sources (Jellyfin SessionInfo extras,
     * ABS specifics). NULL for Lumastra.
     */
    external_payload: unknown | null;
}

const AUDIOBOOK_CLOSE_KEY = '__lumastra_audiobook_close';
const STALE_REAP_KEY = '__lumastra_stale_reap';
/**
 * `external_payload` key marking an AudiobookShelf row opened for a DOWNLOAD
 * (value `'download'`), not for playback.
 *
 * A download's row is what keeps its byte-proxy fetches authorised, and it
 * sends no position reports, so two rules read this: no playback open
 * supersedes it (see `supersedeReplacedAudiobookSessions`), and the reaper
 * gives it the long 30-minute grace rather than a playing deck's 5 minutes.
 */
export const AUDIOBOOK_PURPOSE_KEY = '__lumastra_audiobook_purpose';

/**
 * Longest a download session may live, whatever its grants say (hours).
 *
 * A download row (`purpose = 'download'`) is kept alive by its delivery grants
 * rather than by heartbeats: it is reaped when none of its grants is active and
 * unexpired any more, and unconditionally this long after it started. Playback
 * grants never outlive seven days (`ABSOLUTE_LIFETIME_MS` in playback-grant.ts),
 * so this is the backstop for a grant that somehow did, not a second limit.
 */
export const DOWNLOAD_SESSION_HARD_CAP_HOURS = 7 * 24;

export interface AudiobookClosePayload {
    state: 'pending' | 'processing' | 'done' | 'failed';
    positionMs: number;
    listenedMs: number;
    runtimeMs: number;
    isFinished: boolean;
    absItemId: string | null;
    /**
     * Set once `closeSessionAs` has landed upstream. A close that then fails on
     * `markFinishedAs` is retried for the finish alone — re-closing an already
     * closed AudiobookShelf session is a wasted round-trip that answers 404.
     */
    upstreamClosed?: boolean;
    /** Failed attempts so far; see `MAX_REAP_ATTEMPTS`. */
    attempts?: number;
    /**
     * Whether the upstream close may assert `positionMs` as the listener's
     * progress. False for a REAPED, superseded or killed session, whose position
     * is stale by construction — see `reapClaimPayload`.
     *
     * Absent means true, which is what a client-initiated close writes and what
     * any payload persisted before this field existed means.
     */
    syncPosition?: boolean;
}

const CLOSE_STATES = new Set(['pending', 'processing', 'done', 'failed']);

function audiobookClosePayload(row: SessionRow): AudiobookClosePayload | null {
    const root = row.external_payload;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const value = (root as Record<string, unknown>)[AUDIOBOOK_CLOSE_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (
        typeof payload.state !== 'string' ||
        !CLOSE_STATES.has(payload.state) ||
        typeof payload.positionMs !== 'number' ||
        typeof payload.listenedMs !== 'number' ||
        typeof payload.runtimeMs !== 'number' ||
        typeof payload.isFinished !== 'boolean' ||
        (payload.absItemId !== null && typeof payload.absItemId !== 'string')
    ) {
        return null;
    }
    return payload as unknown as AudiobookClosePayload;
}

export function getAudiobookClosePayload(row: SessionRow): AudiobookClosePayload | null {
    return audiobookClosePayload(row);
}

export interface PolicyRow {
    user_id: string;
    max_concurrent_streams: number;
    require_single_ip: boolean;
    ip_grace_period_seconds: number;
    max_bitrate_kbps: number | null;
    allowed_play_methods: string[] | null;
    updated_at: Date;
    updated_by: string | null;
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export async function createPlaySession(
    sql: postgres.Sql,
    params: CreateSessionParams,
): Promise<SessionRow> {
    const row = await insertOrRevivePlaySession(sql, params.id, params);
    if (row) return row;

    // The conflicting row is KILLED (admin- or user-terminated) — the WHERE
    // guard below refuses to resurrect it. Treat this as a brand-new playback
    // attempt: mint a fresh id so it can't conflict with the dead row. Without
    // this, a client that keeps resending the same client-persisted session_id
    // after a kill (e.g. an idle keepalive from a tab left open) would revive
    // the very session the user/admin just ended.
    const fresh = await insertOrRevivePlaySession(sql, undefined, params);
    if (!fresh) {
        throw new Error('createPlaySession: fresh-id insert produced no row');
    }
    return fresh;
}

async function insertOrRevivePlaySession(
    sql: postgres.Sql,
    id: string | undefined,
    params: CreateSessionParams,
): Promise<SessionRow | undefined> {
    // Always include id in the INSERT. When a client-provided id is given,
    // ON CONFLICT merges client metadata into any existing transcode stub.
    // When id is not provided, gen_random_uuid() ensures no conflict occurs.
    const sessionId = id ? sql`${id}` : sql`gen_random_uuid()`;
    const [row] = await sql<SessionRow[]>`
        INSERT INTO play_sessions (
            id,
            media_id, user_id, device_id, user_agent, client_name, client_version,
            client_features,
            ip_address, play_method, transcode_mode, audio_codec, video_codec,
            container, bitrate_kbps, resolution, position_ms, runtime_ms,
            device_capabilities, requested_format,
            jellyfin_media_source_id,
            audio_stream_index, subtitle_stream_index,
            audio_language, subtitle_language,
            plan_id, file_id, plan_mode, plan_reasons,
            subtitle_method, transcode_codec, delivery_path,
            source, surface, is_preview, purpose, jellyfin_play_session_id,
            entry_mode, start_position_ms, high_water_ms
        ) VALUES (
            ${sessionId},
            ${params.media_id}, ${params.user_id}, ${params.device_id},
            ${params.user_agent ?? null}, ${params.client_name ?? null},
            ${params.client_version ?? null},
            ${params.client_features ? sql.array(params.client_features) : null},
            ${params.ip_address},
            ${params.play_method}, ${params.transcode_mode ?? null},
            ${params.audio_codec ?? null}, ${params.video_codec ?? null},
            ${params.container ?? null}, ${params.bitrate_kbps ?? null},
            ${params.resolution ?? null}, ${params.position_ms},
            ${params.runtime_ms ?? null},
            ${params.device_capabilities ? sql.json(params.device_capabilities as postgres.JSONValue) : null},
            ${params.requested_format ? sql.json(params.requested_format as postgres.JSONValue) : null},
            ${params.jellyfin_media_source_id ?? null},
            ${params.audio_stream_index ?? null}, ${params.subtitle_stream_index ?? null},
            ${params.audio_language ?? null}, ${params.subtitle_language ?? null},
            ${params.plan_id ?? null}, ${params.file_id ?? null},
            ${params.plan_mode ?? null},
            ${params.plan_reasons ? sql.array(params.plan_reasons) : null},
            ${params.subtitle_method ?? null}, ${params.transcode_codec ?? null},
            ${params.delivery_path ?? null},
            -- 'lumastra' is named here rather than left to the column DEFAULT.
            -- A DEFAULT applies only when the column is OMITTED from the INSERT
            -- or given the DEFAULT keyword — an explicitly-bound NULL is a
            -- value, and source is NOT NULL, so relying on the default while
            -- still binding a parameter made every caller that does not set
            -- source (i.e. all of them but local playback) fail outright with
            -- "null value in column source violates not-null constraint".
            ${params.source ?? 'lumastra'},
            ${params.surface},
            ${params.is_preview === true},
            ${params.purpose ?? 'play'},
            ${params.jellyfin_play_session_id ?? null},
            ${params.entry_mode ?? null},
            ${params.position_ms},
            ${params.position_ms}
        )
        ON CONFLICT (id) DO UPDATE SET
            device_id = EXCLUDED.device_id,
            user_agent = COALESCE(EXCLUDED.user_agent, play_sessions.user_agent),
            client_name = COALESCE(EXCLUDED.client_name, play_sessions.client_name),
            client_version = COALESCE(EXCLUDED.client_version, play_sessions.client_version),
            client_features = COALESCE(EXCLUDED.client_features, play_sessions.client_features),
            ip_address = CASE WHEN play_sessions.ip_address = '0.0.0.0'::inet THEN EXCLUDED.ip_address ELSE play_sessions.ip_address END,
            play_method = COALESCE(EXCLUDED.play_method, play_sessions.play_method),
            runtime_ms = COALESCE(EXCLUDED.runtime_ms, play_sessions.runtime_ms),
            device_capabilities = COALESCE(EXCLUDED.device_capabilities, play_sessions.device_capabilities),
            requested_format = COALESCE(EXCLUDED.requested_format, play_sessions.requested_format),
            audio_stream_index = COALESCE(EXCLUDED.audio_stream_index, play_sessions.audio_stream_index),
            subtitle_stream_index = COALESCE(EXCLUDED.subtitle_stream_index, play_sessions.subtitle_stream_index),
            audio_language = COALESCE(EXCLUDED.audio_language, play_sessions.audio_language),
            subtitle_language = COALESCE(EXCLUDED.subtitle_language, play_sessions.subtitle_language),
            jellyfin_media_source_id = COALESCE(EXCLUDED.jellyfin_media_source_id, play_sessions.jellyfin_media_source_id),
            plan_id = COALESCE(EXCLUDED.plan_id, play_sessions.plan_id),
            file_id = COALESCE(EXCLUDED.file_id, play_sessions.file_id),
            plan_mode = COALESCE(EXCLUDED.plan_mode, play_sessions.plan_mode),
            plan_reasons = COALESCE(EXCLUDED.plan_reasons, play_sessions.plan_reasons),
            subtitle_method = COALESCE(EXCLUDED.subtitle_method, play_sessions.subtitle_method),
            transcode_codec = COALESCE(EXCLUDED.transcode_codec, play_sessions.transcode_codec),
            delivery_path = COALESCE(EXCLUDED.delivery_path, play_sessions.delivery_path),
            -- Merging into a transcode stub, or reviving a timed-out row: the
            -- incoming source wins when given. A local session merging onto a
            -- stub created by the streaming path must end up 'local', or it
            -- would silently be metered as an ordinary stream.
            source = COALESCE(EXCLUDED.source, play_sessions.source),
            -- Same rule as source, and for a sharper reason: the transcode
            -- stub in transcode-jobs.queries.ts inserts a row with NO surface,
            -- and it can win the race against the real session create. Without
            -- this line every session whose transcode job landed first would
            -- keep surface NULL forever — inflating 'unknown' on exactly the
            -- transcode-heavy sessions. COALESCE both ways so a revive that
            -- somehow arrives without one cannot clobber a good value either.
            surface = COALESCE(EXCLUDED.surface, play_sessions.surface),
            -- The incoming statement wins, like source: the transcode stub that
            -- raced ahead of this insert cannot know it belongs to a preview.
            is_preview = EXCLUDED.is_preview,
            purpose = EXCLUDED.purpose,
            -- A start that names its entry wins; one that names none (the
            -- transcode stub, a compat revive) keeps what the real start set.
            -- A revive continues the same playback and keeps its start; a transcode
            -- stub (inserted elsewhere, no start) takes the real start's.
            entry_mode = COALESCE(EXCLUDED.entry_mode, play_sessions.entry_mode),
            start_position_ms = COALESCE(play_sessions.start_position_ms, EXCLUDED.start_position_ms),
            high_water_ms = GREATEST(play_sessions.high_water_ms, EXCLUDED.high_water_ms),
            status = 'ACTIVE',
            paused_at = NULL,
            stopped_at = NULL,
            stop_reason = NULL,
            last_heartbeat_at = now(),
            -- Adoption keeps the prepared deck's report ordering. Reset to 0 only on revive: a heartbeat-timed-out session
            -- reused by a reconnecting client is a fresh playback attempt whose seq
            -- counter restarts low, so the gate must accept those new heartbeats.
            -- (This is deliberate — see the "revives a heartbeat-timed-out ..."
            -- integration test. A genuine restart mints a new session id, so the
            -- theoretical stale-buffered-heartbeat replay is not a practical risk.)
            last_event_seq = CASE WHEN play_sessions.purpose = 'prefetch'
                THEN play_sessions.last_event_seq ELSE 0 END
        WHERE play_sessions.status <> 'KILLED'
        RETURNING *
    `;
    return row;
}

export async function getSessionById(sql: postgres.Sql, id: string): Promise<SessionRow | null> {
    const [row] = await sql<SessionRow[]>`
        SELECT ps.*, mi.media_type
        FROM play_sessions ps
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        WHERE ps.id = ${id}
    `;
    return row ?? null;
}

/**
 * Fetch a single session by ID, scoped to `client_name = 'Lumastra Music'`.
 *
 * Used by `PUT /api/v1/play-sessions/{id}` so that callers cannot read
 * video or Jellyfin session rows through the music-session surface —
 * the owner check alone is insufficient because a user who knows another
 * session's UUID (e.g. their own video session) would otherwise receive
 * it formatted as a music session.
 *
 * Returns null for both "not found" and "wrong client_name" so the caller
 * can surface a uniform 404.
 */
export async function getMusicSessionById(
    sql: postgres.Sql,
    id: string,
): Promise<(MusicSessionRow & { user_id: string }) | null> {
    const [row] = await sql<(MusicSessionRow & { user_id: string })[]>`
        SELECT id, media_id, status, position_ms, started_at,
               last_heartbeat_at, stopped_at, device_id, user_agent,
               user_id
        FROM play_sessions
        WHERE id = ${id}
          AND client_name = 'Lumastra Music'
          AND purpose = 'play'
    `;
    return row ?? null;
}

/**
 * Cheap re-read used by the heartbeat backstop to disambiguate a `null` from
 * `updateHeartbeat`. Selects only the two columns needed to classify the
 * termination so we don't ship the full row over the wire on every rejected
 * heartbeat.
 *
 * Returns null for both the row-not-found case and any malformed-UUID case —
 * the backstop treats both as "row vanished", which routes to silent kill.
 * This avoids surfacing a 22P02 invalid-uuid postgres error as a 500 on
 * heartbeat traffic from clients that somehow pass a non-UUID session id.
 */
export async function getSessionStatusAndReason(
    sql: postgres.Sql,
    id: string,
): Promise<{ status: string; stop_reason: string | null } | null> {
    if (!UUID_RE.test(id)) return null;
    const [row] = await sql<{ status: string; stop_reason: string | null }[]>`
        SELECT status, stop_reason
        FROM play_sessions
        WHERE id = ${id}
    `;
    return row ?? null;
}

export async function getActiveSessionsForUser(
    sql: postgres.Sql,
    userId: UserId,
): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        SELECT * FROM play_sessions
        WHERE user_id = ${userId}
          AND status IN ('ACTIVE', 'PAUSED')
          AND NOT is_preview
          AND purpose = 'play'
        ORDER BY started_at DESC
    `;
}

/** A live /j session, as the free-tier stream cap sees it. */
export interface JellyfinCompatStreamRow {
    id: string;
    user_id: string;
    media_id: string;
    started_at: Date;
    username: string;
    jellyfin_play_session_id: string | null;
    last_event_seq: number;
    device_id: string;
}

/**
 * How long an ACTIVE /j row may go without a progress report before the
 * free-tier cap stops counting it. Jellyfin clients report progress every ~10 s
 * while playing, so 2 minutes is many missed reports — the client is gone.
 *
 * Tighter than the reaper's 5-minute ACTIVE window on purpose: the reaper only
 * decides when a row is closed, but here a dead row would hand the NEXT viewer
 * the "stream limit reached" clip (or get a live newcomer kicked) for up to
 * 5 minutes plus a reaper tick. PAUSED rows keep the reaper's rule (30 minutes
 * from `paused_at`): Jellyfin clients stop reporting while paused, and a paused
 * stream is still holding its slot, the same as on real Jellyfin.
 */
export const JELLYFIN_CAP_ACTIVE_FRESHNESS_SECONDS = 120;

/**
 * Every LIVE session started through the Jellyfin-compatible `/j` API, across
 * ALL users, oldest first (id breaks ties, so every replica agrees on the order).
 *
 * The free-tier cap is per server, so this deliberately has no user filter. It
 * keys on `surface = 'jellyfin_compat'`, which only `findOrCreateJellyfinSession`
 * writes (a server-side literal, never taken from the client). Web and
 * native-app sessions have other surfaces and are never returned; neither are
 * native-Jellyfin mirror rows ('jellyfin_mirror').
 *
 * "Live" excludes zombies the reaper has not closed yet: anything
 * `staleSessionCondition` already calls stale, and any ACTIVE row without a
 * progress report for {@link JELLYFIN_CAP_ACTIVE_FRESHNESS_SECONDS}. A client
 * that crashed or lost its network therefore stops holding a slot after
 * 2 minutes instead of showing the next viewer the limit clip.
 * Covered by the `idx_play_sessions_live` partial index on live rows.
 */
export async function getLiveJellyfinCompatSessions(
    sql: postgres.Sql,
): Promise<JellyfinCompatStreamRow[]> {
    return sql<JellyfinCompatStreamRow[]>`
        SELECT id, user_id, media_id, started_at, jellyfin_play_session_id, last_event_seq, device_id,
               (SELECT username FROM users WHERE users.id = play_sessions.user_id) AS username
        FROM play_sessions
        WHERE ${liveJellyfinCompatSessionCondition(sql)}
        ORDER BY started_at ASC, id ASC
    `;
}

/** Shared with enforcement: diagnostics must never count a session whose slot is free. */
function liveJellyfinCompatSessionCondition(sql: postgres.Sql) {
    return sql`
        status IN ('ACTIVE', 'PAUSED')
        AND surface = 'jellyfin_compat'
        AND NOT ${staleSessionCondition(sql)}
        AND (
            status = 'PAUSED'
            OR last_heartbeat_at >= now() - make_interval(secs => ${JELLYFIN_CAP_ACTIVE_FRESHNESS_SECONDS})
        )
    `;
}

/**
 * Conservative diagnostics count: enforcement-live bridge sessions sustained for
 * over 60 seconds, with a progress heartbeat in the last five minutes. The latter
 * preserves diagnostics' recency window for paused clients, which stop reporting.
 * Normal /j progress updates last_heartbeat_at, not the external-poller last_seen_at.
 */
export async function countSustainedLiveJellyfinCompatSessions(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM play_sessions
        WHERE ${liveJellyfinCompatSessionCondition(sql)}
          AND started_at < now() - INTERVAL '60 seconds'
          AND last_heartbeat_at > now() - INTERVAL '5 minutes'
    `;
    return parseInt(row?.n ?? '0', 10);
}

/**
 * How many live sessions there are, and how many of them announced a given
 * client feature.
 *
 * Feeds the operator-facing "will display on N of M" line on the maintenance
 * card. Counted in one pass rather than by fetching rows: the caller wants two
 * integers, and `getAllActiveSessions` caps at 1000 rows, which would make the
 * denominator silently wrong on a busy install.
 *
 * A NULL `client_features` (every pre-16.247.0 client, and every mirrored
 * session with no client to ask) counts toward `total` and not toward
 * `supporting` — `= ANY(NULL)` is NULL, not false, so the `COALESCE` is doing
 * real work here and is not defensive noise.
 */
export async function countLiveSessionsAnnouncing(
    sql: postgres.Sql,
    feature: string,
): Promise<{ total: number; supporting: number }> {
    const [row] = await sql<{ total: string; supporting: string }[]>`
        SELECT count(*)                                                   AS total,
               count(*) FILTER (
                   WHERE COALESCE(${feature} = ANY(client_features), false)
               )                                                          AS supporting
        FROM play_sessions
        WHERE status IN ('ACTIVE', 'PAUSED')
          AND NOT is_preview
          AND purpose = 'play'
    `;
    return {
        total: Number(row?.total ?? 0),
        supporting: Number(row?.supporting ?? 0),
    };
}

export async function getAllActiveSessions(sql: postgres.Sql): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        SELECT * FROM play_sessions
        WHERE status IN ('ACTIVE', 'PAUSED')
          AND NOT is_preview
          AND purpose = 'play'
        ORDER BY last_heartbeat_at DESC
        LIMIT 1000
    `;
}

export interface ActiveSessionWithMedia extends SessionRow {
    media_title: string;
    season_number: number | null;
    episode_number: number | null;
    season_id: string | null;
    season_title: string | null;
    series_id: string | null;
    series_title: string | null;
    file_path?: string | null;
    /** Album title — populated when media_type = 'track' (parent item is the album). */
    album_name: string | null;
    /** Album UUID — populated when media_type = 'track'. Serves as seriesId for image routing. */
    album_id: string | null;
    /**
     * Display artist — populated when media_type = 'track'.
     *
     * The track's OWN artist tag first, the album-artist row only as a
     * fallback. Not the grandparent title: on a compilation that row is the
     * "Various Artists" marker, so every session card on a VA album named the
     * marker instead of the performer.
     */
    artist_name: string | null;
    /**
     * Artist UUID — populated when media_type = 'track'. Resolved from the same
     * tag as `artist_name` so the two never name different entities; NULL
     * rather than a wrong link when no candidate matches the displayed name.
     */
    artist_id: string | null;
    /** Plot/synopsis — falls back to series overview for episodes without their own. */
    overview: string | null;
    /** Release year (from media_items.year). */
    year: number | null;
    /** Runtime in seconds (from media_items.runtime_seconds). */
    runtime_seconds: number | null;
    /**
     * Probed audio-stream detail for the session's file (default audio track).
     * Only `sample_rate` has no `play_sessions` column of its own; the codec and
     * bitrate are carried as a fallback for sessions whose row predates — or
     * whose ingest path never populated — `audio_codec` / `bitrate_kbps`
     * (Subsonic music sessions, rows created before the music-session insert
     * started recording format). All bitrates are bps.
     */
    file_audio_codec: string | null;
    file_audio_bitrate: number | null;
    file_audio_sample_rate: number | null;
    file_audio_channels: number | null;
    /** Container / overall bitrate of the session's file (bps) — same fallback role. */
    file_container: string | null;
    file_total_bitrate: number | null;
    /** External provider IDs — driven from external_ids table. */
    tmdb_id: string | null;
    imdb_id: string | null;
    /** Aggregated community/critic ratings sourced from provider_metadata. */
    community_rating: string | null;
    critic_rating: string | null;
    official_rating: string | null;
    /**
     * The owning user's login handle (users.username), or the raw user_id UUID
     * text when no users row matches. `user_id` is the stable UUID since mig
     * 16.46.0 — use THIS for display, never `user_id`.
     */
    owner_username: string;
    /** The owning user's display name, when set. */
    owner_display_name: string | null;
    /** Device display name from user_devices (custom_name, else reported_name); null when unnamed. */
    device_name: string | null;
}

export async function getAllActiveSessionsWithMedia(
    sql: postgres.Sql,
    filters: { userId?: string; itemId?: string } = {},
): Promise<ActiveSessionWithMedia[]> {
    return sql<ActiveSessionWithMedia[]>`
        SELECT ps.*,
            COALESCE(mi.title, ps.media_id::text) AS media_title,
            mi.media_type,
            mi.season_number,
            mi.episode_number,
            season.id AS season_id,
            season.title AS season_title,
            series.id AS series_id,
            series.title AS series_title,
            COALESCE(mf_plan.file_path, mf_default.file_path) AS file_path,
            COALESCE(mf_plan.container_format, mf_default.container_format) AS file_container,
            COALESCE(mf_plan.total_bitrate, mf_default.total_bitrate) AS file_total_bitrate,
            ms_audio.codec       AS file_audio_codec,
            ms_audio.bitrate     AS file_audio_bitrate,
            ms_audio.sample_rate AS file_audio_sample_rate,
            ms_audio.channels    AS file_audio_channels,
            album.title AS album_name,
            album.id    AS album_id,
            -- Track-level, not the bare album-artist join. The artist alias
            -- is the album's parent row, which on a compilation is the Various
            -- Artists marker — "Apologize (Ti-Mo vs. Stefan Rio Radio Edit)"
            -- on Hands Up Essentials Vol. 1 rendered as "Various Artists"
            -- while its own ARTIST tag reads "The Degrees". Both halves move
            -- together on purpose: resolving only the name would leave the id
            -- pointing at the marker's page.
            --
            -- No backticks anywhere in this comment: it sits inside a tagged
            -- template literal and one would end the query mid-string.
            --
            -- Gated on media_type so a non-track item that ever carries an
            -- 'artist' tag cannot start reporting one here — the album/artist
            -- joins below are gated the same way, and the session card falls
            -- back to the author field for audiobooks when this is NULL.
            CASE WHEN mi.media_type = 'track'
                 THEN ${trackDisplayArtistSql(sql, 'mi')} END AS artist_name,
            CASE WHEN mi.media_type = 'track'
                 THEN ${trackArtistIdSql(sql, 'mi')} END      AS artist_id,
            -- Episodes without their own overview fall back to the series synopsis
            COALESCE(NULLIF(mi.overview, ''), NULLIF(series.overview, '')) AS overview,
            -- For episodes, prefer the series year so the modal doesn't show the air-year of the episode alone
            COALESCE(mi.year, series.year) AS year,
            mi.runtime_seconds,
            (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'tmdb' LIMIT 1) AS tmdb_id,
            (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) AS imdb_id,
            -- Ratings: episodes inherit from the series row where missing
            COALESCE(
                (SELECT pm.metadata->>'vote_average' FROM provider_metadata pm WHERE pm.media_id = mi.id AND pm.provider = 'aggregated' LIMIT 1),
                (SELECT pm.metadata->>'vote_average' FROM provider_metadata pm WHERE pm.media_id = series.id AND pm.provider = 'aggregated' LIMIT 1)
            ) AS community_rating,
            COALESCE(
                (SELECT pm.metadata->>'rt_rating' FROM provider_metadata pm WHERE pm.media_id = mi.id AND pm.provider = 'aggregated' LIMIT 1),
                (SELECT pm.metadata->>'rt_rating' FROM provider_metadata pm WHERE pm.media_id = series.id AND pm.provider = 'aggregated' LIMIT 1)
            ) AS critic_rating,
            COALESCE(
                (SELECT pm.metadata->>'certification' FROM provider_metadata pm WHERE pm.media_id = mi.id AND pm.provider = 'aggregated' LIMIT 1),
                (SELECT pm.metadata->>'certification' FROM provider_metadata pm WHERE pm.media_id = series.id AND pm.provider = 'aggregated' LIMIT 1)
            ) AS official_rating,
            -- ps.user_id is the stable users.id UUID (mig 16.46.0); resolve to a
            -- human-readable handle for display, falling back to the raw UUID text.
            COALESCE(u.username, ps.user_id::text) AS owner_username,
            u.display_name AS owner_display_name,
            -- play_sessions has no name column: the device's display name lives in
            -- user_devices (custom_name wins over reported_name). NULL when unnamed.
            COALESCE(NULLIF(ud.custom_name, ''), NULLIF(ud.reported_name, '')) AS device_name
        FROM play_sessions ps
        LEFT JOIN users u ON u.id = ps.user_id
        LEFT JOIN user_devices ud ON ud.user_id = ps.user_id AND ud.device_id = ps.device_id
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
        LEFT JOIN media_items series ON series.id = CASE
            WHEN mi.media_type = 'season' THEN mi.parent_id
            WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
        END
        LEFT JOIN media_files mf_plan ON mf_plan.id = ps.file_id
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = ps.media_id AND mfi.is_default = true
        LEFT JOIN media_files mf_default ON mf_default.id = mfi.file_id
        LEFT JOIN media_items album  ON album.id  = mi.parent_id  AND mi.media_type = 'track'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND mi.media_type = 'track'
        -- Probed audio stream for the file being played: the track the session
        -- selected when it reported one, else the default/first audio stream.
        -- Indexed on media_streams(file_id), one lookup per session row.
        LEFT JOIN LATERAL (
            -- codec is NOT NULL DEFAULT 'unknown', so a not-yet-identified
            -- stream would otherwise surface as an "UNKNOWN" badge.
            SELECT NULLIF(s.codec, 'unknown') AS codec, s.bitrate, s.sample_rate, s.channels
            FROM media_streams s
            WHERE s.file_id = COALESCE(mf_plan.id, mf_default.id)
              AND s.stream_type = 'audio'
            ORDER BY COALESCE(s.stream_index = ps.audio_stream_index, false) DESC,
                     s.is_default DESC,
                     s.stream_index
            LIMIT 1
        ) ms_audio ON true
        WHERE ps.status IN ('ACTIVE', 'PAUSED')
          AND NOT ps.is_preview AND ps.purpose = 'play'
          AND (${filters.userId ?? null}::uuid IS NULL OR ps.user_id = ${filters.userId ?? null}::uuid)
          AND (${filters.itemId ?? null}::uuid IS NULL OR ps.media_id = ${filters.itemId ?? null}::uuid)
        ORDER BY ps.last_heartbeat_at DESC
        LIMIT 1000
    `;
}

export async function updateHeartbeat(
    sql: postgres.Sql,
    id: string,
    params: HeartbeatParams,
): Promise<SessionRow | null> {
    // Allow CRASHED sessions to be revived — handles clients that resume after
    // a heartbeat timeout (e.g., mobile app returning from background).
    // KILLED sessions are NOT revivable (admin-terminated).
    //
    // Only an ACTIVE report may revive a CRASHED row. A PAUSED one may not:
    // a paused web tab keepalives every 30 s forever (playerStore's idle
    // interval), so a paused heartbeat would flip the row the reaper just
    // CRASHED (paused_at older than the grace, see staleSessionCondition) back
    // to PAUSED — with its original paused_at, since the CASE below only stamps
    // paused_at when it is NULL. The row then ping-pongs CRASHED↔PAUSED every
    // reaper cycle and keeps consuming a concurrent-stream slot indefinitely
    // (a tab paused overnight blocked every new stream for its owner).
    // Both documented reasons for reviving — a container restart mid-playback
    // and a brief network loss — report ACTIVE, and the player sends ACTIVE on
    // resume, so this costs nothing there. A rejected update is NOT surfaced as
    // a 404 either: handleHeartbeat re-reads the row and treats a still
    // ACTIVE/PAUSED/CRASHED status as a no-op success, so the client keeps its
    // session id instead of minting a new row every 30 s.
    //
    // event_seq gate: reject out-of-order heartbeats whose seq is not strictly
    // greater than last_event_seq. The schema requires event_seq on every
    // payload (native clients pre-increment from 1; Jellyfin compat uses
    // Date.now()), so there is no seq=0 bypass.
    //
    // Subtitle method rules (schema-enforced client input + SQL invariants):
    //   • Client cannot report 'burn_in' (ClientSubtitleMethodEnum).
    //   • If the row is already 'burn_in' (server decision from the HLS
    //     planner), preserve it — never let a heartbeat downgrade it.
    //   • When the effective method is 'none', clear subtitle_language and
    //     subtitle_stream_index so the Continue Watching card doesn't render
    //     stale language labels.
    const clientSeq = params.event_seq;
    const [row] = await sql<SessionRow[]>`
        UPDATE play_sessions
        SET
            position_ms           = ${params.position_ms},
            -- Furthest point reached; the resume handoff treats a rewind below it as
            -- not linear until playback passes it again.
            high_water_ms         = GREATEST(COALESCE(high_water_ms, 0), ${params.position_ms}),
            last_heartbeat_at     = now(),
            status                = ${params.status},
            bitrate_kbps          = COALESCE(${params.bitrate_kbps ?? null}, bitrate_kbps),
            resolution            = COALESCE(${params.resolution ?? null}, resolution),
            play_method           = COALESCE(${params.play_method ?? null}, play_method),
            audio_stream_index    = COALESCE(${params.audio_stream_index ?? null}, audio_stream_index),
            audio_language        = COALESCE(${params.audio_language ?? null}, audio_language),
            subtitle_method = CASE
                WHEN subtitle_method = 'burn_in' THEN 'burn_in'
                ELSE COALESCE(${params.subtitle_method ?? null}, subtitle_method)
            END,
            subtitle_stream_index = CASE
                WHEN subtitle_method = 'burn_in' THEN subtitle_stream_index
                WHEN COALESCE(${params.subtitle_method ?? null}, subtitle_method) = 'none' THEN NULL
                ELSE COALESCE(${params.subtitle_stream_index ?? null}, subtitle_stream_index)
            END,
            subtitle_language = CASE
                WHEN subtitle_method = 'burn_in' THEN subtitle_language
                WHEN COALESCE(${params.subtitle_method ?? null}, subtitle_method) = 'none' THEN NULL
                ELSE COALESCE(${params.subtitle_language ?? null}, subtitle_language)
            END,
            buffer_health_sec     = ${params.buffer_health_sec ?? null},
            stopped_at            = NULL,
            stop_reason           = NULL,
            paused_at = CASE
                WHEN ${params.status} = 'PAUSED' AND paused_at IS NULL THEN now()
                WHEN ${params.status} = 'ACTIVE' THEN NULL
                ELSE paused_at
            END,
            last_event_seq = GREATEST(last_event_seq, ${clientSeq})
        WHERE id = ${id}
          AND (
              status IN ('ACTIVE', 'PAUSED')
              OR (status = 'CRASHED' AND ${params.status} = 'ACTIVE')
          )
          AND ${clientSeq} > last_event_seq
        RETURNING *
    `;
    return row ?? null;
}

/**
 * Server-authoritative setter for `subtitle_method` keyed by plan_id.
 *
 * Called from the HLS planner when FFmpeg decides to burn subtitles into
 * the video stream. This is the authoritative path — the heartbeat SQL
 * refuses to downgrade 'burn_in', so setting it here locks the row.
 */
export async function setSessionSubtitleMethodByPlanId(
    sql: postgres.Sql,
    planId: string,
    method: 'external_vtt' | 'burn_in' | 'client_render' | 'none',
): Promise<number> {
    const result = await sql`
        UPDATE play_sessions
        SET subtitle_method = ${method}
        WHERE plan_id = ${planId}
          AND status IN ('ACTIVE', 'PAUSED', 'CRASHED')
          AND (subtitle_method IS DISTINCT FROM ${method})
    `;
    return result.count;
}

export async function updateLastJellyfinReport(
    sql: postgres.Sql,
    session_id: string,
): Promise<void> {
    await sql`
        UPDATE play_sessions
        SET last_jellyfin_report_at = now()
        WHERE id = ${session_id}
    `;
}

/** Terminalize preparation tied to an ended admitted deck; keep cleanup durable. */
export async function expireMusicPrefetchRowsForParent(
    sql: postgres.Sql,
    parentId: string,
): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        WITH expired AS (
            UPDATE play_sessions SET status = 'CRASHED', stopped_at = now(),
                stop_reason = 'prefetch_parent_ended', external_payload = ${reapClaimPayload(sql)}
            WHERE purpose = 'prefetch' AND status IN ('ACTIVE', 'PAUSED')
              AND user_id = (SELECT user_id FROM play_sessions WHERE id = ${parentId}::uuid)
              AND external_payload ->> '__lumastra_prefetch_parent' = ${parentId}
              AND EXISTS (SELECT 1 FROM play_sessions parent WHERE parent.id = ${parentId}::uuid
                  AND parent.status NOT IN ('ACTIVE', 'PAUSED'))
            RETURNING *
        ), revoked AS (
            UPDATE hls_playback_tokens SET is_active = false, ended_reason = 'reaped'
            WHERE play_session_id IN (SELECT id::text FROM expired) AND is_active = true
        ) SELECT * FROM expired`;
}

/**
 * Finalize a session as COMPLETED. Allows CRASHED → COMPLETED (mirrors
 * `updateHeartbeat`'s "allow CRASHED sessions to be revived" precedent) so a
 * completion report that arrives after the heartbeat reaper already closed
 * the row still gets applied, instead of silently no-op'ing. Without this, a
 * client that finishes an episode after its session was heartbeat-timed-out
 * (e.g. a container restart mid-playback) would get an HTTP success on its
 * stop call while `handleStop()`'s watch-state/markWatched/watch_history
 * side effects never ran — the caller can't distinguish "already handled"
 * from "silently dropped" since both return the same 204.
 * KILLED and already-COMPLETED are intentionally excluded: an admin-killed
 * session should not be retroactively completed, and a second stop for an
 * already-COMPLETED row is a harmless idempotent no-op.
 */
export async function stopSession(
    sql: postgres.Sql,
    id: string,
    position_ms: number,
    stop_reason: string,
): Promise<SessionRow | null> {
    return withTx(sql, async (tx) => {
        // Match admission/promotion: user lock before either parent or child rows.
        // Keep it through child expiry even when called on an autocommit handle.
        await tx`
            SELECT pg_advisory_xact_lock(hashtextextended(user_id::text, 0))
            FROM play_sessions WHERE id = ${id}`;
        const [row] = await tx<SessionRow[]>`
            UPDATE play_sessions
            SET
                status      = 'COMPLETED',
                stopped_at  = now(),
                stop_reason = ${stop_reason},
                position_ms = ${position_ms}
            WHERE id = ${id}
              AND status IN ('ACTIVE', 'PAUSED', 'CRASHED')
            RETURNING *
        `;
        if (row) await expireMusicPrefetchRowsForParent(tx, row.id);
        return row ?? null;
    });
}

export async function killSession(
    sql: postgres.Sql,
    id: string,
    killed_by: string,
    stop_reason?: string,
): Promise<(SessionRow & { owner_username: string }) | null> {
    const reason = stop_reason ?? `admin:${killed_by}`;
    const [row] = await sql<Array<SessionRow & { owner_username: string }>>`
        WITH killed AS (
            UPDATE play_sessions
            SET
                status      = 'KILLED',
                stopped_at  = now(),
                stop_reason = ${reason},
                -- An AudiobookShelf row is our own stream with an upstream
                -- session behind it. Killing it without the close stamp left
                -- that session open in ABS with nothing able to find it again
                -- (getRetryableAudiobookSessionCloses keys off the stamp). The
                -- stamped close is position-less, so a kill never rewinds the
                -- listener. Other sources keep their payload untouched.
                external_payload = CASE
                    WHEN source = 'audiobookshelf' THEN ${reapClaimPayload(sql)}
                    ELSE external_payload
                END
            WHERE id = ${id}
              AND status IN ('ACTIVE', 'PAUSED')
            RETURNING *
        )
        SELECT k.*, COALESCE(u.username, k.user_id::text) AS owner_username
        FROM killed k
        LEFT JOIN users u ON u.id = k.user_id
    `;
    if (row) await expireMusicPrefetchRowsForParent(sql, row.id);
    return row ?? null;
}

/**
 * Returns sessions that ended within the last `withinSeconds` seconds.
 * Used by /j/Sessions to emit ghost entries so clients like jellyfin-rpc2
 * can clear their Discord presence — those clients only clear when a session
 * is present but has no NowPlayingItem; StopIteration (empty list) is silently ignored.
 */
export async function getRecentlyEndedSessions(
    sql: postgres.Sql,
    withinSeconds = 60,
): Promise<Array<SessionRow & { owner_username: string; owner_display_name: string | null }>> {
    return sql<Array<SessionRow & { owner_username: string; owner_display_name: string | null }>>`
        SELECT ps.*,
            COALESCE(u.username, ps.user_id::text) AS owner_username,
            u.display_name AS owner_display_name
        FROM play_sessions ps
        LEFT JOIN users u ON u.id = ps.user_id
        WHERE ps.status IN ('COMPLETED', 'CRASHED', 'KILLED')
          AND ps.stopped_at > now() - make_interval(secs => ${withinSeconds})
        ORDER BY ps.stopped_at DESC
        LIMIT 500
    `;
}

/** The most recently ended session, for the admin Home idle line ("last: Leon, 12 min ago"). */
export interface LastEndedSessionRow {
    username: string;
    title: string | null;
    stopped_at: Date;
}

/**
 * Most recently ended play session. Admin Home only asks while nobody is
 * watching. Select one session through the partial ended-session index before
 * enriching its user and media hierarchy.
 */
export async function getLastEndedSession(sql: postgres.Sql): Promise<LastEndedSessionRow | null> {
    // Admin-only surface (GET /api/admin/status/payload): the title is operator
    // context, not a user-facing media listing, so no library/age scoping.
    const [row] = await sql<LastEndedSessionRow[]>`
        WITH latest AS MATERIALIZED (
            SELECT user_id, media_id, stopped_at FROM play_sessions
            WHERE status IN ('COMPLETED', 'CRASHED', 'KILLED') AND stopped_at IS NOT NULL
            ORDER BY stopped_at DESC LIMIT 1
        )
        SELECT
            COALESCE(u.username, ps.user_id::text) AS username,
            CASE
                WHEN mi.media_type = 'episode' AND COALESCE(gp.title, p.title) IS NOT NULL
                    THEN COALESCE(gp.title, p.title) || ' – ' || mi.title
                ELSE mi.title
            END AS title,
            ps.stopped_at
        FROM latest ps
        LEFT JOIN users u ON u.id = ps.user_id
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN media_items p ON p.id = mi.parent_id
        LEFT JOIN media_items gp ON gp.id = p.parent_id
    `;
    return row ?? null;
}

// ─── External-source ingestion (Jellyfin / ABS / LiveTV / music pollers) ─────

/**
 * Parameters for `upsertExternalSession`. Mirrors the columns external pollers
 * write to `play_sessions` via the `(source, source_session_id)` upsert key.
 *
 * Fields are normalised already (e.g. media_id resolved to a UUID, status
 * narrowed to ACTIVE/PAUSED) — this query layer does not interpret data.
 */
export interface UpsertExternalSessionParams {
    /**
     * Which API surface the client spoke. REQUIRED with no default — see
     * `CreateSessionParams.surface`. Callers on this path must NOT hardcode a
     * literal at a shared wrapper: `upsertTranscodeSession` sits on top of this
     * and serves both real Subsonic clients and our own music player, so the
     * decision belongs to each call site.
     */
    surface: PlaySurface;
    source: PlaySessionSource;
    source_session_id: string;
    media_id: string;
    user_id: UserId;
    /** External pollers don't always know the device id; default to source. */
    device_id: string;
    user_agent?: string | null;
    client_name?: string | null;
    client_version?: string | null;
    /**
     * External sessions usually don't expose a useful IP; pollers can pass
     * '0.0.0.0' which is the same sentinel `createPlaySession` uses on merge.
     */
    ip_address?: string;
    play_method?: string;
    status: 'ACTIVE' | 'PAUSED';
    position_ms: number;
    runtime_ms?: number | null;
    audio_codec?: string | null;
    video_codec?: string | null;
    container?: string | null;
    bitrate_kbps?: number | null;
    resolution?: string | null;
    external_payload?: unknown;
    /**
     * Kind of session. Omitted = 'play'. 'download' is an offline audiobook transfer.
     * Only written on INSERT: an existing row keeps its purpose, so a poller upsert can
     * never turn a download into a stream or the reverse.
     */
    purpose?: 'play' | 'download';
}

/**
 * Look up an external session row by its source-system key. Used by
 * `SessionManager` to decide between the lightweight presence refresh and the
 * full upsert when a poller reports an existing session. Returns null if no
 * row exists for `(source, source_session_id)`.
 */
export async function getSessionBySourceKey(
    sql: postgres.Sql,
    source: PlaySessionSource,
    sourceSessionId: string,
): Promise<SessionRow | null> {
    const [row] = await sql<SessionRow[]>`
        SELECT ps.*, mi.media_type
        FROM play_sessions ps
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        WHERE ps.source = ${source}
          AND ps.source_session_id = ${sourceSessionId}
        LIMIT 1
    `;
    return row ?? null;
}

/**
 * Lightweight presence refresh — bumps `last_seen_at` only.
 *
 * The unified-source ingestion contract (F1/F2) requires every poll to refresh
 * `last_seen_at` so the external-source reaper (F5) can distinguish "still
 * being reported" from "vanished from upstream". Heavier semantic columns are
 * left untouched; the caller invokes `upsertExternalSession` separately when
 * a meaningful change is detected. Returns the row count (0 when the upsert
 * has not created the row yet, in which case the caller should fall back to
 * the full INSERT path).
 */
export async function refreshExternalSessionPresence(
    sql: postgres.Sql,
    source: PlaySessionSource,
    sourceSessionId: string,
): Promise<number> {
    const result = await sql`
        UPDATE play_sessions
        SET last_seen_at = now()
        WHERE source = ${source}
          AND source_session_id = ${sourceSessionId}
    `;
    return result.count;
}

/**
 * Upsert a row from an external poller using `(source, source_session_id)` as
 * the conflict key. ON CONFLICT updates only semantic fields plus
 * `last_seen_at` / `last_heartbeat_at`; preserves `started_at` and `id` so
 * cross-references (watch history rows etc.) remain stable across re-syncs.
 *
 * Caller is responsible for the "did anything actually change?" gate — this
 * query unconditionally writes the supplied semantic fields. Returns the
 * resulting row plus a `created` flag (true when a new row was inserted,
 * false when an existing row was updated; uses Postgres's `xmax = 0` trick
 * which is 0 for fresh inserts).
 */
export async function upsertExternalSession(
    sql: postgres.Sql,
    params: UpsertExternalSessionParams,
): Promise<{ row: SessionRow; created: boolean }> {
    const ipAddress = params.ip_address ?? '0.0.0.0';
    const deviceId = params.device_id;
    const playMethod = params.play_method ?? 'direct';

    const rows = await sql<(SessionRow & { inserted: boolean })[]>`
        INSERT INTO play_sessions (
            media_id, user_id, device_id, user_agent, client_name, client_version,
            ip_address, play_method,
            audio_codec, video_codec, container, bitrate_kbps, resolution,
            position_ms, runtime_ms, status,
            source, source_session_id, last_seen_at, external_payload, surface, purpose
        ) VALUES (
            ${params.media_id}, ${params.user_id}, ${deviceId},
            ${params.user_agent ?? null}, ${params.client_name ?? null},
            ${params.client_version ?? null},
            ${ipAddress}::inet, ${playMethod},
            ${params.audio_codec ?? null}, ${params.video_codec ?? null},
            ${params.container ?? null}, ${params.bitrate_kbps ?? null},
            ${params.resolution ?? null},
            ${params.position_ms}, ${params.runtime_ms ?? null}, ${params.status},
            ${params.source}, ${params.source_session_id}, now(),
            ${
                params.external_payload === undefined || params.external_payload === null
                    ? null
                    : sql.json(params.external_payload as postgres.JSONValue)
            },
            ${params.surface},
            ${params.purpose ?? 'play'}
        )
        ON CONFLICT (source, source_session_id) WHERE source_session_id IS NOT NULL DO UPDATE SET
            media_id          = EXCLUDED.media_id,
            user_id           = EXCLUDED.user_id,
            device_id         = COALESCE(EXCLUDED.device_id, play_sessions.device_id),
            user_agent       = COALESCE(EXCLUDED.user_agent, play_sessions.user_agent),
            client_name       = COALESCE(EXCLUDED.client_name, play_sessions.client_name),
            client_version    = COALESCE(EXCLUDED.client_version, play_sessions.client_version),
            play_method       = COALESCE(EXCLUDED.play_method, play_sessions.play_method),
            audio_codec       = COALESCE(EXCLUDED.audio_codec, play_sessions.audio_codec),
            video_codec       = COALESCE(EXCLUDED.video_codec, play_sessions.video_codec),
            container         = COALESCE(EXCLUDED.container, play_sessions.container),
            bitrate_kbps      = COALESCE(EXCLUDED.bitrate_kbps, play_sessions.bitrate_kbps),
            resolution        = COALESCE(EXCLUDED.resolution, play_sessions.resolution),
            runtime_ms        = COALESCE(EXCLUDED.runtime_ms, play_sessions.runtime_ms),
            position_ms       = EXCLUDED.position_ms,
            status            = EXCLUDED.status,
            last_heartbeat_at = now(),
            last_seen_at      = now(),
            paused_at = CASE
                WHEN EXCLUDED.status = 'PAUSED' AND play_sessions.paused_at IS NULL THEN now()
                WHEN EXCLUDED.status = 'ACTIVE' THEN NULL
                ELSE play_sessions.paused_at
            END,
            stopped_at        = NULL,
            stop_reason       = NULL,
            external_payload  = COALESCE(EXCLUDED.external_payload, play_sessions.external_payload),
            -- Never clobber a recorded surface with a NULL from a later poll.
            surface           = COALESCE(EXCLUDED.surface, play_sessions.surface)
        WHERE play_sessions.status <> 'KILLED'
        RETURNING *, (xmax = 0) AS inserted
    `;
    const row = rows[0];
    if (!row) {
        // The conflicting row is KILLED (admin/user-terminated) — the WHERE
        // guard above refuses to resurrect it. The upstream (Jellyfin/Subsonic)
        // keeps streaming regardless — Lumastra can't stop it — so the poller
        // will keep reporting this source_session_id. Return the still-KILLED
        // row unchanged rather than reviving it; `hasSemanticChange` will keep
        // seeing a status mismatch and retry the upsert every poll, which is
        // fine (cheap, no-op at the DB level) and stops as soon as the
        // upstream session actually ends or a genuinely new one starts.
        const existing = await getSessionBySourceKey(sql, params.source, params.source_session_id);
        if (!existing) {
            throw new Error(
                `upsertExternalSession returned no row for ${params.source}:${params.source_session_id}`,
            );
        }
        return { row: existing, created: false };
    }
    const { inserted, ...rest } = row;
    return { row: rest, created: inserted };
}

/**
 * Stop an external-source session by `(source, source_session_id)`. Mirrors
 * `stopSession` but uses the upsert key rather than the internal id, since
 * pollers don't necessarily track the row's UUID. `final_status` is constrained
 * to terminal states the schema CHECK accepts.
 */
export async function stopExternalSession(
    sql: postgres.Sql,
    source: PlaySessionSource,
    sourceSessionId: string,
    params: {
        final_status: 'COMPLETED' | 'CRASHED' | 'KILLED';
        stop_reason: string;
        position_ms?: number;
    },
): Promise<SessionRow | null> {
    const [row] = await sql<SessionRow[]>`
        UPDATE play_sessions
        SET
            status      = ${params.final_status},
            stopped_at  = now(),
            stop_reason = ${params.stop_reason},
            position_ms = COALESCE(${params.position_ms ?? null}, position_ms)
        WHERE source = ${source}
          AND source_session_id = ${sourceSessionId}
          AND status IN ('ACTIVE', 'PAUSED')
        RETURNING *
    `;
    return row ?? null;
}

/**
 * Terminalize an audiobook row and freeze the upstream close arguments in the
 * same statement. A duplicate close returns the existing row, so a failed
 * upstream mutation can resume without accepting newer caller-supplied data.
 */
export async function prepareAudiobookSessionClose(
    sql: postgres.Sql,
    params: {
        sourceSessionId: string;
        userId: UserId;
        mediaId: string;
        stopReason: 'finished' | 'user_stopped';
        payload: Omit<AudiobookClosePayload, 'state'>;
    },
): Promise<SessionRow | null> {
    const pending = { state: 'pending' as const, ...params.payload };
    const [row] = await sql<SessionRow[]>`
        WITH updated AS (
            UPDATE play_sessions
            SET status = 'COMPLETED',
                stopped_at = now(),
                stop_reason = ${params.stopReason},
                position_ms = ${params.payload.positionMs},
                external_payload = jsonb_set(
                    COALESCE(external_payload, '{}'::jsonb),
                    ARRAY[${AUDIOBOOK_CLOSE_KEY}],
                    COALESCE(
                        external_payload -> ${AUDIOBOOK_CLOSE_KEY},
                        ${sql.json(pending)}::jsonb
                    ),
                    TRUE
                )
            WHERE source = 'audiobookshelf'
              AND source_session_id = ${params.sourceSessionId}
              AND user_id = ${params.userId}
              AND media_id = ${params.mediaId}
              AND status IN ('ACTIVE', 'PAUSED')
            RETURNING *
        )
        SELECT * FROM updated
        UNION ALL
        SELECT ps.* FROM play_sessions ps
        WHERE ps.source = 'audiobookshelf'
          AND ps.source_session_id = ${params.sourceSessionId}
          AND ps.user_id = ${params.userId}
          AND ps.media_id = ${params.mediaId}
          AND NOT EXISTS (SELECT 1 FROM updated)
        LIMIT 1
    `;
    return row ?? null;
}

/** Mark a successfully applied immutable upstream close payload complete. */
export async function markAudiobookSessionCloseDone(
    sql: postgres.Sql,
    sourceSessionId: string,
    claimId: string,
): Promise<void> {
    await sql`
        UPDATE play_sessions
        SET external_payload = jsonb_set(
                external_payload,
                ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'],
                '"done"'::jsonb,
                FALSE
            )
        WHERE source = 'audiobookshelf'
          AND source_session_id = ${sourceSessionId}
          AND external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'] = 'processing'
          AND external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimId'] = ${claimId}
    `;
}

/**
 * Claim one pending close. The lease makes multiple replicas coalesce while a
 * crashed worker becomes retryable after one minute.
 */
export async function claimAudiobookSessionClose(
    sql: postgres.Sql,
    sourceSessionId: string,
    claimId: string,
): Promise<SessionRow | null> {
    const [row] = await sql<SessionRow[]>`
        UPDATE play_sessions
        SET external_payload = jsonb_set(
                jsonb_set(
                    jsonb_set(
                        external_payload,
                        ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'],
                        '"processing"'::jsonb,
                        FALSE
                    ),
                    ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimId'],
                    to_jsonb(${claimId}::text),
                    TRUE
                ),
                ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimedAt'],
                to_jsonb(now()),
                TRUE
            )
        WHERE source = 'audiobookshelf'
          AND source_session_id = ${sourceSessionId}
          AND (
              external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'] = 'pending'
              OR (
                  external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'] = 'processing'
                  AND (external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimedAt'])::timestamptz
                      < now() - INTERVAL '1 minute'
              )
          )
        RETURNING *
    `;
    return row ?? null;
}

/**
 * Release a live worker's failed attempt immediately instead of waiting for its
 * lease, recording the attempt so a permanently unprocessable row retires.
 *
 * Returns true when this release exhausted `MAX_REAP_ATTEMPTS` and retired the
 * payload to `state: 'failed'`, so the caller can log the give-up exactly once.
 */
export async function releaseAudiobookSessionClose(
    sql: postgres.Sql,
    sourceSessionId: string,
    claimId: string,
    options: { upstreamClosed?: boolean } = {},
): Promise<boolean> {
    // Single statement for the same reason as `recordStaleSessionAttempt`: a
    // bump-CTE followed by a retire-CTE targets the same row twice, and Postgres
    // silently drops the second modification.
    const [row] = await sql<{ retired: boolean }[]>`
        UPDATE play_sessions ps
        SET external_payload = jsonb_set(
                jsonb_set(
                    jsonb_set(
                        (ps.external_payload #- ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimedAt'])
                            #- ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimId'],
                        ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'attempts'],
                        to_jsonb(next.attempts),
                        TRUE
                    ),
                    ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'upstreamClosed'],
                    to_jsonb(${options.upstreamClosed === true} OR next.already_closed),
                    TRUE
                ),
                ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'],
                CASE
                    WHEN next.attempts >= ${MAX_REAP_ATTEMPTS} THEN '"failed"'::jsonb
                    ELSE '"pending"'::jsonb
                END,
                FALSE
            )
        FROM (
            SELECT
                COALESCE(
                    (external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'attempts'])::int,
                    0
                ) + 1 AS attempts,
                COALESCE(
                    (external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'upstreamClosed'])::boolean,
                    FALSE
                ) AS already_closed
            FROM play_sessions
            WHERE source = 'audiobookshelf'
              AND source_session_id = ${sourceSessionId}
        ) next
        WHERE ps.source = 'audiobookshelf'
          AND ps.source_session_id = ${sourceSessionId}
          AND ps.external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'] = 'processing'
          AND ps.external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimId'] = ${claimId}
        RETURNING (next.attempts >= ${MAX_REAP_ATTEMPTS}) AS retired
    `;
    return row?.retired === true;
}

/**
 * Normal and stale audiobook closes ready for a background retry attempt.
 *
 * Bounded the same way as `getPendingStaleSessions`, and for the same reason: a
 * long AudiobookShelf outage must not turn this into an unbounded serial
 * workload that every cycle replays from the top.
 */
export async function getRetryableAudiobookSessionCloses(sql: postgres.Sql): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        SELECT ps.*, mi.media_type
        FROM play_sessions ps
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        WHERE ps.source = 'audiobookshelf'
          AND ps.source_session_id IS NOT NULL
          AND ps.status IN ('COMPLETED', 'CRASHED', 'KILLED')
          AND COALESCE(
                  (ps.external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'attempts'])::int,
                  0
              ) < ${MAX_REAP_ATTEMPTS}
          AND (
              ps.external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'] = 'pending'
              OR (
                  ps.external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'state'] = 'processing'
                  AND (ps.external_payload #>> ARRAY[${AUDIOBOOK_CLOSE_KEY}, 'claimedAt'])::timestamptz
                      < now() - INTERVAL '1 minute'
              )
          )
        ORDER BY ps.stopped_at ASC NULLS LAST
        LIMIT ${REAP_BATCH_LIMIT}
    `;
}

/**
 * Stop a Lumastra session by id with a non-COMPLETED terminal status.
 * `stopSession` (above) is COMPLETED-only; this helper handles CRASHED/KILLED
 * paths so the inline UPDATE doesn't leak into service code. Mirrors the
 * `WHERE status IN ('ACTIVE', 'PAUSED')` gate so already-terminal rows aren't
 * re-touched.
 */
export async function stopLumastraSession(
    sql: postgres.Sql,
    sessionId: string,
    params: {
        final_status: 'CRASHED' | 'KILLED';
        stop_reason: string;
        position_ms?: number;
    },
): Promise<SessionRow | null> {
    const [row] = await sql<SessionRow[]>`
        UPDATE play_sessions
        SET
            status      = ${params.final_status},
            stopped_at  = now(),
            stop_reason = ${params.stop_reason},
            position_ms = COALESCE(${params.position_ms ?? null}, position_ms)
        WHERE id = ${sessionId}
          AND status IN ('ACTIVE', 'PAUSED')
        RETURNING *
    `;
    return row ?? null;
}

/**
 * Shared staleness predicate for `markStaleSessions`/`getStaleSessionCandidates` —
 * factored out so the "who is stale" definition can't drift between the SELECT
 * (used to decide which stale sessions should be finalized as COMPLETED first)
 * and the UPDATE (used to CRASH whatever is left).
 */
/**
 * True when the row being reaped is a LIVE channel (Live TV), for which the
 * paused-session grace must not apply — see `staleSessionCondition`.
 *
 * Exported for tests only. It used to be shared with a hand-copied reap in
 * `play-sessions.service.ts` so the two staleness definitions would stay aligned;
 * they drifted anyway, so that copy now calls `claimStaleSessionsForUser` and
 * `staleSessionCondition` is the single definition.
 *
 * Correlated on `play_sessions.media_id`, so every caller must query `play_sessions`
 * WITHOUT an alias.
 *
 * Deliberately only `tvchannel`. `radio` is the other live kind, but radio playback
 * does not go through this session path today, so widening it would be an untested
 * behaviour change.
 */
export function isLiveChannelSession(sql: postgres.Sql) {
    return sql`
        EXISTS (
            SELECT 1 FROM media_items mi
            WHERE mi.id = play_sessions.media_id
              AND mi.media_type = 'tvchannel'
        )
    `;
}

/** Delivery and promotion require the admitted deck that authorized this preparation. Uses alias ps. */
export function musicPrefetchUsable(sql: postgres.Sql) {
    return sql`(ps.purpose = 'play' OR (
        ps.started_at > now() - INTERVAL '10 minutes'
        AND EXISTS (SELECT 1 FROM play_sessions parent
            WHERE parent.id::text = ps.external_payload ->> '__lumastra_prefetch_parent'
              AND parent.user_id = ps.user_id AND parent.device_id = ps.device_id
              AND parent.purpose = 'play' AND NOT parent.is_preview
              AND parent.source = 'lumastra' AND parent.status IN ('ACTIVE', 'PAUSED'))
    ))`;
}

/**
 * A delivery grant may be used while the session behind it is a live stream (see
 * {@link musicPrefetchUsable}) or a live download. Uses alias ps.
 *
 * Kept apart from `musicPrefetchUsable` on purpose: that one also guards music
 * deck promotion and transcodes, which must never accept an audiobook download.
 */
export function playbackGrantSessionUsable(sql: postgres.Sql) {
    return sql`(ps.purpose = 'download' OR ${musicPrefetchUsable(sql)})`;
}

/** Live (ACTIVE/PAUSED) download sessions of one user, for the per-user cap. */
export async function countLiveDownloadSessions(
    sql: postgres.Sql,
    userId: string,
): Promise<number> {
    const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM play_sessions
        WHERE user_id = ${userId}::uuid AND purpose = 'download'
          AND status IN ('ACTIVE', 'PAUSED')
    `;
    return Number(row?.n ?? 0);
}

/**
 * Of these upstream AudiobookShelf session ids, those that one of OUR live
 * download rows holds open. Active Streams must not show them as "direct" listeners:
 * downloads are not in the session read model, so the usual claim never covers them.
 */
export async function getLiveDownloadAbsSessionIds(
    sql: postgres.Sql,
    upstreamSessionIds: readonly string[],
): Promise<Set<string>> {
    if (upstreamSessionIds.length === 0) return new Set();
    const rows = await sql<{ source_session_id: string }[]>`
        SELECT source_session_id FROM play_sessions
        WHERE source = 'audiobookshelf' AND purpose = 'download'
          AND status IN ('ACTIVE', 'PAUSED')
          AND source_session_id = ANY(${upstreamSessionIds as string[]})
    `;
    return new Set(rows.map((r) => r.source_session_id));
}

function staleSessionCondition(sql: postgres.Sql) {
    return sql`
        -- Prefetch has an absolute allocation lifetime; idle heartbeats and
        -- delivery requests must never keep an unpromoted deck alive forever.
        ((purpose = 'prefetch' AND (started_at <= now() - INTERVAL '10 minutes'
            OR NOT EXISTS (SELECT 1 FROM play_sessions parent
                WHERE parent.id::text = play_sessions.external_payload ->> '__lumastra_prefetch_parent'
                  AND parent.user_id = play_sessions.user_id AND parent.device_id = play_sessions.device_id
                  AND parent.purpose = 'play' AND NOT parent.is_preview AND parent.source = 'lumastra'
                  AND parent.status IN ('ACTIVE', 'PAUSED')))) OR
        -- A download sends no reports and may run for days, so silence is no
        -- evidence of anything. It lives as long as one of its delivery grants
        -- does: reaped once none is active and unexpired (expired, revoked, or
        -- never minted), and unconditionally after the hard cap. The 2-minute
        -- guard covers the gap between the row's commit and its grant's mint.
        (purpose = 'download' AND (
            started_at <= now() - make_interval(hours => ${DOWNLOAD_SESSION_HARD_CAP_HOURS + 1})
            OR (started_at <= now() - INTERVAL '2 minutes' AND NOT EXISTS (
                SELECT 1 FROM hls_playback_tokens grant_row
                WHERE grant_row.play_session_id = play_sessions.id::text
                    AND grant_row.is_active = true AND grant_row.expires_at > now()))
        )) OR
        (purpose = 'play' AND (
            -- Lumastra (source IS NULL or 'lumastra'): use heartbeat timing while
            -- ACTIVE. The 30-minute PAUSED grace exists so a paused MOVIE survives
            -- a coffee break — but it's measured from paused_at, NOT
            -- last_heartbeat_at. The player sends a 30s idle keepalive while
            -- paused specifically so a short pause survives; that keepalive
            -- refreshes last_heartbeat_at forever as long as the tab stays open,
            -- which would make a heartbeat-based grace never actually expire (a
            -- session paused overnight on a Mac with the tab left open stayed
            -- PAUSED — and kept showing as "watching" downstream — for 15+ hours
            -- before this fix; see the play-sessions.queries.integration.test.ts
            -- case for the exact scenario). paused_at is only stamped once on
            -- the ACTIVE-to-PAUSED transition (see updateHeartbeat) and is NOT
            -- touched by subsequent PAUSED heartbeats/keepalives, so it reliably
            -- answers "how long has this actually been paused" regardless of how
            -- many keepalives fired since.
            --
            -- The grace must NOT apply to a live channel: a live stream cannot be
            -- meaningfully paused (the broadcast runs on regardless), so a paused
            -- tvchannel row is an abandoned tuner, not a resumable session. Leaving
            -- it for 30 min showed dead Live TV sessions in the admin "active
            -- streams" list long after the stream-proxy had already reaped the
            -- encoders (~75 s) and freed the upstream slot — and on providers with a
            -- concurrent-stream cap it made a free slot look occupied.
            ((source IS NULL OR source = 'lumastra') AND
                CASE
                    WHEN paused_at IS NULL THEN last_heartbeat_at < now() - INTERVAL '5 minutes'
                    WHEN ${isLiveChannelSession(sql)} THEN last_heartbeat_at < now() - INTERVAL '5 minutes'
                    ELSE paused_at < now() - INTERVAL '30 minutes'
                END
            )
            OR
            -- Jellyfin/livetv/music pollers: polled every ~5 s, 30 s ≈ 6 missed polls
            (source IN ('jellyfin', 'livetv', 'music') AND last_seen_at < now() - INTERVAL '30 seconds')
            OR
            -- Local playback: our own player reporting on its own cadence, so it
            -- takes the FIRST-PARTY windows, not the 30 s poller one — nobody is
            -- polling anything here.
            --
            -- This branch is not optional. Source is matched exhaustively by
            -- value, so a 'local' row matching NO branch would never be reaped:
            -- it would sit ACTIVE forever after the app was killed and show a
            -- phantom "Downloaded" stream in Active Streams indefinitely. A
            -- session that consumes no slot is exactly the one nobody would
            -- notice was stuck, which is why it is written out here rather than
            -- folded into the (source IS NULL OR source = 'lumastra') arm above,
            -- where a future edit to that arm's CASE could silently drop it.
            (source = 'local' AND
                CASE
                    WHEN paused_at IS NULL THEN last_heartbeat_at < now() - INTERVAL '5 minutes'
                    ELSE paused_at < now() - INTERVAL '30 minutes'
                END
            )
            OR
            -- Subsonic: event-driven (no poller, and the classic protocol has no
            -- pause signal — a client that pauses just stops pinging). Scale the
            -- grace to the track itself — trackLength + 1 minute — instead of a
            -- flat window, so a 3-minute song doesn't linger in "Now Streaming"
            -- as long as a 20-minute one, but a long track still gets to finish.
            -- Falls back to a flat 10 minutes when the track's runtime is
            -- unknown (e.g. missing metadata).
            (source = 'subsonic' AND last_seen_at < now() - (
                INTERVAL '1 minute' + make_interval(secs => COALESCE(
                    (SELECT mi.runtime_seconds FROM media_items mi WHERE mi.id = play_sessions.media_id),
                    600
                ))
            ))
            OR
            -- AudiobookShelf: OUR OWN stream, not a mirror — the byte proxy
            -- serves it and resolveOwnAbsSession requires the row to be
            -- ACTIVE/PAUSED. Mirrors the Lumastra CASE above and for the same
            -- reason: paused_at is stamped once on the ACTIVE-to-PAUSED
            -- transition and the player now stops its periodic heartbeat while
            -- paused (see audiobook-player.store.ts pause()/finishBook()), so it
            -- reliably answers "how long has this actually been paused" —
            -- last_seen_at does not, because a heartbeat still fires once AT the
            -- pause transition and any future client that keeps pinging while
            -- paused would refresh it forever, exactly the bug this mirrors
            -- (see the Lumastra branch's comment: a book paused overnight with
            -- the tab left open squatted on the listener's concurrent-stream
            -- budget indefinitely — same failure, same fix). 30 minutes matches
            -- Lumastra's own PAUSED timeout. The ACTIVE case also matches
            -- Lumastra's: 5 minutes of silence. A playing client reports every
            -- 15-20 s and heartbeats every 10 s (web), so 5 minutes is dozens
            -- of missed pings — a crashed or force-quit app, not a slow one. It
            -- used to be 30 minutes, and a killed Apple TV app held the
            -- listener's stream slot for all of it, so their phone was refused
            -- the book. A pause whose heartbeat was dropped also lands here;
            -- reaping it costs nothing, because the resumed player's next call
            -- 404s and it re-opens (the reap close asserts no position).
            -- A DOWNLOAD's row (AUDIOBOOK_PURPOSE_KEY) sends no reports at all,
            -- so it keeps the 30-minute grace: 5 minutes would cut a long
            -- download off mid-file.
            (source = 'audiobookshelf' AND
                CASE
                    WHEN paused_at IS NOT NULL THEN paused_at < now() - INTERVAL '30 minutes'
                    WHEN external_payload ->> ${AUDIOBOOK_PURPOSE_KEY} = 'download'
                        THEN last_seen_at < now() - INTERVAL '30 minutes'
                    ELSE last_seen_at < now() - INTERVAL '5 minutes'
                END
            )
        )
        -- A paused/report-less player may still be fetching media. Delivery must
        -- protect it even when its paused_at/poller deadline has elapsed.
        AND NOT EXISTS (
            SELECT 1 FROM hls_playback_tokens delivery
            WHERE delivery.play_session_id = play_sessions.id::text
                AND delivery.is_active = true AND delivery.expires_at > NOW()
                AND delivery.last_used_at > NOW() - INTERVAL '5 minutes'
        )))
    `;
}

/**
 * The `external_payload` mutation every reaper applies as it terminalizes a row.
 *
 * Shared between the stale-heartbeat reap and the boot-orphan reap on purpose:
 * a reaper that crashes an audiobook row WITHOUT stamping these keys leaves the
 * upstream AudiobookShelf session open with nothing able to find it again —
 * `getRetryableAudiobookSessionCloses` keys off `AUDIOBOOK_CLOSE_KEY` and
 * `getPendingStaleSessions` off `STALE_REAP_KEY`. Restart-time orphans are the
 * common case in production (deploys are far more frequent than 30-minute
 * client silences), so both paths must stamp identically.
 */
function reapClaimPayload(sql: postgres.Sql) {
    return sql`
        CASE
            WHEN source = 'audiobookshelf' THEN jsonb_set(
                jsonb_set(
                    COALESCE(external_payload, '{}'::jsonb),
                    ARRAY[${STALE_REAP_KEY}],
                    '{"state":"pending"}'::jsonb,
                    TRUE
                ),
                ARRAY[${AUDIOBOOK_CLOSE_KEY}],
                COALESCE(
                    external_payload -> ${AUDIOBOOK_CLOSE_KEY},
                    jsonb_build_object(
                        'state', 'pending',
                        'positionMs', position_ms,
                        'listenedMs', 0,
                        'runtimeMs', COALESCE(runtime_ms, 0),
                        'isFinished', FALSE,
                        'absItemId', NULL,
                        -- A reaped row is reaped BECAUSE nothing has been heard
                        -- from it for minutes (5 playing, 30 paused), and a
                        -- superseded or killed one was replaced by the listener
                        -- or an admin, so its position is by definition old news. AudiobookShelf's progress row is
                        -- last-write-wins with no history: asserting this
                        -- position on close rewinds whichever device the
                        -- listener actually moved to (pause on the web, carry on
                        -- on the phone, get dragged back half an hour later).
                        -- The close still happens — it is what frees the
                        -- upstream session — it just says nothing about where
                        -- the listener is. Only a close the CLIENT asked for
                        -- carries a position; see prepareAudiobookSessionClose.
                        'syncPosition', FALSE
                    )
                ),
                TRUE
            )
            ELSE jsonb_set(
                COALESCE(external_payload, '{}'::jsonb),
                ARRAY[${STALE_REAP_KEY}],
                '{"state":"pending"}'::jsonb,
                TRUE
            )
        END
    `;
}

/**
 * Give-up threshold for both retry loops.
 *
 * Neither loop can succeed for a row whose listener no longer exists, and an
 * unbounded pending set turns a periodic reap into an ever-growing serial job:
 * every cycle re-fetches the whole backlog and spends one upstream round-trip
 * per row. Rows that exhaust their attempts move to `state: 'failed'`, which is
 * excluded from both `getPendingStaleSessions` and
 * `getRetryableAudiobookSessionCloses`.
 */
export const MAX_REAP_ATTEMPTS = 10;

/**
 * Per-cycle work bound. Well above a realistic backlog, so healthy instances
 * never notice it; it exists so a pathological one degrades into "drains over
 * several cycles" instead of "one cycle that never ends".
 */
export const REAP_BATCH_LIMIT = 200;

/**
 * Atomically claim stale sessions by marking them CRASHED and returning the
 * exact rows transitioned by this statement. Destructive cleanup must operate
 * on this result, never on an earlier SELECT snapshot.
 * Thresholds:
 * - Lumastra ACTIVE (source='lumastra' OR NULL, paused_at IS NULL): 5 minutes
 * - Lumastra PAUSED (source='lumastra' OR NULL, paused_at IS NOT NULL): 30 minutes,
 *   EXCEPT a live channel (tvchannel), which gets 5 minutes — a live stream cannot be
 *   meaningfully paused, so a paused row there is an abandoned tuner
 * - Jellyfin/livetv/music mirrors: 30 seconds since last_seen_at
 * - Subsonic: trackLength + 1 minute since last_seen_at (10 min fallback if
 *   the track's runtime is unknown) — the classic protocol has no pause
 *   signal, so a paused client just stops pinging
 * - audiobookshelf ACTIVE: 5 minutes since last_seen_at (a playing client
 *   reports every 15-20 s); a DOWNLOAD's row (no reports): 30 minutes
 * - audiobookshelf PAUSED: 30 minutes since paused_at
 * - download (`purpose = 'download'`, any source): no silence rule at all. Reaped
 *   when none of its delivery grants is active and unexpired, or after
 *   {@link DOWNLOAD_SESSION_HARD_CAP_HOURS}
 */
export async function claimStaleSessions(sql: postgres.Sql): Promise<SessionRow[]> {
    const claimed = await sql<SessionRow[]>`
        WITH claimed AS (
            UPDATE play_sessions
            SET
                status      = 'CRASHED',
                stopped_at  = now(),
                stop_reason = 'heartbeat_timeout',
                external_payload = ${reapClaimPayload(sql)}
            WHERE status IN ('ACTIVE', 'PAUSED')
              AND ${staleSessionCondition(sql)}
            RETURNING *
        )
        SELECT claimed.*, mi.media_type
        FROM claimed
        LEFT JOIN media_items mi ON mi.id = claimed.media_id
    `;
    const dependent: SessionRow[] = [];
    for (const row of claimed) {
        if (row.purpose === 'play') {
            dependent.push(...(await expireMusicPrefetchRowsForParent(sql, row.id)));
        }
    }
    return [...claimed, ...dependent];
}

/**
 * `claimStaleSessions` narrowed to one user, for the admission path.
 *
 * `enforceStreamPolicy` must reap before it counts, or a zombie row blocks a
 * new stream until the next 1-minute cleanup tick. It used to do that with a
 * hand-copied UPDATE, which drifted from `staleSessionCondition` (it kept
 * measuring the PAUSED grace from `last_heartbeat_at` after the shared
 * predicate moved to `paused_at`, and flattened subsonic's runtime-scaled
 * window to 30 minutes) and never stamped `reapClaimPayload` — so an
 * audiobookshelf row it crashed left the upstream ABS session open with
 * nothing able to find it again. One predicate, two callers.
 *
 * Runs inside the caller's transaction; the returned rows are what this
 * statement transitioned, so the 1-minute drain picks up anything stamped here
 * regardless of which path claimed it.
 */
export async function claimStaleSessionsForUser(
    sql: postgres.Sql,
    userId: string,
): Promise<SessionRow[]> {
    const claimed = await sql<SessionRow[]>`
        UPDATE play_sessions
        SET
            status      = 'CRASHED',
            stopped_at  = now(),
            stop_reason = 'heartbeat_timeout',
            external_payload = ${reapClaimPayload(sql)}
        WHERE user_id = ${userId}
          AND status IN ('ACTIVE', 'PAUSED')
          AND ${staleSessionCondition(sql)}
        RETURNING *
    `;
    const dependent: SessionRow[] = [];
    for (const row of claimed) {
        if (row.purpose === 'play') {
            dependent.push(...(await expireMusicPrefetchRowsForParent(sql, row.id)));
        }
    }
    return [...claimed, ...dependent];
}

/**
 * Terminate the listener's other live sessions that a session they have just
 * opened replaces.
 *
 * Two kinds of row are replaced:
 *
 *  - **The same book, on any device, playing or paused.** AudiobookShelf keeps
 *    ONE progress row per (user, book) and it is last-write-wins, so two decks
 *    reporting on the same book do not coexist. They overwrite each other every
 *    reporting interval, and the position flips between the two devices until one
 *    stops. This used to spare ACTIVE rows on the theory that a second device
 *    playing is someone else on the account. That listener was never actually
 *    served: their position was being clobbered either way. The common case is
 *    an Apple TV left playing while the listener carries on from the phone, and
 *    the newest open is the only evidence of where they actually are.
 *  - **Any book, on the same device.** One device plays one audiobook, and
 *    AudiobookShelf itself already closes the older session for the same (user,
 *    device) when a new one opens. A row left behind by a force-quit or crashed
 *    app is otherwise held until the reaper reaches it, and in the meantime it
 *    holds a stream slot. At a one-stream limit, that blocks the listener's next
 *    device from continuing the book at all.
 *
 * The displaced client learns this from its next report or heartbeat
 * (`superseded: true`). It stops, drops the session without closing it (no stale
 * write), and rewinds to the shared position.
 *
 * Stamps `reapClaimPayload`, so the ordinary 1-minute drain closes these
 * upstream. The close carries no position: `syncPosition` is FALSE there, and a
 * superseded session has no business asserting where the listener is. Without
 * the stamp, the AudiobookShelf session would stay open with nothing able to
 * find it.
 *
 * A DOWNLOAD's row is never replaced (`AUDIOBOOK_PURPOSE_KEY`): it is what
 * authorises the files a device is fetching for offline use, and starting to
 * listen to something — on that device or any other — does not cancel a
 * download.
 *
 * Runs inside the caller's policy transaction, so a refused open rolls this
 * back — see `commitPlaySessionRow` in the audiobook session service.
 *
 * Returns the terminated rows so the caller can tell their owners over SSE.
 */
export async function supersedeReplacedAudiobookSessions(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string; deviceId: string; keepSourceSessionId: string },
): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        UPDATE play_sessions
        SET
            status      = 'KILLED',
            stopped_at  = now(),
            stop_reason = 'superseded',
            external_payload = ${reapClaimPayload(sql)}
        WHERE source            = 'audiobookshelf'
          AND user_id           = ${params.userId}
          AND source_session_id IS DISTINCT FROM ${params.keepSourceSessionId}
          AND status IN ('ACTIVE', 'PAUSED')
          AND (media_id = ${params.mediaId}::uuid OR device_id = ${params.deviceId})
          AND external_payload ->> ${AUDIOBOOK_PURPOSE_KEY} IS DISTINCT FROM 'download'
          AND purpose <> 'download'
        RETURNING *
    `;
}

/**
 * End the user's earlier DOWNLOAD sessions for the same book on the same device, when a
 * new download for it starts (a re-issue: the old URLs are replaced, so the old grants
 * must not linger and pile up toward the per-user cap).
 *
 * Same effect as DELETE: KILLED, position-less upstream close stamp. Other devices and
 * other books are untouched. Runs inside the caller's policy transaction.
 */
export async function supersedePreviousDownloadSessions(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string; deviceId: string; keepSourceSessionId: string },
): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        UPDATE play_sessions
        SET
            status      = 'KILLED',
            stopped_at  = now(),
            stop_reason = 'superseded',
            external_payload = ${reapClaimPayload(sql)}
        WHERE source            = 'audiobookshelf'
          AND purpose           = 'download'
          AND user_id           = ${params.userId}
          AND media_id          = ${params.mediaId}::uuid
          AND device_id         = ${params.deviceId}
          AND source_session_id IS DISTINCT FROM ${params.keepSourceSessionId}
          AND status IN ('ACTIVE', 'PAUSED')
        RETURNING *
    `;
}

/**
 * Claimed rows whose completion/upstream cleanup has not fully succeeded yet.
 *
 * Bounded twice over — by attempts (a row nobody can ever process stops coming
 * back) and by batch size — so an upstream outage cannot grow this into an
 * unbounded serial workload. Oldest claims first so a backlog drains in order
 * rather than starving its tail.
 */
export async function getPendingStaleSessions(sql: postgres.Sql): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        SELECT ps.*, mi.media_type
        FROM play_sessions ps
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        WHERE ps.status IN ('CRASHED', 'COMPLETED')
          AND ps.external_payload #>> ARRAY[${STALE_REAP_KEY}, 'state'] = 'pending'
          AND COALESCE(
                  (ps.external_payload #>> ARRAY[${STALE_REAP_KEY}, 'attempts'])::int,
                  0
              ) < ${MAX_REAP_ATTEMPTS}
        ORDER BY ps.stopped_at ASC NULLS LAST
        LIMIT ${REAP_BATCH_LIMIT}
    `;
}

/** Complete a stale claim only after all required local and upstream work. */
export async function markStaleSessionProcessed(
    sql: postgres.Sql,
    sessionId: string,
): Promise<void> {
    await sql`
        UPDATE play_sessions
        SET external_payload = jsonb_set(
                external_payload,
                ARRAY[${STALE_REAP_KEY}, 'state'],
                '"done"'::jsonb,
                FALSE
            )
        WHERE id = ${sessionId}
          AND status IN ('CRASHED', 'COMPLETED')
          AND external_payload #>> ARRAY[${STALE_REAP_KEY}, 'state'] = 'pending'
    `;
}

/**
 * Record a failed processing attempt, and retire the claim once it has burned
 * through `MAX_REAP_ATTEMPTS`.
 *
 * Returns true when the row was retired, so the caller can log the give-up once
 * instead of on every cycle.
 */
export async function recordStaleSessionAttempt(
    sql: postgres.Sql,
    sessionId: string,
): Promise<boolean> {
    // ONE update, not a bump-CTE plus a retire-CTE. Postgres evaluates every CTE
    // against the same snapshot and silently drops a second modification of a
    // row this statement already touched, so a two-CTE version bumps the counter
    // and never actually applies the terminal state.
    const [row] = await sql<{ retired: boolean }[]>`
        UPDATE play_sessions ps
        SET external_payload = jsonb_set(
                jsonb_set(
                    ps.external_payload,
                    ARRAY[${STALE_REAP_KEY}, 'attempts'],
                    to_jsonb(next.attempts),
                    TRUE
                ),
                ARRAY[${STALE_REAP_KEY}, 'state'],
                CASE
                    WHEN next.attempts >= ${MAX_REAP_ATTEMPTS} THEN '"failed"'::jsonb
                    ELSE '"pending"'::jsonb
                END,
                FALSE
            )
        FROM (
            SELECT COALESCE(
                       (external_payload #>> ARRAY[${STALE_REAP_KEY}, 'attempts'])::int,
                       0
                   ) + 1 AS attempts
            FROM play_sessions
            WHERE id = ${sessionId}
        ) next
        WHERE ps.id = ${sessionId}
          AND ps.external_payload #>> ARRAY[${STALE_REAP_KEY}, 'state'] = 'pending'
        RETURNING (next.attempts >= ${MAX_REAP_ATTEMPTS}) AS retired
    `;
    return row?.retired === true;
}

/**
 * Mark active/paused sessions as CRASHED on server startup.
 *
 * Single-node (`graceSeconds = 0`): after a restart every in-flight session is
 * orphaned regardless of heartbeat age — no client can still be connected, so
 * crash them all and free the concurrent-stream quota immediately.
 *
 * Multi-replica (`graceSeconds > 0`): a booting replica must NOT crash sessions
 * that a *sibling* replica is still actively serving during a rolling deploy.
 * We can't tell ownership (play_sessions has no node column), so we use activity
 * recency as the proxy: a session whose most recent heartbeat/poll is within the
 * grace window is still live on some replica and is left alone — the periodic
 * stale-heartbeat reaper (`claimStaleSessions`) cleans genuinely-dead ones. The
 * grace must exceed the client heartbeat cadence so live sessions are never
 * mistaken for orphans; the caller passes the live-peer-aware value.
 */
/**
 * Shared predicate for `claimBootOrphanSessions`/`getBootOrphanCandidates` —
 * factored out for the same reason as `staleSessionCondition`: the SELECT
 * (completion check) and the UPDATE (bulk crash) must agree on "who is an
 * orphan" or a session could be crashed without ever being considered for
 * completion, or vice versa.
 */
function bootOrphanCondition(sql: postgres.Sql, graceSeconds: number) {
    return sql`
        -- A download is state in the database plus its grants; no process holds it,
        -- so a restart orphans nothing. Its grants and the hard cap end it.
        purpose <> 'download'
        AND (
            -- graceSeconds <= 0: single-node, crash everything (legacy behaviour)
            ${graceSeconds} <= 0
            OR GREATEST(
                   COALESCE(last_heartbeat_at, to_timestamp(0)),
                   COALESCE(last_seen_at, to_timestamp(0))
               ) < now() - make_interval(secs => ${graceSeconds})
        )
    `;
}

/**
 * Boot-orphan equivalent of `claimStaleSessions`: crash the orphans AND stamp
 * the same reap payload, returning exactly the rows this statement transitioned.
 *
 * The stamp is the whole point. A restart is the most common way an audiobook
 * session dies mid-book, and without `reapClaimPayload` the row lands in CRASHED
 * with no marker — invisible to `getPendingStaleSessions` and to
 * `getRetryableAudiobookSessionCloses` — leaving the upstream AudiobookShelf
 * session open forever with nothing able to find it again.
 */
export async function claimBootOrphanSessions(
    sql: postgres.Sql,
    graceSeconds = 0,
): Promise<SessionRow[]> {
    return sql<SessionRow[]>`
        WITH claimed AS (
            UPDATE play_sessions
            SET
                status      = 'CRASHED',
                stopped_at  = now(),
                stop_reason = 'server_restart',
                external_payload = ${reapClaimPayload(sql)}
            WHERE status IN ('ACTIVE', 'PAUSED')
              AND ${bootOrphanCondition(sql, graceSeconds)}
            RETURNING *
        )
        SELECT claimed.*, mi.media_type
        FROM claimed
        LEFT JOIN media_items mi ON mi.id = claimed.media_id
    `;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export interface ActivePlaySessionRow {
    id: string;
    media_id: string;
    user_id: string;
    play_method: string;
    status: string;
    position_ms: number;
    bitrate_kbps: number | null;
    video_codec: string | null;
    audio_codec: string | null;
    resolution: string | null;
}

interface IdentifiedActivePlaySessionRow extends ActivePlaySessionRow {
    jellyfin_play_session_id: string | null;
}

/**
 * Find an active or paused play session for a user by item ID.
 * Matches against external_id (jellyfin provider) or media_id UUID.
 * Prefer an exact PlaySessionId; adopt an unidentified legacy row if necessary.
 * A conditional write prevents concurrent callers from claiming the same NULL row.
 */
export async function findActiveSession(
    sql: postgres.Sql,
    params: { userId: UserId; itemId: string; playSessionId?: string },
): Promise<ActivePlaySessionRow | null> {
    const rows = await sql<IdentifiedActivePlaySessionRow[]>`
        SELECT ps.id, ps.media_id, ps.user_id, ps.play_method, ps.status,
               ps.position_ms, ps.bitrate_kbps, ps.video_codec, ps.audio_codec,
               ps.resolution, ps.jellyfin_play_session_id
        FROM play_sessions ps
        LEFT JOIN LATERAL (
            SELECT external_id FROM external_ids
            WHERE media_id = ps.media_id AND provider = 'jellyfin' LIMIT 1
        ) ei ON true
        WHERE ps.user_id = ${params.userId}
          AND ps.status IN ('ACTIVE', 'PAUSED')
          AND NOT ps.is_preview AND ps.purpose = 'play'
          AND (${params.playSessionId ?? null}::text IS NULL
               OR ps.jellyfin_play_session_id = ${params.playSessionId ?? null}
               OR ps.jellyfin_play_session_id IS NULL)
          AND (
              ei.external_id = ${params.itemId}
              OR ps.media_id::text = ${params.itemId}
          )
        ORDER BY (ps.jellyfin_play_session_id = ${params.playSessionId ?? null}) DESC NULLS LAST,
                 ps.last_heartbeat_at DESC
        LIMIT 1
    `;
    const session = rows[0] ?? null;
    if (session && params.playSessionId && session.jellyfin_play_session_id === null) {
        const adopted = await sql`
            UPDATE play_sessions SET jellyfin_play_session_id = ${params.playSessionId}
            WHERE id = ${session.id} AND jellyfin_play_session_id IS NULL
              AND status IN ('ACTIVE', 'PAUSED')
            RETURNING id
        `;
        // Another playback may have claimed or stopped the row since the SELECT.
        if (adopted.length === 0) return findActiveSession(sql, params);
        session.jellyfin_play_session_id = params.playSessionId;
    }
    return session;
}

// ─── Policy ───────────────────────────────────────────────────────────────────

export async function getEffectivePolicy(
    sql: postgres.Sql,
    userId: string,
    // Query modules stay pure (no config import) — callers pass the
    // admin-configurable default in. Only used for the synthetic fallback;
    // a per-user row or the `__default__` row always wins.
    fallbackDefaults?: { max_concurrent_streams?: number },
): Promise<PolicyRow> {
    const [userPolicy] = await sql<PolicyRow[]>`
        SELECT * FROM user_stream_policies WHERE user_id = ${userId}
    `;
    if (userPolicy) return userPolicy;

    const [defaultPolicy] = await sql<PolicyRow[]>`
        SELECT * FROM user_stream_policies WHERE user_id = '__default__'
    `;
    return (
        defaultPolicy ?? {
            user_id: '__default__',
            max_concurrent_streams:
                fallbackDefaults?.max_concurrent_streams ?? UNLIMITED_CONCURRENT_STREAMS,
            require_single_ip: false,
            ip_grace_period_seconds: 120,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
            updated_at: new Date(),
            updated_by: null,
        }
    );
}

// ─── Session Read Model query ────────────────────────────────────────────────

export interface SessionViewFilter {
    /** Filter to one user's sessions, by stable users.id UUID (mig 16.46.0). */
    userId?: UserId;
    mediaId?: string;
    seriesId?: string;
    source?: PlaySessionSource | PlaySessionSource[];
    includeStale?: boolean;
}

/**
 * Raw row returned by `getActiveSessionsView`. All age fields are computed in
 * SQL as milliseconds so the caller never has to ship a clock-skewed timestamp
 * to TypeScript for arithmetic.
 */
export interface ActiveSessionViewRow {
    // play_sessions fields
    id: string;
    source: PlaySessionSource;
    source_session_id: string | null;
    user_id: string;
    /** DISPLAY name re-hydrated from users (JOINed); null if the user row is gone. */
    username: string | null;
    /** DISPLAY name override re-hydrated from users.display_name (JOINed). */
    display_name: string | null;
    media_id: string;
    position_ms: number;
    runtime_ms: number | null;
    status: string;
    started_at: Date;
    last_heartbeat_at: Date;
    last_seen_at: Date;
    user_agent: string | null;
    client_name: string | null;
    client_version: string | null;
    device_id: string;
    /** Delivery method ('direct' | 'remux' | 'audio_transcode' | 'full_transcode'). */
    play_method: string | null;
    bitrate_kbps: number | null;
    resolution: string | null;
    /**
     * Monotonic per-session heartbeat sequence counter. Initialised to 0 on
     * session creation and advanced by the first accepted heartbeat. A value
     * of 0 with status='ACTIVE' means the client has not yet reported a real
     * position (buffering window).
     */
    last_event_seq: number;
    // joined from media_items (the live episode/movie row)
    media_type: string | null;
    has_files: boolean;
    media_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    series_id: string | null;
    series_title: string | null;
    // computed in SQL (milliseconds)
    heartbeat_age_ms: number;
    seen_age_ms: number;
}

/**
 * Single joined query for the SessionReadModel. Returns active/paused sessions
 * enriched with series_id from the media_items hierarchy.
 *
 * Age columns are computed in SQL (`EXTRACT(EPOCH FROM ...) * 1000`) to avoid
 * clock-skew from shipping raw timestamps to TypeScript.
 *
 * Pass `includeStale: true` to bypass the default status IN ('ACTIVE','PAUSED')
 * filter — useful for admin debug views that want to inspect recently-stopped rows.
 */
export async function getActiveSessionsView(
    sql: postgres.Sql,
    filter: SessionViewFilter = {},
): Promise<ActiveSessionViewRow[]> {
    const { userId, mediaId, seriesId, source, includeStale = false } = filter;

    const statusFilter = includeStale ? sql`` : sql`AND ps.status IN ('ACTIVE', 'PAUSED')`;
    // A hover preview is never playback, stale or not: `includeStale` widens the
    // status window for admin debugging, it does not make previews viewers.
    const previewFilter = sql`AND NOT ps.is_preview AND ps.purpose = 'play'`;

    const userFilter = userId != null ? sql`AND ps.user_id = ${userId}::uuid` : sql``;

    const mediaIdFilter = mediaId != null ? sql`AND ps.media_id = ${mediaId}::uuid` : sql``;

    const seriesIdFilter =
        seriesId != null
            ? sql`AND (
              COALESCE(grandparent.id, parent.id)::text = ${seriesId}
              OR parent.id::text = ${seriesId}
          )`
            : sql``;

    const sourceFilter =
        source != null
            ? Array.isArray(source)
                ? sql`AND ps.source = ANY(${sql.array(source)})`
                : sql`AND ps.source = ${source}`
            : sql``;

    return sql<ActiveSessionViewRow[]>`
        SELECT
            ps.id,
            ps.source,
            ps.source_session_id,
            ps.user_id,
            u.username AS username,
            u.display_name AS display_name,
            ps.media_id::text AS media_id,
            ps.position_ms,
            ps.runtime_ms,
            ps.status,
            ps.started_at,
            ps.last_heartbeat_at,
            ps.last_seen_at,
            ps.user_agent,
            ps.client_name,
            ps.client_version,
            ps.device_id,
            ps.play_method,
            ps.bitrate_kbps,
            ps.resolution,
            ps.last_event_seq,
            LOWER(COALESCE(mi.media_type, '')) AS media_type,
            COALESCE(mi.has_files, false) AS has_files,
            mi.title AS media_title,
            mi.season_number,
            mi.episode_number,
            COALESCE(grandparent.id, parent.id)::text AS series_id,
            COALESCE(grandparent.title, parent.title) AS series_title,
            EXTRACT(EPOCH FROM (now() - ps.last_heartbeat_at)) * 1000 AS heartbeat_age_ms,
            EXTRACT(EPOCH FROM (now() - ps.last_seen_at)) * 1000 AS seen_age_ms
        FROM play_sessions ps
        LEFT JOIN users u ON u.id = ps.user_id
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
        WHERE 1=1
            ${statusFilter}
            ${previewFilter}
            ${userFilter}
            ${mediaIdFilter}
            ${seriesIdFilter}
            ${sourceFilter}
        ORDER BY ps.last_heartbeat_at DESC
        LIMIT 1000
    `;
}

// ─── Lightweight music session (no policy/transaction overhead) ──────────────
// UUID_RE is hoisted to the top of the file (used by getSessionStatusAndReason).

export async function createMusicSession(
    sql: postgres.Sql,
    params: {
        media_id: string;
        user_id: UserId;
        device_id: string;
        ip_address: string;
        /**
         * Which API surface the client spoke. REQUIRED with no default — our
         * own music player is reachable from the browser AND from the native
         * apps, so a literal here would collapse two real surfaces into one
         * wrong bucket. See `CreateSessionParams.surface`.
         */
        surface: PlaySurface;
        /**
         * UI features the client announced it renders — see
         * `$lib/shared/client-features.ts`. Accepted here and not only on the
         * video path because the admin "Send message" gate reads this column
         * for EVERY active row: a music session from a client that does render
         * admin toasts would otherwise be gated off as if it could not.
         */
        client_features?: string[];
    },
): Promise<{ id: string } | null> {
    return sql.begin(async (rawTx) => {
        const txSql = rawTx as unknown as postgres.Sql;
        // Complete any existing music session for this user+device first.
        // CRASHED is included alongside ACTIVE/PAUSED: since updateMusicSession
        // now revives CRASHED rows, an orphaned CRASHED session from a previous
        // track must be closed here too, or a late/in-flight heartbeat for it
        // could revive it into a second live row competing with the new track.
        await txSql`
            UPDATE play_sessions
            SET status = 'COMPLETED', stopped_at = now(), stop_reason = 'track_change'
            WHERE user_id = ${params.user_id}
              AND device_id = ${params.device_id}
              AND client_name = 'Lumastra Music'
              AND purpose = 'play'
              AND status IN ('ACTIVE', 'PAUSED', 'CRASHED')
        `;

        // Close the transcode row our own player's stream fetch left behind.
        // The stream route skips that row while a player session is live
        // (route-handler.ts, PLAYER_SESSION_PREFIX), but the very first fetch
        // of a listen can land before this INSERT, and that row would sit in
        // Active Streams as a second "Subsonic" stream until the reaper took
        // it. Third-party rows keep theirs: they are the only record of a
        // client that never reports through this endpoint.
        await txSql`
            UPDATE play_sessions
            SET status = 'COMPLETED', stopped_at = now(), stop_reason = 'superseded'
            WHERE user_id = ${params.user_id}
              AND source = 'music'
              AND surface IS DISTINCT FROM 'third_party_api'
              AND status IN ('ACTIVE', 'PAUSED', 'CRASHED')
        `;

        // Insert new session, pulling runtime from media_items in a subquery.
        // source = 'lumastra' is set explicitly (rather than relying on the DEFAULT)
        // so that markStaleSessions applies the 5-minute heartbeat window — correct
        // for user-driven heartbeats; the 30-second window is for externally-polled
        // sources ('jellyfin', 'livetv', 'music').
        //
        // file_id / container / audio_codec / bitrate_kbps are resolved from the
        // track's default file + its audio stream at INSERT time. Music always
        // plays the source file directly, so the probed values ARE what is being
        // streamed. Without them the session row carried no format at all and
        // both the home "Active Streams" card and /admin/users/sessions showed a
        // music stream with no codec — unlike every video session.
        const [row] = await txSql<{ id: string }[]>`
            INSERT INTO play_sessions (
                media_id, user_id, device_id, user_agent, client_name,
                client_features,
                ip_address, play_method, position_ms, runtime_ms, source,
                file_id, container, audio_codec, bitrate_kbps, surface
            )
            SELECT
                ${params.media_id}::uuid, ${params.user_id}, ${params.device_id},
                'Music Player', 'Lumastra Music',
                ${params.client_features ? sql.array(params.client_features) : null},
                ${params.ip_address}::inet, 'direct', 0,
                CASE WHEN mi.runtime_seconds > 0
                     THEN (mi.runtime_seconds * 1000)::bigint
                     ELSE NULL END,
                'lumastra',
                mf.id,
                mf.container_format,
                ms.codec,
                -- Lossless codecs (FLAC/ALAC) report no per-stream bitrate, so
                -- fall back to the file's overall bitrate. Both are bps.
                (COALESCE(ms.bitrate, mf.total_bitrate) / 1000)::int,
                ${params.surface}
            FROM media_items mi
            LEFT JOIN LATERAL (
                SELECT f.id, f.container_format, f.total_bitrate
                FROM media_file_items mfi
                JOIN media_files f ON f.id = mfi.file_id
                WHERE mfi.media_item_id = mi.id AND NOT f.is_missing
                ORDER BY mfi.is_default DESC, mfi.sort_order
                LIMIT 1
            ) mf ON true
            LEFT JOIN LATERAL (
                SELECT NULLIF(s.codec, 'unknown') AS codec, s.bitrate
                FROM media_streams s
                WHERE s.file_id = mf.id AND s.stream_type = 'audio'
                ORDER BY s.is_default DESC, s.stream_index
                LIMIT 1
            ) ms ON true
            WHERE mi.id = ${params.media_id}::uuid
            RETURNING id
        `;
        return row ?? null;
    });
}

/**
 * Whether the user has a live `Lumastra Music` player session — one that
 * reports its own listen through `/play-sessions/{id}`. The music stream
 * route asks this to decide whether a transcode needs its own play_sessions
 * row (see PLAYER_SESSION_PREFIX). The 5-minute window matches the heartbeat
 * window markStaleSessions applies to `source = 'lumastra'`.
 */
export async function hasLivePlayerMusicSession(
    sql: postgres.Sql,
    userId: UserId,
): Promise<boolean> {
    const [row] = await sql<{ live: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM play_sessions
            WHERE user_id = ${userId}
              AND source = 'lumastra'
              AND client_name = 'Lumastra Music'
              AND purpose = 'play'
              AND status IN ('ACTIVE', 'PAUSED')
              AND last_heartbeat_at > now() - interval '5 minutes'
        ) AS live
    `;
    return row?.live === true;
}

export async function updateMusicSession(
    sql: postgres.Sql,
    id: string,
    userId: UserId,
    positionMs: number,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;

    // Mirrors the video heartbeat path (`updateHeartbeat`) in two ways that
    // keep the miniplayer alive across pauses and transient outages:
    //
    //   1. paused_at: set it on the PAUSE transition (clear on resume). The
    //      stale-session reaper grants a PAUSED session a 30-minute grace but
    //      only when paused_at IS NOT NULL — otherwise it falls into the 5-min
    //      ACTIVE window. This path previously never set paused_at, so a user
    //      who paused and walked away for >5 min had their session reaped, and
    //      the resume heartbeat 404'd → the player closed with a scary
    //      "this session was ended" toast.
    //
    //   2. Revive CRASHED rows: a client sending a heartbeat is demonstrably
    //      alive, so include 'CRASHED' in the status filter and clear the
    //      terminal markers. The reaper (or a server restart) may have flipped
    //      a still-buffered session to CRASHED while the user was paused/away or
    //      briefly offline; reviving on the next heartbeat keeps playback going
    //      instead of tearing the player down. KILLED is deliberately NOT
    //      revivable — admin and stream-limit kills must still stop playback.
    const result = await sql`
        UPDATE play_sessions
        SET
            position_ms = ${positionMs},
            last_heartbeat_at = now(),
            status = ${status},
            paused_at = CASE
                WHEN ${status} = 'PAUSED' AND paused_at IS NULL THEN now()
                WHEN ${status} = 'ACTIVE' THEN NULL
                ELSE paused_at
            END,
            stopped_at  = CASE WHEN ${status} = 'COMPLETED' THEN now() ELSE NULL END,
            stop_reason = CASE WHEN ${status} = 'COMPLETED' THEN 'track_end' ELSE NULL END
        WHERE id = ${id}
          AND user_id = ${userId}
          -- Scope to the music surface (mirrors getMusicSessionById): without
          -- this, the now-revivable CRASHED branch would let a music heartbeat
          -- resurrect the owner's own video session row.
          AND client_name = 'Lumastra Music'
          AND purpose = 'play'
          AND status IN ('ACTIVE', 'PAUSED', 'CRASHED')
    `;
    return result.count > 0;
}

export interface RecentlyListenedRadioRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown> | null;
}

export async function getRecentlyListenedRadioMediaItems(
    sql: postgres.Sql,
    userId: UserId,
    days: number,
    limit: number,
): Promise<RecentlyListenedRadioRow[]> {
    return sql<RecentlyListenedRadioRow[]>`
        SELECT mi.id, mi.title, mi.custom_metadata
        FROM play_sessions ps
        JOIN media_items mi ON mi.id = ps.media_id
        WHERE ps.user_id = ${userId}
          AND mi.media_type = 'radio'
          AND ps.started_at > NOW() - make_interval(days => ${days})
        GROUP BY mi.id, mi.title, mi.custom_metadata
        ORDER BY MAX(ps.started_at) DESC
        LIMIT ${limit}
    `;
}

/**
 * Close all ACTIVE/PAUSED play_sessions rows for `userId` (username),
 * EXCEPT the one identified by (source, sourceSessionId) of the newly-starting
 * track. Used when a music client starts a new track — closes the previously
 * playing track's row that wasn't explicitly scrobbled-complete.
 *
 * Scoped to music sources (subsonic/music) and audio-only play methods
 * (direct/audio_transcode) so video sessions are never interrupted.
 *
 * Returns the rows that were transitioned.
 */
export async function stopOtherActiveMusicSessions(
    sql: postgres.Sql,
    userId: UserId,
    keepSource: PlaySessionSource,
    keepSourceSessionId: string,
): Promise<{ id: string; source: string; source_session_id: string }[]> {
    return sql<{ id: string; source: string; source_session_id: string }[]>`
        UPDATE play_sessions
        SET status             = 'COMPLETED',
            stop_reason        = 'superseded',
            stopped_at         = now(),
            last_heartbeat_at  = now()
        WHERE user_id = ${userId}
          AND status IN ('ACTIVE', 'PAUSED')
          AND source IN ('subsonic', 'music')
          AND play_method IN ('direct', 'audio_transcode')
          AND NOT (source = ${keepSource} AND source_session_id = ${keepSourceSessionId})
        RETURNING id, source, source_session_id
    `;
}

// ---------------------------------------------------------------------------
// Music session read queries (D4 — unified playback reporting)
// ---------------------------------------------------------------------------

/**
 * Row shape returned by the music session list/current queries.
 * Intentionally narrow: only the fields the unified playback reporting surface exposes.
 */
export interface MusicSessionRow {
    id: string;
    media_id: string;
    status: string;
    position_ms: number;
    started_at: Date;
    last_heartbeat_at: Date;
    stopped_at: Date | null;
    device_id: string;
    user_agent: string | null;
}

/**
 * Return all ACTIVE / PAUSED music sessions for the given user.
 *
 * Scoped to `client_name = 'Lumastra Music'` so video sessions are excluded.
 * Ordered most-recently-started first.
 */
export async function getMusicSessionsForUser(
    sql: postgres.Sql,
    userId: UserId,
): Promise<MusicSessionRow[]> {
    return sql<MusicSessionRow[]>`
        SELECT id, media_id, status, position_ms, started_at,
               last_heartbeat_at, stopped_at, device_id, user_agent
        FROM play_sessions
        WHERE user_id = ${userId}
          AND client_name = 'Lumastra Music'
          AND purpose = 'play'
          AND status IN ('ACTIVE', 'PAUSED')
        ORDER BY started_at DESC
    `;
}

/**
 * Return the single most-recent ACTIVE music session for the given user.
 * This is the "now-playing" equivalent (replaces the null stub).
 * Returns null when no active session exists.
 */
export async function getCurrentMusicSession(
    sql: postgres.Sql,
    userId: UserId,
): Promise<MusicSessionRow | null> {
    const [row] = await sql<MusicSessionRow[]>`
        SELECT id, media_id, status, position_ms, started_at,
               last_heartbeat_at, stopped_at, device_id, user_agent
        FROM play_sessions
        WHERE user_id = ${userId}
          AND client_name = 'Lumastra Music'
          AND purpose = 'play'
          AND status = 'ACTIVE'
        ORDER BY last_heartbeat_at DESC
        LIMIT 1
    `;
    return row ?? null;
}

export async function upsertStreamPolicy(
    sql: postgres.Sql,
    userId: string,
    updates: Partial<Omit<PolicyRow, 'user_id' | 'updated_at'>>,
    _updated_by: string,
): Promise<PolicyRow> {
    const [row] = await sql<PolicyRow[]>`
        INSERT INTO user_stream_policies (user_id, updated_at,
            max_concurrent_streams, require_single_ip, ip_grace_period_seconds,
            max_bitrate_kbps, allowed_play_methods)
        VALUES (${userId}, now(),
            ${updates.max_concurrent_streams ?? 2},
            ${updates.require_single_ip ?? false},
            ${updates.ip_grace_period_seconds ?? 120},
            ${updates.max_bitrate_kbps ?? null},
            ${updates.allowed_play_methods ? sql.array(updates.allowed_play_methods) : null})
        ON CONFLICT (user_id) DO UPDATE SET
            max_concurrent_streams  = COALESCE(${updates.max_concurrent_streams ?? null}, user_stream_policies.max_concurrent_streams),
            require_single_ip       = COALESCE(${updates.require_single_ip ?? null}, user_stream_policies.require_single_ip),
            ip_grace_period_seconds = COALESCE(${updates.ip_grace_period_seconds ?? null}, user_stream_policies.ip_grace_period_seconds),
            max_bitrate_kbps        = CASE WHEN ${Object.hasOwn(updates, 'max_bitrate_kbps')} THEN ${updates.max_bitrate_kbps ?? null} ELSE user_stream_policies.max_bitrate_kbps END,
            allowed_play_methods    = CASE WHEN ${Object.hasOwn(updates, 'allowed_play_methods')} THEN ${updates.allowed_play_methods ? sql.array(updates.allowed_play_methods) : null} ELSE user_stream_policies.allowed_play_methods END,
            updated_at = now()
        RETURNING *
    `;
    return row;
}

/**
 * Delete the per-user (or `__default__`) stream policy override row, so the
 * key falls back to the next tier in `getEffectivePolicy` (the `__default__`
 * row, or the synthetic fallback).
 *
 * Returns true when a row was actually deleted, false when there was nothing
 * to delete (idempotent no-op).
 */
export async function deleteStreamPolicy(sql: postgres.Sql, userId: string): Promise<boolean> {
    const rows = await sql`
        DELETE FROM user_stream_policies WHERE user_id = ${userId}
        RETURNING user_id
    `;
    return rows.length > 0;
}

/**
 * Correct a session's `play_method` to the server's actual decision.
 *
 * `play_method` is written at session start from the client-supplied
 * `requested.play_method`, which is a REQUEST, not an outcome — and some clients
 * do not update it. The Lumastra tvOS client reports `full_transcode` for every
 * session, so stream copies were recorded as full transcodes, inflating any
 * admin/cost view that counts transcodes (a copy is nearly free; a 4K transcode
 * is not). Clients that send a `plan_id` were unaffected, which is why this only
 * showed up on the tvOS path.
 *
 * Called once the transcode job resolves its decision — the point at which the
 * server first knows what it is really doing. Only ever narrows the value to the
 * truth, and is a no-op when it already matches.
 *
 * Direct play is untouched: it spawns no transcode job, so nothing calls this
 * and the client-reported value stands (it is the only signal available).
 */
export async function reconcileSessionPlayMethod(
    sql: postgres.Sql,
    sessionId: string,
    playMethod: 'direct' | 'remux' | 'audio_transcode' | 'full_transcode',
): Promise<boolean> {
    if (!UUID_RE.test(sessionId)) return false;
    const rows = await sql`
        UPDATE play_sessions
        SET play_method = ${playMethod}
        WHERE id = ${sessionId}
          AND play_method IS DISTINCT FROM ${playMethod}
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Client name of the user's most recent play session on one media item,
 * skipping `excludeSessionId` (the caller's own session) and every other
 * session of the caller's device: progress made on this device is never
 * attributed to it as "from <device>". Best-effort device attribution for the
 * series watch marker: null when no such row survives or the row carries no
 * client name.
 */
export async function getLatestSessionClientName(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
    excludeSessionId: string | null,
): Promise<string | null> {
    const rows = await sql<Array<{ client_name: string | null }>>`
        SELECT ps.client_name
        FROM play_sessions ps
        WHERE ps.user_id = ${userId}
          AND ps.media_id = ${mediaId}::uuid
          AND (
              ${excludeSessionId}::text IS NULL
              OR (
                  ps.id::text <> ${excludeSessionId}::text
                  AND NOT EXISTS (
                      SELECT 1
                      FROM play_sessions caller
                      WHERE caller.id::text = ${excludeSessionId}::text
                        AND caller.device_id = ps.device_id
                  )
              )
          )
        ORDER BY COALESCE(ps.last_heartbeat_at, ps.started_at) DESC NULLS LAST
        LIMIT 1
    `;
    return rows[0]?.client_name ?? null;
}

/** Device id of one play session, or null when the session is unknown. */
export async function getSessionDeviceId(
    sql: postgres.Sql,
    sessionId: string,
): Promise<string | null> {
    const rows = await sql<Array<{ device_id: string | null }>>`
        SELECT device_id FROM play_sessions WHERE id::text = ${sessionId}::text LIMIT 1
    `;
    return rows[0]?.device_id ?? null;
}

/**
 * Position (ms) of the newest durable progress event a Lumastra player session
 * wrote for one item, or null when none of its progress events is on record.
 * The idle-keepalive gate asks this before skipping an unmoved heartbeat: a
 * position the session stored on its row but never got into durable state (a
 * failed or rejected write) must still be written.
 */
export async function getSessionDurableProgressMs(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
    sessionId: string,
): Promise<number | null> {
    const rows = await sql<Array<{ position_ms: string | number | null }>>`
        SELECT position_ms
        FROM user_media_events
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}::uuid
          AND source = 'lumastra-player'
          AND event_type = 'progress'
          AND repudiated_at IS NULL
          AND session_id = ${sessionId}
        ORDER BY occurred_at DESC
        LIMIT 1
    `;
    const position = rows[0]?.position_ms;
    return position === null || position === undefined ? null : Number(position);
}

/**
 * Whether this session already wrote a live `completed` for the media — the
 * stop path's gate against counting one viewing twice (see
 * `PlaySessionLifecycleService.handleStop`).
 */
export async function sessionHasCompletion(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
    sessionId: string,
): Promise<boolean> {
    return hasSessionCompletion(sql, { userId, mediaId, sessionId });
}
