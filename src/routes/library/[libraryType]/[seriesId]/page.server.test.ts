// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The non-entertainment series page answers only for series the viewer may see.
 *
 * Its load used to call the raw query with nothing but the id, so a user denied
 * a library group (or above their age rating) got the series, its episode list
 * and every episode's absolute server file path from
 * `GET /library/<type>/<id>` or its `__data.json`. Found in the 2026-10-07
 * entry-point review.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSeriesWithEpisodes: vi.fn(),
    checkMediaAccess: vi.fn(),
    filterAccessibleMediaIds: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/non-entertainment-browse.queries.js', () => ({
    getSeriesWithEpisodes: mocks.getSeriesWithEpisodes,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mocks.checkMediaAccess,
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleMediaIds: mocks.filterAccessibleMediaIds,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: vi.fn(() => ({ library: { kind: 'all' }, age: { kind: 'any' } })),
}));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: { batchGetWatchStates: vi.fn(async () => new Map()) },
}));

import { load } from './+page.server';

const SERIES = { id: 'series-1', title: 'Garden diary', media_type: 'home_video' };
const EPISODES = [
    { id: 'ep-1', title: 'S01E01', file_name: 'spring-planting.mp4' },
    { id: 'ep-2', title: 'S01E02', file_name: 'summer.mp4' },
];
const USER = { userId: 'u-1', username: 'restricted', isAdmin: false };

type LoadEvent = Parameters<typeof load>[0];

function run(user: typeof USER | null = USER): ReturnType<typeof load> {
    return load({
        params: { libraryType: 'home_video', seriesId: SERIES.id },
        locals: { user: user ?? undefined },
        depends: vi.fn(),
    } as unknown as LoadEvent);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSeriesWithEpisodes.mockResolvedValue({ series: SERIES, episodes: EPISODES });
    mocks.checkMediaAccess.mockResolvedValue(true);
    mocks.filterAccessibleMediaIds.mockImplementation(
        async (_sql: unknown, ids: string[]) => new Set(ids),
    );
});

describe('/library/[libraryType]/[seriesId] load', () => {
    it('a series the viewer may not see is a 404, like a missing one', async () => {
        mocks.checkMediaAccess.mockResolvedValue(false);
        await expect(run()).rejects.toMatchObject({ status: 404 });
        expect(mocks.checkMediaAccess).toHaveBeenCalledWith({}, SERIES.id, USER);
    });

    it('drops episodes the viewer may not see from an accessible series', async () => {
        mocks.filterAccessibleMediaIds.mockResolvedValue(new Set(['ep-2']));
        const data = (await run()) as { episodes: Array<{ id: string }> };
        expect(data.episodes.map((e) => e.id)).toEqual(['ep-2']);
    });

    it('a series none of whose episodes the viewer may see is a 404 too', async () => {
        // The series row has no files, so checkMediaAccess alone passes it.
        mocks.filterAccessibleMediaIds.mockResolvedValue(new Set());
        await expect(run()).rejects.toMatchObject({ status: 404 });
    });

    it('fails closed without a user', async () => {
        await expect(run(null)).rejects.toMatchObject({ status: 404 });
        expect(mocks.getSeriesWithEpisodes).not.toHaveBeenCalled();
    });
});
