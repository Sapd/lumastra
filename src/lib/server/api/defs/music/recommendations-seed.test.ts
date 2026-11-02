// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `seed` contract for POST /music/recommendations.
 *
 * This exists because the shape was previously unknowable from the outside: a
 * bare `JSON.parse` in a `catch {}` meant every wrong spelling behaved exactly
 * like a right one. An iOS client probed four shapes — including the literal
 * string `notjson` — got byte-identical picks for all four, and had no way to
 * learn that none of them worked.
 *
 * Each case below is one of those real probes.
 */

import { describe, it, expect } from 'vitest';
import { MusicRecommendationSeedSchema } from '$lib/schemas/api-music-responses';
import { seedMoodVectorKey } from '$lib/server/services/music/recommendations.service';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('MusicRecommendationSeedSchema — accepted shapes', () => {
    it('accepts a mood seed', () => {
        expect(
            MusicRecommendationSeedSchema.safeParse({ type: 'mood', mood: 'melancholy' }).success,
        ).toBe(true);
    });

    it('accepts a genre seed', () => {
        expect(
            MusicRecommendationSeedSchema.safeParse({ type: 'genre', genre: 'Trance' }).success,
        ).toBe(true);
    });

    it('accepts artist and album seeds', () => {
        expect(MusicRecommendationSeedSchema.safeParse({ type: 'artist', id: UUID }).success).toBe(
            true,
        );
        expect(MusicRecommendationSeedSchema.safeParse({ type: 'album', id: UUID }).success).toBe(
            true,
        );
    });
});

describe('MusicRecommendationSeedSchema — the shapes that used to pass silently', () => {
    it('rejects the value in the wrong field', () => {
        // The client's first probe. `value` is not a field on any arm.
        expect(
            MusicRecommendationSeedSchema.safeParse({ type: 'genre', value: 'Trance' }).success,
        ).toBe(false);
    });

    it('rejects a payload with no discriminator', () => {
        // The client's second probe, and the dangerous one: it parsed as JSON,
        // was therefore truthy, and disabled the genre-streak signal while
        // contributing no seed vector at all.
        expect(MusicRecommendationSeedSchema.safeParse({ genre: 'Trance' }).success).toBe(false);
    });

    it('rejects an invented discriminator field', () => {
        expect(
            MusicRecommendationSeedSchema.safeParse({ kind: 'genre', name: 'Trance' }).success,
        ).toBe(false);
    });

    it('rejects an unknown type', () => {
        expect(
            MusicRecommendationSeedSchema.safeParse({ type: 'decade', decade: '80s' }).success,
        ).toBe(false);
    });

    it('rejects a type whose own field is missing or empty', () => {
        expect(MusicRecommendationSeedSchema.safeParse({ type: 'mood' }).success).toBe(false);
        expect(MusicRecommendationSeedSchema.safeParse({ type: 'genre', genre: '' }).success).toBe(
            false,
        );
    });

    it('rejects a non-uuid artist or album id', () => {
        expect(
            MusicRecommendationSeedSchema.safeParse({ type: 'artist', id: 'Alphaharbor' }).success,
        ).toBe(false);
    });

    it('rejects a bare scalar', () => {
        // What `notjson` becomes once it is quoted into valid JSON.
        expect(MusicRecommendationSeedSchema.safeParse('notjson').success).toBe(false);
        expect(MusicRecommendationSeedSchema.safeParse(null).success).toBe(false);
    });
});

describe('seedMoodVectorKey — the mood_vectors row a mood seed reads', () => {
    // Regression: the handler looked up the BARE key (`chill`), but music
    // rows are stored as `music:chill`, so every mood radio (web chips and
    // third-party clients alike) ran without its mood arm — silently, because
    // a missing row reads as "no mood vector".
    it('namespaces the bare key the way mood_vectors stores it', () => {
        expect(seedMoodVectorKey({ type: 'mood', mood: 'chill' })).toBe('music:chill');
    });

    it('is null for every non-mood seed and for no seed', () => {
        expect(seedMoodVectorKey({ type: 'genre', genre: 'Trance' })).toBeNull();
        expect(
            seedMoodVectorKey({ type: 'artist', artistId: '11111111-1111-4111-8111-111111111111' }),
        ).toBeNull();
        expect(seedMoodVectorKey(null)).toBeNull();
    });
});
