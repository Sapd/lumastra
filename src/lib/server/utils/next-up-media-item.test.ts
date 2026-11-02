// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { nextUpRowToMediaItem } from './next-up-media-item';
import type { NextUpRow } from '$lib/server/database/queries/watch-state.queries';

const row: NextUpRow = {
    media_id: 'ep-uuid',
    has_files: true,
    title: 'Pilot',
    season_number: 1,
    episode_number: 2,
    runtime_seconds: 1800,
    premiere_date: null,
    overview: 'An episode',
    parent_id: 'season-uuid',
    series_id: 'series-uuid',
    series_name: 'My Show',
    series_tmdb_id: '123',
    series_imdb_id: null,
    last_watched_at: null,
    last_event_source: null,
    sort_date: '1970-01-01',
    backdrop_blurhash: null,
    trailer_url: null,
};

describe('nextUpRowToMediaItem', () => {
    it('maps the episode media_id into externalIds.internal and id', () => {
        const item = nextUpRowToMediaItem(row);
        expect(item.id).toBe('ep-uuid');
        const ext = item.externalIds as Record<string, unknown>;
        expect(ext.internal).toBe('ep-uuid');
        expect(item.mediaType).toBe('episode');
        expect(item.seasonNumber).toBe(1);
        expect(item.episodeNumber).toBe(2);
    });

    it('sets remoteTrailers to [trailer_url] when the series trailer is present', () => {
        const item = nextUpRowToMediaItem({
            ...row,
            trailer_url: 'https://youtube.com/watch?v=abc123',
        });
        expect(item.remoteTrailers).toEqual(['https://youtube.com/watch?v=abc123']);
    });

    it('leaves remoteTrailers undefined when trailer_url is null', () => {
        const item = nextUpRowToMediaItem({ ...row, trailer_url: null });
        expect(item.remoteTrailers).toBeUndefined();
    });

    it('uses internal ids for seriesId and the backdrop, never a Jellyfin id', () => {
        const item = nextUpRowToMediaItem(row);
        expect(item.seriesId).toBe('series-uuid');
        expect(item.seriesInternalId).toBe('series-uuid');
        expect(item.imageBackdropId).toBe('series-uuid');
        expect(item.externalIds).not.toHaveProperty('jellyfin');
    });

    it('falls back to the episode id for the backdrop when the series id is missing', () => {
        const item = nextUpRowToMediaItem({ ...row, series_id: null });
        expect(item.imageBackdropId).toBe('ep-uuid');
        expect(item.seriesId).toBeUndefined();
    });
});
