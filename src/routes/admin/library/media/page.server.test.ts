// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The media browser load's `?filter=` wiring.
 *
 * `resolveBrowserFilter` is unit-tested next door, but a correct mapper that
 * the load never hands to the query layer is an unfiltered list rendered under
 * a filtered heading — nothing throws, and the badge that linked here reports a
 * number the page contradicts. This asserts at the SEAM: what the query module
 * actually receives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listAdminMediaItemsMock = vi.fn();
const countAdminMediaItemsMock = vi.fn();
const countAdminMediaViewsMock = vi.fn();
const jellyfinSync = vi.hoisted(() => ({ value: false }));
const getLibraryGroupsWithCountsMock = vi.fn();

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
vi.mock('$lib/server/database/queries/series-health.queries.js', () => ({
    getSeasonCoverageBatch: async () => [],
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getAdminDb: () => ({}) as unknown,
}));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupsWithCounts: (...args: unknown[]) => getLibraryGroupsWithCountsMock(...args),
}));
vi.mock('$lib/server/database/queries/admin-media.queries.js', () => ({
    listAdminMediaItems: (...args: unknown[]) => listAdminMediaItemsMock(...args),
    countAdminMediaItems: (...args: unknown[]) => countAdminMediaItemsMock(...args),
    countAdminMediaViews: (...args: unknown[]) => countAdminMediaViewsMock(...args),
}));

// The shared short-TTL cache is Valkey-backed; here it is a pass-through so
// every test sees its own query mocks rather than a previous test's cached value.
vi.mock('$lib/server/services/admin-media-browser-cache.js', () => ({
    getCachedMediaBrowserViewCounts: (_key: string, compute: () => Promise<unknown>) => compute(),
    getCachedMediaBrowserLibraryGroups: (compute: () => Promise<unknown>) => compute(),
}));

vi.mock('$lib/server/config.js', () => ({
    features: {
        get jellyfinSync() {
            return jellyfinSync.value;
        },
    },
}));

import { actions, load } from './+page.server.js';
import { MUSIC_HYGIENE_FINDINGS, MUSIC_HYGIENE_VIEW } from '$lib/shared/music-hygiene.js';

interface QueryOpts {
    types: string[];
    musicHygiene?: string;
    fileIssues?: boolean;
}

interface LoadResult {
    activeFilters: { music_hygiene: string | null; file_issues: boolean };
}

interface QueueRefreshData {
    page: number;
    total: number;
    pageSize: number;
    activeFilters: { music_hygiene: string | null };
    items: unknown[];
}

interface QueueRefreshActionResult {
    browserData: QueueRefreshData;
    correctedPage: number;
}

async function runLoad(
    search: string,
    cookieJar: Record<string, string> = {},
): Promise<LoadResult> {
    const url = new URL(`https://example.invalid/admin/library/media?${search}`);
    return (await load({
        url,
        locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
        cookies: { get: (name: string) => cookieJar[name] },
    } as never)) as unknown as LoadResult;
}

/** Empty-but-well-shaped responses so `load` reaches its return statement. */
function primeMocks(): void {
    vi.clearAllMocks();
    listAdminMediaItemsMock.mockResolvedValue([]);
    countAdminMediaItemsMock.mockResolvedValue(0);
    getLibraryGroupsWithCountsMock.mockResolvedValue([]);
    countAdminMediaViewsMock.mockResolvedValue({});
    jellyfinSync.value = false;
}

describe('media browser load — ?filter= wiring', () => {
    beforeEach(primeMocks);

    it('passes each music-hygiene finding to BOTH the list and the count', async () => {
        for (const finding of MUSIC_HYGIENE_FINDINGS) {
            primeMocks();
            const view = MUSIC_HYGIENE_VIEW[finding];
            const result = await runLoad(
                `filter=${finding}&domain=${view.domain}&type=${view.type}`,
            );

            const listOpts = listAdminMediaItemsMock.mock.calls[0]![1] as QueryOpts;
            const countOpts = countAdminMediaItemsMock.mock.calls[0]![1] as QueryOpts;
            // The count feeding the page's own total must carry the same
            // predicate as the page — that pair is the parity the operator sees.
            expect(listOpts.musicHygiene, finding).toBe(finding);
            expect(countOpts.musicHygiene, finding).toBe(finding);
            expect(listOpts.types, finding).toEqual([view.type]);
            expect(countOpts.types, finding).toEqual([view.type]);
            expect(listOpts.fileIssues, finding).toBeUndefined();
            // The chip needs the finding id, not a boolean, to name which one.
            expect(result.activeFilters.music_hygiene, finding).toBe(finding);
        }
    });

    it('keeps file-issues working and carries no hygiene finding', async () => {
        const result = await runLoad('filter=file-issues&domain=everything&type=all');
        const listOpts = listAdminMediaItemsMock.mock.calls[0]![1] as QueryOpts;
        expect(listOpts.fileIssues).toBe(true);
        expect(listOpts.musicHygiene).toBeUndefined();
        expect(result.activeFilters.music_hygiene).toBeNull();
    });

    it('treats an unknown filter value as no filter at all', async () => {
        const result = await runLoad('filter=music-invented-by-a-newer-build');
        const listOpts = listAdminMediaItemsMock.mock.calls[0]![1] as QueryOpts;
        expect(listOpts.musicHygiene).toBeUndefined();
        expect(listOpts.fileIssues).toBeUndefined();
        expect(result.activeFilters.music_hygiene).toBeNull();
    });
});

/**
 * Saved views (triage spec §2): what `?view=` hands the query layer. Asserted
 * at the seam — the list AND the count receive the same view options, and the
 * view-count query receives exactly the views the page offers.
 */
describe('media browser load — ?view= wiring', () => {
    beforeEach(primeMocks);

    function lastOpts(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
        return mock.mock.calls.at(-1)![1] as Record<string, unknown>;
    }

    it('passes a problem view as the same issue to the list and the count', async () => {
        const result = await runLoad('view=artwork');
        expect(lastOpts(listAdminMediaItemsMock).issue).toBe('no_poster');
        expect(lastOpts(countAdminMediaItemsMock).issue).toBe('no_poster');
        expect((result as unknown as { view: string }).view).toBe('artwork');
    });

    it('Needs attention ORs the warning/error issues and includes unavailable rows', async () => {
        await runLoad('view=attention');
        const opts = lastOpts(listAdminMediaItemsMock);
        expect(opts.showUnavailable).toBe(true);
        expect(opts.attentionKinds).toEqual(
            expect.arrayContaining(['files_lost', 'file_problem', 'no_tmdb', 'no_poster']),
        );
        expect(opts.attentionKinds).not.toContain('not_in_jellyfin');
        expect(lastOpts(countAdminMediaItemsMock).attentionKinds).toEqual(opts.attentionKinds);
    });

    it('canonicalizes an unsupported issue view so the URL agrees with All', async () => {
        await expect(runLoad('view=duplicates&domain=music')).rejects.toMatchObject({
            status: 303,
            location: '/admin/library/media?domain=music',
        });
        await expect(runLoad('view=jellyfin')).rejects.toMatchObject({
            status: 303,
            location: '/admin/library/media',
        });
        expect(listAdminMediaItemsMock).not.toHaveBeenCalled();
    });

    it('offers Not in Jellyfin only while Jellyfin sync is on', async () => {
        const off = (await runLoad('')) as unknown as { availableViews: string[] };
        expect(off.availableViews).not.toContain('jellyfin');

        jellyfinSync.value = true;
        const on = (await runLoad('view=jellyfin')) as unknown as {
            availableViews: string[];
            view: string;
        };
        expect(on.availableViews).toContain('jellyfin');
        expect(on.view).toBe('jellyfin');
        expect(lastOpts(listAdminMediaItemsMock).issue).toBe('not_in_jellyfin');
    });

    it('asks the view-count query for exactly the offered views', async () => {
        const result = (await runLoad('')) as unknown as { availableViews: string[] };
        const spec = countAdminMediaViewsMock.mock.calls.at(-1)![2] as {
            views: Array<{ id: string }>;
        };
        expect(spec.views.map((v) => v.id)).toEqual(result.availableViews);
    });
});

describe('media browser load — page size, layout and A–Z jump', () => {
    beforeEach(primeMocks);

    it('reads the page size from its cookie and clamps anything else to 50', async () => {
        await runLoad('', { admin_media_page_size: '100' });
        expect((listAdminMediaItemsMock.mock.calls.at(-1)![1] as { limit: number }).limit).toBe(
            100,
        );

        await runLoad('', { admin_media_page_size: '5000' });
        expect((listAdminMediaItemsMock.mock.calls.at(-1)![1] as { limit: number }).limit).toBe(50);
    });

    it('reads the layout from its cookie', async () => {
        const grid = (await runLoad('', { admin_media_layout: 'grid' })) as unknown as {
            layout: string;
        };
        expect(grid.layout).toBe('grid');
        const list = (await runLoad('')) as unknown as { layout: string };
        expect(list.layout).toBe('list');
    });

    /**
     * 120 rows sort before "C" at 50 per page: rows 121+ start on page 3.
     * Revert-check: drop the `+ 1` and this lands on page 2.
     */
    it('redirects a letter jump to the page the letter starts on', async () => {
        countAdminMediaItemsMock.mockResolvedValueOnce(120);
        await expect(runLoad('jump=c&view=artwork')).rejects.toMatchObject({
            status: 303,
            location: '/admin/library/media?view=artwork&page=3',
        });
        const opts = countAdminMediaItemsMock.mock.calls.at(-1)![1] as Record<string, unknown>;
        expect(opts.titleBefore).toBe('C');
        expect(opts.issue).toBe('no_poster');
    });

    it('sends # and non-title sorts to page 1 without counting', async () => {
        await expect(runLoad('jump=%23&page=4')).rejects.toMatchObject({
            location: '/admin/library/media',
        });
        await expect(runLoad('jump=B&sort=year')).rejects.toMatchObject({
            location: '/admin/library/media?sort=year',
        });
        expect(countAdminMediaItemsMock).not.toHaveBeenCalled();
    });
});

describe('media browser read-only queue refresh action', () => {
    beforeEach(primeMocks);

    function actionEvent(
        search: string,
        locals: { user: { ownerIsAdmin: boolean }; principal: { isAdmin: boolean } } = {
            user: { ownerIsAdmin: true },
            principal: { isAdmin: true },
        },
    ) {
        return {
            url: new URL(`https://example.invalid/admin/library/media?${search}`),
            locals,
            cookies: { get: () => undefined },
        } as never;
    }

    it('reuses the explicit admin gate before reading queue data', async () => {
        await expect(
            actions.refreshSingleActQueue(
                actionEvent('filter=music-artist-unsplit', {
                    user: { ownerIsAdmin: false },
                    principal: { isAdmin: false },
                }),
            ),
        ).resolves.toMatchObject({ status: 403 });
        expect(countAdminMediaItemsMock).not.toHaveBeenCalled();
        expect(listAdminMediaItemsMock).not.toHaveBeenCalled();
    });

    it('returns the same scoped browser data and clamps an emptied last page', async () => {
        const result = await actions.refreshSingleActQueue(
            actionEvent(
                'domain=music&filter=music-artist-unsplit&q=lantern&page=3&sort=title&order=desc',
            ),
        );
        const actionResult = result as QueueRefreshActionResult;
        const browserData = actionResult.browserData;
        const listCalls = listAdminMediaItemsMock.mock.calls.map(
            (call) =>
                call[1] as {
                    musicHygiene?: string;
                    query?: string;
                    offset: number;
                    sortBy: string;
                    sortDir: string;
                },
        );
        const countCalls = countAdminMediaItemsMock.mock.calls.map(
            (call) => call[1] as { musicHygiene?: string; query?: string },
        );

        expect(browserData).toMatchObject({
            page: 1,
            total: 0,
            pageSize: 50,
            activeFilters: { music_hygiene: 'music-artist-unsplit' },
            items: [],
        });
        expect(actionResult.correctedPage).toBe(1);
        expect(listCalls).toHaveLength(2);
        expect(listCalls.map(({ offset }) => offset)).toEqual([100, 0]);
        for (const call of [...listCalls, ...countCalls]) {
            expect(call.musicHygiene).toBe('music-artist-unsplit');
            expect(call.query).toBe('lantern');
        }
        expect(listCalls.map(({ sortBy, sortDir }) => [sortBy, sortDir])).toEqual([
            ['title', 'desc'],
            ['title', 'desc'],
        ]);
    });
});

/**
 * The selected view's pill shows the list's fresh total when both cover the
 * same population, so a fix that removes a row updates the number at once.
 */
describe('media browser load — selected view count', () => {
    beforeEach(primeMocks);

    it('replaces the cached count of the selected view with the list total', async () => {
        countAdminMediaViewsMock.mockResolvedValue({ all: 50, artwork: 9 });
        countAdminMediaItemsMock.mockResolvedValue(7);
        const result = (await runLoad('view=artwork')) as unknown as {
            viewCounts: Record<string, number>;
        };
        expect(result.viewCounts).toEqual({ all: 50, artwork: 7 });
    });

    it('keeps the cached count while a search narrows the list', async () => {
        countAdminMediaViewsMock.mockResolvedValue({ all: 50, artwork: 9 });
        countAdminMediaItemsMock.mockResolvedValue(2);
        const result = (await runLoad('view=artwork&q=matrix')) as unknown as {
            viewCounts: Record<string, number>;
        };
        expect(result.viewCounts.artwork).toBe(9);
    });

    it('keeps the cached count while an advanced filter or the catalog toggle is on', async () => {
        countAdminMediaViewsMock.mockResolvedValue({ all: 50 });
        countAdminMediaItemsMock.mockResolvedValue(3);
        const filtered = (await runLoad('missing_poster=1')) as unknown as {
            viewCounts: Record<string, number>;
        };
        expect(filtered.viewCounts.all).toBe(50);
        const catalog = (await runLoad('unavailable=1')) as unknown as {
            viewCounts: Record<string, number>;
        };
        expect(catalog.viewCounts.all).toBe(50);
    });
});

describe('media browser load — search type scope', () => {
    beforeEach(primeMocks);

    function lastTypes(): string[] {
        return (listAdminMediaItemsMock.mock.calls.at(-1)?.[1] as QueryOpts).types;
    }

    // Music defaults to Artists, and a match only expands DOWN to children, so a
    // search scoped to artists never finds an album or track by its own title
    // ("WoW Oldschool PVP Music Vol 4" on prod: 0 rows under Artists).
    it('searches every music type when no type was chosen', async () => {
        const result = (await runLoad('domain=music&q=pvp')) as unknown as { typeFilter: string };
        expect(lastTypes()).toEqual(expect.arrayContaining(['artist', 'album', 'track']));
        expect(result.typeFilter).toBe('music');
    });

    it('keeps the Artists default while browsing without a search', async () => {
        await runLoad('domain=music');
        expect(lastTypes()).toEqual(['artist']);
    });

    it('honours an explicitly chosen type during a search', async () => {
        await runLoad('domain=music&type=artist&q=pvp');
        expect(lastTypes()).toEqual(['artist']);
    });
});

describe('media browser load — hostile query params', () => {
    beforeEach(primeMocks);

    it.each(['constructor', '__proto__', 'toString'])(
        'added_since=%s is ignored instead of throwing',
        async (value) => {
            await runLoad(`added_since=${value}`);
            const opts = listAdminMediaItemsMock.mock.calls[0]![1] as { addedSince?: string };
            expect(opts.addedSince).toBeUndefined();
        },
    );

    it('drops a non-uuid library id before it reaches the uuid cast', async () => {
        await runLoad('library=not-a-uuid');
        const opts = listAdminMediaItemsMock.mock.calls[0]![1] as { libraryGroupId?: string };
        expect(opts.libraryGroupId || undefined).toBeUndefined();
    });

    it('keeps a real library id', async () => {
        const id = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
        await runLoad(`library=${id}`);
        const opts = listAdminMediaItemsMock.mock.calls[0]![1] as { libraryGroupId?: string };
        expect(opts.libraryGroupId).toBe(id);
    });
});
