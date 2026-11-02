// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure mapping for the AudiobookShelf watch-sync connector.
 *
 * No I/O — the connector does the fetching and hands payloads here, so every
 * decision below is unit-testable against real recorded payloads.
 *
 * **Units are not uniform in the ABS payload and are not guessable:**
 *
 * | Field                                | Unit             |
 * | ------------------------------------ | ---------------- |
 * | `currentTime`, `duration`            | seconds (float)  |
 * | `lastUpdate`, `startedAt`, `finishedAt` | epoch milliseconds |
 *
 * Reading `lastUpdate` as seconds yields dates in the year 55879 — which sorts
 * every pulled event to the end of time and wins every arbitration forever,
 * without ever looking like a units bug at the call site.
 */

import type { AudiobookMediaProgress, AudiobookSession } from '../audiobookshelf.js';
import type { WatchStatePullItem } from '@sapd/lumastra-plugin-sdk';
import { AUDIOBOOK_MEDIA_TYPE } from '../database/queries/audiobooks.queries.js';

/**
 * How long an open ABS session may go without an update before it stops
 * freezing its item's position.
 *
 * ABS sessions linger in `playbackSessionManager` after a client crash and ABS
 * exposes no client-liveness signal, so without a cap a dead session freezes
 * that book's position indefinitely — it would never resume again. Five minutes
 * matches the sweep interval and the cutoff the Active Streams merge already
 * uses for the same class of stale ABS session.
 */
export const ABS_SESSION_STALE_MS = 5 * 60 * 1000;

/** Seconds → whole milliseconds, guarding NaN/negative. */
function secondsToMs(seconds: number | null | undefined): number {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000);
}

/** Epoch-ms → Date, or null when absent/implausible. */
function epochMsToDate(ms: number | null | undefined): Date | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
    return new Date(ms);
}

/**
 * Should this progress row participate in the sync at all?
 *
 * Podcasts are out of scope entirely, and a row without a `libraryItemId` has
 * nothing to resolve against. `mediaItemType` ABSENT is treated as a book on
 * purpose: older ABS builds omit the field, and defaulting to "not a book"
 * would silently sync nothing against those servers — the exact failure shape
 * this integration keeps producing.
 */
export function isCountableBookProgress(row: AudiobookMediaProgress): boolean {
    if (!row.libraryItemId) return false;
    if (row.episodeId) return false;
    const type = row.mediaItemType;
    if (type === undefined || type === null || type === '') return true;
    return type.toLowerCase() === 'book';
}

/**
 * Composite freeze key. Usernames fold to lowercase — ABS's are mixed-case.
 *
 * Keyed on the folded USERNAME rather than a Lumastra user UUID because an ABS
 * session only carries the ABS username. Two Lumastra accounts whose usernames
 * fold together would therefore share a freeze entry — acceptable because such
 * accounts already resolve to one ABS account (`matchAbsUser` refuses to link an
 * ambiguous fold at all), so they cannot both be syncing independently.
 */
export function frozenKey(username: string, libraryItemId: string): string {
    return `${username.normalize('NFC').trim().toLowerCase()}::${libraryItemId}`;
}

/**
 * Build the set of (user, item) pairs whose position must not be moved by this
 * pull, from ABS's open-session list.
 *
 * Two exclusions, both load-bearing:
 *
 *  1. **Stale sessions** older than {@link ABS_SESSION_STALE_MS} are ignored —
 *     see that constant.
 *  2. **Lumastra's own sessions are exempt.** Lumastra holds an ABS session open
 *     server-side while the user is merely PAUSED, so without this the pull the
 *     player wants to consume on resume ("you listened on your phone while this
 *     tab was paused") is frozen by the player's own session and the position
 *     never advances. The guard exists to protect against OTHER devices.
 *
 * A session with no `updatedAt` is kept rather than aged out: absent is not
 * evidence of staleness, and dropping it would un-freeze a live listener.
 */
export function buildFrozenItemKeys(
    openSessions: readonly AudiobookSession[],
    nowMs: number,
    lumastraSessionIds: ReadonlySet<string>,
): Set<string> {
    const frozen = new Set<string>();

    for (const s of openSessions) {
        if (!s?.libraryItemId) continue;
        if (s.id && lumastraSessionIds.has(s.id)) continue;

        const updatedAt = s.updatedAt;
        const hasStamp = typeof updatedAt === 'number' && Number.isFinite(updatedAt);
        if (hasStamp && nowMs - updatedAt > ABS_SESSION_STALE_MS) continue;

        const username = s.user?.username;
        if (!username) continue;

        frozen.add(frozenKey(username, s.libraryItemId));
    }

    return frozen;
}

export interface MapProgressOpts {
    /** True when another device owns this item's position right now. */
    frozen: boolean;
}

/**
 * Map one ABS `mediaProgress` row to a pull item.
 *
 * `lastWatchedAt` carries ABS's own timestamp so the engine stamps
 * `occurred_at` with when the listening actually happened rather than when we
 * fetched it — without this a years-old backlog imports as "watched today" and
 * floods Continue Watching. For a finished row it prefers `finishedAt`, which
 * is distinct per completion and therefore usable as a completion identity.
 */
export function mapProgressToPullItem(
    row: AudiobookMediaProgress,
    providerUsername: string,
    opts: MapProgressOpts,
): WatchStatePullItem {
    const runtimeMs = secondsToMs(row.duration);
    const rawPositionMs = secondsToMs(row.currentTime);

    // ABS can report currentTime slightly PAST duration on a finished row
    // (observed on the live server: 104747.898 vs 104747.180). Left unclamped
    // every consumer that divides the two renders >100%.
    const resumePositionMs = runtimeMs > 0 ? Math.min(rawPositionMs, runtimeMs) : rawPositionMs;

    const activityAt = row.isFinished
        ? (epochMsToDate(row.finishedAt) ?? epochMsToDate(row.lastUpdate))
        : epochMsToDate(row.lastUpdate);

    return {
        providerId: row.libraryItemId,
        tmdbId: null,
        imdbId: null,
        mediaType: AUDIOBOOK_MEDIA_TYPE,
        isWatched: row.isFinished === true,
        resumePositionMs,
        runtimeMs,
        // Derived by the rebuilder from the event log, never written from here.
        watchCount: 0,
        providerUsername,
        lastWatchedAt: activityAt,
        firstWatchedAt: epochMsToDate(row.startedAt) ?? activityAt,
        freezePosition: opts.frozen,
    };
}

/**
 * Compute the cursor to persist after a successful pull, as an ISO string, or
 * `null` when there is nothing safe to record.
 *
 * Two rules, both correctness-critical:
 *
 *  1. **Advance over ALL rows seen, not just the freshly-imported ones.** The
 *     newest row may be one this cycle's cursor filtered out; taking the max of
 *     the fresh subset alone lets the cursor stall and re-read forever.
 *  2. **Never advance past a FROZEN row.** A frozen item contributes no progress
 *     event, so advancing past it means never looking at it again. Concretely: a
 *     listener stops on their phone at the moment we pull; the open session then
 *     goes stale after {@link ABS_SESSION_STALE_MS} and we un-freeze — but by
 *     then the row is older than the cursor and is filtered out permanently, so
 *     their final position is lost. Clamping just below the oldest frozen row
 *     guarantees it is re-read next cycle.
 *
 * Re-reading is cheap and idempotent (the engine's per-source gates converge),
 * so erring toward an earlier cursor costs nothing but a comparison.
 */
export function computeNextCursor(
    rows: readonly AudiobookMediaProgress[],
    frozenLibraryItemIds: ReadonlySet<string>,
): string | null {
    let newest = 0;
    let oldestFrozen = Number.POSITIVE_INFINITY;

    for (const row of rows) {
        const stamp = row.lastUpdate;
        if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) continue;

        if (frozenLibraryItemIds.has(row.libraryItemId)) {
            oldestFrozen = Math.min(oldestFrozen, stamp);
        } else {
            newest = Math.max(newest, stamp);
        }
    }

    if (Number.isFinite(oldestFrozen)) {
        newest = Math.min(newest, oldestFrozen - 1);
    }

    return newest > 0 ? new Date(newest).toISOString() : null;
}

/**
 * Drop rows not newer than the engine-supplied cursor.
 *
 * ABS has no `changed-since` parameter, so this is client-side. An unparseable
 * cursor keeps everything: re-importing is idempotent (the engine's per-source
 * gates converge), whereas dropping the pull loses real activity.
 */
export function filterProgressByCursor(
    rows: readonly AudiobookMediaProgress[],
    cursor: string | undefined,
): AudiobookMediaProgress[] {
    if (!cursor) return [...rows];
    const cutoff = Date.parse(cursor);
    if (!Number.isFinite(cutoff)) return [...rows];
    // `>=`, not `>`. ABS stamps `lastUpdate` to the millisecond and can write
    // several rows within the same one (bulk operations do this). With a strict
    // `>` a row written at exactly the cursor value after the cursor was set is
    // dropped on every subsequent cycle, forever, and the cursor never advances
    // past that value to unstick it. The cost of `>=` is re-reading the boundary
    // row each cycle, which the engine's per-source gates converge on without
    // appending a duplicate event.
    return rows.filter((r) => typeof r.lastUpdate === 'number' && r.lastUpdate >= cutoff);
}
