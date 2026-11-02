// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '$lib/server/database/connection.js';
import { getFileSiblingEpisodes } from '$lib/server/database/queries/episode-search.queries.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { resolveWatchTogetherEntryPosition } from './watch-together-entry-position';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    getFileSiblingEpisodes: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: vi.fn(),
}));

const rows = [
    {
        id: 'one',
        title: 'Part one',
        episode_number: 1,
        season_number: 1,
        start_offset_ms: '0',
        end_offset_ms: '60000',
    },
    {
        id: 'two',
        title: 'Part two',
        episode_number: 2,
        season_number: 1,
        start_offset_ms: '60000',
        end_offset_ms: '120000',
    },
];

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFileSiblingEpisodes).mockResolvedValue(rows);
    vi.mocked(getFilesForMediaItem).mockResolvedValue([
        { id: 'default', is_default: true },
        { id: 'alternate', is_default: false },
    ] as Awaited<ReturnType<typeof getFilesForMediaItem>>);
});

describe('party entry position', () => {
    it('starts a later combined episode at its file offset', async () => {
        expect(await resolveWatchTogetherEntryPosition('two', 'episode')).toBe(60);
        expect(await resolveWatchTogetherEntryPosition('one', 'episode')).toBe(0);
    });
    it('uses the same entry for an explicit default file', async () => {
        expect(await resolveWatchTogetherEntryPosition('two', 'episode', 'default')).toBe(60);
    });
    it('does not inherit default-file windows for another version', async () => {
        expect(await resolveWatchTogetherEntryPosition('two', 'episode', 'alternate')).toBe(0);
        expect(getFileSiblingEpisodes).not.toHaveBeenCalled();
    });
    it('preserves an explicit whole-file position even before this episode window', async () => {
        expect(await resolveWatchTogetherEntryPosition('two', 'episode', undefined, 0)).toBe(0);
        expect(await resolveWatchTogetherEntryPosition('two', 'episode', undefined, 5)).toBe(5);
        expect(getDb).not.toHaveBeenCalled();
    });
    it('keeps movies and unsplit or incomplete episode windows at zero', async () => {
        expect(await resolveWatchTogetherEntryPosition('movie', 'movie')).toBe(0);
        vi.mocked(getFileSiblingEpisodes).mockResolvedValueOnce(rows.slice(1));
        expect(await resolveWatchTogetherEntryPosition('two', 'episode')).toBe(0);
        vi.mocked(getFileSiblingEpisodes).mockResolvedValueOnce(
            rows.map((row) => ({ ...row, end_offset_ms: null })),
        );
        expect(await resolveWatchTogetherEntryPosition('two', 'episode')).toBe(0);
    });
    it('propagates lookup failure instead of silently starting the wrong episode', async () => {
        vi.mocked(getFileSiblingEpisodes).mockRejectedValueOnce(new Error('database unavailable'));
        await expect(resolveWatchTogetherEntryPosition('two', 'episode')).rejects.toThrow(
            'database unavailable',
        );
    });
});
