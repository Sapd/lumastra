// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live Watching Overlay (P2 — exact-key matching, no heuristics)
 *
 * Merges live `play_sessions` rows (via `SessionReadModel.ActiveSessionView`)
 * onto durable Continue Watching / Next Up rows so the actively-playing
 * episode/movie immediately becomes the visible CW anchor.
 *
 * The old four-tier `comparableSeriesKey` heuristic (Jellyfin id → external
 * provider id → internal series id → name) caused failures when keys
 * diverged between sources. This rewrite drops that entirely and matches
 * exclusively on internal UUIDs:
 *
 *   - Episodes are keyed by `series:${seriesId}` (the internal series UUID,
 *     resolved by the SQL view via media_items grandparent join).
 *   - Movies / non-episode media are keyed by `media:${mediaId}`.
 *
 * If the keys don't match, they don't match. There is no fall-through.
 */
import type { ExternalIds } from '$lib/types/api-common';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { getCatalogPosterUrl } from '$lib/utils/image-utils.js';
import type { ActiveSessionView } from '$lib/server/services/session-read-model.service.js';
import type { ContinueWatchingItem } from './section-builder.js';
import { completionThresholdFor } from './watch-constants.js';
import { isEpisode } from '$lib/server/utils/media-types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface OverlayInput {
    username: string;
    /** Durable continue-watching rows from watchManager.getContinueWatching. */
    continueWatching: ContinueWatchingItem[];
    /** Durable next-up rows (used for the synthetic-next-up swap). */
    nextUp: ContinueWatchingItem[];
    /** Active sessions from SessionReadModel.getActiveSessionsForUser. */
    activeSessions: ActiveSessionView[];
    /** ISO timestamp injected for deterministic test runs (defaults to now). */
    nowIso?: string;
}

/**
 * Origin of a suppressed anchor. `live` means the suppression came from a
 * past-completion ActiveSessionView; `durable` means the freshest CW row for
 * that series/media was itself past completion (no live session involved).
 * Used by the route to pick the correct next-up shim metadata.
 */
export type SuppressedAnchorOrigin = 'live' | 'durable';

/**
 * Normalized handle for a CW row that was suppressed because it crossed the
 * completion threshold. The route iterates this list to drive the synthetic
 * next-up injection regardless of whether the source was a live session or
 * a durable user_media_state row.
 */
export interface SuppressedAnchor {
    origin: SuppressedAnchorOrigin;
    /** Internal series UUID, if any. Movies/non-series carry undefined. */
    seriesId?: string;
    /** Internal media UUID of the suppressed episode/movie. */
    mediaId: string;
    /** Original mediaType ('episode'|'movie'|...) for downstream branching. */
    mediaType: string;
    /**
     * Source of the latest event behind this suppression — used to label the
     * synthetic next-up shim ('lumastra-player' for live lumastra, etc.).
     */
    lastEventSource?: string;
    /** The matching durable CW row, if one existed. */
    durableMatch?: ContinueWatchingItem;
    /** The live session, when origin === 'live'. */
    session?: ActiveSessionView;
}

export interface OverlayResult {
    /** Continue-watching rows after live overlay + suppression. */
    continueWatching: ContinueWatchingItem[];
    /** Next-up rows (unchanged; callers run synthetic-next-up separately). */
    nextUp: ContinueWatchingItem[];
    /**
     * Internal series UUIDs whose chosen anchor is past completion threshold
     * (live OR durable). The CW row has been dropped; the caller should query
     * `findNextSequentialEpisode` and inject the next episode into next-up.
     */
    suppressedSeriesIds: Set<string>;
    /**
     * Internal media UUIDs (movies, non-series media) whose anchor is past
     * completion threshold. Their CW rows have been dropped.
     */
    suppressedMediaIds: Set<string>;
    /**
     * Internal media UUIDs that appear in the post-merge CW list. Used by the
     * caller for exact-id dedup against new-episodes.
     */
    representedMediaIds: Set<string>;
    /**
     * Internal series UUIDs that appear in the post-merge CW list. Used for
     * series-level dedup against new-episodes.
     */
    representedSeriesIds: Set<string>;
    /**
     * Internal context — list of suppressed LIVE items only, full
     * ActiveSessionView. Retained for backwards compatibility; new callers
     * should iterate `suppressedAnchors` to handle both origins.
     */
    suppressedSessions: ActiveSessionView[];
    /**
     * Map from suppressed key (`series:${seriesId}` or `media:${mediaId}`)
     * to the durable CW row that matched. For live origins this is the prior
     * durable row (may be undefined when the live session crossed threshold
     * without ever being in CW). For durable origins this IS the suppressed
     * row itself.
     */
    suppressedDurableMatches: Map<string, ContinueWatchingItem | undefined>;
    /**
     * Unified per-key list of suppressed anchors (live + durable) so the
     * caller can drive the synthetic next-up loop without reaching into
     * separate lists.
     */
    suppressedAnchors: SuppressedAnchor[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NON_PLAYABLE_TYPES = new Set([
    'music',
    'audio',
    'track',
    'channel',
    'tvchannel',
    'livetv',
    'live',
]);

function lower(value: string | undefined | null): string {
    return value?.trim().toLowerCase() ?? '';
}

function positiveNumber(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The exact key for matching a CW row or a session. Episodes key on series UUID,
 * everything else on media UUID. No heuristics, no fall-through.
 */
function rowKey(item: {
    mediaType: string;
    seriesId?: string;
    id: string;
    externalIds?: ExternalIds;
}): string | null {
    if (isEpisode(item.mediaType)) {
        if (item.seriesId) return `series:${item.seriesId}`;
        return null; // Orphan episode — defensive: skip rather than fall through.
    }
    const internal =
        item.externalIds && 'internal' in item.externalIds
            ? (item.externalIds as Record<string, string | undefined>).internal
            : undefined;
    const mediaId = internal ?? item.id;
    return `media:${mediaId}`;
}

function sessionKey(session: ActiveSessionView): string | null {
    const mediaType = lower(session.mediaType);
    if (NON_PLAYABLE_TYPES.has(mediaType)) return null;
    if (isEpisode(session.mediaType)) {
        if (session.seriesId) return `series:${session.seriesId}`;
        return null;
    }
    return `media:${session.mediaId}`;
}

/**
 * Session sources whose rows describe a resumable, positional watch/listen the
 * CW rail can anchor on.
 *
 * 'audiobookshelf' belongs here even though the name reads external: the row is
 * written by `openAudiobookSession` and heartbeat by our OWN web/iOS players —
 * ABS is where the position is mirrored to, not who reports it. Leaving it out
 * meant a book being listened to right now never carried `livePlaybackState`,
 * so the rail labelled a live listen off the durable row's timestamp
 * ("Paused just now") while the phone was playing it.
 *
 * 'music' / 'subsonic' stay out: their media types are non-playable here anyway
 * (see NON_PLAYABLE_TYPES) — a track is not a thing you resume.
 */
const OVERLAY_SOURCES: ReadonlySet<string> = new Set(['lumastra', 'jellyfin', 'audiobookshelf']);

function shouldOverlay(session: ActiveSessionView, username: string): boolean {
    if (!OVERLAY_SOURCES.has(session.source)) {
        return false;
    }
    if (!session.hasFiles) return false;
    if (lower(session.username) !== lower(username)) return false;
    if (!session.isFresh) return false;
    if (NON_PLAYABLE_TYPES.has(lower(session.mediaType))) return false;
    if (positiveNumber(session.positionMs) === undefined) return false;
    return true;
}

function pickFreshestPerKey(sessions: ActiveSessionView[]): Map<string, ActiveSessionView> {
    const byKey = new Map<string, ActiveSessionView>();
    for (const session of sessions) {
        const key = sessionKey(session);
        if (!key) continue;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, session);
            continue;
        }
        // Prefer ACTIVE over PAUSED, then freshest heartbeat.
        const existingActive = existing.isPlaying;
        const candidateActive = session.isPlaying;
        if (candidateActive && !existingActive) {
            byKey.set(key, session);
            continue;
        }
        if (!candidateActive && existingActive) continue;
        if (session.heartbeatAgeMs < existing.heartbeatAgeMs) {
            byKey.set(key, session);
        }
    }
    return byKey;
}

function sessionToContinueWatchingItem(
    session: ActiveSessionView,
    nowIso: string,
): ContinueWatchingItem {
    const runtimeMs = session.runtimeMs ?? 0;
    const positionMs = Math.max(0, session.positionMs);
    const watchProgress = runtimeMs > 0 ? Math.min((positionMs / runtimeMs) * 100, 100) : 0;
    const durationSeconds = runtimeMs > 0 ? Math.round(runtimeMs / 1000) : undefined;
    const resumeRatio = runtimeMs > 0 ? positionMs / runtimeMs : undefined;

    return {
        id: session.mediaId,
        title: session.title ?? '',
        mediaType: session.mediaType,
        watchProgress,
        duration: durationSeconds,
        imageUrl: getCatalogPosterUrl(session.mediaId, { size: 'thumb' }),
        externalIds: createExternalIds({ internal: session.mediaId }),
        hasFiles: session.hasFiles,
        // Session presence is not availability evidence; the joined media row
        // carries the canonical file-backed signal.
        isAvailable: session.hasFiles,
        seriesId: session.seriesId ?? undefined,
        seriesName: session.seriesName,
        seasonNumber: session.seasonNumber,
        episodeNumber: session.episodeNumber,
        resumeRatio,
        updatedAt: nowIso,
        source: 'continue-watching',
        lastEventSource: session.source === 'jellyfin' ? 'jellyfin-session' : 'lumastra-player',
        livePlaybackState: session.isPlaying ? 'playing' : 'paused',
    };
}

/**
 * Build the live CW row. Episode-specific fields (title, seasonNumber,
 * episodeNumber) prefer the session's joined media_items metadata, which is
 * always the live episode. Series-level fields (seriesName, seriesId)
 * inherit from the durable row since the session's grandparent join may not
 * carry the human-readable series name in all cases.
 */
function buildLiveItem(
    session: ActiveSessionView,
    durableRow: ContinueWatchingItem | undefined,
    nowIso: string,
): ContinueWatchingItem {
    const base = sessionToContinueWatchingItem(session, nowIso);
    if (!durableRow) return base;

    // Same item on both planes (movies, audiobooks — anything keyed by
    // `media:`, and an episode whose durable row IS the live one). Then the
    // durable row is not a stale sibling to be replaced, it is the SAME card
    // with more on it: `overview`, `customMetadata` (an audiobook's author and
    // narrator block), and everything else a session row cannot know. Layer
    // the live plane on top of it rather than discarding it.
    //
    // The guard matters: for a series the durable row is usually a DIFFERENT
    // episode, and spreading it would paint the previous episode's synopsis
    // onto the one now playing.
    if (durableMediaId(durableRow) === session.mediaId) {
        const hasLiveRuntime = positiveNumber(session.runtimeMs ?? undefined) !== undefined;
        return {
            ...durableRow,
            ...base,
            title: base.title || durableRow.title,
            imageUrl: base.imageUrl ?? durableRow.imageUrl,
            seriesName: base.seriesName ?? durableRow.seriesName,
            seasonNumber: base.seasonNumber ?? durableRow.seasonNumber,
            episodeNumber: base.episodeNumber ?? durableRow.episodeNumber,
            seriesId: session.seriesId ?? durableRow.seriesId,
            externalIds: { ...durableRow.externalIds, ...base.externalIds },
            // A session with no runtime cannot compute a ratio, and a live row
            // is no reason to blank a progress bar the durable plane knows.
            ...(hasLiveRuntime
                ? {}
                : {
                      watchProgress: durableRow.watchProgress,
                      duration: durableRow.duration,
                      resumeRatio: durableRow.resumeRatio,
                  }),
        };
    }

    return {
        ...base,
        // Episode-specific fields: live session wins when present.
        title: base.title || durableRow.title,
        seasonNumber: base.seasonNumber ?? durableRow.seasonNumber,
        episodeNumber: base.episodeNumber ?? durableRow.episodeNumber,
        imageUrl: base.imageUrl ?? durableRow.imageUrl,
        // Series-level fields: durable row carries these reliably.
        seriesName: base.seriesName ?? durableRow.seriesName,
        seriesId: session.seriesId ?? durableRow.seriesId,
        externalIds: {
            ...durableRow.externalIds,
            ...base.externalIds,
        },
    };
}

function isPastCompletion(session: ActiveSessionView): boolean {
    if (!session.runtimeMs || session.runtimeMs <= 0) return false;
    const ratio = session.positionMs / session.runtimeMs;
    if (!Number.isFinite(ratio)) return false;
    const threshold = completionThresholdFor(session.mediaType, session.runtimeMs);
    return ratio >= threshold;
}

/**
 * Coerce an `updatedAt` ISO string to a numeric epoch-ms. The type permits
 * only `string | undefined`, but defensive callers occasionally hand us a
 * Date. Missing / invalid inputs degrade to 0 so they sort last under a
 * desc comparator.
 */
function durableUpdatedMs(item: ContinueWatchingItem): number {
    const raw: unknown = item.updatedAt;
    if (!raw) return 0;
    if (typeof raw === 'string') {
        const ms = Date.parse(raw);
        return Number.isFinite(ms) ? ms : 0;
    }
    if (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { getTime?: () => number }).getTime === 'function'
    ) {
        const t = (raw as { getTime: () => number }).getTime();
        return Number.isFinite(t) ? t : 0;
    }
    return 0;
}

/**
 * Resolve the internal media UUID for a CW item — prefers the explicit
 * `externalIds.internal` over `id` so deterministic lexical tiebreakers
 * compare apples to apples even when callers pass the legacy id field.
 */
function durableMediaId(item: ContinueWatchingItem): string {
    const internal =
        item.externalIds && 'internal' in item.externalIds
            ? (item.externalIds as Record<string, string | undefined>).internal
            : undefined;
    return internal ?? item.id ?? '';
}

/**
 * Encode (seasonNumber, episodeNumber) as a single sortable number so the
 * tiebreaker walks the right cross-season order: S2E2 wins over S1E10. Uses
 * a generous per-season slot (10000) — far more than any real series has —
 * so collisions are impossible at runtime. Episodes without a numeric season
 * or episode are treated as `-Infinity` so any numbered episode wins over
 * an un-numbered one.
 */
function episodeOrderOf(item: ContinueWatchingItem): number {
    const s = typeof item.seasonNumber === 'number' ? item.seasonNumber : NaN;
    const e = typeof item.episodeNumber === 'number' ? item.episodeNumber : NaN;
    if (Number.isFinite(s) && Number.isFinite(e)) return s * 10000 + e;
    if (Number.isFinite(e)) return e; // unknown season — fall back to episode alone
    return -Infinity;
}

/**
 * Total-order comparator for picking the per-series anchor among durable CW
 * rows. Compare desc by `updatedAt`, then desc by season-aware episode order
 * (so S2E2 wins over S1E10 on a tie — usually the user's latest engagement),
 * then asc by media UUID for absolute determinism.
 */
function compareDurableForAnchor(a: ContinueWatchingItem, b: ContinueWatchingItem): number {
    const ta = durableUpdatedMs(a);
    const tb = durableUpdatedMs(b);
    if (ta !== tb) return tb - ta;

    const ea = episodeOrderOf(a);
    const eb = episodeOrderOf(b);
    if (ea !== eb) return eb - ea;

    const ida = durableMediaId(a);
    const idb = durableMediaId(b);
    if (ida === idb) return 0;
    return ida < idb ? -1 : 1;
}

/**
 * Pick the single anchor row from a list of durable CW candidates that share
 * the same key (`series:${seriesId}` or `media:${mediaId}`). The list is
 * never empty when called — callers group first.
 */
function pickFreshestDurable(items: ContinueWatchingItem[]): ContinueWatchingItem {
    if (items.length === 1) return items[0];
    let best = items[0];
    for (let i = 1; i < items.length; i++) {
        if (compareDurableForAnchor(items[i], best) < 0) {
            best = items[i];
        }
    }
    return best;
}

/**
 * Durable-row counterpart of `isPastCompletion`. Uses the same runtime-aware
 * threshold so live and durable suppression are unified. Falls back to the
 * `watchProgress` percent (already populated for DB-sourced rows) when an
 * explicit duration isn't available.
 *
 * Unit guard: `ContinueWatchingItem.duration` is documented as seconds (set
 * by sessionToContinueWatchingItem and the durable transforms), but the
 * field has no runtime check. A 24-hour cap (86_400 seconds) is far longer
 * than any real episode/movie; a value above that is almost certainly
 * milliseconds from a future-misbehaving caller, so we divide by 1000 to
 * salvage the threshold lookup. Threshold worst-case is conservative — an
 * incorrect-large value yields a higher threshold and under-suppresses
 * rather than over-suppresses.
 */
function isPastCompletionDurable(item: ContinueWatchingItem): boolean {
    const rawDuration =
        typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0
            ? item.duration
            : undefined;
    const durationSeconds =
        rawDuration !== undefined && rawDuration > 86_400 ? rawDuration / 1000 : rawDuration;
    const runtimeMs = durationSeconds !== undefined ? durationSeconds * 1000 : undefined;
    const threshold = completionThresholdFor(item.mediaType, runtimeMs);
    const percent =
        typeof item.watchProgress === 'number' && Number.isFinite(item.watchProgress)
            ? item.watchProgress
            : NaN;
    if (!Number.isFinite(percent)) return false;
    return percent / 100 >= threshold;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Apply the live-session overlay to durable CW + nextUp lists.
 *
 * Matching is exact: episodes key on internal `seriesId`, others on internal
 * `mediaId`. Sessions that lack a matching key (orphan episodes, non-playable
 * types, stale heartbeats, other users) are filtered out before the merge.
 *
 * Pure: no DB or cache access. The caller is responsible for sourcing
 * `activeSessions` (typically `getSessionReadModel().getActiveSessionsForUser`)
 * and for running synthetic-next-up enrichment on `suppressedSeriesIds`.
 */
export function applyLiveOverlay(input: OverlayInput): OverlayResult {
    const { username, continueWatching, nextUp, activeSessions } = input;
    const nowIso = input.nowIso ?? new Date().toISOString();

    // 1. Filter sessions to candidates we can reason about.
    const candidates = activeSessions.filter((s) => shouldOverlay(s, username));

    // 2. Reduce to one row per key (freshest active wins).
    const liveByKey = pickFreshestPerKey(candidates);

    // 3. Group durable CW rows by exact key, then pick a single anchor per
    //    key with a deterministic comparator. The SQL query intentionally
    //    returns one row per (user, media_id) — for a series with multiple
    //    unfinished episodes that's multiple rows sharing the same series
    //    key, and we must collapse them here at the resolver layer rather
    //    than rely on the SQL ORDER BY (which is by last_event_at and would
    //    silently drop the freshest episode if an older one happened to
    //    have a more recent uws.last_event_at).
    const durableByKey = new Map<string, ContinueWatchingItem[]>();
    const cwUnkeyed: ContinueWatchingItem[] = [];
    for (const item of continueWatching) {
        const key = rowKey(item);
        if (!key) {
            cwUnkeyed.push(item);
            continue;
        }
        const list = durableByKey.get(key);
        if (list) {
            list.push(item);
        } else {
            durableByKey.set(key, [item]);
        }
    }

    const cwByKey = new Map<string, ContinueWatchingItem>();
    for (const [key, items] of durableByKey) {
        cwByKey.set(key, pickFreshestDurable(items));
    }

    // 4. Decide for each live key: suppress, or replace/insert.
    const suppressedSeriesIds = new Set<string>();
    const suppressedMediaIds = new Set<string>();
    const suppressedSessions: ActiveSessionView[] = [];
    const suppressedDurableMatches = new Map<string, ContinueWatchingItem | undefined>();
    const suppressedAnchors: SuppressedAnchor[] = [];
    const overlayItems: ContinueWatchingItem[] = [];
    const overlayKeys = new Set<string>();
    const suppressedKeys = new Set<string>();

    for (const [key, session] of liveByKey) {
        // Suppression only makes sense when there's a possible replacement —
        // i.e. a series with a next sequential episode. For movies and other
        // non-series media the route's findNextSequentialEpisode returns
        // null, so suppressing would just make the row vanish from CW until
        // the auto-complete heartbeat fires. Let those fall through to the
        // normal overlay path; the durable plane will drop them shortly.
        if (isPastCompletion(session) && session.seriesId) {
            suppressedKeys.add(key);
            suppressedSessions.push(session);
            const durableMatch = cwByKey.get(key);
            suppressedDurableMatches.set(key, durableMatch);
            suppressedAnchors.push({
                origin: 'live',
                seriesId: session.seriesId,
                mediaId: session.mediaId,
                mediaType: session.mediaType,
                lastEventSource:
                    session.source === 'jellyfin' ? 'jellyfin-session' : 'lumastra-player',
                durableMatch,
                session,
            });
            suppressedSeriesIds.add(session.seriesId);
            continue;
        }
        const durable = cwByKey.get(key);
        const liveRow = buildLiveItem(session, durable, nowIso);
        overlayItems.push(liveRow);
        overlayKeys.add(key);
    }

    // 4b. Second pass: any durable anchor whose key is NOT being overlaid by
    //     a live session AND is itself past completion threshold gets
    //     suppressed too. Mirrors the live near-complete handling so the
    //     route's synthetic-next-up loop picks it up regardless of source.
    //     Same series-only gate: movies/non-series can't synthesize a
    //     replacement, so leave them in CW until the durable plane flips
    //     is_watched naturally.
    for (const [key, item] of cwByKey) {
        if (overlayKeys.has(key) || suppressedKeys.has(key)) continue;
        if (!item.seriesId) continue;
        if (!isPastCompletionDurable(item)) continue;
        suppressedKeys.add(key);
        suppressedDurableMatches.set(key, item);
        const mediaId = durableMediaId(item) || item.id;
        suppressedAnchors.push({
            origin: 'durable',
            seriesId: item.seriesId,
            mediaId,
            mediaType: item.mediaType,
            lastEventSource: item.lastEventSource,
            durableMatch: item,
        });
        suppressedSeriesIds.add(item.seriesId);
    }

    // 5. Compose final CW list:
    //    - overlay rows first (sorted by lastHeartbeatAt desc)
    //    - then per-key durable winners whose key isn't overlaid OR suppressed
    //    - then unkeyed (orphan-episode) durable rows in original order
    overlayItems.sort((a, b) => {
        const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return tb - ta;
    });

    // Walk the original input order so insertion order matches what the
    // caller (which sorts later) expects. We use a Set of already-emitted
    // keys to skip the non-anchor duplicates within a series.
    const merged: ContinueWatchingItem[] = [...overlayItems];
    const emittedKeys = new Set<string>();
    for (const item of continueWatching) {
        const key = rowKey(item);
        if (!key) {
            merged.push(item);
            continue;
        }
        if (overlayKeys.has(key) || suppressedKeys.has(key)) continue;
        if (emittedKeys.has(key)) continue;
        const winner = cwByKey.get(key);
        if (!winner) continue;
        merged.push(winner);
        emittedKeys.add(key);
    }

    // 6. Compute represented sets for caller-side dedup.
    const representedMediaIds = new Set<string>();
    const representedSeriesIds = new Set<string>();
    for (const item of merged) {
        const internal =
            item.externalIds && 'internal' in item.externalIds
                ? (item.externalIds as Record<string, string | undefined>).internal
                : undefined;
        const mediaId = internal ?? item.id;
        if (mediaId) representedMediaIds.add(mediaId);
        if (item.seriesId) representedSeriesIds.add(item.seriesId);
    }

    return {
        continueWatching: merged,
        nextUp,
        suppressedSeriesIds,
        suppressedMediaIds,
        representedMediaIds,
        representedSeriesIds,
        suppressedSessions,
        suppressedDurableMatches,
        suppressedAnchors,
    };
}
