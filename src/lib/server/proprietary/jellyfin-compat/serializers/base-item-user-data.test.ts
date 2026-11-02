// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/** Jellyfin user-data parity in the item serializer (2026-10-07 audit gaps 3, 15). */

import { describe, expect, it } from 'vitest';
import { serializeBaseItem, type MediaItemForSerialization } from './base-item';

function item(overrides: Partial<MediaItemForSerialization>): MediaItemForSerialization {
    return {
        id: '11111111-2222-3333-4444-555555555555',
        title: 'X',
        media_type: 'tv',
        ...overrides,
    };
}

describe('series / season user data (Folder.FillUserDataDtoValues)', () => {
    it('derives UnplayedItemCount, PlayedPercentage and Played from the episode counts', () => {
        const dto = serializeBaseItem(
            item({ child_count: 2, recursive_item_count: 8, played_item_count: 2 }),
        );
        expect(dto.ChildCount).toBe(2);
        expect(dto.RecursiveItemCount).toBe(8);
        expect(dto.UserData).toMatchObject({
            UnplayedItemCount: 6,
            PlayedPercentage: 25,
            Played: false,
            PlaybackPositionTicks: 0,
        });
    });

    it('is Played with 100 % once every counted episode is watched', () => {
        const dto = serializeBaseItem(
            item({ media_type: 'season', recursive_item_count: 3, played_item_count: 3 }),
        );
        expect(dto.UserData).toMatchObject({
            UnplayedItemCount: 0,
            PlayedPercentage: 100,
            Played: true,
            PlayCount: 1,
        });
    });

    it('a folder with nothing to count is Played, like Jellyfin', () => {
        const dto = serializeBaseItem(item({ recursive_item_count: 0, played_item_count: 0 }));
        expect(dto.UserData).toMatchObject({ UnplayedItemCount: 0, Played: true });
    });

    it('keeps the favourite flag', () => {
        const dto = serializeBaseItem(
            item({ recursive_item_count: 1, played_item_count: 0, is_favorite: true }),
        );
        expect(dto.UserData?.IsFavorite).toBe(true);
    });

    it('without counts a series keeps the row-level user data', () => {
        const dto = serializeBaseItem(item({ is_watched: false }));
        expect(dto.RecursiveItemCount).toBeUndefined();
        expect(dto.UserData?.UnplayedItemCount).toBeUndefined();
    });

    it('a movie never takes the folder branch', () => {
        const dto = serializeBaseItem(
            item({ media_type: 'movie', recursive_item_count: 5, played_item_count: 5 }),
        );
        expect(dto.UserData?.Played).toBe(false);
        expect(dto.UserData?.UnplayedItemCount).toBeUndefined();
    });
});

describe('UserData.LastPlayedDate', () => {
    it('is the last play time as an ISO datetime', () => {
        const at = new Date('2026-10-01T20:15:00.000Z');
        const dto = serializeBaseItem(item({ media_type: 'movie', last_played_at: at }));
        expect(dto.UserData?.LastPlayedDate).toBe('2026-10-01T20:15:00.000Z');
    });

    it('is absent when the item was never played', () => {
        const dto = serializeBaseItem(item({ media_type: 'movie', last_played_at: null }));
        expect(dto.UserData).not.toHaveProperty('LastPlayedDate', expect.anything());
    });

    it('is read from the row', async () => {
        const { mapRowToMediaItem } = await import('./base-item');
        const at = '2026-10-02T08:00:00.000Z';
        expect(
            mapRowToMediaItem({ id: 'x', title: 'X', media_type: 'episode', last_played_at: at })
                .last_played_at,
        ).toBe(at);
    });
});

describe('SortName (the key Lumastra sorts by)', () => {
    it('uses sort_title, never the original-language title', () => {
        const dto = serializeBaseItem(
            item({
                media_type: 'movie',
                title: 'The Seventh Seal',
                original_title: 'Det sjunde inseglet',
                sort_title: 'seventh seal',
            }),
        );
        expect(dto.SortName).toBe('seventh seal');
        expect(dto.OriginalTitle).toBe('Det sjunde inseglet');
    });

    it('falls back to the lower-cased display title', () => {
        const dto = serializeBaseItem(
            item({ media_type: 'tv', title: 'Dark', original_title: 'Dunkel' }),
        );
        expect(dto.SortName).toBe('dark');
    });

    it('episodes and seasons sort by their numbers, like Jellyfin', () => {
        expect(
            serializeBaseItem(
                item({
                    media_type: 'episode',
                    title: 'Pilot',
                    season_number: 1,
                    episode_number: 7,
                }),
            ).SortName,
        ).toBe('001 - 0007 - pilot');
        expect(serializeBaseItem(item({ media_type: 'season', season_number: 2 })).SortName).toBe(
            '0002',
        );
    });

    it('mapRowToMediaItem reads sort_title', async () => {
        const { mapRowToMediaItem } = await import('./base-item');
        expect(
            mapRowToMediaItem({ id: 'x', title: 'X', media_type: 'movie', sort_title: 'x, the' })
                .sort_title,
        ).toBe('x, the');
    });
});
