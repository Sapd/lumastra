// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pressing Play on a finished movie must start it from the beginning.
 *
 * Reverse-proxy e2e 2026-10-06: the movie's user_media_state row was
 * `is_watched=true, resume_position_ms=420059` for a 420021 ms file (watched to
 * the end; the rebuilder keeps the last position on watched rows so a re-watch
 * can resume). The loader handed that straight to the player, which started HLS
 * at 420.08 s — past the last segment. hls.js fell back to segment 0, the server
 * took it for a backward seek and re-transcoded from 0 while the player sat at
 * the tail, and playback wedged at 30 s for good.
 *
 * This pins the seam the player reads its start from:
 * `playbackInfo.userData.playbackPositionTicks`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveResume } from '$lib/server/services/effective-playback.js';

const {
    getMediaItemForWatch,
    checkMediaAccess,
    resolveEffectiveResume,
    getFileSiblingEpisodes,
    getDefaultFileDurationMs,
    findNextSequentialEpisode,
} = vi.hoisted(() => ({
    getMediaItemForWatch: vi.fn(),
    checkMediaAccess: vi.fn(),
    resolveEffectiveResume: vi.fn(),
    getFileSiblingEpisodes: vi.fn(),
    getDefaultFileDurationMs: vi.fn(),
    findNextSequentialEpisode: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemForWatch,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess }));
const { ACCESS_BOUNDARY } = vi.hoisted(() => ({ ACCESS_BOUNDARY: { library: 'boundary-marker' } }));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({}),
    searchAccessBoundary: vi.fn(() => ACCESS_BOUNDARY),
}));
vi.mock('$lib/server/services/effective-playback.js', () => ({ resolveEffectiveResume }));
vi.mock('$lib/server/database/queries/episode-search.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/episode-search.queries.js')
    >()),
    getFileSiblingEpisodes,
    findNextSequentialEpisode,
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getDefaultFileDurationMs,
}));
vi.mock('$lib/server/plugins/runtime/widget-metadata.js', () => ({
    listPluginWidgetsFor: vi.fn().mockResolvedValue([]),
}));

const { load } = await import('./+page.server.js');

const MOVIE = '33333333-3333-4333-8333-333333333333';

const MOVIE_ROW = {
    id: MOVIE,
    title: 'Seven Minutes',
    media_type: 'movie',
    runtime_seconds: 420,
    has_files: true,
    series_id: null,
    series_title: null,
    season_number: null,
    episode_number: null,
};

function resume(positionMs: number, isWatched: boolean): EffectiveResume {
    return {
        positionMs,
        source: 'durable',
        fromLive: false,
        anchorMs: Date.parse('2026-10-06T10:00:00Z'),
        isWatched,
    };
}

/** Runs the loader and returns where the player will start, in ms. */
async function startPositionMs(itemId = MOVIE): Promise<number> {
    const result = (await load({
        params: { itemId },
        locals: { user: { username: 'alice', userId: 'user-1' } },
        url: new URL(`http://localhost/watch/${itemId}`),
    } as unknown as Parameters<typeof load>[0])) as {
        playbackInfo: { userData: { playbackPositionTicks: number } };
    };
    return result.playbackInfo.userData.playbackPositionTicks / 10_000;
}

beforeEach(() => {
    vi.clearAllMocks();
    getMediaItemForWatch.mockResolvedValue(MOVIE_ROW);
    checkMediaAccess.mockResolvedValue(true);
    getFileSiblingEpisodes.mockResolvedValue([]);
    // The repro file: 420.021 s, probed.
    getDefaultFileDurationMs.mockResolvedValue(420_021);
});

describe('/watch/<movieId> — start position for a finished movie', () => {
    it('starts a movie watched to the end (resume past the runtime) from 0', async () => {
        resolveEffectiveResume.mockResolvedValue(resume(420_059, true));
        expect(await startPositionMs()).toBe(0);
    });

    it('starts from 0 when the resume sits in the credits, watched flag or not', async () => {
        resolveEffectiveResume.mockResolvedValue(resume(405_000, false));
        expect(await startPositionMs()).toBe(0);
    });

    it('keeps a mid-movie re-watch resume', async () => {
        resolveEffectiveResume.mockResolvedValue(resume(210_000, true));
        expect(await startPositionMs()).toBe(210_000);
    });

    // The catalog says 7 min, the file is a 10 min extended cut: 7.5 min is the
    // middle of THIS file, not past the end of the title.
    it('judges against the file duration, not the catalog runtime', async () => {
        getDefaultFileDurationMs.mockResolvedValue(600_000);
        resolveEffectiveResume.mockResolvedValue(resume(450_000, false));
        expect(await startPositionMs()).toBe(450_000);
    });

    it('keeps the resume when the file duration is unknown (the player clamps the end)', async () => {
        getDefaultFileDurationMs.mockResolvedValue(null);
        resolveEffectiveResume.mockResolvedValue(resume(420_059, true));
        expect(await startPositionMs()).toBe(420_059);
    });

    it('keeps the resume when the duration read fails', async () => {
        getDefaultFileDurationMs.mockRejectedValue(new Error('db down'));
        resolveEffectiveResume.mockResolvedValue(resume(210_000, true));
        expect(await startPositionMs()).toBe(210_000);
    });
});

describe('/watch/<episodeId> — combined multi-episode file', () => {
    const SERIES = '44444444-4444-4444-8444-444444444444';
    const E24 = '55555555-5555-4555-8555-555555555524';
    const E25 = '55555555-5555-4555-8555-555555555525';
    const E25_ROW = {
        id: E25,
        title: 'Twenty-Five',
        media_type: 'episode',
        runtime_seconds: 660,
        has_files: true,
        series_id: SERIES,
        series_title: 'Show',
        season_number: 2,
        episode_number: 25,
    };
    const SIBLINGS = [
        { id: E24, episode_number: 24, title: 'A', start_offset_ms: '0', end_offset_ms: '660000' },
        {
            id: E25,
            episode_number: 25,
            title: 'B',
            start_offset_ms: '660000',
            end_offset_ms: '1320000',
        },
    ];

    beforeEach(() => {
        getMediaItemForWatch.mockResolvedValue(E25_ROW);
        getFileSiblingEpisodes.mockResolvedValue(SIBLINGS);
        // Unprobed: the episode windows are all there is to judge against.
        getDefaultFileDurationMs.mockResolvedValue(null);
    });

    // Positions are file-absolute: 692 s is half a minute into episode 25, not
    // 105 % of its 660 s runtime.
    it('keeps a file-absolute resume past one episode runtime', async () => {
        resolveEffectiveResume.mockResolvedValue(resume(692_000, false));
        expect(await startPositionMs(E25)).toBe(692_000);
    });

    it('starts from 0 when the resume is at the end of the whole file', async () => {
        resolveEffectiveResume.mockResolvedValue(resume(1_319_000, true));
        expect(await startPositionMs(E25)).toBe(0);
    });
});

describe('/watch — playback-aware next episode', () => {
    it.each([true, false])(
        'requests the episode after the whole default file and gates its visibility (allowed=%s)',
        async (allowed) => {
            const seriesId = '44444444-4444-4444-8444-444444444444';
            const episodeId = '55555555-5555-4555-8555-555555555501';
            const nextId = '55555555-5555-4555-8555-555555555503';
            checkMediaAccess.mockImplementation(
                async (_sql: unknown, id: string) => id !== nextId || allowed,
            );
            getMediaItemForWatch.mockResolvedValue({
                ...MOVIE_ROW,
                id: episodeId,
                media_type: 'episode',
                series_id: seriesId,
                series_title: 'Combined Show',
                season_number: 1,
                episode_number: 1,
            });
            resolveEffectiveResume.mockResolvedValue(resume(0, false));
            findNextSequentialEpisode.mockResolvedValue({
                id: nextId,
                title: 'Third',
                season_number: 1,
                episode_number: 3,
                is_new_season: false,
                has_primary_image: false,
                overview: null,
            });
            const result = await load({
                params: { itemId: episodeId },
                locals: { user: { username: 'alice', userId: 'user-1' } },
                url: new URL(`http://localhost/watch/${episodeId}`),
            } as unknown as Parameters<typeof load>[0]);
            // The caller's access boundary goes into the SQL, and playback
            // chaining keeps specials in season 0.
            expect(findNextSequentialEpisode).toHaveBeenCalledWith({}, seriesId, episodeId, {
                afterCurrentFile: true,
                playableOnly: true,
                specialsStayInSeason: true,
                access: ACCESS_BOUNDARY,
            });
            expect(checkMediaAccess).toHaveBeenCalledWith({}, episodeId, expect.anything());
            expect(checkMediaAccess).toHaveBeenCalledWith({}, nextId, expect.anything());
            if (allowed) {
                expect(result).toMatchObject({ playbackInfo: { nextEpisode: { itemId: nextId } } });
            } else {
                expect(result).toMatchObject({ playbackInfo: { nextEpisode: undefined } });
            }
        },
    );
});
