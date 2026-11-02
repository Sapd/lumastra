// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for resolveMediaRefId / mapToRecommendationItem / mapBatch.
 *
 * These pin the fix for a defect class that had spread across four rails:
 * `media.id` being set to something a client cannot dereference. The variants
 * found in the wild were:
 *   - `tmdb:603`      (trending)          — 2-part, REJECTED by parseMediaId
 *   - a bare Jellyfin GUID (editorial)    — not a UUID, not a composite
 *   - `''`            (fulfilled-requests)— unresolvable AND collides as a list key
 *   - `ext:603`       (popular-shows)     — non-deterministic, unparseable
 *
 * The contract now: internal UUID > valid 3-part composite > drop the item.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

const { resolveMediaRefId, mapToRecommendationItem, mapBatch } = await import('./item-mapper.js');
const { parseMediaId } = await import('$lib/server/utils/media-key-parser.js');

const UUID = '11111111-2222-3333-4444-555555555555';

describe('resolveMediaRefId', () => {
    it('prefers the internal UUID', () => {
        expect(resolveMediaRefId({ internal: UUID, tmdb: '603' }, 'movie')).toBe(UUID);
    });

    it('falls back to a 3-part composite when there is no internal UUID', () => {
        expect(resolveMediaRefId({ tmdb: '603' }, 'movie')).toBe('tmdb:603:movie');
    });

    it('emits a composite the real parser actually accepts', () => {
        // This is the whole point: the old 2-part `tmdb:603` was rejected here.
        const parsed = parseMediaId(resolveMediaRefId({ tmdb: '603' }, 'movie')!);
        expect(parsed.type).toBe('composite');
        expect(parsed.provider).toBe('tmdb');
        expect(parsed.externalId).toBe('603');
    });

    it("normalises the 'series' segment to 'tv' through the parser", () => {
        const key = resolveMediaRefId({ tmdb: '1399' }, 'series');
        expect(key).toBe('tmdb:1399:series');
        // media.id stays self-consistent with media.type, and still resolves.
        expect(parseMediaId(key!).mediaType).toBe('tv');
    });

    it('rejects the 2-part form that used to be emitted', () => {
        // Regression guard: proves the old fallback really was broken.
        const parsed = parseMediaId('tmdb:603');
        expect(parsed.type).not.toBe('composite');
    });

    it('returns null when there is neither an internal UUID nor a provider id', () => {
        expect(resolveMediaRefId({}, 'movie')).toBeNull();
        expect(resolveMediaRefId(undefined, 'movie')).toBeNull();
    });
});

describe('mapToRecommendationItem', () => {
    it('maps an item with an internal UUID', () => {
        const item = mapToRecommendationItem(
            {
                externalIds: { internal: UUID, tmdb: '603' },
                mediaType: 'movie',
                title: 'The Lantern',
            },
            'trending',
            'internal',
        );

        expect(item).not.toBeNull();
        expect(item!.media.id).toBe(UUID);
        expect(item!.media.ids.internal).toBe(UUID);
    });

    it('maps a discovery-only item to a valid composite', () => {
        const item = mapToRecommendationItem(
            { externalIds: { tmdb: '603' }, mediaType: 'movie', title: 'The Lantern' },
            'trending',
            'internal',
        );

        expect(item!.media.id).toBe('tmdb:603:movie');
    });

    it('returns null for an undereferenceable item instead of a synthetic id', () => {
        const item = mapToRecommendationItem(
            { externalIds: {}, mediaType: 'movie', title: 'Orphan' },
            'trending',
            'internal',
        );

        expect(item).toBeNull();
    });

    // `media.type` is a real enum (publicMediaTypeSchema) and is what the client
    // routes playback off. The old `canonicalType` helper returned
    // `toPublicMediaType(raw) ?? raw.toLowerCase()` — a raw passthrough that put
    // an internal-only media_type straight into the public discriminator, with a
    // `?? 'movie'` default for a missing one. Both are worse than dropping: the
    // client sends a "movie" it cannot play into the movie playback path.
    it.each(['tvchannel', 'home_video', 'music'])(
        'returns null for an item whose media_type has no public representation (%s)',
        (mediaType) => {
            expect(
                mapToRecommendationItem(
                    { externalIds: { internal: UUID }, mediaType, title: 'Channel 4' },
                    'trending',
                    'internal',
                ),
            ).toBeNull();
        },
    );

    it('returns null instead of defaulting a missing media_type to movie', () => {
        expect(
            mapToRecommendationItem(
                { externalIds: { internal: UUID }, mediaType: '', title: 'Typeless' },
                'trending',
                'internal',
            ),
        ).toBeNull();
    });

    it('still maps every type it CAN represent (a drop, not a blanket reject)', () => {
        const types: Array<[string, string]> = [
            ['tv', 'series'],
            ['show', 'series'],
            ['movie', 'movie'],
            ['episode', 'episode'],
            ['audiobook', 'audiobook'],
            ['album', 'album'],
        ];
        for (const [raw, expected] of types) {
            const out = mapToRecommendationItem(
                { externalIds: { internal: UUID }, mediaType: raw, title: 'X' },
                'trending',
                'internal',
            );
            expect(out?.media.type).toBe(expected);
        }
    });

    it('never emits the old ext: prefix', () => {
        const item = mapToRecommendationItem(
            { externalIds: { tmdb: '603' }, mediaType: 'movie', title: 'X' },
            'trending',
            'internal',
        );

        expect(item!.media.id.startsWith('ext:')).toBe(false);
    });
});

describe('mapBatch', () => {
    const rows = [
        { externalIds: { internal: UUID }, mediaType: 'movie', title: 'Keeps' },
        { externalIds: {}, mediaType: 'movie', title: 'Dropped' },
        { externalIds: { tmdb: '1399' }, mediaType: 'tv', title: 'Composite' },
    ];

    it('drops undereferenceable rows from the page', () => {
        const { items } = mapBatch(rows, 10, 'trending', 'internal');

        expect(items).toHaveLength(2);
        expect(items.map((i) => i.media.title)).toEqual(['Keeps', 'Composite']);
    });

    it('drops rows whose media_type has no public representation', () => {
        const { items } = mapBatch(
            [
                { externalIds: { internal: UUID }, mediaType: 'movie', title: 'Keeps' },
                { externalIds: { internal: 'chan-1' }, mediaType: 'tvchannel', title: 'WBN One' },
                { externalIds: { internal: 'vid-1' }, mediaType: 'home_video', title: 'Holiday' },
            ],
            10,
            'trending',
            'internal',
        );

        expect(items.map((i) => i.media.title)).toEqual(['Keeps']);
        // And nothing was smuggled through under a wrong-but-valid type.
        expect(items.map((i) => i.media.type)).toEqual(['movie']);
    });

    it('emits no empty-string ids (which would collide as list keys)', () => {
        const { items } = mapBatch(rows, 10, 'trending', 'internal');

        for (const item of items) {
            expect(item.media.id).toBeTruthy();
        }
        expect(new Set(items.map((i) => i.media.id)).size).toBe(items.length);
    });

    it('still derives hasMore from the raw fetch, not the filtered page', () => {
        // A page that shrank due to drops must not stall pagination.
        const { items, hasMore } = mapBatch(rows, 2, 'trending', 'internal');

        expect(hasMore).toBe(true);
        expect(items.length).toBeLessThanOrEqual(2);
    });
});
