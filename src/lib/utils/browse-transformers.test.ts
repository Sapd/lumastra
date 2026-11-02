// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * browse-transformers.ts Unit Tests
 *
 * [M29] Pins the fix for browse/+page.svelte:271/281 mapping
 * transformJellyfinItem/transformKeywordItem with no per-item guard: a
 * malformed (falsy) item must be skipped/handled defensively, not throw and
 * take out the whole carousel section.
 */

import { describe, it, expect } from 'vitest';
import {
    transformJellyfinItem,
    transformKeywordItem,
    transformChannelItem,
    type BrowseItem,
    type KeywordBrowseItem,
} from './browse-transformers';

describe('[M29] transformJellyfinItem — malformed item handling', () => {
    it('does not throw for a null item', () => {
        expect(() => transformJellyfinItem(null)).not.toThrow();
    });

    it('does not throw for an undefined item', () => {
        expect(() => transformJellyfinItem(undefined)).not.toThrow();
    });

    it('drops a null item (no type ⇒ no card) instead of emitting an id-less movie card', () => {
        // Was: a placeholder movie card with an empty id. A malformed item has no
        // `type`, and inventing 'movie' for it is the bug class this transform
        // just stopped participating in.
        expect(transformJellyfinItem(null)).toBeNull();
    });

    it('transforms a well-formed item normally', () => {
        const item: BrowseItem = {
            id: 'jf-123',
            type: 'Movie',
            name: 'Test Movie',
            year: 2020,
            imageId: 'img-1',
        };
        const result = transformJellyfinItem(item);
        expect(result?.id).toBe('jf-123');
        expect(result?.mediaType).toBe('movie');
        expect(result?.title).toBe('Test Movie');
        expect(result?.year).toBe(2020);
        expect(result?.subtitle).toBeUndefined();
        // A non-UUID id is not an internal id, and never goes in a Jellyfin slot.
        expect(result?.externalIds?.internal).toBeUndefined();
        expect(result?.externalIds).not.toHaveProperty('jellyfin');
    });

    it('puts only a real media_items UUID into externalIds.internal', () => {
        const uuid = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
        expect(
            transformJellyfinItem({ id: uuid, type: 'Movie', name: 'Internal' })?.externalIds
                ?.internal,
        ).toBe(uuid);
        // A Jellyfin item id (32 hex, no dashes) is not an internal id.
        expect(
            transformJellyfinItem({
                id: '6f1c2d3e4a5b4c6d8e7f90a1b2c3d4e5',
                type: 'Movie',
                name: 'Legacy',
            })?.externalIds?.internal,
        ).toBeUndefined();
    });

    it('the array-level filter guard skips falsy/id-less items before mapping (as used in browse/+page.svelte)', () => {
        const rawItems: Array<BrowseItem | null | undefined> = [
            { id: 'jf-1', type: 'movie', name: 'Good Item' },
            null,
            undefined,
            { id: '', type: 'movie', name: 'No id' } as BrowseItem,
            { id: 'jf-2', type: 'series', name: 'Another Good Item' },
        ];

        // Mirrors the guard at browse/+page.svelte:333 — plus the null-drop the
        // transform now performs itself.
        const transformed = rawItems
            .filter((item): item is BrowseItem => !!item?.id)
            .map(transformJellyfinItem)
            .filter((item): item is NonNullable<typeof item> => item !== null);

        expect(transformed).toHaveLength(2);
        expect(transformed.map((i) => i.id)).toEqual(['jf-1', 'jf-2']);
    });
});

describe('transformJellyfinItem — carries the real media type (audiobook regression)', () => {
    it('keeps an audiobook an audiobook instead of collapsing it to movie', () => {
        const item: BrowseItem = {
            id: 'ab-1',
            type: 'audiobook',
            name: 'Der dunkle Hafen',
            externalIds: { internal: '11111111-1111-4111-8111-111111111111' },
        };
        const result = transformJellyfinItem(item);
        expect(result?.mediaType).toBe('audiobook');
    });

    it('still maps movies, series (both spellings) and episodes', () => {
        expect(transformJellyfinItem({ id: 'a', type: 'Movie' })?.mediaType).toBe('movie');
        expect(transformJellyfinItem({ id: 'b', type: 'series' })?.mediaType).toBe('series');
        expect(transformJellyfinItem({ id: 'c', type: 'tv' })?.mediaType).toBe('series');
        expect(transformJellyfinItem({ id: 'd', type: 'episode' })?.mediaType).toBe('episode');
    });

    it('honours the independent isEpisode wire flag even when type names the parent series', () => {
        const result = transformJellyfinItem({ id: 'e', type: 'tv', isEpisode: true });
        expect(result?.mediaType).toBe('episode');
    });

    it('drops (returns null for) an item whose type has no card the client can open', () => {
        // 'book' has no UniversalMediaType member — a card the client cannot
        // open is worse than no card.
        expect(transformJellyfinItem({ id: 'f', type: 'book' })).toBeNull();
        expect(transformJellyfinItem({ id: 'g', type: 'nonsense' })).toBeNull();
        expect(transformJellyfinItem({ id: 'h' })).toBeNull();
    });
});

describe('[M29] transformKeywordItem — malformed item handling', () => {
    it('does not throw for a null item', () => {
        expect(() => transformKeywordItem(null)).not.toThrow();
    });

    it('does not throw for an undefined item', () => {
        expect(() => transformKeywordItem(undefined)).not.toThrow();
    });

    it('returns a safe placeholder for a null item', () => {
        const result = transformKeywordItem(null);
        expect(result.title).toBeTruthy();
        expect(result.image).toBeTruthy();
        expect(typeof result.id).toBe('string');
    });

    it('transforms a well-formed item normally', () => {
        const item: KeywordBrowseItem = {
            type: 'movie',
            name: 'Test Keyword Movie',
            year: 2021,
            externalIds: { tmdb: '550' },
            isAvailable: true,
        };
        const result = transformKeywordItem(item);
        expect(result.title).toBe('Test Keyword Movie');
        expect(result.mediaType).toBe('movie');
        expect(result.isAvailable).toBe(true);
        expect(result.canRequest).toBe(false);
    });

    it('the array-level filter guard skips falsy/identity-less items before mapping (as used in browse/+page.svelte)', () => {
        const rawItems: Array<KeywordBrowseItem | null | undefined> = [
            { name: 'Good Keyword Item' },
            null,
            undefined,
            { externalIds: { tmdb: '999' } },
        ];

        // Mirrors the guard added at browse/+page.svelte:281
        const transformed = rawItems
            .filter(
                (item): item is KeywordBrowseItem => !!item && (!!item.externalIds || !!item.name),
            )
            .map(transformKeywordItem);

        expect(transformed).toHaveLength(2);
    });
});

describe('series count propagation', () => {
    const counts = {
        seasonCount: 3,
        episodeCount: 60,
        availableEpisodeCount: 24,
        watchedEpisodeCount: 24,
        unwatchedEpisodeCount: 0,
    };
    it('carries all count fields through recent/genre cards, including explicit zero', () => {
        expect(
            transformJellyfinItem({ id: 'series', type: 'series', name: 'Series', ...counts }),
        ).toMatchObject(counts);
    });
    it('carries all count fields through keyword cards, including explicit zero', () => {
        expect(
            transformKeywordItem({
                externalIds: { internal: 'series' },
                type: 'series',
                name: 'Series',
                ...counts,
            }),
        ).toMatchObject(counts);
    });
});

describe('transformChannelItem — ids', () => {
    it('sets externalIds.internal only for a UUID channel id', () => {
        const uuid = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
        const base = { name: 'Channel', images: {} };
        expect(transformChannelItem({ ...base, id: uuid }, 0).item.externalIds).toEqual({
            internal: uuid,
        });
        expect(
            transformChannelItem({ ...base, id: '6f1c2d3e4a5b4c6d8e7f90a1b2c3d4e5' }, 0).item
                .externalIds,
        ).toEqual({});
    });
});
