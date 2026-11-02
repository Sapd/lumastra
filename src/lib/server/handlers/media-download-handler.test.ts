// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildDownloadFilename } from './media-download-handler';
import type { MediaDownloadNamingRow } from '$lib/server/database/queries/catalog-operations.queries';

function movie(overrides: Partial<MediaDownloadNamingRow> = {}): MediaDownloadNamingRow {
    return {
        id: 'movie-1',
        title: 'The Lantern',
        year: 1999,
        media_type: 'movie',
        season_number: null,
        episode_number: null,
        series_title: null,
        ...overrides,
    };
}

function episode(overrides: Partial<MediaDownloadNamingRow> = {}): MediaDownloadNamingRow {
    return {
        id: 'ep-1',
        title: 'Pilot',
        year: null,
        media_type: 'episode',
        season_number: 1,
        episode_number: 2,
        series_title: 'Drifting Clouds',
        ...overrides,
    };
}

describe('buildDownloadFilename', () => {
    it('formats a movie as "Title (Year).ext"', () => {
        expect(buildDownloadFilename(movie(), '.mkv')).toBe('The Lantern (1999).mkv');
    });

    it('drops the year suffix when absent', () => {
        expect(buildDownloadFilename(movie({ year: null }), '.mp4')).toBe('The Lantern.mp4');
    });

    it('formats an episode as "Series - SxxEyy - Title.ext"', () => {
        expect(buildDownloadFilename(episode(), '.mkv')).toBe(
            'Drifting Clouds - S01E02 - Pilot.mkv',
        );
    });

    it('pads season/episode numbers to two digits', () => {
        expect(
            buildDownloadFilename(episode({ season_number: 12, episode_number: 3 }), '.mkv'),
        ).toBe('Drifting Clouds - S12E03 - Pilot.mkv');
    });

    it('omits the series prefix when series_title is unavailable', () => {
        expect(buildDownloadFilename(episode({ series_title: null }), '.mkv')).toBe(
            'S01E02 - Pilot.mkv',
        );
    });

    it('falls back to the bare title when an episode has no season/episode numbers', () => {
        expect(
            buildDownloadFilename(episode({ season_number: null, episode_number: null }), '.mkv'),
        ).toBe('Pilot.mkv');
    });

    it('strips filesystem-reserved characters from the title', () => {
        expect(buildDownloadFilename(movie({ title: 'Cloud Runner: 2049' }), '.mkv')).toBe(
            'Cloud Runner 2049 (1999).mkv',
        );
    });

    it('strips slashes and quotes without leaving gaps', () => {
        expect(buildDownloadFilename(movie({ title: 'A/V "Test"' }), '.mkv')).toBe(
            'AV Test (1999).mkv',
        );
    });

    it('collapses whitespace left behind by stripped characters', () => {
        expect(buildDownloadFilename(movie({ title: 'Foo *** Bar' }), '.mkv')).toBe(
            'Foo Bar (1999).mkv',
        );
    });

    it('falls back to "download" when sanitizing empties the name', () => {
        expect(buildDownloadFilename(movie({ title: '???', year: null }), '.mkv')).toBe(
            'download.mkv',
        );
    });

    it('truncates absurdly long titles', () => {
        const longTitle = 'A'.repeat(300);
        const result = buildDownloadFilename(movie({ title: longTitle, year: null }), '.mkv');
        // 180 (MAX_NAME_LENGTH) + '.mkv'
        expect(result).toBe(`${'A'.repeat(180)}.mkv`);
    });
});
