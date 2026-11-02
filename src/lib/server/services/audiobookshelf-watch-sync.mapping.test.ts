// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure mapping layer of the AudiobookShelf watch-sync connector.
 *
 * Every fixture below is shaped from a payload actually returned by
 * audio.example.com, because this integration has repeatedly shipped
 * correctly-typed comparisons that silently never fired. The units in
 * particular are not uniform and not guessable:
 *
 *   currentTime / duration  → SECONDS (float)
 *   lastUpdate / startedAt / finishedAt → epoch MILLISECONDS
 */

import { describe, it, expect } from 'vitest';
import type { AudiobookMediaProgress, AudiobookSession } from '../audiobookshelf.js';
import {
    mapProgressToPullItem,
    buildFrozenItemKeys,
    frozenKey,
    isCountableBookProgress,
    filterProgressByCursor,
    computeNextCursor,
    ABS_SESSION_STALE_MS,
} from './audiobookshelf-watch-sync.mapping.js';

/** A finished row, copied from the live server (Milo Farrow, book 5). */
const FINISHED: AudiobookMediaProgress = {
    id: '6ac861bd-759d-42b9-aa41-5f2afc70562a',
    libraryItemId: 'e36bdf49-9fd5-48a3-afc4-a270fdd3338b',
    mediaItemType: 'book',
    episodeId: null,
    currentTime: 104747.8984375,
    duration: 104747.180409,
    progress: 1,
    isFinished: true,
    hideFromContinueListening: false,
    lastUpdate: 1768997454344,
    startedAt: 1724948372685,
    finishedAt: 1768997446681,
};

/** An in-progress row, copied from the live server (Pippi Langstrumpf). */
const IN_PROGRESS: AudiobookMediaProgress = {
    id: '00925a90-ce70-4380-8de0-2883f04a57cd',
    libraryItemId: '45151f41-8df1-4cf4-9f90-b9c7ed3d3ea9',
    mediaItemType: 'book',
    episodeId: null,
    currentTime: 570.67102,
    duration: 25703.888978999996,
    progress: 0.022201738439900538,
    isFinished: false,
    hideFromContinueListening: false,
    lastUpdate: 1701448181253,
    startedAt: 1701265658237,
    finishedAt: null,
};

function session(overrides: Partial<AudiobookSession> = {}): AudiobookSession {
    return {
        id: 'sess-1',
        userId: 'abs-user-1',
        libraryItemId: IN_PROGRESS.libraryItemId,
        displayTitle: 'x',
        displayAuthor: 'x',
        mediaMetadata: {} as AudiobookSession['mediaMetadata'],
        currentTime: 1,
        duration: 2,
        chapters: [],
        updatedAt: 1_000_000,
        user: { username: 'testuser' },
        mediaPlayer: 'x',
        deviceInfo: { browserName: 'x' },
        ...overrides,
    };
}

describe('mapProgressToPullItem — units', () => {
    it('converts seconds to milliseconds for position and runtime', () => {
        const item = mapProgressToPullItem(IN_PROGRESS, 'testuser', { frozen: false });

        expect(item.resumePositionMs).toBe(570_671);
        expect(item.runtimeMs).toBe(25_703_889);
    });

    it('reads lastUpdate as epoch milliseconds, not seconds', () => {
        const item = mapProgressToPullItem(IN_PROGRESS, 'testuser', { frozen: false });

        // 1701448181253 ms = 2023-12-01. Interpreted as seconds it would be
        // year 55879 — a silently absurd occurred_at that would sort every
        // pulled event to the end of time.
        expect(item.lastWatchedAt?.toISOString()).toBe('2023-12-01T16:29:41.253Z');
        expect(item.lastWatchedAt!.getUTCFullYear()).toBe(2023);
    });

    it('threads startedAt into firstWatchedAt so a first pull does not stamp today', () => {
        const item = mapProgressToPullItem(IN_PROGRESS, 'testuser', { frozen: false });

        expect(item.firstWatchedAt?.getUTCFullYear()).toBe(2023);
    });

    it('carries the ABS item id as the provider id', () => {
        const item = mapProgressToPullItem(IN_PROGRESS, 'testuser', { frozen: false });

        expect(item.providerId).toBe(IN_PROGRESS.libraryItemId);
        expect(item.mediaType).toBe('audiobook');
        expect(item.tmdbId).toBeNull();
    });
});

describe('mapProgressToPullItem — finished rows', () => {
    it('maps isFinished to isWatched', () => {
        expect(mapProgressToPullItem(FINISHED, 'testuser', { frozen: false }).isWatched).toBe(true);
        expect(mapProgressToPullItem(IN_PROGRESS, 'testuser', { frozen: false }).isWatched).toBe(
            false,
        );
    });

    it('clamps a currentTime that overshoots duration', () => {
        // Real data: currentTime 104747.898 > duration 104747.180. Left
        // unclamped this yields resumePositionMs > runtimeMs, i.e. a >100%
        // progress ratio in every consumer that divides the two.
        const item = mapProgressToPullItem(FINISHED, 'testuser', { frozen: false });

        expect(item.resumePositionMs).toBeLessThanOrEqual(item.runtimeMs);
    });

    it('uses finishedAt as the completion identity when present', () => {
        const item = mapProgressToPullItem(FINISHED, 'testuser', { frozen: false });

        expect(item.lastWatchedAt?.getTime()).toBe(FINISHED.finishedAt);
    });
});

describe('isCountableBookProgress', () => {
    it('accepts an ordinary book row', () => {
        expect(isCountableBookProgress(IN_PROGRESS)).toBe(true);
    });

    it('rejects podcast episodes — podcasts are out of scope', () => {
        expect(
            isCountableBookProgress({
                ...IN_PROGRESS,
                mediaItemType: 'podcastEpisode',
                episodeId: 'ep-1',
            }),
        ).toBe(false);
    });

    it('accepts a row whose mediaItemType is absent rather than dropping it', () => {
        // Older ABS versions omit the field; defaulting to "not a book" would
        // silently sync nothing against those servers.
        const { mediaItemType: _omitted, ...withoutType } = IN_PROGRESS;
        expect(isCountableBookProgress(withoutType as AudiobookMediaProgress)).toBe(true);
    });

    it('rejects a row with no libraryItemId to resolve against', () => {
        expect(isCountableBookProgress({ ...IN_PROGRESS, libraryItemId: '' })).toBe(false);
    });
});

describe('buildFrozenItemKeys', () => {
    const NOW = 10_000_000;

    it('freezes an item with a fresh open session', () => {
        const frozen = buildFrozenItemKeys([session({ updatedAt: NOW - 1000 })], NOW, new Set());

        expect(frozen.has(frozenKey('testuser', IN_PROGRESS.libraryItemId))).toBe(true);
    });

    /**
     * ABS sessions linger in `playbackSessionManager` after a client crash and
     * there is no client-liveness signal. Without an age cap a dead session
     * freezes that item's position forever — the book would never resume again.
     */
    it('ignores a session older than the staleness cap', () => {
        const stale = session({ updatedAt: NOW - ABS_SESSION_STALE_MS - 1 });
        const frozen = buildFrozenItemKeys([stale], NOW, new Set());

        expect(frozen.size).toBe(0);
    });

    it('keeps a session exactly at the cap boundary', () => {
        const edge = session({ updatedAt: NOW - ABS_SESSION_STALE_MS });
        expect(buildFrozenItemKeys([edge], NOW, new Set()).size).toBe(1);
    });

    /**
     * The exemption that makes resume work at all. Lumastra holds an ABS
     * session open server-side while the user is merely PAUSED. Without this,
     * the pull the player wants to consume on resume — "you listened on your
     * phone while this tab was paused" — is frozen by the player's own session,
     * and the position never advances.
     */
    it('exempts Lumastra own sessions from the freeze', () => {
        const ours = session({ id: 'lumastra-session-1' });
        const frozen = buildFrozenItemKeys([ours], NOW, new Set(['lumastra-session-1']));

        expect(frozen.size).toBe(0);
    });

    it('still freezes another device when one of the two sessions is ours', () => {
        const ours = session({ id: 'lumastra-session-1' });
        const phone = session({ id: 'phone-session', updatedAt: NOW - 500 });
        const frozen = buildFrozenItemKeys([ours, phone], NOW, new Set(['lumastra-session-1']));

        expect(frozen.has(frozenKey('testuser', IN_PROGRESS.libraryItemId))).toBe(true);
    });

    it('keys the freeze per (user, item) so one user does not freeze another', () => {
        const other = session({ user: { username: 'testlistener' }, updatedAt: NOW - 500 });
        const frozen = buildFrozenItemKeys([other], NOW, new Set());

        expect(frozen.has(frozenKey('testlistener', IN_PROGRESS.libraryItemId))).toBe(true);
        expect(frozen.has(frozenKey('testuser', IN_PROGRESS.libraryItemId))).toBe(false);
    });

    it('matches usernames case-insensitively', () => {
        const capitalised = session({ user: { username: 'Testuser' }, updatedAt: NOW - 500 });
        const frozen = buildFrozenItemKeys([capitalised], NOW, new Set());

        expect(frozen.has(frozenKey('testuser', IN_PROGRESS.libraryItemId))).toBe(true);
    });

    it('keeps a session with no updatedAt rather than treating it as ancient', () => {
        const noStamp = session({ updatedAt: undefined as unknown as number });
        expect(buildFrozenItemKeys([noStamp], NOW, new Set()).size).toBe(1);
    });
});

describe('computeNextCursor', () => {
    it('advances to the newest row seen', () => {
        const cursor = computeNextCursor([IN_PROGRESS, FINISHED], new Set());
        expect(cursor).toBe(new Date(FINISHED.lastUpdate).toISOString());
    });

    it('advances past rows the cursor already filtered out', () => {
        // The newest row may be one this cycle skipped; taking the max over
        // only the fresh subset would stall the cursor.
        const cursor = computeNextCursor([FINISHED], new Set());
        expect(cursor).toBe(new Date(FINISHED.lastUpdate).toISOString());
    });

    /**
     * The bug this exists to prevent: a frozen item contributes no progress
     * event this cycle, so if the cursor advanced past its `lastUpdate` we would
     * never look at it again. A listener who stops on their phone at the exact
     * moment we pull would have that final position skipped permanently — the
     * open session goes stale after the cap, we un-freeze, and by then the row
     * is older than the cursor and filtered out forever.
     */
    it('never advances past a frozen row, so its position is re-read next cycle', () => {
        const frozen = new Set([IN_PROGRESS.libraryItemId]);
        const cursor = computeNextCursor([IN_PROGRESS, FINISHED], frozen);

        expect(Date.parse(cursor!)).toBeLessThan(IN_PROGRESS.lastUpdate);
    });

    it('returns null when there is nothing to record', () => {
        expect(computeNextCursor([], new Set())).toBeNull();
    });

    it('returns null when every row is frozen and none predates them', () => {
        const frozen = new Set([IN_PROGRESS.libraryItemId]);
        expect(computeNextCursor([IN_PROGRESS], frozen)).toBeNull();
    });
});

describe('filterProgressByCursor', () => {
    it('drops rows older than the cursor', () => {
        const rows = [IN_PROGRESS, FINISHED];
        const cursor = new Date(FINISHED.lastUpdate).toISOString();

        const kept = filterProgressByCursor(rows, cursor);

        expect(kept).toEqual([FINISHED]);
    });

    /**
     * Boundary-inclusive on purpose. ABS can write several rows within the same
     * millisecond, so a strict `>` drops a row stamped exactly at the cursor
     * forever — and the cursor never advances past that value to unstick it.
     * Re-reading the boundary row is idempotent; losing it is not.
     */
    it('keeps a row stamped exactly at the cursor rather than losing it forever', () => {
        const cursor = new Date(IN_PROGRESS.lastUpdate).toISOString();

        const kept = filterProgressByCursor([IN_PROGRESS], cursor);

        expect(kept).toEqual([IN_PROGRESS]);
    });

    it('keeps everything when there is no cursor', () => {
        expect(filterProgressByCursor([IN_PROGRESS, FINISHED], undefined)).toHaveLength(2);
    });

    it('keeps everything when the cursor is unparseable rather than dropping the pull', () => {
        expect(filterProgressByCursor([IN_PROGRESS, FINISHED], 'not-a-date')).toHaveLength(2);
    });
});
