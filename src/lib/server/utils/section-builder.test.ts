// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    arbitrateWatching,
    buildMergedWatchingSection,
    buildRandomPicksSection,
    buildRecentlyAddedSection,
    markSuspiciousItems,
    transformFulfilledRequest,
    type ContinueWatchingItem,
    type FulfilledRequestItem,
    type LibraryMediaItem,
    type SuspicionWindow,
} from './section-builder.js';

// Defaults match src/lib/server/config.ts:
//   CONTINUE_WATCHING_SUBSTANTIAL_PERCENT = 20
//   CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEpisode(
    overrides: Partial<ContinueWatchingItem> & {
        id: string;
        seriesId: string;
        seasonNumber: number;
        episodeNumber: number;
    },
): ContinueWatchingItem {
    return {
        title: `S${overrides.seasonNumber}E${overrides.episodeNumber}`,
        mediaType: 'episode',
        watchProgress: 0,
        externalIds: { internal: overrides.id },
        seriesName: 'Test Series',
        ...overrides,
    };
}

function makeMovie(
    overrides: Partial<ContinueWatchingItem> & { id: string },
): ContinueWatchingItem {
    return {
        title: 'Test Movie',
        mediaType: 'movie',
        watchProgress: 50,
        externalIds: { internal: overrides.id },
        ...overrides,
    };
}

function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe('buildMergedWatchingSection (anchor rule)', () => {
    it('returns an empty-state section when both lists are empty and not loading', () => {
        // Changed in M1: the CW row is the primary row on the home page —
        // hiding it when empty creates a silent gap and drops a useful CTA.
        // The row now renders with meta.emptyState so the UI can offer a
        // "you're all caught up — browse trending" affordance.
        const section = buildMergedWatchingSection({ continueWatching: [], nextUp: [] }, false);
        expect(section).not.toBeNull();
        expect(section?.items).toHaveLength(0);
        expect(section?.meta?.emptyState).toBeDefined();
        // The server offers the library; the client upgrades to trending once it has items.
        expect(section?.meta?.emptyState?.linkHref).toBe('/browse');
    });

    it('returns a loading shell when both lists are empty but loading', () => {
        const section = buildMergedWatchingSection({ continueWatching: [], nextUp: [] }, true);
        expect(section).not.toBeNull();
        expect(section?.meta?.loading).toBe(true);
    });

    it('carries durable file availability through the merged card section', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [
                makeMovie({ id: 'movie-unavailable', hasFiles: false }),
                makeMovie({ id: 'movie-available', hasFiles: true }),
            ],
            nextUp: [],
        });

        const unavailable = section?.items.find(
            (item) => item.externalIds?.internal === 'movie-unavailable',
        );
        const available = section?.items.find(
            (item) => item.externalIds?.internal === 'movie-available',
        );
        expect(unavailable?.isAvailable).toBe(false);
        expect(available?.isAvailable).toBe(true);
    });

    it('CW-only series: CW item wins by default', () => {
        const cw = makeEpisode({
            id: 'ep-s2e5',
            seriesId: 'series-A',
            seasonNumber: 2,
            episodeNumber: 5,
            source: 'continue-watching',
            resumeRatio: 0.4,
            updatedAt: isoDaysAgo(1),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain(cw.id);
    });

    it('uses a playing label for live continue-watching overlays', () => {
        const cw = makeEpisode({
            id: 'ep-live',
            seriesId: 'series-live',
            seasonNumber: 3,
            episodeNumber: 8,
            source: 'continue-watching',
            resumeRatio: 0.03,
            updatedAt: isoDaysAgo(0),
            livePlaybackState: 'playing',
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [],
        });

        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].contextLabel).toBe('Playing now');
    });

    it('NU-only series: NU item wins when no CW exists', () => {
        const nu = makeEpisode({
            id: 'ep-s3e1',
            seriesId: 'series-B',
            seasonNumber: 3,
            episodeNumber: 1,
            source: 'next-up',
            updatedAt: isoDaysAgo(2),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [],
            nextUp: [nu],
        });
        expect(section?.items).toHaveLength(1);
        // Next Up cards no longer carry isNew=true (that was causing a
        // "New" badge to render on every CW row regardless of freshness).
        // The intent is now carried by contextLabel.
        expect(section?.items[0].isNew).toBe(false);
        expect(section?.items[0].contextLabel).toMatch(/^Next episode/);
        expect(section?.items[0].progress).toBeUndefined();
    });

    it('CW behind NU (backlog catch-up): CW wins', () => {
        // User stopped at S2E5 (in progress). Max completed is S2E4 so NU
        // returns S2E6. CW episode (5) < NU episode (6) → CW wins.
        const cw = makeEpisode({
            id: 'ep-s2e5',
            seriesId: 'series-C',
            seasonNumber: 2,
            episodeNumber: 5,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: isoDaysAgo(0),
        });
        const nu = makeEpisode({
            id: 'ep-s2e6',
            seriesId: 'series-C',
            seasonNumber: 2,
            episodeNumber: 6,
            source: 'next-up',
            updatedAt: isoDaysAgo(0),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [nu],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('ep-s2e5');
    });

    it('phantom scrub (CW ahead + low progress + stale): NU wins', () => {
        // User stopped at S7E24. A brief play on S8E14 left a low-progress
        // phantom CW. NU correctly points at S8E01. Phantom is old and thin
        // → NU should win.
        const cw = makeEpisode({
            id: 'ep-s8e14',
            seriesId: 'series-D',
            seasonNumber: 8,
            episodeNumber: 14,
            source: 'continue-watching',
            resumeRatio: 0.11, // past CW_MIN_PERCENT but below SUBSTANTIAL
            updatedAt: isoDaysAgo(10), // stale past 3-day window
        });
        const nu = makeEpisode({
            id: 'ep-s8e01',
            seriesId: 'series-D',
            seasonNumber: 8,
            episodeNumber: 1,
            source: 'next-up',
            updatedAt: isoDaysAgo(11),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [nu],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('ep-s8e01');
    });

    it('deliberate jump-ahead with substantial progress: CW wins', () => {
        // User jumped to S3E10 and genuinely watched 35% of it. Even though
        // CW is ahead of NU, substantial progress wins.
        const cw = makeEpisode({
            id: 'ep-s3e10',
            seriesId: 'series-E',
            seasonNumber: 3,
            episodeNumber: 10,
            source: 'continue-watching',
            resumeRatio: 0.35,
            updatedAt: isoDaysAgo(7), // stale but substantial
        });
        const nu = makeEpisode({
            id: 'ep-s1e06',
            seriesId: 'series-E',
            seasonNumber: 1,
            episodeNumber: 6,
            source: 'next-up',
            updatedAt: isoDaysAgo(8),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [nu],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('ep-s3e10');
    });

    it('fresh ahead-of-sequence CW (low progress but recent): CW wins', () => {
        // Brief play on S8E14 yesterday — staleness window not yet exceeded.
        // Treat as real intent (user might return today).
        const cw = makeEpisode({
            id: 'ep-s8e14',
            seriesId: 'series-F',
            seasonNumber: 8,
            episodeNumber: 14,
            source: 'continue-watching',
            resumeRatio: 0.12,
            updatedAt: isoDaysAgo(1), // fresh (< 3 days)
        });
        const nu = makeEpisode({
            id: 'ep-s8e01',
            seriesId: 'series-F',
            seasonNumber: 8,
            episodeNumber: 1,
            source: 'next-up',
            updatedAt: isoDaysAgo(2),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [nu],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('ep-s8e14');
    });

    it('two CW rows for same series: keeps the most recently updated', () => {
        const stale = makeEpisode({
            id: 'ep-s1e03',
            seriesId: 'series-G',
            seasonNumber: 1,
            episodeNumber: 3,
            source: 'continue-watching',
            resumeRatio: 0.5,
            updatedAt: isoDaysAgo(10),
        });
        const fresh = makeEpisode({
            id: 'ep-s1e04',
            seriesId: 'series-G',
            seasonNumber: 1,
            episodeNumber: 4,
            source: 'continue-watching',
            resumeRatio: 0.2,
            updatedAt: isoDaysAgo(1),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [stale, fresh],
            nextUp: [],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('ep-s1e04');
    });

    it('movies: always shown from CW (Next Up path does not apply)', () => {
        const movie = makeMovie({
            id: 'movie-1',
            source: 'continue-watching',
            resumeRatio: 0.4,
            updatedAt: isoDaysAgo(2),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [movie],
            nextUp: [],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('movie-1');
    });

    it('unknown CW timestamp: treated as fresh (CW wins over NU)', () => {
        // Edge case: CW item without updatedAt should not be silently
        // dropped as "stale" — unknown timestamp is not evidence of age.
        const cw = makeEpisode({
            id: 'ep-s8e14',
            seriesId: 'series-Q',
            seasonNumber: 8,
            episodeNumber: 14,
            source: 'continue-watching',
            resumeRatio: 0.12, // below substantial
            updatedAt: undefined, // no timestamp
        });
        const nu = makeEpisode({
            id: 'ep-s8e01',
            seriesId: 'series-Q',
            seasonNumber: 8,
            episodeNumber: 1,
            source: 'next-up',
            updatedAt: isoDaysAgo(2),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [nu],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].id).toContain('ep-s8e14');
    });

    it('ties in activity timestamp: deterministic order by id', () => {
        const a = makeEpisode({
            id: 'a-s1e1',
            seriesId: 'series-A',
            seasonNumber: 1,
            episodeNumber: 1,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: undefined,
        });
        const b = makeEpisode({
            id: 'b-s1e1',
            seriesId: 'series-B',
            seasonNumber: 1,
            episodeNumber: 1,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: undefined,
        });
        // Feed in two different orders; expect same output.
        const first = buildMergedWatchingSection({
            continueWatching: [b, a],
            nextUp: [],
        });
        const second = buildMergedWatchingSection({
            continueWatching: [a, b],
            nextUp: [],
        });
        expect(first?.items.map((i) => i.id)).toEqual(second?.items.map((i) => i.id));
    });

    it('propagates isSuspicious flag through the merged item', () => {
        // Upstream marker set by the watching API route — verifies the flag
        // survives the transform pipeline and lands on the UniversalMediaItem.
        const cw = makeEpisode({
            id: 'ep-sus',
            seriesId: 'series-SUS',
            seasonNumber: 1,
            episodeNumber: 2,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: isoDaysAgo(1),
            isSuspicious: true,
        });
        const section = buildMergedWatchingSection({
            continueWatching: [cw],
            nextUp: [],
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].isSuspicious).toBe(true);
    });

    it('orders merged output by most recent activity (freshest first)', () => {
        // Three distinct series: A fresh, B stale, C mid.
        const a = makeEpisode({
            id: 'a-s1e1',
            seriesId: 'series-A',
            seasonNumber: 1,
            episodeNumber: 1,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: isoDaysAgo(0),
        });
        const b = makeEpisode({
            id: 'b-s1e1',
            seriesId: 'series-B',
            seasonNumber: 1,
            episodeNumber: 1,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: isoDaysAgo(10),
        });
        const c = makeEpisode({
            id: 'c-s1e1',
            seriesId: 'series-C',
            seasonNumber: 1,
            episodeNumber: 1,
            source: 'continue-watching',
            resumeRatio: 0.3,
            updatedAt: isoDaysAgo(2),
        });
        const section = buildMergedWatchingSection({
            continueWatching: [b, c, a], // deliberately unsorted
            nextUp: [],
        });
        expect(section?.items).toHaveLength(3);
        // Expect order: A (0d) → C (2d) → B (10d)
        expect(section?.items[0].id).toContain('a-s1e1');
        expect(section?.items[1].id).toContain('c-s1e1');
        expect(section?.items[2].id).toContain('b-s1e1');
    });
});

describe('markSuspiciousItems', () => {
    const WINDOW_START = '2026-04-10T12:00:00.000Z';
    const WINDOW_END = '2026-04-10T12:00:10.000Z';
    const INSIDE = '2026-04-10T12:00:05.000Z';
    const BEFORE = '2026-04-10T11:59:55.000Z';
    const AFTER = '2026-04-10T12:00:15.000Z';

    function mkItem(id: string, updatedAt: string | undefined): ContinueWatchingItem {
        return {
            id,
            title: id,
            mediaType: 'episode',
            watchProgress: 0,
            externalIds: { internal: id },
            updatedAt,
        };
    }

    const windows: SuspicionWindow[] = [{ window_start: WINDOW_START, window_end: WINDOW_END }];

    it('flags items whose updatedAt falls inside a window', () => {
        const items = [mkItem('inside', INSIDE)];
        const out = markSuspiciousItems(items, windows);
        expect(out[0].isSuspicious).toBe(true);
    });

    it('leaves items outside all windows unflagged', () => {
        const items = [mkItem('before', BEFORE), mkItem('after', AFTER)];
        const out = markSuspiciousItems(items, windows);
        expect(out[0].isSuspicious).toBeUndefined();
        expect(out[1].isSuspicious).toBeUndefined();
    });

    it('treats the window range as inclusive on both ends', () => {
        const items = [mkItem('start', WINDOW_START), mkItem('end', WINDOW_END)];
        const out = markSuspiciousItems(items, windows);
        expect(out[0].isSuspicious).toBe(true);
        expect(out[1].isSuspicious).toBe(true);
    });

    it('leaves items without updatedAt unflagged (no evidence)', () => {
        const items = [mkItem('no-ts', undefined)];
        const out = markSuspiciousItems(items, windows);
        expect(out[0].isSuspicious).toBeUndefined();
    });

    it('returns the input array unchanged when no windows are given', () => {
        const items = [mkItem('a', INSIDE)];
        const out = markSuspiciousItems(items, []);
        // Same reference signals "fast-path, no allocation" — callers that
        // want to detect "did anything change" can trust identity.
        expect(out).toBe(items);
    });

    it('ignores malformed window timestamps', () => {
        const items = [mkItem('a', INSIDE)];
        const bad: SuspicionWindow[] = [{ window_start: 'not-a-date', window_end: 'also-bad' }];
        const out = markSuspiciousItems(items, bad);
        expect(out[0].isSuspicious).toBeUndefined();
    });

    it('does not mutate its input items', () => {
        const item = mkItem('inside', INSIDE);
        markSuspiciousItems([item], windows);
        expect(item.isSuspicious).toBeUndefined();
    });

    it('vetoes suspicion for lumastra-player / lumastra-user-mark sources', () => {
        // Edge case from the edge-case reviewer: the bulk-mark time window
        // might legitimately contain a user's real lumastra-player progress
        // event — flagging it as suspicious would punish real activity.
        // When last_event_source is a trusted user-driven source, skip the
        // window check entirely.
        const player: ContinueWatchingItem = {
            ...mkItem('player', INSIDE),
            lastEventSource: 'lumastra-player',
        };
        const mark: ContinueWatchingItem = {
            ...mkItem('mark', INSIDE),
            lastEventSource: 'lumastra-user-mark',
        };
        const jf: ContinueWatchingItem = {
            ...mkItem('jellyfin', INSIDE),
            lastEventSource: 'jellyfin-sync',
        };
        const out = markSuspiciousItems([player, mark, jf], windows);
        expect(out[0].isSuspicious).toBeUndefined();
        expect(out[1].isSuspicious).toBeUndefined();
        expect(out[2].isSuspicious).toBe(true);
    });
});

describe('transformFulfilledRequest (availability guard)', () => {
    const base: Omit<FulfilledRequestItem, 'isAvailable'> = {
        externalIds: { tmdb: '121034', internal: 'file-row-uuid' },
        mediaType: 'movie',
        title: 'Obersalzberg',
    };

    it('marks the card available when a playable (has_files) row resolved', () => {
        const item = transformFulfilledRequest({ ...base, isAvailable: true });
        expect(item.isAvailable).toBe(true);
        expect(item.hasFiles).toBe(true);
    });

    // Regression: a fulfilled Jellyseerr request whose only catalog match is a
    // file-less discovery row used to be hardcoded isAvailable:true, so the card
    // claimed "ready" and 404'd on click/play. The card must reflect reality.
    it('does NOT claim availability when no playable row resolved (prevents 404)', () => {
        const item = transformFulfilledRequest({ ...base, isAvailable: false });
        expect(item.isAvailable).toBe(false);
        expect(item.hasFiles).toBe(false);
    });
});

describe('library rails (recently-added / random-picks) media-type narrowing', () => {
    function libRow(id: string, media_type: string): LibraryMediaItem {
        return { id, title: `title-${id}`, media_type, year: 2026, overview: null };
    }

    it('emits the public discriminator, never the stored tv token', () => {
        const section = buildRecentlyAddedSection([libRow('m', 'movie'), libRow('s', 'tv')]);
        expect(section?.items.map((i) => i.mediaType)).toEqual(['movie', 'series']);
    });

    // Regression: these rails are library-WIDE, so an album/track/audiobook row
    // genuinely arrives. The old `isMovie(x) ? 'movie' : 'tv'` was a binary
    // fallback that labelled every one of them a series — a card that opened the
    // series modal on an album. Narrowing now drops what has no card instead.
    it('drops rows the client has no card for rather than calling them series', () => {
        const section = buildRecentlyAddedSection([
            libRow('m', 'movie'),
            libRow('a', 'album'),
            libRow('b', 'audiobook'),
            libRow('h', 'home_video'),
        ]);
        // album and audiobook carry their OWN card type (the old code called
        // both 'tv'); home_video has no UniversalMediaType member, so it drops.
        expect(section?.items.map((i) => i.id)).toEqual(['m', 'a', 'b']);
        expect(section?.items.map((i) => i.mediaType)).toEqual(['movie', 'album', 'audiobook']);
    });

    // The builders used to guard `items.length === 0` on the INPUT. Once
    // narrowing can drop rows, that guard would ship a rail with zero cards.
    it('returns null when every row was dropped, instead of an empty rail', () => {
        expect(buildRecentlyAddedSection([libRow('h', 'home_video')])).toBeNull();
        expect(buildRandomPicksSection([libRow('x', 'not-a-media-type')])).toBeNull();
    });

    it('still returns null for an empty input', () => {
        expect(buildRecentlyAddedSection([])).toBeNull();
        expect(buildRandomPicksSection([])).toBeNull();
    });

    it('applies the same narrowing to random-picks', () => {
        const section = buildRandomPicksSection([libRow('s', 'tv'), libRow('t', 'track')]);
        expect(section?.items.map((i) => i.mediaType)).toEqual(['series', 'track']);
    });
});

describe('arbitrateWatching', () => {
    it('returns one anchor per series (CW+NU for the same series collapse to one)', () => {
        const cw = [
            {
                id: 'ep1',
                mediaType: 'episode',
                title: 'S1E1',
                seriesId: 's1',
                watchProgress: 30,
                resumeRatio: 0.3,
                updatedAt: '2026-07-20T00:00:00Z',
                externalIds: { internal: 'ep1' },
            },
        ];
        const nu = [
            {
                id: 'ep2',
                mediaType: 'episode',
                title: 'S1E2',
                seriesId: 's1',
                watchProgress: 0,
                updatedAt: '2026-07-21T00:00:00Z',
                externalIds: { internal: 'ep2' },
            },
        ];
        const anchors = arbitrateWatching({ continueWatching: cw as never, nextUp: nu as never });
        expect(anchors).toHaveLength(1); // one card for series s1
        expect(anchors[0].origin === 'cw' || anchors[0].origin === 'nextup').toBe(true);
    });

    it('orders distinct series freshest-first by activity', () => {
        const cw = [
            {
                id: 'a',
                mediaType: 'movie',
                title: 'A',
                watchProgress: 50,
                resumeRatio: 0.5,
                updatedAt: '2026-07-20T00:00:00Z',
                externalIds: { internal: 'a' },
            },
            {
                id: 'b',
                mediaType: 'movie',
                title: 'B',
                watchProgress: 50,
                resumeRatio: 0.5,
                updatedAt: '2026-07-22T00:00:00Z',
                externalIds: { internal: 'b' },
            },
        ];
        const anchors = arbitrateWatching({ continueWatching: cw as never, nextUp: [] });
        expect(anchors.map((x) => x.item.id)).toEqual(['b', 'a']);
    });
});
