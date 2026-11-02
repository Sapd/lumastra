// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Effective Next-Up — single-series primitive that mirrors the home strip's
 * live-overlay-aware next-up resolution.
 *
 * Why: the per-series next-episode endpoint and the home strip used to
 * compute "what's next" via two different code paths. During an active
 * binge, the home strip's `applyLiveOverlay` + synthetic next-up logic
 * advances ahead of the durable plane while per-series stayed pinned to
 * whatever `user_media_state` last persisted. That's the parity drift.
 *
 * Resolution rules, in order:
 *   1. If the user has a fresh active session for this series and the
 *      session crossed the completion threshold, return the episode AFTER
 *      the session episode (synthetic next-up).
 *   2. Otherwise return the durable next-up from `watchManager.getNextUpForSeries`.
 *
 * Live overlay runs with an optional budget so SSR/hot-path callers can
 * fail-open to the durable answer.
 */
import {
    findNextSequentialEpisode,
    findEpisodeForNextUp,
    type NextSequentialEpisodeRow,
} from '$lib/server/database/queries/episode-search.queries.js';
import { getDb } from '$lib/server/database/index.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { getSessionReadModel } from '$lib/server/services/session-read-model.service.js';
import { completionThresholdFor } from '$lib/server/utils/watch-constants.js';
import { withBudget } from '$lib/server/utils/with-budget.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isCallerSession } from '$lib/server/services/effective-series-marker.service.js';
import type { UserId } from '$lib/shared/user-id.js';

const logger = Logger.for('EffectiveNextUp');

// Applied when the caller does not pass an explicit budget, so a slow or
// hung session store never blocks the per-series next-episode endpoint
// indefinitely. Errors are already suppressed by withBudget, so this is
// purely a ceiling on hang time.
const DEFAULT_OVERLAY_BUDGET_MS = 2000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EffectiveNextUpInput {
    userId: UserId;
    seriesId: string;
    /** Hard timeout for the live-session check (ms). Default: untimed. */
    liveOverlayBudgetMs?: number;
    sql?: ReturnType<typeof getDb>;
    /**
     * The caller's own play session, left out of the live overlay: a player
     * paused in the credits must not see its own session as "past completion"
     * and be sent to the next episode.
     */
    excludeSessionId?: string | null;
    /**
     * Episode and position of a caller that could not name its session. With
     * no `excludeSessionId`, a live session on this episode at this position
     * is taken to be the caller and left out too (see `isCallerSession`).
     */
    callerEpisodeId?: string | null;
    callerPositionMs?: number | null;
}

export interface EffectiveNextUpRow {
    media_id: string;
    title: string;
    season_number: number;
    episode_number: number;
    overview: string | null;
    runtime_seconds: number | null;
    premiere_date: string | null;
}

export interface EffectiveNextUpResult {
    /** The next-up episode, or null when none can be resolved. */
    episode: EffectiveNextUpRow | null;
    /**
     * 'durable' = stock next-up from user_media_state.
     * 'synthetic-live' = the live session was past completion and we returned
     * the episode AFTER it. Synthetic rows carry only id/title/season/episode;
     * other fields are null because `findNextSequentialEpisode` doesn't fetch
     * them. Callers that surface those fields (overview, runtime, premiere
     * date) should NOT cache synthetic rows — see next-episode/+server.ts.
     * 'none' = no episode could be resolved.
     */
    source: 'durable' | 'synthetic-live' | 'none';
    /**
     * Whether the live overlay step ran to completion within budget.
     * Distinct from `source`: an overlay can run successfully and return
     * `source='durable'` because the user has no live session, vs an overlay
     * that timed out and silently fell back to durable.
     */
    liveOverlayApplied: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPastCompletion(positionMs: number, runtimeMs: number, mediaType: string): boolean {
    if (!runtimeMs || runtimeMs <= 0) return false;
    const ratio = positionMs / runtimeMs;
    if (!Number.isFinite(ratio)) return false;
    const threshold = completionThresholdFor(mediaType, runtimeMs);
    return ratio >= threshold;
}

function nextSequentialToRow(next: NextSequentialEpisodeRow): EffectiveNextUpRow {
    return {
        media_id: next.id,
        title: next.title,
        season_number: next.season_number,
        episode_number: next.episode_number,
        overview: null,
        runtime_seconds: null,
        premiere_date: null,
    };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function effectiveNextUpForSeries(
    input: EffectiveNextUpInput,
): Promise<EffectiveNextUpResult> {
    const { userId, seriesId, liveOverlayBudgetMs, sql: providedSql } = input;
    const sql = providedSql ?? getDb();

    if (!sql) {
        // No DB: nothing to resolve. Production callers (the route) already
        // gate on this and return 503; preserving the contract here keeps the
        // service safely callable.
        return { episode: null, source: 'none', liveOverlayApplied: false };
    }

    // Step 1: live-session check.
    //
    // The promise returns:
    //   { episode: <row>, inProgressEpisodeId: null }   → past threshold, synthetic next-up
    //   { episode: null,  inProgressEpisodeId: <id> }   → mid-episode (not yet complete)
    //   { episode: null,  inProgressEpisodeId: null }   → no matching session
    //
    // `withBudget` returns null only on timeout/error; that sets
    // liveOverlayApplied=false and we fall straight through to durable.
    //
    // The `inProgressEpisodeId` field is the rewatch-gap fix: when all
    // episodes are already watched the durable anchor is the old finale, so
    // the durable query returns null. Step 3 detects that combination and
    // surfaces the in-progress episode so the modal/watch page doesn't go dark.
    type OverlayOutcome = {
        episode: EffectiveNextUpRow | null;
        inProgressEpisodeId: string | null;
    };
    const overlayPromise: Promise<OverlayOutcome> = (async () => {
        const sessions = await getSessionReadModel().getActiveSessionsForUser(userId);
        // Mid-handoff a user can have multiple sessions for the same series
        // (TV started, phone joined). Pick the most-advanced — the one whose
        // position is furthest along — so synthetic next-up reflects the
        // newest binge frontier, not whichever session indexed first.
        const candidates = sessions.filter(
            (s) =>
                s.seriesId === seriesId &&
                s.isFresh &&
                s.hasFiles &&
                (s.source === 'lumastra' || s.source === 'jellyfin') &&
                !isCallerSession(s, input),
        );
        const matching =
            candidates.length === 0
                ? null
                : candidates.reduce((best, s) => (s.positionMs > best.positionMs ? s : best));
        if (!matching) return { episode: null, inProgressEpisodeId: null };
        if (!isPastCompletion(matching.positionMs, matching.runtimeMs ?? 0, matching.mediaType)) {
            // The current episode is not yet complete. Durable handles the
            // normal first-watch case (anchor is behind the current episode).
            // For rewatches (anchor is the old finale, durable returns null),
            // step 3 uses inProgressEpisodeId as a fallback.
            return { episode: null, inProgressEpisodeId: matching.mediaId };
        }
        const next = await findNextSequentialEpisode(sql, seriesId, matching.mediaId, {
            playableOnly: true,
        });
        if (!next || next.has_files !== true) return { episode: null, inProgressEpisodeId: null };
        return {
            episode: nextSequentialToRow(next),
            inProgressEpisodeId: null,
        };
    })();

    const effectiveBudget = liveOverlayBudgetMs ?? DEFAULT_OVERLAY_BUDGET_MS;
    const overlayResult = await withBudget(overlayPromise, effectiveBudget);
    const liveOverlayApplied = overlayResult !== null;

    if (overlayResult === null) {
        logger.debug('Live overlay exceeded budget for per-series next-up', {
            budgetMs: effectiveBudget,
            seriesId,
            userId,
        });
    }

    if (overlayResult?.episode) {
        return {
            episode: overlayResult.episode,
            source: 'synthetic-live',
            liveOverlayApplied: true,
        };
    }

    // Step 2: durable next-up.
    const durable = await watchManager.getNextUpForSeries(seriesId, userId);
    if (durable) {
        return {
            episode: {
                media_id: durable.media_id,
                title: durable.title,
                season_number: durable.season_number,
                episode_number: durable.episode_number,
                overview: durable.overview,
                runtime_seconds: durable.runtime_seconds,
                premiere_date: durable.premiere_date,
            },
            source: 'durable',
            liveOverlayApplied,
        };
    }

    // Step 3: rewatch gap recovery.
    // Durable returned null and the overlay detected a live session that
    // hadn't crossed the completion threshold. This happens at the start of a
    // rewatch: the durable anchor is still the old finale (no newer completed
    // event yet), so there is nothing "after the anchor". Surface the
    // in-progress episode directly so the modal/watch page doesn't go dark.
    if (overlayResult?.inProgressEpisodeId) {
        const currentEp = await findEpisodeForNextUp(sql, overlayResult.inProgressEpisodeId);
        if (currentEp) {
            const premiereDate = currentEp.premiere_date
                ? currentEp.premiere_date instanceof Date
                    ? currentEp.premiere_date.toISOString()
                    : String(currentEp.premiere_date)
                : null;
            return {
                episode: {
                    media_id: currentEp.id,
                    title: currentEp.title,
                    season_number: currentEp.season_number,
                    episode_number: currentEp.episode_number,
                    overview: currentEp.overview,
                    runtime_seconds: currentEp.runtime_seconds,
                    premiere_date: premiereDate,
                },
                source: 'synthetic-live',
                liveOverlayApplied: true,
            };
        }
    }

    return { episode: null, source: 'none', liveOverlayApplied };
}
