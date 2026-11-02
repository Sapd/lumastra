// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Effective series marker — the single answer to "where am I in this series".
 *
 * Continue Watching, next-up and the device-side series Play button used to
 * resolve this independently and disagreed (E9 skipped + E10 half-watched:
 * CW said E10, next-up said E9). Every "continue" surface consumes this
 * resolver instead.
 *
 * Resolution, first hit wins:
 *   1. Live: the freshest live play session on an episode of the series,
 *      excluding the caller's own session. Past completion → the following
 *      episode as `next`.
 *   2. In progress: the durable Continue Watching representative for the
 *      series (same thresholds, max age and dismissals as the rail), unless
 *      the rail's CW-vs-next-up rule (`resolveSeriesAnchor`) picks next-up.
 *   3. Next: `effectiveNextUpForSeries` (its live overlay also excluding the
 *      caller), at position 0, once the main line has any watch history.
 *   4. Finished: every playable main-line episode watched → the furthest
 *      watched one in episode order.
 *   5. Not started: the first main-line episode (or no episode at all).
 *
 * With `fromEpisodeId` the result also carries the forward-only relation of
 * the marker to the caller's episode, computed here so no client
 * re-implements episode ordering. Access is NOT re-checked: callers gate the
 * series with `checkMediaAccess` first.
 *
 * Combined files: positions in a multi-episode file are file-absolute, both
 * on live sessions and in durable resume rows (the player reports the opened
 * episode with the file's playhead). A marker that shares the caller's file
 * is therefore compared by position, not by episode order, and a
 * position-less marker (`next` / `finished` / `not_started`, position 0) is
 * placed at its episode's window start in that file.
 */
import type postgres from 'postgres';
import { buildPlaybackProgress, type PlaybackProgress } from '$lib/schemas/playback-progress.js';
import { getDb } from '$lib/server/database/index.js';
import type {
    ContinueWatchingRow,
    EpisodeOrderKeyRow,
    SeriesMainlineWatchSummary,
} from '$lib/server/database/queries/watch-state.queries.js';
import type { ActiveSessionView } from '$lib/server/services/session-read-model.service.js';
import type {
    EffectiveNextUpInput,
    EffectiveNextUpResult,
} from '$lib/server/services/effective-next-up.service.js';
import {
    resolveSeriesAnchor,
    type SeriesAnchorCandidate,
    type SeriesAnchorConfig,
} from '$lib/server/utils/series-anchor.js';
import { completionThresholdFor } from '$lib/server/utils/watch-constants.js';
import { withBudget } from '$lib/server/utils/with-budget.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { UserId } from '$lib/shared/user-id.js';

const logger = Logger.for('EffectiveSeriesMarker');

/** Ceiling on the live-session step; a slow session store falls through to durable. */
const LIVE_STEP_BUDGET_MS = 2000;

/** A live session on the caller's episode within this distance of its position is the caller itself. */
export const SELF_SESSION_POSITION_TOLERANCE_MS = 1000;

/**
 * Whether a live session is the caller's own. The session id decides when the
 * caller names one; only a caller without an id falls back to the position
 * heuristic (same episode, within {@link SELF_SESSION_POSITION_TOLERANCE_MS}),
 * which would otherwise also drop another device paused at the same spot.
 */
export function isCallerSession(
    session: { sessionId: string; mediaId: string; positionMs: number },
    caller: {
        excludeSessionId?: string | null;
        callerEpisodeId?: string | null;
        callerPositionMs?: number | null;
    },
): boolean {
    const excludeSessionId = caller.excludeSessionId ?? null;
    if (excludeSessionId !== null) return session.sessionId === excludeSessionId;
    const episodeId = caller.callerEpisodeId ?? null;
    const positionMs = caller.callerPositionMs ?? null;
    return (
        episodeId !== null &&
        positionMs !== null &&
        session.mediaId === episodeId &&
        Math.abs(session.positionMs - positionMs) <= SELF_SESSION_POSITION_TOLERANCE_MS
    );
}

/** Same-episode (or same-file) marker counts as forward only when it is this far past the caller. */
const SAME_EPISODE_FORWARD_MARGIN_MS = 30_000;

/** Rows re-read by the self-contamination guard. */
const GUARD_ROW_LIMIT = 3;

// ─── Public types ─────────────────────────────────────────────────────────────

export type SeriesMarkerState = 'in_progress' | 'next' | 'finished' | 'not_started';
export type SeriesMarkerRelation = 'forward' | 'same' | 'behind' | 'none';

export interface SeriesMarkerEpisode {
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    /** COALESCE(eo.order_season_number, season)*EPISODE_ORDER_MULTIPLIER + COALESCE(eo.order_episode_number, sort_order, episode_number) */
    orderKey: number;
}

export interface SeriesMarker {
    progress: PlaybackProgress;
    state: SeriesMarkerState;
    episode: SeriesMarkerEpisode | null;
    positionMs: number;
    /** ISO timestamp of the activity behind the marker, when known. */
    updatedAt: string | null;
    deviceName: string | null;
    /** Relation of the marker to `from` (null `from` → 'none'). */
    relation: SeriesMarkerRelation;
    /** True when `from` and the marker episode share a media file (combined file) → seek, not navigate. */
    sameFileAsFrom: boolean;
}

export interface SeriesMarkerInput {
    userId: UserId;
    seriesId: string;
    fromEpisodeId?: string | null;
    fromPositionMs?: number | null;
    excludeSessionId?: string | null;
    sql?: ReturnType<typeof getDb>;
}

export interface InProgressRowsParams {
    userId: UserId;
    seriesId: string;
    limit: number;
    collapsePerSeries: boolean;
}

/** Collaborators, injectable for unit tests (same style as `EffectivePlaybackDeps`). */
export interface SeriesMarkerDeps {
    getLiveSessions: (userId: UserId, seriesId: string) => Promise<ActiveSessionView[]>;
    findNextEpisode: (
        sql: postgres.Sql,
        seriesId: string,
        episodeId: string,
    ) => Promise<{ id: string } | null>;
    /** Continue Watching rows for one series, with the rail's configured thresholds. */
    getInProgressRows: (
        sql: postgres.Sql,
        params: InProgressRowsParams,
    ) => Promise<ContinueWatchingRow[]>;
    getNextUp: (input: EffectiveNextUpInput) => Promise<EffectiveNextUpResult>;
    getMainlineSummary: (
        sql: postgres.Sql,
        userId: UserId,
        seriesId: string,
    ) => Promise<SeriesMainlineWatchSummary | null>;
    getFirstEpisode: (seriesId: string) => Promise<{ media_id: string } | null>;
    getEpisodeOrderKeys: (sql: postgres.Sql, ids: string[]) => Promise<EpisodeOrderKeyRow[]>;
    /** Client name of the latest session on `mediaId`, skipping the excluded session and its device. */
    getLatestClientName: (
        sql: postgres.Sql,
        userId: UserId,
        mediaId: string,
        excludeSessionId: string | null,
    ) => Promise<string | null>;
    /** Device id of a play session, or null when unknown. */
    getSessionDeviceId: (sql: postgres.Sql, sessionId: string) => Promise<string | null>;
    episodesShareFile: (sql: postgres.Sql, fromId: string, otherId: string) => Promise<boolean>;
    /** File-absolute start (ms) of an episode's window in its combined file, or null. */
    getEpisodeWindowStartMs: (sql: postgres.Sql, episodeId: string) => Promise<number | null>;
    /** The Continue Watching rail's CW-vs-next-up anchor thresholds. */
    getAnchorConfig: () => Promise<SeriesAnchorConfig>;
}

// ─── Default wiring ───────────────────────────────────────────────────────────

/** Production collaborators, imported lazily so unit tests never load them. */
function defaultDeps(): SeriesMarkerDeps {
    return {
        getLiveSessions: async (userId, seriesId) => {
            const { getSessionReadModel } =
                await import('$lib/server/services/session-read-model.service.js');
            return getSessionReadModel().getActiveSessionsForSeries(userId, seriesId);
        },
        findNextEpisode: async (sql, seriesId, episodeId) => {
            const { findNextSequentialEpisode } =
                await import('$lib/server/database/queries/episode-search.queries.js');
            return findNextSequentialEpisode(sql, seriesId, episodeId);
        },
        getInProgressRows: async (sql, params) => {
            const [{ getContinueWatchingFromDb }, { config }] = await Promise.all([
                import('$lib/server/database/queries/watch-state.queries.js'),
                import('$lib/server/config.js'),
            ]);
            return getContinueWatchingFromDb.all(sql, {
                ...params,
                minMs: config.CONTINUE_WATCHING_MIN_SECONDS * 1000,
                minPercent: config.CONTINUE_WATCHING_MIN_PERCENT,
                maxAgeDays: config.CONTINUE_WATCHING_MAX_AGE_DAYS,
            });
        },
        getNextUp: async (input) => {
            const { effectiveNextUpForSeries } =
                await import('$lib/server/services/effective-next-up.service.js');
            return effectiveNextUpForSeries(input);
        },
        getMainlineSummary: async (sql, userId, seriesId) => {
            const { getSeriesMainlineWatchSummary } =
                await import('$lib/server/database/queries/watch-state.queries.js');
            return getSeriesMainlineWatchSummary.one(sql, { userId, seriesId });
        },
        getFirstEpisode: async (seriesId) => {
            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');
            return watchManager.getFirstEpisode(seriesId);
        },
        getEpisodeOrderKeys: async (sql, ids) => {
            const { getEpisodeOrderKeys } =
                await import('$lib/server/database/queries/watch-state.queries.js');
            return getEpisodeOrderKeys.all(sql, { ids });
        },
        getLatestClientName: async (sql, userId, mediaId, excludeSessionId) => {
            const { getLatestSessionClientName } =
                await import('$lib/server/database/queries/play-sessions.queries.js');
            return getLatestSessionClientName(sql, userId, mediaId, excludeSessionId);
        },
        getSessionDeviceId: async (sql, sessionId) => {
            const { getSessionDeviceId } =
                await import('$lib/server/database/queries/play-sessions.queries.js');
            return getSessionDeviceId(sql, sessionId);
        },
        episodesShareFile: async (sql, fromId, otherId) => {
            const { episodesShareFile } =
                await import('$lib/server/database/queries/watch-state.queries.js');
            return episodesShareFile(sql, fromId, otherId);
        },
        getEpisodeWindowStartMs: async (sql, episodeId) => {
            const { getEpisodeWindowsForFile } =
                await import('$lib/server/database/queries/file-segments.queries.js');
            const windows = await getEpisodeWindowsForFile(sql, episodeId);
            return windows.find((w) => w.mediaItemId === episodeId)?.startMs ?? null;
        },
        getAnchorConfig: async () => {
            const { config } = await import('$lib/server/config.js');
            return {
                substantialPercent: (config.CONTINUE_WATCHING_SUBSTANTIAL_PERCENT ?? 20) / 100,
                phantomStalenessDays: config.CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS ?? 3,
            };
        },
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The marker before its episode is decorated with ordering data. */
interface ResolvedMarker {
    durationMs?: number | null;
    state: SeriesMarkerState;
    episodeId: string | null;
    positionMs: number;
    updatedAt: string | null;
    deviceName: string | null;
}

function toIso(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isPastCompletion(session: ActiveSessionView): boolean {
    const runtimeMs = session.runtimeMs ?? 0;
    if (runtimeMs <= 0) return false;
    const ratio = session.positionMs / runtimeMs;
    return Number.isFinite(ratio) && ratio >= completionThresholdFor(session.mediaType, runtimeMs);
}

/** Playing beats paused; among equals the most recent heartbeat wins. */
function pickFreshest(sessions: ActiveSessionView[]): ActiveSessionView | null {
    let best: ActiveSessionView | null = null;
    for (const s of sessions) {
        if (
            best === null ||
            (s.isPlaying && !best.isPlaying) ||
            (s.isPlaying === best.isPlaying && s.heartbeatAgeMs < best.heartbeatAgeMs)
        ) {
            best = s;
        }
    }
    return best;
}

/** Memoised `getEpisodeOrderKeys`: each id is read at most once per resolution. */
class OrderKeyCache {
    private readonly rows = new Map<string, EpisodeOrderKeyRow | null>();

    constructor(
        private readonly sql: postgres.Sql,
        private readonly deps: SeriesMarkerDeps,
    ) {}

    async load(ids: Array<string | null>): Promise<void> {
        const missing = [
            ...new Set(ids.filter((id): id is string => id !== null && !this.rows.has(id))),
        ];
        if (missing.length === 0) return;
        const found = await this.deps.getEpisodeOrderKeys(this.sql, missing);
        for (const id of missing) this.rows.set(id, null);
        for (const row of found) this.rows.set(row.id, row);
    }

    get(id: string | null): EpisodeOrderKeyRow | null {
        return id === null ? null : (this.rows.get(id) ?? null);
    }
}

// ─── Resolution steps ─────────────────────────────────────────────────────────

async function resolveLive(
    sql: postgres.Sql,
    input: SeriesMarkerInput,
    deps: SeriesMarkerDeps,
): Promise<ResolvedMarker | null> {
    const { userId, seriesId } = input;
    const excludeSessionId = input.excludeSessionId ?? null;
    const fromEpisodeId = input.fromEpisodeId ?? null;
    const fromPositionMs = input.fromPositionMs ?? null;

    const caller = {
        excludeSessionId,
        callerEpisodeId: fromEpisodeId,
        callerPositionMs: fromPositionMs,
    };

    const step = (async (): Promise<ResolvedMarker | null> => {
        const sessions = await deps.getLiveSessions(userId, seriesId);
        const candidates = sessions.filter((s) => {
            if (!s.isFresh || isCallerSession(s, caller)) return false;
            if (s.source !== 'lumastra' && s.source !== 'jellyfin') return false;
            // Specials never become the marker.
            return s.seasonNumber !== 0;
        });
        const session = pickFreshest(candidates);
        if (!session) return null;

        // No attribution for a session on the caller's own device (another
        // tab of the same browser): the copy then says "another device".
        const callerDeviceId =
            excludeSessionId === null
                ? null
                : (sessions.find((s) => s.sessionId === excludeSessionId)?.device?.deviceId ??
                  (await deps.getSessionDeviceId(sql, excludeSessionId)));
        const sameDevice = callerDeviceId !== null && session.device?.deviceId === callerDeviceId;
        const deviceName = sameDevice ? null : (session.device?.client ?? null);
        const updatedAt = toIso(session.lastHeartbeatAt);
        if (isPastCompletion(session)) {
            const next = await deps.findNextEpisode(sql, seriesId, session.mediaId);
            if (!next) return null;
            return { state: 'next', episodeId: next.id, positionMs: 0, updatedAt, deviceName };
        }
        return {
            state: 'in_progress',
            episodeId: session.mediaId,
            positionMs: session.positionMs,
            durationMs: session.runtimeMs,
            updatedAt,
            deviceName,
        };
    })();

    const result = await withBudget(step, LIVE_STEP_BUDGET_MS);
    if (result === null) {
        logger.debug('Live step produced no marker (none, timeout or error)', { seriesId });
    }
    return result;
}

/** The in-progress marker plus the fields the rail's CW-vs-next-up rule reads. */
interface InProgressResolution {
    marker: ResolvedMarker;
    anchor: SeriesAnchorCandidate;
}

async function resolveInProgress(
    sql: postgres.Sql,
    input: SeriesMarkerInput,
    deps: SeriesMarkerDeps,
    keys: OrderKeyCache,
): Promise<InProgressResolution | null> {
    const { userId, seriesId } = input;
    const fromEpisodeId = input.fromEpisodeId ?? null;
    const excludeSessionId = input.excludeSessionId ?? null;

    const [row] = await deps.getInProgressRows(sql, {
        userId,
        seriesId,
        limit: 1,
        collapsePerSeries: true,
    });
    if (!row || row.media_type === 'movie') return null;

    let chosen: ContinueWatchingRow = row;
    // Self-contamination guard: the caller's own episode can be the series'
    // most recent row (a stale tab kept it fresh). It must never mask a later
    // in-progress episode, so look past it for one ordered after `from`.
    if (fromEpisodeId !== null && row.media_id === fromEpisodeId) {
        const rows = await deps.getInProgressRows(sql, {
            userId,
            seriesId,
            limit: GUARD_ROW_LIMIT,
            collapsePerSeries: false,
        });
        await keys.load([fromEpisodeId, ...rows.map((r) => r.media_id)]);
        const fromKey = keys.get(fromEpisodeId);
        const later = rows
            .filter((r) => {
                const key = keys.get(r.media_id);
                return fromKey !== null && key !== null && key.order_key > fromKey.order_key;
            })
            .sort(
                (a, b) =>
                    new Date(String(b.last_event_at)).getTime() -
                    new Date(String(a.last_event_at)).getTime(),
            )[0];
        if (later) chosen = later;
    }

    const deviceName = await deps.getLatestClientName(
        sql,
        userId,
        chosen.media_id,
        excludeSessionId,
    );
    const positionMs = Number(chosen.resume_position_ms);
    const runtimeMs = chosen.runtime_ms ? Number(chosen.runtime_ms) : 0;
    const updatedAt = toIso(chosen.last_event_at);
    return {
        marker: {
            state: 'in_progress',
            episodeId: chosen.media_id,
            positionMs,
            durationMs: runtimeMs > 0 ? runtimeMs : null,
            updatedAt,
            deviceName,
        },
        // Same mapping as the rail's `continueWatchingRowToItem`.
        anchor: {
            seasonNumber: chosen.season_number ?? undefined,
            episodeNumber: chosen.episode_number ?? undefined,
            resumeRatio: runtimeMs > 0 ? positionMs / runtimeMs : undefined,
            updatedAt: updatedAt ?? undefined,
        },
    };
}

async function resolveDurable(
    sql: postgres.Sql,
    input: SeriesMarkerInput,
    deps: SeriesMarkerDeps,
    keys: OrderKeyCache,
): Promise<ResolvedMarker> {
    const { userId, seriesId } = input;

    const inProgress = await resolveInProgress(sql, input, deps, keys);

    const [nextUp, summary] = await Promise.all([
        deps.getNextUp({
            userId,
            seriesId,
            sql,
            excludeSessionId: input.excludeSessionId ?? null,
            callerEpisodeId: input.fromEpisodeId ?? null,
            callerPositionMs: input.fromPositionMs ?? null,
        }),
        deps.getMainlineSummary(sql, userId, seriesId),
    ]);
    // Next-up also answers for an untouched series (its first episode); that
    // is `not_started`, not `next`.
    const hasWatched = (summary?.watched_episodes ?? 0) > 0;
    // An in-progress row and next-up are arbitrated by the rail's own rule, so
    // the marker never contradicts the series' Continue Watching card: a stale,
    // barely-started backlog row (a months-old rewatch of S01E10 while the
    // user has since finished S06E10) loses to next-up instead of pulling a
    // Continue tap back to it.
    if (inProgress) {
        if (!nextUp.episode) return inProgress.marker;
        const { winner } = resolveSeriesAnchor({
            cw: inProgress.anchor,
            nu: {
                seasonNumber: nextUp.episode.season_number,
                episodeNumber: nextUp.episode.episode_number,
            },
            config: await deps.getAnchorConfig(),
        });
        if (winner !== 'nu') return inProgress.marker;
    }
    if (nextUp.episode && hasWatched) {
        return {
            state: 'next',
            episodeId: nextUp.episode.media_id,
            positionMs: 0,
            updatedAt: null,
            deviceName: null,
        };
    }

    if (
        summary &&
        summary.total_episodes > 0 &&
        summary.watched_episodes >= summary.total_episodes &&
        summary.last_watched_episode_id
    ) {
        const deviceName = await deps.getLatestClientName(
            sql,
            userId,
            summary.last_watched_episode_id,
            input.excludeSessionId ?? null,
        );
        return {
            state: 'finished',
            episodeId: summary.last_watched_episode_id,
            positionMs: 0,
            updatedAt: toIso(summary.last_watched_at),
            deviceName,
        };
    }

    const first = await deps.getFirstEpisode(seriesId);
    return {
        state: 'not_started',
        episodeId: first?.media_id ?? nextUp.episode?.media_id ?? null,
        positionMs: 0,
        updatedAt: null,
        deviceName: null,
    };
}

function relationOf(
    marker: EpisodeOrderKeyRow | null,
    markerPositionMs: number,
    from: EpisodeOrderKeyRow | null,
    fromPositionMs: number,
    seriesId: string,
    sameFile: boolean,
): SeriesMarkerRelation {
    if (!marker || !from || from.series_id !== seriesId) return 'none';
    // A special never pulls a main-line player.
    if (marker.season_number === 0 && from.season_number !== 0) return 'none';
    // One combined file: both positions are file-absolute, so the playheads
    // decide. A later episode behind the caller's playhead is a backward seek.
    if (sameFile) {
        const delta = markerPositionMs - fromPositionMs;
        if (delta > SAME_EPISODE_FORWARD_MARGIN_MS) return 'forward';
        if (delta < -SAME_EPISODE_FORWARD_MARGIN_MS) return 'behind';
        return 'same';
    }
    if (marker.order_key > from.order_key) return 'forward';
    if (marker.order_key < from.order_key) return 'behind';
    return markerPositionMs > fromPositionMs + SAME_EPISODE_FORWARD_MARGIN_MS ? 'forward' : 'same';
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function effectiveSeriesMarker(
    input: SeriesMarkerInput,
    deps: SeriesMarkerDeps = defaultDeps(),
): Promise<SeriesMarker> {
    const sql = input.sql ?? getDb();
    const fromEpisodeId = input.fromEpisodeId ?? null;
    const empty: SeriesMarker = {
        state: 'not_started',
        progress: buildPlaybackProgress({
            positionMs: null,
            durationMs: null,
            finished: false,
            updatedAt: null,
        }),
        episode: null,
        positionMs: 0,
        updatedAt: null,
        deviceName: null,
        relation: 'none',
        sameFileAsFrom: false,
    };
    if (!sql) return empty;

    const keys = new OrderKeyCache(sql, deps);
    const resolved =
        (await resolveLive(sql, input, deps)) ?? (await resolveDurable(sql, input, deps, keys));

    await keys.load([resolved.episodeId, fromEpisodeId]);
    const markerKey = keys.get(resolved.episodeId);
    if (!markerKey) {
        return {
            ...empty,
            state: resolved.state,
            progress: buildPlaybackProgress({
                positionMs: null,
                durationMs: null,
                finished: resolved.state === 'finished',
                updatedAt: resolved.updatedAt,
            }),
        };
    }
    const fromKey = keys.get(fromEpisodeId);

    const sameFileAsFrom =
        fromKey !== null && fromKey.series_id === input.seriesId && fromKey.id !== markerKey.id
            ? await deps.episodesShareFile(sql, fromKey.id, markerKey.id)
            : false;
    // Only live / in-progress positions are real playheads; every other state
    // means "the start of the episode", which in a shared file is its window.
    let positionMs = resolved.positionMs;
    if (sameFileAsFrom && resolved.state !== 'in_progress') {
        positionMs = (await deps.getEpisodeWindowStartMs(sql, markerKey.id)) ?? positionMs;
    }

    const relation = relationOf(
        markerKey,
        positionMs,
        fromKey,
        input.fromPositionMs ?? 0,
        input.seriesId,
        sameFileAsFrom,
    );

    return {
        progress: buildPlaybackProgress({
            positionMs,
            durationMs: resolved.durationMs ?? null,
            finished: resolved.state === 'finished',
            updatedAt: resolved.updatedAt,
        }),
        state: resolved.state,
        episode: {
            id: markerKey.id,
            seasonNumber: Number(markerKey.season_number),
            episodeNumber: Number(markerKey.episode_number),
            title: markerKey.title,
            orderKey: Number(markerKey.order_key),
        },
        positionMs,
        updatedAt: resolved.updatedAt,
        deviceName: resolved.deviceName,
        relation,
        sameFileAsFrom,
    };
}
