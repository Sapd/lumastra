// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/download-list: the season queue the web UI downloads from.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckBatch = vi.fn();
const mockCheckAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckAccess(...a),
    checkMediaAccessBatch: (...a: unknown[]) => mockCheckBatch(...a),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('../../catalog/resolve-id.js', () => ({
    resolveCatalogInternalId: async (e: RequestEvent) => e.params.id ?? null,
}));

const mockRoot = vi.fn();
const mockEpisodes = vi.fn();
const mockSingle = vi.fn();
vi.mock('$lib/server/database/queries/download-list.queries.js', () => ({
    getDownloadListRoot: (...a: unknown[]) => mockRoot(...a),
    listEpisodeDownloadRows: (...a: unknown[]) => mockEpisodes(...a),
    getSingleDownloadRow: (...a: unknown[]) => mockSingle(...a),
}));

const mockCanDownload = vi.fn();
vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: (...a: unknown[]) => mockCanDownload(...a),
    userMayDownload: vi.fn(),
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (t, k, r) => (k === 'DOWNLOAD_MAX_PARALLEL_PER_USER' ? 3 : Reflect.get(t, k, r)),
        }),
    };
});

const { def } = await import('./download-list.js');

function ep(
    id: string,
    season: number | null,
    episode: number | null,
    over: Record<string, unknown> = {},
) {
    return {
        id,
        title: `Ep ${id}`,
        year: null,
        media_type: 'episode',
        season_number: season,
        episode_number: episode,
        series_title: 'Show: Name',
        file_id: `f-${id}`,
        file_path: `/media/x/${id}.mkv`,
        file_size_bytes: 1000,
        is_missing: false,
        ...over,
    };
}

async function call(query = '', id = 'series1') {
    const url = `http://localhost/api/media/${id}/download-list${query}`;
    const res = await def.handlers.GET!(
        {
            locals: { user: { userId: 'u1', username: 'alice' }, principal: { isAdmin: false } },
            url: new URL(url),
            params: { id },
            request: new Request(url),
        } as unknown as RequestEvent,
        { surface: 'internal' } as never,
    );
    return { res, body: res.status === 200 ? await res.json() : null };
}

describe('media/{id}/download-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCanDownload.mockResolvedValue(true);
        mockCheckAccess.mockResolvedValue(true);
        mockCheckBatch.mockImplementation(async (_s: unknown, ids: string[]) => new Set(ids));
        mockRoot.mockResolvedValue({
            id: 'series1',
            title: 'Show: Name',
            year: 2004,
            media_type: 'tv',
        });
        mockEpisodes.mockResolvedValue([
            ep('e2-1', 2, 1),
            ep('s0-1', 0, 1),
            ep('e1-2', 1, 2),
            ep('e1-1', 1, 1),
        ]);
    });

    it('lists a series by season and episode, specials excluded by default', async () => {
        const { body } = await call();
        expect(body.allowed).toBe(true);
        expect(body.maxParallel).toBe(3);
        expect(body.seriesFolder).toBe('Show Name (2004)');
        expect(body.items.map((i: { mediaItemId: string }) => i.mediaItemId)).toEqual([
            'e1-1',
            'e1-2',
            'e2-1',
        ]);
        expect(body.items[0]).toMatchObject({
            fileId: 'f-e1-1',
            season: 1,
            episode: 1,
            seasonFolder: 'Season 01',
            fileName: 'Show Name - S01E01 - Ep e1-1.mkv',
            sizeBytes: 1000,
            available: true,
        });
    });

    it('specials=1 adds season 0 first, folder "Specials"', async () => {
        const { body } = await call('?specials=1');
        expect(body.items[0]).toMatchObject({ mediaItemId: 's0-1', seasonFolder: 'Specials' });
        expect(body.items).toHaveLength(4);
    });

    it('season=2 returns only that season', async () => {
        const { body } = await call('?season=2');
        expect(body.items.map((i: { mediaItemId: string }) => i.mediaItemId)).toEqual(['e2-1']);
    });

    it('omits an episode the user may not access (age or library)', async () => {
        mockCheckBatch.mockImplementation(
            async (_s: unknown, ids: string[]) => new Set(ids.filter((i) => i !== 'e1-2')),
        );
        const { body } = await call();
        expect(body.items.map((i: { mediaItemId: string }) => i.mediaItemId)).toEqual([
            'e1-1',
            'e2-1',
        ]);
    });

    it('marks a missing file unavailable', async () => {
        mockEpisodes.mockResolvedValue([ep('e1-1', 1, 1, { is_missing: true })]);
        const { body } = await call();
        expect(body.items[0].available).toBe(false);
    });

    it('allowed is false when the download gate is closed', async () => {
        mockCanDownload.mockResolvedValue(false);
        const { body } = await call();
        expect(body.allowed).toBe(false);
    });

    it('a movie is one item with no season folder', async () => {
        mockRoot.mockResolvedValue({ id: 'm1', title: 'Film', year: null, media_type: 'movie' });
        mockSingle.mockResolvedValue(
            ep('m1', null, null, { media_type: 'movie', title: 'Film', series_title: null }),
        );
        const { body } = await call('', 'm1');
        expect(body.seriesFolder).toBe('Film');
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
            seasonFolder: null,
            season: null,
            fileName: 'Film.mkv',
        });
    });

    it('404 for an item the user cannot access', async () => {
        mockCheckAccess.mockResolvedValue(false);
        const { res } = await call();
        expect(res.status).toBe(404);
    });

    it('missingCount counts accessible episodes without a file row', async () => {
        mockEpisodes.mockResolvedValue([
            ep('e1-1', 1, 1),
            ep('e1-2', 1, 2, { file_id: null, file_path: null }),
            ep('e1-3', 1, 3, { file_id: null, file_path: null }),
        ]);
        mockCheckBatch.mockImplementation(
            async (_s: unknown, ids: string[]) => new Set(ids.filter((i) => i !== 'e1-3')),
        );
        const { body } = await call();
        expect(body.items).toHaveLength(1);
        expect(body.missingCount).toBe(1);
    });

    it('a single episode gets the series folder, season folder and the series-prefixed name', async () => {
        mockRoot.mockResolvedValue({ id: 'e1', title: 'Pilot', year: null, media_type: 'episode' });
        mockSingle.mockResolvedValue(
            ep('e1', 1, 1, { title: 'Pilot', series_title: 'Show', series_year: 2004 }),
        );
        const { body } = await call('', 'e1');
        expect(body.seriesFolder).toBe('Show (2004)');
        expect(body.missingCount).toBe(0);
        expect(body.items[0]).toMatchObject({
            seasonFolder: 'Season 01',
            fileName: 'Show - S01E01 - Pilot.mkv',
        });
    });
});
