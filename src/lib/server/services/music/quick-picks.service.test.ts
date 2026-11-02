// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
// normalizeTitle is now the shared module — import and test from its canonical location
import { normalizeTitle } from '$lib/server/database/queries/music-title-normalize.js';

// Mock the queries module BEFORE importing quick-picks.service.js so the
// service's own import of these functions resolves to the mocks below.
// Only the three functions exercised by computeFreshNewDiscovery's no-cluster
// fallback are stubbed; nothing else in this test file drives a code path
// that touches the other exports, so they're simply omitted rather than
// re-exporting `actual` (which would need a real `sql` to be safe to call).
vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getTasteSimilarTracks: vi.fn(),
    getNeverPlayedTracksNearCentroid: vi.fn(),
    getTopPlayedEmbeddings: vi.fn(),
}));

import {
    interleaveAndDedup,
    applyArtistDiversityGuard,
    applyGlobalArtistCap,
    allocateClusterSlots,
    getScaledBucketTargets,
    getDiversityCaps,
    filterConfiguredDurations,
    computeFreshNewDiscovery,
    type TaggedTrack,
} from './quick-picks.service.js';
import {
    getTasteSimilarTracks,
    getNeverPlayedTracksNearCentroid,
    getTopPlayedEmbeddings,
} from '$lib/server/database/queries/music-quick-picks.queries.js';

function track(
    id: string,
    bucket: string,
    artistId = 'artist-1',
    opts?: { title?: string; albumId?: string; artistTitle?: string },
): TaggedTrack {
    return {
        id,
        title: opts?.title ?? `Track ${id}`,
        sort_order: null,
        runtime_seconds: null,
        custom_poster_url: null,
        custom_metadata: {},
        album_id: opts?.albumId ?? `album-${id}`,
        album_title: 'Album',
        album_custom_poster_url: null,
        artist_id: artistId,
        // Derive a unique artist_title from artistId so effectiveArtistKey
        // (which prefers artist_title) treats different artist IDs as
        // distinct artists. Tests that need a shared artist override via
        // opts.artistTitle.
        artist_title: opts?.artistTitle ?? `Artist ${artistId}`,
        last_played_at: '2026-01-01',
        hours_since_played: null,
        file_path: null,
        bucket: bucket as TaggedTrack['bucket'],
    };
}

describe('normalizeTitle (shared three-pass module)', () => {
    it('strips bracket-wrapped remix/edit suffixes', () => {
        expect(normalizeTitle('Edge of Harbor (Club Mix)')).toBe(
            normalizeTitle('Edge of Harbor (Radio Edit)'),
        );
    });

    it('strips bracket-wrapped extended/remaster suffixes', () => {
        expect(normalizeTitle('My Song (Extended Version)')).toBe(
            normalizeTitle('My Song (Remaster)'),
        );
    });

    it('keeps distinct base titles separate', () => {
        expect(normalizeTitle('Edge of Harbor')).not.toBe(normalizeTitle('Stairway to Heaven'));
    });

    it('strips dash-separated remix suffixes', () => {
        expect(normalizeTitle('Rockstar - Radio Edit')).toBe(normalizeTitle('Rockstar'));
    });

    it('strips feature credits in brackets', () => {
        expect(normalizeTitle('My Song (feat. Artist)')).toBe(normalizeTitle('My Song'));
    });

    // These are the bare-suffix cases the OLD local normalizeTitle missed:
    it('strips bare un-bracketed remaster suffix (was missed by old local impl)', () => {
        expect(normalizeTitle('Song Remastered')).toBe(normalizeTitle('Song'));
    });

    it('strips bare un-bracketed club mix suffix (was missed by old local impl)', () => {
        expect(normalizeTitle('Rockstar Club Mix')).toBe(normalizeTitle('Rockstar'));
    });

    it('strips bare remix suffix', () => {
        expect(normalizeTitle('Track Remix')).toBe(normalizeTitle('Track'));
    });

    it('does not strip mid-title remix keywords', () => {
        // "Live Wire" should not be normalised to just "Live" —
        // BARE_REMIX_SUFFIX_REGEX is end-anchored and keyword-matched.
        const base = normalizeTitle('Live Wire');
        expect(base).toBe('live wire');
    });
});

describe('interleaveAndDedup', () => {
    it('interleaves tracks from multiple buckets', () => {
        const pools = {
            'heavy-rotation': [
                track('a1', 'heavy-rotation', 'art-1'),
                track('a2', 'heavy-rotation', 'art-2'),
            ],
            'recently-heard': [
                track('b1', 'recently-heard', 'art-3'),
                track('b2', 'recently-heard', 'art-4'),
            ],
            random: [track('c1', 'random', 'art-5')],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result.map((t) => t.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
    });

    it('deduplicates tracks by ID across buckets', () => {
        const pools = {
            'heavy-rotation': [track('same', 'heavy-rotation', 'art-1')],
            'recently-heard': [track('same', 'recently-heard', 'art-1')],
            random: [track('other', 'random', 'art-2')],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('same');
        expect(result[0].bucket).toBe('heavy-rotation');
    });

    it('deduplicates remixes by normalized title', () => {
        const pools = {
            'heavy-rotation': [
                track('t1', 'heavy-rotation', 'art-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            'recently-heard': [
                track('t2', 'recently-heard', 'art-2', {
                    title: 'Edge of Harbor (Radio Edit)',
                }),
            ],
            random: [track('t3', 'random', 'art-3', { title: 'Other Song' })],
        };
        const result = interleaveAndDedup(pools, 5);
        // Only one "Edge of Harbor" variant should appear
        const edgeTracks = result.filter((t) => t.title.startsWith('Edge of Harbor'));
        expect(edgeTracks).toHaveLength(1);
    });

    it('caps tracks per artist at 2', () => {
        const pools = {
            'heavy-rotation': [
                track('a1', 'heavy-rotation', 'same-artist', {
                    albumId: 'alb-1',
                }),
                track('a2', 'heavy-rotation', 'same-artist', {
                    albumId: 'alb-2',
                }),
                track('a3', 'heavy-rotation', 'same-artist', {
                    albumId: 'alb-3',
                }),
            ],
            random: [track('b1', 'random', 'other-artist')],
        };
        const result = interleaveAndDedup(pools, 10);
        const sameArtist = result.filter((t) => t.artist_id === 'same-artist');
        expect(sameArtist).toHaveLength(2);
    });

    it('caps tracks per album at 1', () => {
        const pools = {
            'heavy-rotation': [
                track('a1', 'heavy-rotation', 'art-1', {
                    albumId: 'same-album',
                }),
                track('a2', 'heavy-rotation', 'art-2', {
                    albumId: 'same-album',
                }),
            ],
            random: [track('b1', 'random', 'art-3', { albumId: 'other-album' })],
        };
        const result = interleaveAndDedup(pools, 10);
        const sameAlbum = result.filter((t) => t.album_id === 'same-album');
        expect(sameAlbum).toHaveLength(1);
    });

    it('respects target count', () => {
        const pools = {
            'heavy-rotation': Array.from({ length: 10 }, (_, i) =>
                track(`a${i}`, 'heavy-rotation', `artist-${i}`),
            ),
            random: Array.from({ length: 10 }, (_, i) =>
                track(`b${i}`, 'random', `artist-${i + 10}`),
            ),
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(5);
    });

    it('returns empty array when all pools are empty', () => {
        const result = interleaveAndDedup({}, 20);
        expect(result).toEqual([]);
    });

    it('exempts "Various Artists" tracks from the per-artist cap', () => {
        // 5 tracks from different VA compilation albums — each track is by a
        // different real artist but they all share artist_id (the synthetic
        // VA artist UUID). Without VA-aware keying only 2 would survive.
        const va = 'va-artist-uuid';
        const pools = {
            'heavy-rotation': [
                track('v1', 'heavy-rotation', va, {
                    albumId: 'comp-1',
                    artistTitle: 'Various Artists',
                }),
                track('v2', 'heavy-rotation', va, {
                    albumId: 'comp-2',
                    artistTitle: 'Various Artists',
                }),
                track('v3', 'heavy-rotation', va, {
                    albumId: 'comp-3',
                    artistTitle: 'Various Artists',
                }),
                track('v4', 'heavy-rotation', va, {
                    albumId: 'comp-4',
                    artistTitle: 'Various Artists',
                }),
                track('v5', 'heavy-rotation', va, {
                    albumId: 'comp-5',
                    artistTitle: 'Various Artists',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(5);
        expect(result.map((t) => t.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    });

    it('still enforces the per-album cap on VA tracks from the same compilation', () => {
        // VA artist exemption must NOT bypass the album cap — otherwise one
        // hot compilation could flood the carousel.
        const va = 'va-artist-uuid';
        const pools = {
            'heavy-rotation': [
                track('v1', 'heavy-rotation', va, {
                    albumId: 'same-comp',
                    artistTitle: 'Various Artists',
                }),
                track('v2', 'heavy-rotation', va, {
                    albumId: 'same-comp',
                    artistTitle: 'Various Artists',
                }),
                track('v3', 'heavy-rotation', va, {
                    albumId: 'same-comp',
                    artistTitle: 'Various Artists',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        // maxPerAlbum default is 1 — only the first VA track survives.
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('v1');
    });

    it('suppresses tracks whose normalised title matches a played stem (cross-session cooldown)', () => {
        // "Song (Club Mix)" normalises to "song" via the shared three-pass normalizeTitle.
        // If "song" is in the playedTitleStems set, neither "Song (Club Mix)" nor
        // "Song (Radio Edit)" should appear in the carousel.
        const pools = {
            'heavy-rotation': [
                track('t1', 'heavy-rotation', 'art-1', { title: 'Song (Club Mix)' }),
                track('t2', 'heavy-rotation', 'art-2', { title: 'Other Track' }),
            ],
            'recently-heard': [
                track('t3', 'recently-heard', 'art-3', { title: 'Song (Radio Edit)' }),
            ],
        };
        // "song" is the shared-normalizeTitle output for both remix variants.
        const result = interleaveAndDedup(pools, 5, {
            playedTitleStems: new Set(['song']),
        });
        expect(result.some((t) => t.id === 't1')).toBe(false);
        expect(result.some((t) => t.id === 't3')).toBe(false);
        // Other Track is unaffected.
        expect(result.some((t) => t.id === 't2')).toBe(true);
    });

    it('places sonic-discovery tracks in correct BUCKET_ORDER position (after new-discovery)', () => {
        const pools = {
            'new-discovery': [track('nd1', 'new-discovery', 'art-1')],
            'sonic-discovery': [track('sd1', 'sonic-discovery', 'art-2')],
            'highly-rated': [track('hr1', 'highly-rated', 'art-3')],
        };
        // BUCKET_ORDER: ...new-discovery, sonic-discovery, highly-rated...
        const result = interleaveAndDedup(pools, 3);
        expect(result.map((t) => t.id)).toEqual(['nd1', 'sd1', 'hr1']);
    });

    it('places popular-hits tracks in correct BUCKET_ORDER position (right after hot-this-week)', () => {
        const pools = {
            'hot-this-week': [track('hw1', 'hot-this-week', 'art-1')],
            'popular-hits': [track('ph1', 'popular-hits', 'art-2')],
            'sonic-taste': [track('st1', 'sonic-taste', 'art-3')],
        };
        // BUCKET_ORDER: ...hot-this-week, popular-hits, sonic-taste...
        const result = interleaveAndDedup(pools, 3);
        expect(result.map((t) => t.id)).toEqual(['hw1', 'ph1', 'st1']);
    });

    it('does NOT swap a version-tagged pick from forgotten-favourites (user-behavior bucket)', () => {
        const pools = {
            // 'forgotten-favourites' reflects actual listening history — the
            // remix stays even when an untagged original from a LATER
            // discovery bucket (co-album, which follows forgotten-favourites
            // in BUCKET_ORDER) shows up.
            'forgotten-favourites': [
                track('remix1', 'forgotten-favourites', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            'co-album': [
                track('orig1', 'co-album', 'artist-1', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('remix1');
        expect(result[0].bucket).toBe('forgotten-favourites');
    });

    it('swaps a version-tagged pick from popular-hits (discovery bucket) for a later same-artist original', () => {
        const pools = {
            // 'popular-hits' is a discovery bucket (not in USER_BEHAVIOR_BUCKETS)
            // — its remix pick is swappable for a same-artist original.
            'popular-hits': [
                track('remix1', 'popular-hits', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            'new-discovery': [
                track('orig1', 'new-discovery', 'artist-1', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('orig1');
        expect(result[0].bucket).toBe('new-discovery');
    });

    it('swaps a version-tagged pick from a discovery bucket for a later same-artist original', () => {
        const pools = {
            // 'taste-similar' is a discovery bucket — its remix pick is swappable.
            'taste-similar': [
                track('remix1', 'taste-similar', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            // 'new-discovery' runs after 'taste-similar' in BUCKET_ORDER, so its
            // untagged same-artist candidate is considered on the next round.
            'new-discovery': [
                track('orig1', 'new-discovery', 'artist-1', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(1);
        // The original replaced the remix IN PLACE at the same result index.
        expect(result[0].id).toBe('orig1');
        expect(result[0].bucket).toBe('new-discovery');
    });

    it('does NOT swap a version-tagged pick from a user-behavior bucket', () => {
        const pools = {
            // 'heavy-rotation' is a user-behavior bucket — reflects actual
            // listening, so the remix stays even when an original shows up later.
            'heavy-rotation': [
                track('remix1', 'heavy-rotation', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            'new-discovery': [
                track('orig1', 'new-discovery', 'artist-1', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('remix1');
        expect(result[0].bucket).toBe('heavy-rotation');
    });

    it('does NOT swap when the later original is from a different artist', () => {
        const pools = {
            'taste-similar': [
                track('remix1', 'taste-similar', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            'new-discovery': [
                track('orig1', 'new-discovery', 'artist-2', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5);
        // Different-artist collision: dropped, not swapped — the remix stays
        // and the different-artist "original" never appears.
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('remix1');
    });

    it('swaps into an already-full carousel: a later same-artist original replaces a discovery-bucket remix even after target count is reached', () => {
        // targetCount=1 means 'taste-similar' fills the list on the very
        // first candidate — the normal round-robin fill loop's inner break
        // (`result.length >= targetCount`) means 'new-discovery' (which
        // comes later in BUCKET_ORDER) is NEVER visited by the fill pass.
        // Only the post-fill swap-only pass can find and apply this swap.
        const pools = {
            'taste-similar': [
                track('remix1', 'taste-similar', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                }),
            ],
            'new-discovery': [
                track('orig1', 'new-discovery', 'artist-1', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 1);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('orig1');
        expect(result[0].bucket).toBe('new-discovery');
    });

    it('does not swap when the incoming original album is already at cap (A4)', () => {
        // 'blocker' already occupies the only album-cap-1 slot for
        // 'album-orig1'. The original candidate belongs to that same album,
        // so swapping the remix out would push 'album-orig1' over its cap —
        // the swap must be rejected and the remix stays.
        const pools = {
            'heavy-rotation': [
                // user-behavior bucket track to occupy the album slot without
                // itself being swap-eligible.
                track('blocker', 'heavy-rotation', 'other-artist', {
                    title: 'Unrelated Song',
                    albumId: 'album-orig1',
                }),
            ],
            'taste-similar': [
                track('remix1', 'taste-similar', 'artist-1', {
                    title: 'Edge of Harbor (Club Mix)',
                    albumId: 'album-remix1',
                }),
            ],
            'new-discovery': [
                track('orig1', 'new-discovery', 'artist-1', {
                    title: 'Edge of Harbor',
                    albumId: 'album-orig1',
                }),
            ],
        };
        const result = interleaveAndDedup(pools, 5, { maxPerAlbum: 1 });
        expect(result.some((t) => t.id === 'remix1')).toBe(true);
        expect(result.some((t) => t.id === 'orig1')).toBe(false);
    });

    it('relaxes diversity caps only modestly (v3: bounded relax, not full)', () => {
        // v3 tightens the relaxation so one artist can never saturate the
        // carousel. Relaxed artist cap is MAX_PER_ARTIST+1=3, relaxed album
        // cap is MAX_PER_ALBUM+1=2.
        const pools = {
            'heavy-rotation': Array.from({ length: 6 }, (_, i) =>
                track(`a${i}`, 'heavy-rotation', 'same-artist', {
                    albumId: `album-${i}`,
                }),
            ),
        };

        const strict = interleaveAndDedup(pools, 6, {
            maxPerArtist: 2,
            maxPerAlbum: 1,
        });
        const relaxed = interleaveAndDedup(pools, 6, {
            maxPerArtist: 2,
            maxPerAlbum: 1,
            relaxCapsOnShortfall: true,
        });

        expect(strict).toHaveLength(2);
        // With 6 tracks all sharing `same-artist`, the relaxed cap (3) stops
        // the run at 3 — not 6. This is the correctness fix.
        expect(relaxed).toHaveLength(3);
    });
});

describe('getScaledBucketTargets', () => {
    it('scales the v3.5 base-26 mix composition up to larger requests', () => {
        // v3.5 base (26 total): heavy-rot=3, recently=0 (retired), hot-week=2,
        // popular-hits=3, sonic-taste=3, taste-similar=2, new-discovery=3,
        // sonic-discovery=2, highly=2, forgotten-favourites=2, loved-alb=2,
        // co-album=2 → sum=26.
        const result = getScaledBucketTargets(48);
        expect(Object.values(result).reduce((sum, count) => sum + count, 0)).toBe(48);
        // Heavy-rotation weight 3/26 * 48 = 5.54 -> 5.
        expect(result['heavy-rotation']).toBe(5);
        // sonic-taste weight 3/26 * 48 = 5.54 -> 5.
        expect(result['sonic-taste']).toBe(5);
        // popular-hits weight 3/26 * 48 = 5.54 -> 5.
        expect(result['popular-hits']).toBe(5);
        // sonic-discovery weight 2/26 * 48 = 3.69 -> 3, +1 from remainder drift = 4.
        expect(result['sonic-discovery']).toBe(4);
        // v3 retired `random` and `deep-cuts`; v3.5 retires `recently-heard` —
        // always 0 for experienced users.
        expect(result.random).toBe(0);
        expect(result['deep-cuts']).toBe(0);
        expect(result['recently-heard']).toBe(0);
        expect(result['unplayed-from-loved-albums']).toBeGreaterThan(0);
        expect(result['co-album']).toBeGreaterThan(0);
        expect(result['forgotten-favourites']).toBeGreaterThan(0);
    });

    it('sonic-taste and sonic-discovery are additive (each has its own slot at default size)', () => {
        const result = getScaledBucketTargets(26);
        // Both buckets have non-zero weight in the base config.
        expect(result['sonic-taste']).toBeGreaterThan(0);
        expect(result['sonic-discovery']).toBeGreaterThan(0);
        // taste-similar still has a slot (reduced from 3 to 2, but non-zero).
        expect(result['taste-similar']).toBeGreaterThan(0);
    });

    it('always returns the requested total for uneven counts', () => {
        const result = getScaledBucketTargets(48);
        expect(Object.values(result).reduce((sum, count) => sum + count, 0)).toBe(48);
    });

    it('never resurrects retired buckets via drift redistribution', () => {
        const result = getScaledBucketTargets(26);
        expect(result.random).toBe(0);
        expect(result['deep-cuts']).toBe(0);
    });

    it('never resurrects recently-heard via drift redistribution', () => {
        // recently-heard was retired in v3.5 (moved its weight to popular-hits).
        // Drift redistribution must skip zero-base-weight buckets, so
        // recently-heard should stay at 0 regardless of the requested total.
        const result = getScaledBucketTargets(26);
        expect(result['recently-heard']).toBe(0);
        const resultLarge = getScaledBucketTargets(100);
        expect(resultLarge['recently-heard']).toBe(0);
    });

    it('gives popular-hits and forgotten-favourites proportional slots', () => {
        const result = getScaledBucketTargets(26);
        expect(result['popular-hits']).toBeGreaterThan(0);
        expect(result['forgotten-favourites']).toBeGreaterThan(0);
    });

    it('returns the exact total for a request matching the base count', () => {
        const result = getScaledBucketTargets(26);
        expect(Object.values(result).reduce((sum, count) => sum + count, 0)).toBe(26);
    });
});

describe('applyGlobalArtistCap', () => {
    it('preserves order and total count when under cap', () => {
        const tracks = [
            track('a', 'heavy-rotation', 'artist-1'),
            track('b', 'taste-similar', 'artist-2'),
            track('c', 'highly-rated', 'artist-3'),
        ];
        const result = applyGlobalArtistCap(tracks, 2);
        expect(result).toHaveLength(3);
        expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('pushes overflow tracks from the same artist to the tail', () => {
        // Five tracks from one synthetic artist spread across buckets.
        // With cap=2 the 3rd/4th/5th should land at end.
        const tracks = [
            track('m1', 'heavy-rotation', 'artist-1'),
            track('other', 'taste-similar', 'artist-2'),
            track('m2', 'taste-similar', 'artist-1'),
            track('m3', 'heavy-rotation', 'artist-1'),
            track('m4', 'taste-similar', 'artist-1'),
            track('m5', 'co-album', 'artist-1'),
        ];
        const result = applyGlobalArtistCap(tracks, 2);
        // First 3 (visible in carousel) must contain at most 2 dj-maralon.
        const firstThree = result.slice(0, 3);
        const djInFirstThree = firstThree.filter((t) => t.artist_id === 'artist-1').length;
        expect(djInFirstThree).toBeLessThanOrEqual(2);
        // Tail contains the overflow.
        expect(result[result.length - 1].artist_id).toBe('artist-1');
        expect(result).toHaveLength(tracks.length);
    });

    it('buckets empty/missing artist_id under a synthetic key and still caps', () => {
        // Pre-F8 these were waived from capping; now they share an "unknown"
        // key so one row per "no artist" signal doesn't saturate the list.
        const tracks: TaggedTrack[] = [
            { ...track('a', 'random', 'x'), id: 'a', artist_id: '' },
            { ...track('b', 'random', 'x'), id: 'b', artist_id: '' },
            { ...track('c', 'random', 'x'), id: 'c', artist_id: '' },
            { ...track('d', 'random', 'x'), id: 'd', artist_id: '' },
        ];
        const result = applyGlobalArtistCap(tracks, 2);
        // Total preserved (overflow goes to tail, never dropped).
        expect(result).toHaveLength(4);
        // Visible carousel prefix should respect the cap.
        expect(result.slice(0, 2).map((t) => t.id)).toEqual(['a', 'b']);
        expect(result.slice(2).map((t) => t.id)).toEqual(['c', 'd']);
    });

    it('does NOT cap "Various Artists" tracks together — each gets its own key', () => {
        // Compilation albums collapse every track to one artist_id (the
        // synthetic VA artist UUID). Without VA-specific keying this
        // suppresses VA tracks after 2 even though the underlying real
        // artists are different. Each VA track must be its own partition.
        const va = 'va-artist-uuid';
        const tracks: TaggedTrack[] = [
            track('v1', 'heavy-rotation', va, {
                artistTitle: 'Various Artists',
            }),
            track('v2', 'taste-similar', va, {
                artistTitle: 'Various Artists',
            }),
            track('v3', 'hot-this-week', va, {
                artistTitle: 'Various Artists',
            }),
            track('v4', 'highly-rated', va, { artistTitle: 'Various Artists' }),
            track('v5', 'co-album', va, { artistTitle: 'Various Artists' }),
        ];
        const result = applyGlobalArtistCap(tracks, 2);
        // All 5 must stay in the visible (non-overflow) prefix.
        expect(result.map((t) => t.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    });

    it('matches "VA" alias the same as the canonical "Various Artists"', () => {
        const va = 'va-artist-uuid';
        const tracks: TaggedTrack[] = [
            track('a', 'heavy-rotation', va, { artistTitle: 'VA' }),
            track('b', 'taste-similar', va, { artistTitle: 'V.A.' }),
            track('c', 'hot-this-week', va, { artistTitle: 'Various' }),
        ];
        const result = applyGlobalArtistCap(tracks, 2);
        // None pushed to overflow.
        expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });
});

describe('allocateClusterSlots', () => {
    it('allocates zero when no slots requested', () => {
        expect(allocateClusterSlots([10, 5, 3], 0)).toEqual([0, 0, 0]);
    });

    it('allocates zero when all clusters are empty', () => {
        expect(allocateClusterSlots([0, 0, 0], 5)).toEqual([0, 0, 0]);
    });

    it('sums to the requested slot count exactly', () => {
        expect(allocateClusterSlots([10, 5, 3], 6).reduce((s, n) => s + n, 0)).toBe(6);
        expect(allocateClusterSlots([28, 14, 8], 3).reduce((s, n) => s + n, 0)).toBe(3);
    });

    it('gives the largest cluster the most slots (proportional)', () => {
        const result = allocateClusterSlots([28, 14, 8], 5);
        expect(result[0]).toBeGreaterThanOrEqual(result[1]);
        expect(result[1]).toBeGreaterThanOrEqual(result[2]);
    });

    it('respects largest-remainder so rounding is balanced', () => {
        // Sizes [5, 5, 5] and 4 slots: one cluster must get 2, others 1.
        const result = allocateClusterSlots([5, 5, 5], 4);
        expect(result.reduce((s, n) => s + n, 0)).toBe(4);
        expect(Math.max(...result)).toBe(2);
        expect(Math.min(...result)).toBe(1);
    });
});

describe('getDiversityCaps', () => {
    it('keeps the original caps for the base 20-track mix', () => {
        expect(getDiversityCaps(20)).toEqual({
            maxPerArtist: 2,
            maxPerAlbum: 1,
        });
    });

    it('raises caps for larger Quick Picks requests', () => {
        expect(getDiversityCaps(48)).toEqual({
            maxPerArtist: 4,
            maxPerAlbum: 2,
        });
    });

    it('derived relaxed caps (maxPerArtist/Album + 1) stay ABOVE the strict scaled caps at targetCount 48 — regression for the flat RELAXED_MAX_PER_ARTIST(3) constant being below a scaled maxPerArtist of 4', () => {
        // getQuickPicks used to pass the module-level RELAXED_MAX_PER_ARTIST
        // (a flat 3) as the relax-on-shortfall cap regardless of targetCount.
        // At targetCount=48 the STRICT scaled cap is already 4, so the
        // "relax" pass gave zero extra headroom exactly when large requests
        // needed it most. The fix derives the relaxed caps from the scaled
        // strict caps (+1) at the call site instead.
        const caps = getDiversityCaps(48);
        const relaxedMaxPerArtist = caps.maxPerArtist + 1;
        const relaxedMaxPerAlbum = caps.maxPerAlbum + 1;
        expect(relaxedMaxPerArtist).toBeGreaterThan(caps.maxPerArtist);
        expect(relaxedMaxPerAlbum).toBeGreaterThan(caps.maxPerAlbum);

        // Exercise the actual interleave behavior with the derived values: a
        // single dominant artist supplying far more than targetCount tracks
        // should be allowed up to relaxedMaxPerArtist (5) on shortfall, not
        // capped at the old flat constant (3).
        const pools = {
            'heavy-rotation': Array.from({ length: 48 }, (_, i) =>
                track(`a${i}`, 'heavy-rotation', 'same-artist', { albumId: `album-${i}` }),
            ),
        };
        const relaxed = interleaveAndDedup(pools, 48, {
            ...caps,
            relaxCapsOnShortfall: true,
            relaxedMaxPerArtist,
            relaxedMaxPerAlbum,
        });
        expect(relaxed).toHaveLength(relaxedMaxPerArtist);
    });
});

describe('filterConfiguredDurations pool-assembly ordering (must run BEFORE interleaveAndDedup)', () => {
    it('demonstrates the shortfall bug when duration filtering is deferred until after interleave, and the fix of filtering the pool first', () => {
        // Three same-artist candidates: one is outside the configured
        // autoplay duration window, two are valid. maxPerArtist=2 means the
        // artist cap can only ever admit 2 of the 3 into the carousel.
        const outOfWindow = track('short', 'heavy-rotation', 'same-artist', {
            albumId: 'album-short',
        });
        outOfWindow.runtime_seconds = 1; // effectively below any sane MIN_TRACK_SECONDS
        const valid1 = track('valid1', 'heavy-rotation', 'same-artist', { albumId: 'album-1' });
        valid1.runtime_seconds = 200;
        const valid2 = track('valid2', 'heavy-rotation', 'same-artist', { albumId: 'album-2' });
        valid2.runtime_seconds = 200;

        const pools = { 'heavy-rotation': [outOfWindow, valid1, valid2] };
        const caps = { maxPerArtist: 2, maxPerAlbum: 2 };

        // BUGGY ordering (what quick-picks.service.ts used to do): interleave
        // first — the artist cap admits `outOfWindow` + `valid1` (round-robin
        // order) and rejects `valid2` outright because the cap is already
        // spent. Only THEN is filterConfiguredDurations applied, dropping
        // `outOfWindow` and leaving just 1 track even though 2 valid
        // same-artist candidates existed — a silent shortfall against the
        // targetCount of 2.
        const interleavedFirst = interleaveAndDedup(pools, 2, caps);
        const filteredAfter = filterConfiguredDurations(interleavedFirst);
        expect(filteredAfter.length).toBeLessThan(2);

        // FIXED ordering: filter the candidate pool BEFORE interleave, so the
        // artist cap is only ever spent on in-window candidates.
        const filteredPools = {
            'heavy-rotation': filterConfiguredDurations(pools['heavy-rotation']),
        };
        const filteredFirst = interleaveAndDedup(filteredPools, 2, caps);
        expect(filteredFirst).toHaveLength(2);
        expect(filteredFirst.map((t) => t.id).sort()).toEqual(['valid1', 'valid2']);
    });

    it('keeps tracks with null runtime_seconds (missing metadata treated as in-window)', () => {
        const noRuntime = track('no-runtime', 'random', 'artist-x');
        noRuntime.runtime_seconds = null;
        expect(filterConfiguredDurations([noRuntime])).toHaveLength(1);
    });
});

describe('computeFreshNewDiscovery no-cluster fallback (Fix: must diverge from taste-similar)', () => {
    const userId = toUserId('11111111-1111-1111-1111-111111111111');
    const noRestrictions = { deniedGroupIds: null, ageRating: null };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('when clusters are unavailable, queries a never-played centroid neighbourhood instead of reusing the shared taste-similar query', async () => {
        // Simulates a <10-play user (below MIN_PLAYS_FOR_CLUSTERING) or
        // clustering disabled: getUserTasteClusters resolves to null upstream,
        // so computeFreshNewDiscovery is called with clusters=null.
        vi.mocked(getTopPlayedEmbeddings).mockResolvedValue([
            { track_id: 'played-1', embedding: [0.1, 0.2, 0.3], is_liked: false },
        ]);
        vi.mocked(getNeverPlayedTracksNearCentroid).mockResolvedValue([
            {
                id: 'nd1',
                title: 'Never Played One',
                sort_order: null,
                runtime_seconds: 200,
                custom_poster_url: null,
                custom_metadata: {},
                album_id: 'album-nd1',
                album_title: 'Album',
                album_custom_poster_url: null,
                artist_id: 'artist-1',
                artist_title: 'Artist 1',
                last_played_at: '2026-01-01',
                hours_since_played: null,
                file_path: null,
                embedding: [0.1, 0.2, 0.3],
                similarity: 0.9,
            },
        ]);
        // If the bug regressed, this is the call that would "win" and starve
        // new-discovery via interleaveAndDedup's seenIds (taste-similar runs
        // first in BUCKET_ORDER and would already have claimed these rows).
        vi.mocked(getTasteSimilarTracks).mockResolvedValue([
            {
                id: 'ts-collision',
                title: 'Would Collide With Taste-Similar',
                sort_order: null,
                runtime_seconds: 200,
                custom_poster_url: null,
                custom_metadata: {},
                album_id: 'album-ts',
                album_title: 'Album',
                album_custom_poster_url: null,
                artist_id: 'artist-2',
                artist_title: 'Artist 2',
                last_played_at: '2026-01-01',
                hours_since_played: null,
                file_path: null,
            },
        ]);

        const fakeSql = {} as unknown as postgres.Sql;
        const result = await computeFreshNewDiscovery(
            fakeSql,
            userId,
            null, // clusters unavailable
            ['excluded-1'],
            2, // slots
            noRestrictions,
        );

        // The distinct never-played-filtered query was used to source
        // candidates for this bucket...
        expect(getNeverPlayedTracksNearCentroid).toHaveBeenCalledTimes(1);
        // ...seeded by a centroid averaged from the user's played embeddings.
        expect(getNeverPlayedTracksNearCentroid).toHaveBeenCalledWith(
            fakeSql,
            userId,
            [0.1, 0.2, 0.3],
            ['excluded-1'],
            expect.any(Number),
        );
        // ...and NOT the legacy shared query that caused the collision with
        // the taste-similar bucket (BUCKET_ORDER runs taste-similar first, so
        // identical rows there would starve new-discovery's slots).
        expect(getTasteSimilarTracks).not.toHaveBeenCalled();

        expect(result.map((t) => t.id)).toEqual(['nd1']);
        expect(result[0].bucket).toBe('new-discovery');
    });

    it('falls back to the legacy single-centroid query only when the user has zero embeddable plays (true cold-start edge case)', async () => {
        vi.mocked(getTopPlayedEmbeddings).mockResolvedValue([]);
        vi.mocked(getTasteSimilarTracks).mockResolvedValue([
            {
                id: 'legacy1',
                title: 'Legacy Pick',
                sort_order: null,
                runtime_seconds: 200,
                custom_poster_url: null,
                custom_metadata: {},
                album_id: null,
                album_title: null,
                album_custom_poster_url: null,
                artist_id: 'artist-3',
                artist_title: 'Artist 3',
                last_played_at: '2026-01-01',
                hours_since_played: null,
                file_path: null,
            },
        ]);

        const fakeSql = {} as unknown as postgres.Sql;
        const result = await computeFreshNewDiscovery(fakeSql, userId, null, [], 2, noRestrictions);

        expect(getNeverPlayedTracksNearCentroid).not.toHaveBeenCalled();
        expect(getTasteSimilarTracks).toHaveBeenCalledTimes(1);
        expect(result.map((t) => t.id)).toEqual(['legacy1']);
    });
});

describe('applyArtistDiversityGuard', () => {
    it('breaks runs of 3+ consecutive same-artist tracks', () => {
        const tracks = [
            track('1', 'heavy-rotation', 'A', { albumId: 'a1' }),
            track('2', 'recently-heard', 'A', { albumId: 'a2' }),
            track('3', 'hot-this-week', 'A', { albumId: 'a3' }),
            track('4', 'random', 'B', { albumId: 'a4' }),
            track('5', 'deep-cuts', 'C', { albumId: 'a5' }),
        ];
        const result = applyArtistDiversityGuard(tracks);
        for (let i = 2; i < result.length; i++) {
            const sameArtist =
                result[i].artist_id === result[i - 1].artist_id &&
                result[i - 1].artist_id === result[i - 2].artist_id;
            expect(sameArtist).toBe(false);
        }
        expect(result).toHaveLength(5);
    });

    it('treats consecutive null/empty artists as a run (E9)', () => {
        // Pre-fix, the raw `result[i].artist_id &&` short-circuited on the
        // first falsy compare, so three empty-artist tracks stayed adjacent.
        // Post-E9 they are bucketed under the synthetic "unknown" key and
        // the 3rd one gets displaced like any other same-artist run.
        const empty = (id: string): TaggedTrack => ({
            ...track(id, 'random', 'x'),
            id,
            artist_id: '',
        });
        const result = applyArtistDiversityGuard([
            empty('a'),
            empty('b'),
            empty('c'),
            track('d', 'random', 'artist-2'),
        ]);
        expect(result.map((t) => t.id)).toEqual(['a', 'b', 'd', 'c']);
    });

    it('does nothing when no consecutive duplicates', () => {
        const tracks = [
            track('1', 'heavy-rotation', 'A'),
            track('2', 'recently-heard', 'B'),
            track('3', 'random', 'C'),
        ];
        const result = applyArtistDiversityGuard(tracks);
        expect(result.map((t) => t.id)).toEqual(['1', '2', '3']);
    });

    it('does NOT displace 3+ consecutive Various Artists tracks', () => {
        // Three VA tracks in a row are by three different real artists, so
        // the no-three-in-a-row rule should not fire. Each VA track gets a
        // unique partition key (`va:${id}`) for adjacency comparison.
        const va = 'va-artist-uuid';
        const tracks = [
            track('1', 'heavy-rotation', va, {
                artistTitle: 'Various Artists',
            }),
            track('2', 'recently-heard', va, {
                artistTitle: 'Various Artists',
            }),
            track('3', 'random', va, { artistTitle: 'Various Artists' }),
            track('4', 'random', 'other-artist'),
        ];
        const result = applyArtistDiversityGuard(tracks);
        expect(result.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
    });
});
