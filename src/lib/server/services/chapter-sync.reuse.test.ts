// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * chapter-sync probes a file only when its chapters are not already known.
 * The known set is the file's stored chapters, trusted when the file's
 * `chapters_probed_*` marker matches its stat (the scanner or an earlier
 * chapter-sync wrote it). A `force` run always probes. A failed probe never
 * writes the marker, so the next run tries again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const {
    mockProbeChapters,
    mockLoadKnown,
    mockMarkProbed,
    mockUpsert,
    mockRefreshSegments,
    mockResolveMediaPath,
    mockGetFiles,
    mockSafeStat,
    mockReplace,
} = vi.hoisted(() => ({
    mockProbeChapters: vi.fn(),
    mockLoadKnown: vi.fn(),
    mockMarkProbed: vi.fn(),
    mockUpsert: vi.fn(),
    mockRefreshSegments: vi.fn(),
    mockResolveMediaPath: vi.fn(),
    mockGetFiles: vi.fn(),
    mockSafeStat: vi.fn(),
    mockReplace: vi.fn(),
}));

vi.mock('$lib/server/utils/ffprobe.js', () => ({ probeChapters: mockProbeChapters }));
vi.mock('$lib/server/utils/safe-fs.js', () => ({ safeStat: mockSafeStat }));

vi.mock('$lib/server/database/queries/episode-chapters.queries.js', () => ({
    upsertChaptersForFile: mockUpsert,
    loadKnownFileChapters: mockLoadKnown,
    markChaptersProbed: mockMarkProbed,
}));

vi.mock('$lib/server/database/queries/file-segments.queries.js', () => ({
    refreshSegmentsForFile: mockRefreshSegments,
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: mockGetFiles,
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: mockResolveMediaPath,
}));

vi.mock('$lib/server/jellyfin/index.js', () => ({
    jellyfinSeriesService: { getItemWithChapters: vi.fn() },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    },
}));

vi.mock('./file-chapters.service.js', () => ({ replaceProbedFileChapters: mockReplace }));

import { syncSeriesChapters } from './chapter-sync.service.js';

const FILE_PATH = '/data/movies/Movie.mkv';
const STORED = [{ index: 0, title: 'Opening', startTimeMs: 0, endTimeMs: 90000 }];
const MTIME = new Date('2026-10-01T10:00:00.000Z');
const LATER = new Date('2026-10-02T10:00:00.000Z');
/** The stat the probe saw: the marker must record exactly this, not the row's. */
const PROBED_STAT = { mtime: MTIME, size: 4096 };

/** A movie item with one linked file, answered by query text. */
function movieSql(): postgres.Sql {
    return vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        if (text.includes('SELECT media_type FROM media_items')) return [{ media_type: 'movie' }];
        if (text.includes('COUNT(*)')) return [{ count: 1 }];
        if (text.includes('mi.id AS media_item_id')) {
            return [
                {
                    media_item_id: 'm1',
                    jellyfin_id: null,
                    file_id: 'f1',
                    file_path: FILE_PATH,
                    season_number: null,
                    episode_number: null,
                },
            ];
        }
        return [];
    }) as unknown as postgres.Sql;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockReplace.mockResolvedValue(true);
    mockResolveMediaPath.mockResolvedValue({
        isAccessible: true,
        containerPath: FILE_PATH,
    });
    mockGetFiles.mockResolvedValue([]);
    mockSafeStat.mockResolvedValue({ mtime: MTIME, size: 4096 });
    mockLoadKnown.mockResolvedValue(null);
    mockProbeChapters.mockResolvedValue({ chapters: [], durationMs: 0, success: true });
    mockUpsert.mockResolvedValue(undefined);
    mockMarkProbed.mockResolvedValue(undefined);
    mockRefreshSegments.mockResolvedValue(undefined);
});

describe('syncSeriesChapters — stored chapter reuse', () => {
    it('reuses stored chapters when the marker matches: no ffprobe, segments refreshed', async () => {
        mockLoadKnown.mockResolvedValue({ chapters: STORED });

        const result = await syncSeriesChapters(movieSql(), 'm1');

        expect(mockLoadKnown).toHaveBeenCalledWith(expect.anything(), 'f1');
        expect(mockProbeChapters).not.toHaveBeenCalled();
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockRefreshSegments).toHaveBeenCalledWith(expect.anything(), 'f1');
        expect(result.episodesWithChapters).toBe(1);
        expect(result.inaccessibleFiles).toBe(0);
    });

    it('reuses a stored "no chapters" marker without ffprobe and without a refresh', async () => {
        mockLoadKnown.mockResolvedValue({ chapters: [] });

        const result = await syncSeriesChapters(movieSql(), 'm1');

        expect(mockProbeChapters).not.toHaveBeenCalled();
        expect(mockRefreshSegments).not.toHaveBeenCalled();
        expect(result.episodesWithChapters).toBe(0);
        expect(result.inaccessibleFiles).toBe(0);
    });

    it('probes when there is no matching marker', async () => {
        mockLoadKnown.mockResolvedValue(null);

        await syncSeriesChapters(movieSql(), 'm1');

        expect(mockProbeChapters).toHaveBeenCalledTimes(1);
        expect(mockProbeChapters).toHaveBeenCalledWith(FILE_PATH, undefined, {
            signal: undefined,
        });
    });

    it('a force run probes even when the marker matches', async () => {
        mockLoadKnown.mockResolvedValue({ chapters: STORED });

        await syncSeriesChapters(movieSql(), 'm1', undefined, undefined, undefined, {
            force: true,
        });

        expect(mockProbeChapters).toHaveBeenCalledTimes(1);
    });

    it('an unreadable file is still "inaccessible", even when chapters were stored', async () => {
        mockLoadKnown.mockResolvedValue({ chapters: STORED });
        mockResolveMediaPath.mockResolvedValue({ isAccessible: false, containerPath: FILE_PATH });

        const result = await syncSeriesChapters(movieSql(), 'm1');

        expect(result.inaccessibleFiles).toBe(1);
        expect(result.episodesWithChapters).toBe(0);
        expect(mockProbeChapters).not.toHaveBeenCalled();
    });
});

describe('syncSeriesChapters — marking what was probed', () => {
    it('a successful probe with no chapters marks the file probed at the probed stat', async () => {
        await syncSeriesChapters(movieSql(), 'm1');

        expect(mockReplace).toHaveBeenCalledWith(
            expect.anything(),
            'f1',
            expect.objectContaining({ stat: PROBED_STAT }),
            FILE_PATH,
            { signal: undefined },
        );
    });

    it('a failed probe does not mark the file, so the next run probes again', async () => {
        mockProbeChapters.mockResolvedValue({ chapters: [], durationMs: 0, success: false });

        const result = await syncSeriesChapters(movieSql(), 'm1');

        expect(mockMarkProbed).not.toHaveBeenCalled();
        expect(result.episodesWithChapters).toBe(0);
    });

    it('a successful probe with chapters stores them and marks the file probed at the probed stat', async () => {
        mockProbeChapters.mockResolvedValue({ chapters: STORED, durationMs: 90000, success: true });

        const result = await syncSeriesChapters(movieSql(), 'm1');

        expect(mockReplace).toHaveBeenCalledWith(
            expect.anything(),
            'f1',
            expect.objectContaining({ stat: PROBED_STAT }),
            FILE_PATH,
            { signal: undefined },
        );
        expect(result.episodesWithChapters).toBe(1);
    });

    it('a file that changed during the probe (empty result) is not marked', async () => {
        mockSafeStat
            .mockResolvedValueOnce({ mtime: MTIME, size: 4096 })
            .mockResolvedValueOnce({ mtime: LATER, size: 4096 });

        await syncSeriesChapters(movieSql(), 'm1');

        expect(mockProbeChapters).toHaveBeenCalledTimes(1);
        expect(mockMarkProbed).not.toHaveBeenCalled();
    });

    it('a file that changed during the probe (with chapters) leaves evidence untouched and remains retryable', async () => {
        mockProbeChapters.mockResolvedValue({ chapters: STORED, durationMs: 90000, success: true });
        mockSafeStat
            .mockResolvedValueOnce({ mtime: MTIME, size: 4096 })
            .mockResolvedValueOnce({ mtime: MTIME, size: 9999 });

        const result = await syncSeriesChapters(movieSql(), 'm1');

        expect(mockReplace).not.toHaveBeenCalled();
        expect(mockMarkProbed).not.toHaveBeenCalled();
        expect(result.episodesWithChapters).toBe(0);
        expect(result.inaccessibleFiles).toBe(1);
    });
});
