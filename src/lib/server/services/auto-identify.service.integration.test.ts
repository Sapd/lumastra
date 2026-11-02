// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for processAutoIdentifyPersonalMedia.
 *
 * Uses the real `lumastra_tests` database for media_items / external_ids state.
 * All external provider calls (TMDB API, plugin search) are mocked.
 *
 * Covered:
 *   empty state:
 *     - returns immediately when there are no personal media items
 *
 *   no providers:
 *     - returns immediately when provider list is empty
 *
 *   successful identification:
 *     - stores external_id on the item after a provider returns a match
 *     - increments matched count
 *     - marks item as identified (external_ids row appears)
 *
 *   no match:
 *     - item without a provider match is skipped (skipped count increments)
 *     - no external_ids row created for skipped item
 *
 *   abort signal:
 *     - stops processing after signal is aborted
 *     - aborted count is reflected in the message
 *
 *   identification never merges duplicate catalog entries
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '$lib/server/database/queries/media-files.queries.js';
import { processAutoIdentifyPersonalMedia } from './auto-identify.service.js';
import { CatalogService } from './catalog.service.js';

// ---------------------------------------------------------------------------
// Mock external provider calls — use vi.hoisted() for factories that reference
// module-level variables, since vi.mock factories are hoisted before the module.
// ---------------------------------------------------------------------------

const { mockProviders, mockInvokeSearch, mockIsConfigured, mockResolve } = vi.hoisted(() => {
    const mockProviders: Array<{ id: string; resolveExternalId?: () => void }> = [];
    const mockInvokeSearch = vi.fn().mockResolvedValue([]);
    const mockIsConfigured = vi.fn().mockResolvedValue(true);
    return {
        mockProviders,
        mockInvokeSearch,
        mockIsConfigured,
        mockResolve: vi.fn().mockResolvedValue(null),
    };
});

// Mock tmdbApi to prevent actual HTTP calls.
vi.mock('$lib/server/providers/implementations/tmdb', () => ({
    tmdbApi: {
        isAvailable: vi.fn().mockReturnValue(false),
        findByExternalId: vi.fn().mockResolvedValue({ movie_results: [], tv_results: [] }),
    },
}));

// Mock plugin-context — provider list, search and isConfigured.
vi.mock('$lib/server/tasks/plugin-context', () => ({
    getProvidersByPriority: vi.fn().mockImplementation(() => mockProviders),
    invokeProviderSearch: mockInvokeSearch,
    invokeProviderResolveExternalId: mockResolve,
    isProviderConfigured: mockIsConfigured,
    invokeProviderDetail: vi.fn().mockResolvedValue(null),
}));

// The service imports from 'plugin-context' without .js extension; also mock
// the .js variant used by CatalogService.
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: vi.fn().mockImplementation(() => mockProviders),
    invokeProviderSearch: mockInvokeSearch,
    invokeProviderResolveExternalId: mockResolve,
    isProviderConfigured: mockIsConfigured,
    invokeProviderDetail: vi.fn().mockResolvedValue(null),
}));

// Mock the provider-level normalizer.
vi.mock('$lib/server/providers/normalize', () => ({
    normalizeSearchResult: vi.fn().mockReturnValue(null),
}));

// Mock MediaLifecycleService side effects (enqueue metadata sync etc.).
vi.mock('$lib/server/services/media-lifecycle.service', () => ({
    MediaLifecycleService: {
        afterMatched: vi.fn().mockResolvedValue(undefined),
        afterExternalIdChanged: vi.fn().mockResolvedValue(undefined),
        afterContentChanged: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/plugins/runtime/field-authority-loader.js', () => ({
    buildFieldAuthorityConfigFromDefinitions: vi.fn().mockReturnValue({}),
    loadProviderSettingsCached: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Tables cleaned between tests
// ---------------------------------------------------------------------------

const CLEANUP_TABLES = ['media_file_items', 'media_files', 'external_ids', 'media_items'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a personal media item + a media file attached to it so that
 * `listPersonalMediaItems` (which requires has_files = true) returns it.
 *
 * Returns the media item UUID.
 */
async function createPersonalMovieWithFile(
    sql: postgres.Sql,
    title: string,
    options: { year?: number } = {},
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, year, status)
        VALUES (${id}::uuid, ${title}, 'movie', ${options.year ?? null}, 'active')
    `;

    // A media file is required for listPersonalMediaItems to include this item.
    const { id: fileId } = await upsertMediaFile(sql, {
        filePath: `/data/movies/${title.replace(/\s+/g, '_')}.mkv`,
    });
    await attachFileToItem(sql, fileId, id);

    return id;
}

/**
 * Create a personal TV series with a season, episode, and file.
 * Returns the series UUID.
 */
async function createPersonalSeriesWithFile(sql: postgres.Sql, title: string): Promise<string> {
    const seriesId = crypto.randomUUID();
    const seasonId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();

    await sql`
        INSERT INTO media_items (id, title, media_type, status)
        VALUES (${seriesId}::uuid, ${title}, 'tv', 'active')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
        VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 1, 'active')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
        VALUES (${episodeId}::uuid, 'Episode 1', 'episode', ${seasonId}::uuid, 1, 1, 'active')
    `;

    const { id: fileId } = await upsertMediaFile(sql, {
        filePath: `/data/tv/${title.replace(/\s+/g, '_')}/S01E01.mkv`,
    });
    await attachFileToItem(sql, fileId, episodeId);

    return seriesId;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('processAutoIdentifyPersonalMedia (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, CLEANUP_TABLES);
        vi.clearAllMocks();
        // Default: empty provider list → service returns "No metadata providers available"
        mockProviders.length = 0;
        mockInvokeSearch.mockResolvedValue([]);
        mockIsConfigured.mockResolvedValue(true);
        mockResolve.mockResolvedValue(null);
    });

    // -----------------------------------------------------------------------
    // Empty state
    // -----------------------------------------------------------------------

    describe('empty state', () => {
        it('returns total=0 and a "no items" message when there are no personal media items', async () => {
            // No items in DB; provider list with one entry.
            mockProviders.push({ id: 'tmdb-provider' });

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.total).toBe(0);
            expect(result.matched).toBe(0);
            expect(result.skipped).toBe(0);
            expect(result.failed).toBe(0);
            expect(result.message).toMatch(/no personal media items/i);
        });
    });

    // -----------------------------------------------------------------------
    // No providers
    // -----------------------------------------------------------------------

    describe('no providers configured', () => {
        it('returns immediately when provider list is empty', async () => {
            // Insert a personal item so it is NOT an empty-state exit.
            await createPersonalMovieWithFile(sql, 'Orphan Film');
            // mockProviders is already empty.

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.message).toMatch(/no metadata providers/i);
            expect(result.matched).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Successful identification
    // -----------------------------------------------------------------------

    describe('successful identification', () => {
        it('stores an external_id when a provider returns a confident match', async () => {
            const mediaId = await createPersonalMovieWithFile(sql, 'Daydream');
            mockProviders.push({ id: 'tmdb-provider' });

            // Provider returns a single candidate above the 0.8 threshold.
            mockInvokeSearch.mockResolvedValue([
                {
                    id: '27205',
                    title: 'Daydream',
                    year: 2010,
                    mediaType: 'movie',
                },
            ]);

            // normalizeSearchResult maps the raw result to a MetadataCandidate.
            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '27205',
                mediaType: 'movie',
                title: 'Daydream',
                confidence: 0.95,
            } as ReturnType<typeof normalizeSearchResult>);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.matched).toBe(1);
            expect(result.skipped).toBe(0);

            // An external_ids row must exist after matching.
            const ids = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${mediaId}::uuid
                  AND provider = 'tmdb-provider'
            `;
            expect(ids).toHaveLength(1);
            expect(ids[0].external_id).toBe('27205');
            const { MediaLifecycleService } = await import('./media-lifecycle.service.js');
            expect(MediaLifecycleService.afterExternalIdChanged).toHaveBeenCalledWith(mediaId);
        });

        it('identifies an item that has only a Jellyfin file-sync link', async () => {
            const mediaId = await createPersonalMovieWithFile(sql, 'Daydream');
            await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
                provider: 'jellyfin',
                id: 'a'.repeat(32),
                mediaType: 'movie',
                source: 'watch-sync-file',
            });
            mockProviders.push({ id: 'tmdb-provider' });

            // Provider returns a single candidate above the 0.8 threshold.
            mockInvokeSearch.mockResolvedValue([
                {
                    id: '27205',
                    title: 'Daydream',
                    year: 2010,
                    mediaType: 'movie',
                },
            ]);

            // normalizeSearchResult maps the raw result to a MetadataCandidate.
            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '27205',
                mediaType: 'movie',
                title: 'Daydream',
                confidence: 0.95,
            } as ReturnType<typeof normalizeSearchResult>);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.matched).toBe(1);
            expect(result.skipped).toBe(0);

            // An external_ids row must exist after matching.
            const ids = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${mediaId}::uuid
                  AND provider = 'tmdb-provider'
            `;
            expect(ids).toHaveLength(1);
            expect(ids[0].external_id).toBe('27205');
            const { MediaLifecycleService } = await import('./media-lifecycle.service.js');
            expect(MediaLifecycleService.afterExternalIdChanged).toHaveBeenCalledWith(mediaId);
        });

        it('increments matched count for each identified item', async () => {
            await createPersonalMovieWithFile(sql, 'Movie One');
            await createPersonalMovieWithFile(sql, 'Movie Two');
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            let callIdx = 0;
            // Echo the candidate's own title (which equals the seeded item title,
            // since the service searches by item title) so the title-similarity
            // gate accepts the match — this test asserts match-counting, not the gate.
            // normalizeSearchResult is called as (providerId, rawResult, ...), so the
            // raw search result (carrying the title) is the SECOND argument.
            vi.mocked(normalizeSearchResult).mockImplementation((_providerId, rawResult) => {
                callIdx++;
                const candidateTitle =
                    (rawResult as { title?: string } | null)?.title ?? `Movie ${callIdx}`;
                return {
                    provider: 'tmdb-provider',
                    externalId: String(10000 + callIdx),
                    mediaType: 'movie',
                    title: candidateTitle,
                    confidence: 0.9,
                } as ReturnType<typeof normalizeSearchResult>;
            });
            mockInvokeSearch.mockImplementation((_providerId, { query }) => {
                return Promise.resolve([
                    {
                        id: String(query.length),
                        title: query,
                        year: 2020,
                        mediaType: 'movie',
                    },
                ]);
            });

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.matched).toBe(2);
            expect(result.total).toBe(2);
        });
    });

    it('skips a provider result when another provider manually identifies the row during search', async () => {
        const mediaId = await createPersonalMovieWithFile(sql, 'Concurrent Manual Match', {
            year: 2015,
        });
        mockProviders.push({ id: 'tmdb-provider' });
        let entered!: () => void;
        const atSearch = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const searchGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        mockInvokeSearch.mockImplementation(async () => {
            entered();
            await searchGate;
            return [
                {
                    id: 'auto-1515',
                    title: 'Concurrent Manual Match',
                    year: 2015,
                    mediaType: 'movie',
                },
            ];
        });
        const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
        vi.mocked(normalizeSearchResult).mockReturnValue({
            provider: 'tmdb-provider',
            externalId: 'auto-1515',
            mediaType: 'movie',
            title: 'Concurrent Manual Match',
            year: 2015,
            confidence: 0.99,
        } as ReturnType<typeof normalizeSearchResult>);

        const run = processAutoIdentifyPersonalMedia({ sql });
        await atSearch;
        expect(
            await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                mediaId,
                {
                    provider: 'tvdb',
                    id: 'manual-1515',
                    mediaType: 'movie',
                    source: 'manual',
                    confidence: 1,
                },
                true,
            ),
        ).toBe(true);
        release();
        const result = await run;

        expect(result.matched).toBe(0);
        expect(result.skipped).toBe(1);
        const { MediaLifecycleService } = await import('./media-lifecycle.service.js');
        expect(MediaLifecycleService.afterExternalIdChanged).not.toHaveBeenCalledWith(mediaId);
        const ids = await sql<{ provider: string; external_id: string }[]>`
            SELECT provider, external_id FROM external_ids WHERE media_id = ${mediaId}::uuid ORDER BY provider
        `;
        expect(ids).toEqual([{ provider: 'tvdb', external_id: 'manual-1515' }]);
    });

    // -----------------------------------------------------------------------
    // No match (skipped)
    // -----------------------------------------------------------------------

    describe('no provider match', () => {
        it('skips items when no provider returns a match above threshold', async () => {
            const mediaId = await createPersonalMovieWithFile(sql, 'Obscure Film XYZ');
            mockProviders.push({ id: 'tmdb-provider' });

            // normalizeSearchResult returns null → no candidate above threshold.
            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue(null);
            mockInvokeSearch.mockResolvedValue([{ id: '1', title: 'Wrong Match', year: 2000 }]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.skipped).toBe(1);
            expect(result.matched).toBe(0);

            // No external_id should exist for the skipped item.
            const ids = await sql`
                SELECT id FROM external_ids WHERE media_id = ${mediaId}::uuid
            `;
            expect(ids).toHaveLength(0);
        });

        it('skips items when provider returns an empty candidate list', async () => {
            await createPersonalMovieWithFile(sql, 'Empty Result Film');
            mockProviders.push({ id: 'tmdb-provider' });
            mockInvokeSearch.mockResolvedValue([]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.skipped).toBe(1);
            expect(result.matched).toBe(0);
        });

        it('skips items with no title overlap even at high provider confidence', async () => {
            await createPersonalMovieWithFile(sql, 'Low Confidence Film');
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '99999',
                mediaType: 'movie',
                title: 'Completely Unrelated Title',
                confidence: 0.95,
            } as ReturnType<typeof normalizeSearchResult>);
            mockInvokeSearch.mockResolvedValue([
                { id: '99999', title: 'Completely Unrelated Title' },
            ]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.skipped).toBe(1);
            expect(result.matched).toBe(0);
        });

        it('matches a back-catalog title despite low provider popularity confidence', async () => {
            // Regression test: provider confidence (e.g. TMDB popularity/100) is
            // NOT a proxy for match quality — an exact title match must be
            // accepted regardless of how unpopular the title currently is.
            const mediaId = await createPersonalMovieWithFile(sql, 'Low Popularity Film');
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '99999',
                mediaType: 'movie',
                title: 'Low Popularity Film',
                confidence: 0.075, // e.g. Math.min(popularity=7.5 / 100, 1)
            } as ReturnType<typeof normalizeSearchResult>);
            mockInvokeSearch.mockResolvedValue([{ id: '99999', title: 'Low Popularity Film' }]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.matched).toBe(1);
            expect(result.skipped).toBe(0);

            const ids = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${mediaId}::uuid
                  AND provider = 'tmdb-provider'
            `;
            expect(ids).toHaveLength(1);
            expect(ids[0].external_id).toBe('99999');
        });
    });

    // -----------------------------------------------------------------------
    // Abort signal
    // -----------------------------------------------------------------------

    describe('abort signal', () => {
        it('stops processing when signal is already aborted before the loop', async () => {
            // Create multiple items so the loop would otherwise iterate several times.
            await createPersonalMovieWithFile(sql, 'Aborted Film A');
            await createPersonalMovieWithFile(sql, 'Aborted Film B');
            mockProviders.push({ id: 'tmdb-provider' });

            const controller = new AbortController();
            // Abort BEFORE calling the service.
            controller.abort();

            const result = await processAutoIdentifyPersonalMedia({
                sql,
                signal: controller.signal,
            });

            // The service checks signal.aborted at the top of each item loop;
            // with a pre-aborted signal it should break immediately.
            expect(result.message).toMatch(/aborted/i);
            expect(result.matched).toBe(0);
        });

        it('stops mid-sweep when signal is aborted between items', async () => {
            // Create 3 items; abort after the first iteration.
            await createPersonalMovieWithFile(sql, 'Abort Mid A');
            await createPersonalMovieWithFile(sql, 'Abort Mid B');
            await createPersonalMovieWithFile(sql, 'Abort Mid C');
            mockProviders.push({ id: 'tmdb-provider' });

            const controller = new AbortController();
            let callCount = 0;

            // Abort on the second invocation of invokeProviderSearch.
            mockInvokeSearch.mockImplementation(() => {
                callCount++;
                if (callCount >= 2) controller.abort();
                return Promise.resolve([]);
            });
            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue(null);

            const result = await processAutoIdentifyPersonalMedia({
                sql,
                signal: controller.signal,
            });

            // Not all 3 items should have been processed.
            expect(result.matched + result.skipped + result.failed).toBeLessThan(3);
            expect(result.message).toMatch(/aborted/i);
        });
    });

    // -----------------------------------------------------------------------
    // Progress callback
    // -----------------------------------------------------------------------

    describe('onProgress callback', () => {
        it('reports searching progress without a hidden dedup phase', async () => {
            await createPersonalMovieWithFile(sql, 'Progress Film');
            mockProviders.push({ id: 'tmdb-provider' });
            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue(null);

            const phases: string[] = [];
            await processAutoIdentifyPersonalMedia({
                sql,
                onProgress: (phase) => {
                    phases.push(phase);
                },
            });

            expect(phases).not.toContain('dedup');
            expect(phases).toContain('searching');
        });
    });

    // -----------------------------------------------------------------------
    // Title-similarity gate ("popularity is not confidence")
    // -----------------------------------------------------------------------

    describe('title-similarity gate', () => {
        it('rejects a popular-but-wrong candidate whose title is unrelated to the item', async () => {
            // Seed an item whose title shares no tokens with the candidate.
            const mediaId = await createPersonalMovieWithFile(sql, 'Birthday 2019');
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            // High provider confidence (popularity-driven) but a completely
            // unrelated title — the title-similarity floor (0.6) must reject it.
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '299536',
                mediaType: 'movie',
                title: 'Wayfarers: Last Light',
                confidence: 0.95,
            } as ReturnType<typeof normalizeSearchResult>);
            mockInvokeSearch.mockResolvedValue([
                { id: '299536', title: 'Wayfarers: Last Light', year: 2019, mediaType: 'movie' },
            ]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            // titleSimilarity("Birthday 2019", "Wayfarers: Last Light") << 0.6
            // → finalScore too low regardless of provider confidence → rejected.
            expect(result.matched).toBe(0);
            expect(result.skipped).toBe(1);

            const ids = await sql`
                SELECT id FROM external_ids WHERE media_id = ${mediaId}::uuid
            `;
            expect(ids).toHaveLength(0);
        });

        it('accepts a candidate whose title exactly matches the item', async () => {
            const mediaId = await createPersonalMovieWithFile(sql, 'Starhaven');
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            // Perfect title match + confidence >= 0.8 → accepted.
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '95396',
                mediaType: 'movie',
                title: 'Starhaven',
                confidence: 0.95,
            } as ReturnType<typeof normalizeSearchResult>);
            mockInvokeSearch.mockResolvedValue([
                { id: '95396', title: 'Starhaven', year: 2022, mediaType: 'movie' },
            ]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            // titleSim = 1.0, yearProximity = 1.0 (no item year), matchScore = 1.0 >= 0.8 → accepted.
            expect(result.matched).toBe(1);
            expect(result.skipped).toBe(0);

            const ids = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${mediaId}::uuid
                  AND provider = 'tmdb-provider'
            `;
            expect(ids).toHaveLength(1);
            expect(ids[0].external_id).toBe('95396');
        });

        it('rejects a strong-title match when the release year is 3+ years off', async () => {
            // Item says 2022; candidate says 2019 — a 3-year gap.
            // yearProximity(2022, 2019) = 0, so finalScore = confidence * titleSim * 0 = 0 < 0.8.
            const mediaId = await createPersonalMovieWithFile(sql, 'Starhaven', { year: 2022 });
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '12345',
                mediaType: 'movie',
                title: 'Starhaven',
                confidence: 0.95,
                year: 2019,
            } as ReturnType<typeof normalizeSearchResult>);
            mockInvokeSearch.mockResolvedValue([
                { id: '12345', title: 'Starhaven', year: 2019, mediaType: 'movie' },
            ]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            // matchScore = 1.0 * yearProximity(2022, 2019) = 1.0 * 0 = 0 → rejected.
            expect(result.matched).toBe(0);
            expect(result.skipped).toBe(1);

            const ids = await sql`
                SELECT id FROM external_ids WHERE media_id = ${mediaId}::uuid
            `;
            expect(ids).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // TV series (media_type = 'tv')
    // -----------------------------------------------------------------------

    describe('TV series identification', () => {
        it('identifies TV series and stores external_id', async () => {
            const seriesId = await createPersonalSeriesWithFile(sql, 'Drifting Clouds');
            mockProviders.push({ id: 'tmdb-provider' });

            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue({
                provider: 'tmdb-provider',
                externalId: '1396',
                mediaType: 'tv',
                title: 'Drifting Clouds',
                confidence: 0.98,
            } as ReturnType<typeof normalizeSearchResult>);
            mockInvokeSearch.mockResolvedValue([
                {
                    id: '1396',
                    title: 'Drifting Clouds',
                    year: 2008,
                    mediaType: 'tv',
                },
            ]);

            const result = await processAutoIdentifyPersonalMedia({ sql });

            expect(result.matched).toBe(1);

            const ids = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${seriesId}::uuid
                  AND provider = 'tmdb-provider'
            `;
            expect(ids).toHaveLength(1);
            expect(ids[0].external_id).toBe('1396');
        });
    });

    describe('identification never removes catalog identities', () => {
        it.each(['daily', 'selected', 'scoped'] as const)(
            '%s matching never invokes global dedup',
            async (mode) => {
                const first = await createPersonalMovieWithFile(sql, 'Cobalt Horizon', {
                    year: 2020,
                });
                const duplicate = crypto.randomUUID();
                await sql`INSERT INTO media_items(id,title,media_type,year,status) VALUES (${duplicate},'Cobalt Horizon','movie',2020,'active')`;
                const outside = await createPersonalSeriesWithFile(sql, 'Outside Horizon');
                const outsideDuplicate = crypto.randomUUID();
                await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${outsideDuplicate},'Outside Horizon','tv','active')`;
                mockProviders.push({ id: 'tmdb-provider' });
                mockInvokeSearch.mockResolvedValue([]);
                await processAutoIdentifyPersonalMedia({
                    sql,
                    ...(mode === 'selected'
                        ? { mediaItemIds: [first] }
                        : mode === 'scoped'
                          ? { scope: { mediaType: 'movie' as const } }
                          : {}),
                });
                expect(
                    await sql`SELECT id FROM media_items WHERE id=ANY(${[first, duplicate, outside, outsideDuplicate]}::uuid[])`,
                ).toHaveLength(4);
                expect(
                    await sql`SELECT media_id FROM external_ids WHERE media_id=ANY(${[first, duplicate, outside, outsideDuplicate]}::uuid[])`,
                ).toEqual([]);
            },
        );
        it('reports an authoritative provider conflict without merging or moving history', async () => {
            const current = await createPersonalMovieWithFile(sql, 'Woven Comet');
            const existing = crypto.randomUUID();
            await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${existing},'Woven Comet Discovery','movie','active')`;
            await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                existing,
                {
                    provider: 'tmdb-provider',
                    id: 'comet-77',
                    mediaType: 'movie',
                    source: 'manual',
                    confidence: 1,
                },
                true,
            );
            await sql`UPDATE media_files SET file_path='/invented/Woven.Comet.[imdb-tt1234567].mkv'`;
            mockProviders.push({ id: 'tmdb-provider', resolveExternalId: () => {} });
            mockResolve.mockResolvedValue({
                provider: 'tmdb-provider',
                externalId: 'comet-77',
                mediaType: 'movie',
                title: 'Woven Comet',
                confidence: 1,
            });
            const result = await processAutoIdentifyPersonalMedia({ sql });
            expect(mockResolve).toHaveBeenCalled();
            expect(result.matched).toBe(0);
            expect(result.conflicts).toBe(1);
            expect(result.message).toContain('explicit merge choice');
            expect(
                await sql`SELECT id FROM media_items WHERE id=ANY(${[current, existing]}::uuid[])`,
            ).toHaveLength(2);
            expect(await sql`SELECT media_id FROM external_ids WHERE media_id=${current}`).toEqual(
                [],
            );
            expect(
                (await sql`SELECT media_id FROM external_ids WHERE external_id='comet-77'`)[0]
                    .media_id,
            ).toBe(existing);
        });
        it('does not spend provider calls or assign IDs for kept items, including selected requests', async () => {
            const id = await createPersonalMovieWithFile(sql, 'Private Lantern');
            await sql`INSERT INTO personal_media_dispositions(media_id,disposition,decided_by) VALUES (${id},'kept','curator')`;
            mockProviders.push({ id: 'tmdb-provider' });
            const result = await processAutoIdentifyPersonalMedia({ sql, mediaItemIds: [id] });
            expect(result.matched).toBe(0);
            expect(mockInvokeSearch).not.toHaveBeenCalled();
            expect(await sql`SELECT id FROM media_items WHERE id=${id}`).toHaveLength(1);
            expect(await sql`SELECT media_id FROM external_ids WHERE media_id=${id}`).toEqual([]);
        });
    });

    describe('scope', () => {
        it('only processes the items the filtered list shows', async () => {
            await createPersonalMovieWithFile(sql, 'Scoped Movie Alpha');
            await createPersonalSeriesWithFile(sql, 'Scoped Series Beta');
            mockProviders.push({ id: 'tmdb-provider' });
            const { normalizeSearchResult } = await import('$lib/server/providers/normalize');
            vi.mocked(normalizeSearchResult).mockReturnValue(null);
            mockInvokeSearch.mockResolvedValue([]);

            const byType = await processAutoIdentifyPersonalMedia({
                sql,
                scope: { mediaType: 'tv' },
            });
            expect(byType.total).toBe(1);

            const bySearch = await processAutoIdentifyPersonalMedia({
                sql,
                scope: { search: 'Alpha' },
            });
            expect(bySearch.total).toBe(1);
        });
    });
});
