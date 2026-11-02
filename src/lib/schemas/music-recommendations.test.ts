// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Contract guard for MusicRecommendationsResponse.next (POST /api/v1/music/recommendations).
 *
 * `next` (then `autoNext`) used to be `.nullable()`, and the handler always emitted the key —
 * so a no-pick response sent `autoNext: null`. The OpenAPI generator emits a
 * bare `$ref` for a nullable object (a $ref sibling cannot carry nullability in
 * the emitted shape), so the spec documented a NON-nullable MusicTrack and every
 * strict generated decoder threw on exactly the case the field exists for.
 *
 * The failure mode is silent: a client that maps a decode throw to nil sees "no
 * next track" rather than an error, and autoplay simply stops extending the
 * queue with nothing in any log.
 *
 * So: absent, never null. These tests fail if someone restores `.nullable()`.
 */

import { describe, it, expect } from 'vitest';
import { MusicRecommendationsResponseSchema } from './api-music-responses.js';
import { musicImagesFixture } from '$lib/server/services/music/__tests__/image-fixtures.js';

const TRACK = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Big in Japan',
    artists: [{ id: null, title: 'Alphaharbor' }],
    albumArtist: null,
    album: null,
    trackNumber: null,
    discNumber: null,
    durationMs: null,
    genres: [],
    year: null,
    isRadio: false,
    images: musicImagesFixture('11111111-1111-4111-8111-111111111111', 'v1'),
    type: 'track' as const,
};

describe('MusicRecommendationsResponse.next', () => {
    it('accepts a response with no next key at all', () => {
        const parsed = MusicRecommendationsResponseSchema.safeParse({
            alternatives: [],
            source: 'metadata',
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.next).toBeUndefined();
    });

    it('rejects an explicit null — the shape the spec cannot express', () => {
        const parsed = MusicRecommendationsResponseSchema.safeParse({
            next: null,
            alternatives: [],
            source: 'metadata',
        });
        expect(parsed.success).toBe(false);
    });

    it('still accepts a real pick', () => {
        const parsed = MusicRecommendationsResponseSchema.safeParse({
            next: TRACK,
            alternatives: [TRACK],
            source: 'sonic',
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.next?.id).toBe(TRACK.id);
    });

    it('rejects more than three alternatives and an unknown source', () => {
        expect(
            MusicRecommendationsResponseSchema.safeParse({
                alternatives: [TRACK, TRACK, TRACK, TRACK],
                source: 'sonic',
            }).success,
        ).toBe(false);
        expect(
            MusicRecommendationsResponseSchema.safeParse({ alternatives: [], source: 'queue' })
                .success,
        ).toBe(false);
    });
});
