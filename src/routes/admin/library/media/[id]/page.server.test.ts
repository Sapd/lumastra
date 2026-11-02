// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EpisodeLanguageSummary } from '$lib/schemas/admin-language-summary.js';

const getEpisodeLanguageSummariesMock = vi.fn(
    async (_sql: unknown, _ids: string[]): Promise<Map<string, EpisodeLanguageSummary>> =>
        new Map(),
);
const getDbMock = vi.fn();
const getAllExternalIdsOneMock = vi.fn();
const getMediaItemLockStatusMock = vi.fn();
const getSeriesEpisodeCoverageMock = vi.fn();
const getFileHealthIssuesForItemTreeMock = vi.fn();
const getMediaFileSummaryMock = vi.fn();
const getLastProviderSyncAtMock = vi.fn();
const getMediaItemByIdMock = vi.fn();
const getMediaItemChildCountsMock = vi.fn();
const resolveAncestorChainMock = vi.fn();
const listAdminMediaItemsMock = vi.fn(async (): Promise<unknown[]> => []);
const getArtistAlbumCountMock = vi.fn();
const getAudiobookAdminDetailMock = vi.fn();
const listRunsMock = vi.fn();

vi.mock('$lib/server/database/queries/admin-language-summary.queries.js', () => ({
    getEpisodeLanguageSummaries: (sql: unknown, ids: string[]) =>
        getEpisodeLanguageSummariesMock(sql, ids),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => getDbMock() }));
vi.mock('$lib/server/database/queries/external-ids.queries.js', () => ({
    getAllExternalIds: { one: (...args: unknown[]) => getAllExternalIdsOneMock(...args) },
}));
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    getMediaItemLockStatus: (...args: unknown[]) => getMediaItemLockStatusMock(...args),
}));
vi.mock('$lib/server/database/queries/series-health.queries.js', () => ({
    getSeriesEpisodeCoverage: (...args: unknown[]) => getSeriesEpisodeCoverageMock(...args),
    getSeasonCoverageBatch: async () => [],
    coverageHealthStatus: () => 'healthy',
}));
vi.mock('$lib/server/utils/provider-config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/provider-config.js')>()),
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFileHealthIssuesForItemTree: (...args: unknown[]) =>
        getFileHealthIssuesForItemTreeMock(...args),
    getMediaFileSummary: (...args: unknown[]) => getMediaFileSummaryMock(...args),
}));
vi.mock('$lib/server/database/queries/admin-media.queries.js', () => ({
    getLastProviderSyncAt: (...args: unknown[]) => getLastProviderSyncAtMock(...args),
    getMediaItemById: (...args: unknown[]) => getMediaItemByIdMock(...args),
    getMediaItemChildCounts: (...args: unknown[]) => getMediaItemChildCountsMock(...args),
    resolveAncestorChain: (...args: unknown[]) => resolveAncestorChainMock(...args),
    // The issues strip reads the item's row through the browser's list query;
    // these tests are about other fields, so it finds no row.
    listAdminMediaItems: (...args: unknown[]) => listAdminMediaItemsMock(...(args as [])),
}));
vi.mock('$lib/server/database/queries/music-admin.queries.js', () => ({
    getMusicContainerSummary: async () => null,
    getArtistAlbumCount: (...args: unknown[]) => getArtistAlbumCountMock(...args),
}));
vi.mock('$lib/server/database/queries/audiobook-admin-detail.queries.js', () => ({
    getAudiobookAdminDetail: (...args: unknown[]) => getAudiobookAdminDetailMock(...args),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { MAX_IMAGE_UPLOAD_MB: 10, AUDIOURL: '' },
    features: { jellyfinSync: false },
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { listRuns: (...args: unknown[]) => listRunsMock(...args) },
}));
// The fixtures use readable ids ('ep-1', 'series-1'); the load's uuid guard
// keeps its real behaviour for everything else.
vi.mock('$lib/server/utils/media-key-parser.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/utils/media-key-parser.js')>();
    return {
        ...real,
        isUuid: (value: string) => real.isUuid(value) || /^[a-z]+-\d+$/.test(value),
    };
});
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn() }) },
}));

import { load } from './+page.server.js';

interface LoadShape {
    sidebarEntryCount: number | null;
    fileSummary: { count: number; totalBytes: number | null };
    fileSummaryDetermined: boolean;
}

const runLoad = async (mediaId: string): Promise<LoadShape> =>
    (await load({
        url: new URL(`https://example.invalid/admin/library/media/${mediaId}`),
        params: { id: mediaId },
        locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
        depends: vi.fn(),
    } as never)) as unknown as LoadShape;

beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({} as never);
    getAllExternalIdsOneMock.mockResolvedValue(null);
    getMediaItemLockStatusMock.mockResolvedValue(null);
    getSeriesEpisodeCoverageMock.mockResolvedValue(null);
    getFileHealthIssuesForItemTreeMock.mockResolvedValue([]);
    getLastProviderSyncAtMock.mockResolvedValue(undefined);
    getArtistAlbumCountMock.mockResolvedValue(null);
    getAudiobookAdminDetailMock.mockResolvedValue(null);
    listRunsMock.mockResolvedValue({ runs: [] });
    listAdminMediaItemsMock.mockResolvedValue([]);
});

// A single-season show: one season ('season-1') holding twelve episodes,
// under series 'series-1'. `ep-1` is one of those twelve episodes.
function seedEpisodePage(): void {
    getMediaItemByIdMock.mockImplementation((_sql: unknown, id: string) => {
        if (id === 'ep-1') {
            return Promise.resolve({
                id: 'ep-1',
                title: 'Pilot',
                original_title: null,
                english_title: null,
                year: null,
                media_type: 'episode',
                status: null,
                parent_id: 'season-1',
                season_number: 1,
                episode_number: 1,
                runtime_seconds: null,
                premiere_date: null,
                overview: null,
                created_at: new Date(),
                updated_at: new Date(),
                custom_metadata: null,
            });
        }
        return Promise.resolve(undefined);
    });
    resolveAncestorChainMock.mockResolvedValue([
        {
            id: 'season-1',
            title: 'Season 1',
            media_type: 'season',
            season_number: 1,
            parent_id: 'series-1',
            depth: 1,
        },
        {
            id: 'series-1',
            title: 'The Show',
            media_type: 'tv',
            season_number: null,
            parent_id: null,
            depth: 2,
        },
    ]);
    // Single season overall (seasonCount === 1), but that one season holds
    // twelve episodes.
    getMediaItemChildCountsMock.mockImplementation((_sql: unknown, id: string) => {
        if (id === 'series-1') return Promise.resolve({ seasonCount: 1, episodeCount: 12 });
        if (id === 'season-1') return Promise.resolve({ seasonCount: 0, episodeCount: 12 });
        throw new Error(`unexpected getMediaItemChildCounts id: ${id}`);
    });
    getMediaFileSummaryMock.mockResolvedValue({ count: 1, totalBytes: 100 });
}

describe('sidebarEntryCount on an episode page (Finding 1)', () => {
    it("counts the episodes in this item's own season, not just the series season total", async () => {
        // MediaHierarchySidebar auto-expands the season containing
        // `currentItemId` whenever that id matches one of its episodes — which
        // is exactly what happens on an episode page. So the sidebar renders
        // the series' season row(s) PLUS every episode in this episode's own
        // season, not the season count alone.
        //
        // If +page.server.ts reverts to counting only the series' season total
        // for episode pages (`sidebarEntryCount = seriesCounts.seasonCount`),
        // this single-season show yields sidebarEntryCount === 1, which
        // `shouldAutoCollapseByEntryCount` treats as trivial (<=2) and
        // collapses — hiding the sidebar that is the ONLY way to reach a
        // sibling episode (the Episodes tab excludes episode pages). This test
        // fails against that reverted behaviour.
        seedEpisodePage();

        const data = await runLoad('ep-1');

        // seriesCounts.seasonCount (1) + seasonCounts.episodeCount (12) = 13
        expect(data.sidebarEntryCount).toBe(13);
        expect(getEpisodeLanguageSummariesMock).toHaveBeenCalledWith(expect.anything(), ['ep-1']);
    });
});

describe('fileSummaryDetermined fails open on a query failure (Finding 2)', () => {
    it('degrades fileSummary to zero but marks it as UNDETERMINED when the query throws', async () => {
        // Reverting the fail-open fix collapses "we could not tell" into the
        // same shape as "this item genuinely has zero files"
        // (`{ count: 0, totalBytes: null }`, no other signal). That silently
        // removed a working Watch link from an item that does have files.
        // This test fails against that reverted behaviour because
        // `fileSummaryDetermined` would not exist / would be `true`.
        getMediaItemByIdMock.mockResolvedValue({
            id: 'movie-1',
            title: 'A Movie',
            original_title: null,
            english_title: null,
            year: null,
            media_type: 'movie',
            status: null,
            parent_id: null,
            season_number: null,
            episode_number: null,
            runtime_seconds: null,
            premiere_date: null,
            overview: null,
            created_at: new Date(),
            updated_at: new Date(),
            custom_metadata: null,
        });
        getMediaFileSummaryMock.mockRejectedValue(new Error('ECONNREFUSED'));

        const data = await runLoad('movie-1');

        expect(data.fileSummary).toEqual({ count: 0, totalBytes: null });
        expect(data.fileSummaryDetermined).toBe(false);
    });

    it('marks fileSummary as DETERMINED when the query genuinely resolves to zero', async () => {
        getMediaItemByIdMock.mockResolvedValue({
            id: 'movie-2',
            title: 'Another Movie',
            original_title: null,
            english_title: null,
            year: null,
            media_type: 'movie',
            status: null,
            parent_id: null,
            season_number: null,
            episode_number: null,
            runtime_seconds: null,
            premiere_date: null,
            overview: null,
            created_at: new Date(),
            updated_at: new Date(),
            custom_metadata: null,
        });
        getMediaFileSummaryMock.mockResolvedValue({ count: 0, totalBytes: null });

        const data = await runLoad('movie-2');

        expect(data.fileSummary).toEqual({ count: 0, totalBytes: null });
        expect(data.fileSummaryDetermined).toBe(true);
    });

    it("marks an audiobook's zero as DETERMINED (by design, not a fallback)", async () => {
        getMediaItemByIdMock.mockResolvedValue({
            id: 'book-1',
            title: 'A Book',
            original_title: null,
            english_title: null,
            year: null,
            media_type: 'audiobook',
            status: null,
            parent_id: null,
            season_number: null,
            episode_number: null,
            runtime_seconds: null,
            premiere_date: null,
            overview: null,
            created_at: new Date(),
            updated_at: new Date(),
            custom_metadata: null,
        });

        const data = await runLoad('book-1');

        // getMediaFileSummary must not even be consulted for an audiobook.
        expect(getMediaFileSummaryMock).not.toHaveBeenCalled();
        expect(data.fileSummary).toEqual({ count: 0, totalBytes: null });
        expect(data.fileSummaryDetermined).toBe(true);
    });
});

/**
 * The issues strip (triage spec §7) reads the item's row through the
 * browser's own list query and mapping. Its own file problems are left to
 * FileIssuesPanel; a series' rolled-up episode problems are kept.
 */
describe('issues strip', () => {
    function row(extra: Record<string, unknown>): Record<string, unknown> {
        return {
            id: 'ep-1',
            media_type: 'episode',
            has_files: true,
            files_lost: false,
            tmdb_id: null,
            has_poster: false,
            has_overview: false,
            jellyfin_id: 'jf',
            is_duplicate: false,
            episode_problem_count: 0,
            health_issue_types: ['truncated_video'],
            health_issue_details: [],
            integrity_issues: [],
            ...extra,
        };
    }

    it('passes the item issues through, without its own file problems', async () => {
        seedEpisodePage();
        listAdminMediaItemsMock.mockResolvedValue([row({})]);
        const result = (await runLoad('ep-1')) as unknown as { issues: Array<{ kind: string }> };
        expect(result.issues.map((i) => i.kind)).toEqual(['no_overview']);
        expect(listAdminMediaItemsMock.mock.calls[0]).toBeDefined();
        const opts = (listAdminMediaItemsMock.mock.calls[0] as unknown[])[1] as Record<
            string,
            unknown
        >;
        expect(opts).toMatchObject({
            itemIds: ['ep-1'],
            types: ['episode'],
            showUnavailable: true,
        });
    });

    it('keeps a series rolled-up episode problem', async () => {
        seedEpisodePage();
        listAdminMediaItemsMock.mockResolvedValue([
            row({
                media_type: 'tv',
                has_overview: true,
                has_poster: true,
                tmdb_id: '1',
                health_issue_types: [],
                episode_problem_count: 2,
            }),
        ]);
        const result = (await runLoad('ep-1')) as unknown as {
            issues: Array<{ kind: string; subtype?: string }>;
        };
        expect(result.issues).toEqual([
            expect.objectContaining({ kind: 'file_problem', subtype: 'episodes', count: 2 }),
        ]);
    });

    it('a failing issues query costs the strip, not the page', async () => {
        seedEpisodePage();
        listAdminMediaItemsMock.mockRejectedValue(new Error('boom'));
        const result = (await runLoad('ep-1')) as unknown as { issues: unknown[] };
        expect(result.issues).toEqual([]);
    });
});

describe('load guards', () => {
    it('answers a non-uuid id with 404 before querying', async () => {
        await expect(runLoad('not a uuid')).rejects.toMatchObject({ status: 404 });
        expect(getMediaItemByIdMock).not.toHaveBeenCalled();
    });

    it('keeps a series sidebar count unknown when the child count query fails', async () => {
        getMediaItemByIdMock.mockResolvedValue({
            id: 'series-1',
            title: 'Show',
            original_title: null,
            english_title: null,
            year: null,
            media_type: 'tv',
            status: null,
            parent_id: null,
            season_number: null,
            episode_number: null,
            runtime_seconds: null,
            premiere_date: null,
            overview: null,
            created_at: new Date(),
            updated_at: new Date(),
            custom_metadata: null,
        });
        getMediaItemChildCountsMock.mockRejectedValue(new Error('db down'));
        getMediaFileSummaryMock.mockResolvedValue({ count: 0, totalBytes: null });
        resolveAncestorChainMock.mockResolvedValue([]);

        const result = (await runLoad('series-1')) as LoadShape & {
            childCounts: unknown;
        };

        expect(result.childCounts).toBeNull();
        expect(result.sidebarEntryCount).toBeNull();
    });
});

describe('reviewed title snapshot', () => {
    it('loads title, source and full precision protection from the same row', async () => {
        seedEpisodePage();
        getMediaItemByIdMock.mockResolvedValue({
            id: 'track-1',
            title: 'You Da One',
            title_source: 'filename',
            media_type: 'track',
            status: 'active',
            parent_id: null,
            custom_metadata: {},
            metadata_locked: true,
            metadata_locked_by: 'reviewer',
            lock_version: '1792845296.123456',
            is_dismissed: true,
            canonical_id: 'canonical-track',
        });
        const data = (await runLoad('track-1')) as LoadShape & {
            mediaItem: { title: string; titleSource: string };
            lockStatus: { locked: boolean; lockedBy: string; lockedAt: string };
        };
        expect(data.mediaItem).toMatchObject({
            title: 'You Da One',
            titleSource: 'filename',
            dismissed: true,
            canonicalId: 'canonical-track',
        });
        expect(data.lockStatus).toEqual({
            locked: true,
            lockedBy: 'reviewer',
            lockedAt: '1792845296.123456',
        });
        expect(getMediaItemLockStatusMock).not.toHaveBeenCalled();
        expect(getEpisodeLanguageSummariesMock).not.toHaveBeenCalled();
    });
});
