// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix matches load: the `?library=` scope reaches EVERY query the page runs —
 * the Broken-match list, its count, and the Never-matched badge count — and an
 * id that names no library is dropped instead of reaching the ::uuid casts.
 * Asserts at the seam: what the query modules receive.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const countReidentifyItemsMock = vi.fn();
const loadReidentifyQueueMock = vi.fn();
const countPersonalMediaItemsMock = vi.fn();
const getAllLibraryGroupsMock = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}) as unknown,
}));
vi.mock('$lib/server/database/queries/ingest-map.queries.js', () => ({
    countReidentifyItems: (...args: unknown[]) => countReidentifyItemsMock(...args),
    loadReidentifyQueue: (...args: unknown[]) => loadReidentifyQueueMock(...args),
}));
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    countPersonalMediaItems: (...args: unknown[]) => countPersonalMediaItemsMock(...args),
}));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getAllLibraryGroups: (...args: unknown[]) => getAllLibraryGroupsMock(...args),
}));

import { load, type FixMatchesPageData } from './+page.server.js';

// Names say nothing about content — "Evening" holds movies, "Harbor" audiobooks.
const EVENING = '0f1e2d3c-4b5a-4968-8776-655443322110';
const HARBOR = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';

async function runLoad(search: string): Promise<FixMatchesPageData> {
    const url = new URL(`https://example.invalid/admin/library/fix-matches?${search}`);
    return (await load({
        url,
        locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
    } as never)) as FixMatchesPageData;
}

beforeEach(() => {
    vi.clearAllMocks();
    countReidentifyItemsMock.mockResolvedValue(0);
    loadReidentifyQueueMock.mockResolvedValue([]);
    countPersonalMediaItemsMock.mockResolvedValue(0);
    getAllLibraryGroupsMock.mockResolvedValue([
        { id: EVENING, name: 'evening', display_name: 'Evening' },
        { id: HARBOR, name: 'harbor', display_name: '  ' },
    ]);
});

describe('fix-matches load — ?library=', () => {
    it('scopes the broken-match list, its count and the never-matched count', async () => {
        const data = await runLoad(`view=broken&library=${EVENING}&q=x&type=movie`);

        expect(data.libraryGroupId).toBe(EVENING);
        expect(countReidentifyItemsMock).toHaveBeenCalledWith(expect.anything(), {
            search: 'x',
            mediaType: 'movie',
            libraryGroupId: EVENING,
        });
        expect(loadReidentifyQueueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ libraryGroupId: EVENING, search: 'x', mediaType: 'movie' }),
        );
        expect(countPersonalMediaItemsMock).toHaveBeenCalledWith(expect.anything(), {
            libraryGroupId: EVENING,
        });
    });

    it('lists every library, falling back to the name when the display name is blank', async () => {
        const data = await runLoad('');

        expect(data.libraries).toEqual([
            { id: EVENING, name: 'Evening' },
            { id: HARBOR, name: 'harbor' },
        ]);
        expect(data.libraryGroupId).toBeNull();
        expect(countReidentifyItemsMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ libraryGroupId: undefined }),
        );
        expect(countPersonalMediaItemsMock).toHaveBeenCalledWith(expect.anything(), {
            libraryGroupId: undefined,
        });
    });

    it('ignores an id that names no library (and never passes a non-uuid on)', async () => {
        for (const bogus of ['not-a-uuid', '99999999-9999-4999-8999-999999999999']) {
            vi.clearAllMocks();
            const data = await runLoad(`library=${bogus}`);

            expect(data.libraryGroupId).toBeNull();
            expect(countReidentifyItemsMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ libraryGroupId: undefined }),
            );
        }
    });
});
