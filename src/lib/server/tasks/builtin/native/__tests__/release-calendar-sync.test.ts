// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * release-calendar-sync unit tests.
 *
 * Exercises the task's execute() with all external dependencies mocked:
 *   - sonarrClient / radarrClient    (from '$lib/server/sonarr.js')
 *   - resolveExternalIdToUuid        (from '…/database/queries/media-lookup.queries.js')
 *   - getPrimaryExternalIdProvider   (from '$lib/server/utils/provider-config.js')
 *
 * Scenarios:
 *   A) Neither Sonarr nor Radarr is configured (getCalendar throws) → task
 *      succeeds, counts episodes/movies as 0, errors === 2.
 *
 *   B) Sonarr calendar entry for an EXISTING episode stub → premiere_date and
 *      has_files columns are updated; episodesUpdated === 1.
 *
 *   C) Sonarr entry where the series/season/episode stub does NOT exist → skipped,
 *      episodesSkipped === 1, no DB write.
 *
 *   D) Radarr entry with a valid tmdbId whose movie row exists → that row is
 *      updated; moviesUpserted === 1.
 *
 *   D2) Radarr entry whose movie has no catalog row → skipped, NO media_items
 *      row is created (the calendar reads the upcoming_releases projection).
 *
 *   E) Radarr entry with tmdbId = 0 → moviesSkipped === 1, no lookup.
 *
 *   F) Sonarr throws but Radarr succeeds → errors includes the Sonarr failure,
 *      Radarr movies are still upserted (independent provider handling).
 *
 *   G) Radarr throws but Sonarr succeeds → errors includes the Radarr failure,
 *      Sonarr episodes are still updated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const sonarrMock = vi.hoisted(() => ({
    sonarrClient: { getCalendar: vi.fn(), isConfigured: vi.fn(() => true) },
    radarrClient: { getCalendar: vi.fn(), isConfigured: vi.fn(() => true) },
    // Minimal stand-in for the real ArrApiError (src/lib/server/sonarr.ts) —
    // the task's outage guard does `instanceof ArrApiError` to read `.status`,
    // so the mocked module must export something to check against.
    ArrApiError: class ArrApiError extends Error {
        status: number | null;
        constructor(message: string, status: number | null) {
            super(message);
            this.name = 'ArrApiError';
            this.status = status;
        }
    },
}));
vi.mock('$lib/server/sonarr.js', () => sonarrMock);

// The task must never create catalog rows: fail loudly if it still tries.
const upsertMock = vi.hoisted(() => ({
    upsertMediaMetadata: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-upsert.js', () => upsertMock);

const lookupMock = vi.hoisted(() => ({
    resolveExternalIdToUuid: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => lookupMock);

const providerMock = vi.hoisted(() => ({
    getPrimaryExternalIdProvider: vi.fn(() => 'tmdb'),
}));
vi.mock('$lib/server/utils/provider-config.js', () => providerMock);

// Suppress registry side-effect.
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// withApiCallSpend is a thin wrapper — pass through to avoid needing spend mock.
vi.mock('$lib/server/tasks/api-call-spend.js', () => ({
    withApiCallSpend: async (_ctx: unknown, body: () => Promise<unknown>) => body(),
}));

// ─── Import real task after mocks ─────────────────────────────────────────────

import { releaseCalendarSyncTask } from '../release-calendar-sync.js';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ─── Context factory ──────────────────────────────────────────────────────────

type ArrCtx = Parameters<typeof releaseCalendarSyncTask.execute>[0];

function makeCtx(sqlRows?: unknown[][]): { ctx: ArrCtx; rec: ReturnType<typeof makeRecordingSql> } {
    const ac = new AbortController();
    const rec = makeRecordingSql();
    // Pre-queue any rows the caller needs
    if (sqlRows) {
        for (const rows of sqlRows) {
            rec.queueRows(rows);
        }
    }
    const ctx: ArrCtx = {
        sql: rec.sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-acs',
        input: {},
        reportProgress: vi.fn(),
        spend: vi.fn(),
    } as unknown as ArrCtx;
    return { ctx, rec };
}

/** Minimal Sonarr calendar entry with a known episode stub. */
function makeSonarrEntry(
    overrides: Partial<{
        series: { tmdbId: number; tvdbId: number };
        seasonNumber: number;
        episodeNumber: number;
        airDateUtc: string;
        hasFile: boolean;
    }> = {},
) {
    return {
        series: overrides.series ?? { tmdbId: 12345, tvdbId: 67890 },
        seasonNumber: overrides.seasonNumber ?? 1,
        episodeNumber: overrides.episodeNumber ?? 3,
        airDateUtc: overrides.airDateUtc ?? '2026-04-01T20:00:00Z',
        hasFile: overrides.hasFile ?? true,
    };
}

/** Minimal Radarr calendar entry. */
function makeRadarrEntry(
    overrides: Partial<{
        tmdbId: number;
        title: string;
        year: number;
        overview: string;
        inCinemas: string | null;
        physicalRelease: string | null;
        digitalRelease: string | null;
        hasFile: boolean;
    }> = {},
) {
    return {
        tmdbId: overrides.tmdbId ?? 99999,
        title: overrides.title ?? 'Test Movie',
        year: overrides.year ?? 2026,
        overview: overrides.overview ?? 'A test movie.',
        inCinemas: overrides.inCinemas ?? '2026-05-01T00:00:00Z',
        physicalRelease: overrides.physicalRelease ?? null,
        digitalRelease: overrides.digitalRelease ?? null,
        hasFile: overrides.hasFile ?? false,
    };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('release-calendar-sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: both Arrs configured. Not-configured cases opt out explicitly.
        sonarrMock.sonarrClient.isConfigured.mockReturnValue(true);
        sonarrMock.radarrClient.isConfigured.mockReturnValue(true);
    });

    // ── A: neither provider configured ────────────────────────────────────────

    it('A: neither provider configured (getCalendar returns []) → succeeds, 0 work, errors === 0', async () => {
        // A NOT-configured Arr client returns [] (non-null) from getCalendar — it
        // does NOT throw (see ArrClientBase.getCalendar: `if (!isConfigured()) return []`).
        // That is the legitimate "nothing to do" case and must stay success.
        sonarrMock.sonarrClient.isConfigured.mockReturnValue(false);
        sonarrMock.radarrClient.isConfigured.mockReturnValue(false);
        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([]);

        const { ctx } = makeCtx();
        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.result?.episodesUpdated).toBe(0);
        expect(result.result?.moviesUpserted).toBe(0);
        expect(result.result?.errors).toBe(0);
    });

    // ── I: single-arr deployment, the ONLY configured provider is down ────────

    it('I: only Sonarr configured and it is unreachable (Radarr not configured) → throws transient TaskError', async () => {
        // The bug this locks in: on a single-arr deployment the unconfigured side
        // is always [] (non-null), so the old `both === null` guard never fired
        // and a total outage of the ONLY configured provider returned success.
        sonarrMock.sonarrClient.isConfigured.mockReturnValue(true);
        sonarrMock.radarrClient.isConfigured.mockReturnValue(false);
        sonarrMock.sonarrClient.getCalendar.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([]); // not configured → []

        const { ctx } = makeCtx();

        await expect(releaseCalendarSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    // ── H: both providers configured-but-unreachable → OUTAGE, must be visible ─

    it('H: both providers configured-but-unreachable (both throw) → throws transient TaskError', async () => {
        // A CONFIGURED-but-down Arr client throws from getCalendar (the network
        // call fails). Both down with zero work is a total upstream outage — the
        // old code returned success:true, hiding it from alerting + the circuit
        // breaker. The task now throws a transient TaskError so the run is marked
        // failed, retried, and the breaker can trip.
        sonarrMock.sonarrClient.getCalendar.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        sonarrMock.radarrClient.getCalendar.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const { ctx } = makeCtx();

        await expect(releaseCalendarSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    // ── H2: both providers reject the API key → distinct "check the key" message ─

    it('H2: both providers configured-but-401 → throws transient TaskError with an auth-specific message', async () => {
        sonarrMock.sonarrClient.getCalendar.mockRejectedValueOnce(
            new sonarrMock.ArrApiError('Sonarr API /calendar returned 401', 401),
        );
        sonarrMock.radarrClient.getCalendar.mockRejectedValueOnce(
            new sonarrMock.ArrApiError('Radarr API /calendar returned 401', 401),
        );

        const { ctx } = makeCtx();

        await expect(releaseCalendarSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('rejected the configured API key'),
        });
    });

    // ── B: Sonarr entry for existing episode stub ──────────────────────────────

    it('B: Sonarr entry with existing episode → updates premiere_date + has_files, episodesUpdated=1', async () => {
        const seriesId = 'aabbccdd-0000-0000-0000-000000000001';
        const seasonId = 'aabbccdd-0000-0000-0000-000000000002';

        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([makeSonarrEntry()]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([]);

        // resolveExternalIdToUuid called for tmdb provider (primary default)
        lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(seriesId);

        // The task issues two SQL calls per episode:
        //   1. SELECT season row  → [{ id: seasonId }]
        //   2. UPDATE episode     → [{ id: 'some-episode-id' }]
        const { ctx, rec } = makeCtx();
        rec.queueRows([{ id: seasonId }]); // season SELECT
        rec.queueRows([{ id: 'some-episode-id' }]); // episode UPDATE

        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.result?.sonarrEntries).toBe(1);
        expect(result.result?.episodesUpdated).toBe(1);
        expect(result.result?.episodesSkipped).toBe(0);
        expect(result.result?.errors).toBe(0);

        // Verify resolveExternalIdToUuid was called with the tmdb series id
        expect(lookupMock.resolveExternalIdToUuid).toHaveBeenCalledWith(
            ctx.sql,
            '12345',
            'tv',
            'tmdb',
        );
    });

    // ── C: Sonarr entry where no series stub exists ────────────────────────────

    it('C: Sonarr entry with no matching series → skipped, no SQL episode update', async () => {
        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([makeSonarrEntry()]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([]);

        // resolveExternalIdToUuid returns null for both tmdb and tvdb
        lookupMock.resolveExternalIdToUuid.mockResolvedValue(null);

        const { ctx } = makeCtx();
        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.result?.episodesUpdated).toBe(0);
        expect(result.result?.episodesSkipped).toBe(1);
        expect(result.result?.errors).toBe(0);
    });

    // ── D: Radarr entry with valid tmdbId → upserts movie stub ───────────────

    it('D: Radarr entry with valid tmdbId and an existing movie row → moviesUpserted=1, no stub created', async () => {
        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([makeRadarrEntry()]);

        const mediaId = 'ccddee00-0000-0000-0000-000000000001';
        lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(mediaId);

        // The task issues an UPDATE after upsert — queue that row
        const { ctx, rec } = makeCtx();
        rec.queueRows([]); // UPDATE premiere_date (no RETURNING needed by task)

        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.result?.radarrEntries).toBe(1);
        expect(result.result?.moviesUpserted).toBe(1);
        expect(result.result?.moviesSkipped).toBe(0);
        expect(result.result?.errors).toBe(0);

        expect(lookupMock.resolveExternalIdToUuid).toHaveBeenCalledWith(
            ctx.sql,
            '99999',
            'movie',
            'tmdb',
        );
        expect(upsertMock.upsertMediaMetadata).not.toHaveBeenCalled();
    });

    it('D1: Radarr movie lookup uses the literal tmdb provider even when tvdb is primary', async () => {
        providerMock.getPrimaryExternalIdProvider.mockReturnValueOnce('tvdb');
        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([makeRadarrEntry()]);
        lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce('ccddee00-0000-0000-0000-000000000002');

        const { ctx, rec } = makeCtx();
        rec.queueRows([]);

        await releaseCalendarSyncTask.execute(ctx);

        expect(lookupMock.resolveExternalIdToUuid).toHaveBeenCalledWith(
            ctx.sql,
            '99999',
            'movie',
            'tmdb',
        );
    });

    // ── D2: movie without a catalog row → no stub is created ─────────────────

    it('D2: Radarr entry without a catalog row → moviesSkipped=1, nothing inserted into media_items', async () => {
        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([makeRadarrEntry()]);
        lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(null);

        const { ctx, rec } = makeCtx();
        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.result?.moviesUpserted).toBe(0);
        expect(result.result?.moviesSkipped).toBe(1);
        expect(result.result?.errors).toBe(0);
        expect(upsertMock.upsertMediaMetadata).not.toHaveBeenCalled();
        expect(rec.calls.some((c) => /INSERT INTO media_items/i.test(c.query))).toBe(false);
        expect(rec.calls.some((c) => c.query.includes('mi.id ='))).toBe(false);
        // The projection row is still written, so the calendar still shows it.
        expect(rec.calls.some((c) => c.query.includes('upcoming_release'))).toBe(true);
    });

    // ── E: Radarr entry with tmdbId = 0 → skipped ────────────────────────────

    it('E: Radarr entry with tmdbId=0 → moviesSkipped=1, no upsert', async () => {
        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([makeRadarrEntry({ tmdbId: 0 })]);

        const { ctx } = makeCtx();
        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.result?.moviesUpserted).toBe(0);
        expect(result.result?.moviesSkipped).toBe(1);
        expect(upsertMock.upsertMediaMetadata).not.toHaveBeenCalled();
    });

    // ── F: Sonarr throws, Radarr succeeds (independent provider handling) ──────

    it('F: Sonarr throws, Radarr succeeds → errors=1, moviesUpserted=1', async () => {
        sonarrMock.sonarrClient.getCalendar.mockRejectedValueOnce(new Error('Sonarr down'));
        sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([makeRadarrEntry()]);

        const mediaId = 'ccddee00-0000-0000-0000-000000000002';
        lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(mediaId);

        const { ctx, rec } = makeCtx();
        rec.queueRows([]); // UPDATE row for premiere_date

        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.result?.errors).toBe(1);
        expect(result.result?.episodesUpdated).toBe(0);
        expect(result.result?.moviesUpserted).toBe(1);
    });

    // ── G: Radarr throws, Sonarr succeeds ────────────────────────────────────

    it('G: Radarr throws, Sonarr succeeds → errors=1, episodesUpdated=1', async () => {
        const seriesId = 'aabbccdd-0000-0000-0000-000000000003';
        const seasonId = 'aabbccdd-0000-0000-0000-000000000004';

        sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([makeSonarrEntry()]);
        sonarrMock.radarrClient.getCalendar.mockRejectedValueOnce(new Error('Radarr down'));

        lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(seriesId);

        const { ctx, rec } = makeCtx();
        rec.queueRows([{ id: seasonId }]);
        rec.queueRows([{ id: 'ep-id-g' }]);

        const result = await releaseCalendarSyncTask.execute(ctx);

        expect(result.result?.errors).toBe(1);
        expect(result.result?.episodesUpdated).toBe(1);
        expect(result.result?.moviesUpserted).toBe(0);
    });

    // ── BUG 4: has_files is reconciled against local media_file_items
    //    evidence, NOT written directly from the arr's `hasFile` flag ────────

    describe('BUG 4: has_files reconciled against media_file_items, not the arr payload', () => {
        it('episode UPDATE derives has_files from EXISTS(media_file_items), not entry.hasFile', async () => {
            const seriesId = 'aabbccdd-0000-0000-0000-000000000005';
            const seasonId = 'aabbccdd-0000-0000-0000-000000000006';

            // Arr reports hasFile=false — under the OLD code this would have
            // unconditionally flipped has_files to false even if the local
            // scanner had already found the file.
            sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([
                makeSonarrEntry({ hasFile: false }),
            ]);
            sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([]);
            lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(seriesId);

            const { ctx, rec } = makeCtx();
            rec.queueRows([{ id: seasonId }]); // season SELECT
            rec.queueRows([{ id: 'some-episode-id' }]); // episode UPDATE

            await releaseCalendarSyncTask.execute(ctx);

            const episodeUpdate = rec.calls.find(
                (c) => c.query.includes('episode_number') && c.query.includes('UPDATE'),
            );
            expect(episodeUpdate).toBeDefined();
            // The has_files write must be a SQL-side EXISTS(...) against
            // media_file_items joined on media_item_id, not an interpolated
            // parameter.
            expect(episodeUpdate?.query).toContain('media_file_items');
            expect(episodeUpdate?.query).toContain('media_item_id');
            expect(episodeUpdate?.query).toContain('EXISTS');
            // entry.hasFile (a boolean) must NOT appear among the interpolated
            // values anymore — it used to be `has_files = ${entry.hasFile}`.
            expect(episodeUpdate?.values.some((v) => typeof v === 'boolean')).toBe(false);
        });

        it('movie UPDATE (with airDate) derives has_files from EXISTS(media_file_items), not entry.hasFile', async () => {
            sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
            sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([
                makeRadarrEntry({ hasFile: true }),
            ]);

            const mediaId = 'ccddee00-0000-0000-0000-000000000003';
            lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(mediaId);

            const { ctx, rec } = makeCtx();
            rec.queueRows([]); // movie UPDATE

            await releaseCalendarSyncTask.execute(ctx);

            const movieUpdate = rec.calls.find(
                (c) => c.query.includes('premiere_date') && c.query.includes('mi.id ='),
            );
            expect(movieUpdate).toBeDefined();
            expect(movieUpdate?.query).toContain('media_file_items');
            expect(movieUpdate?.query).toContain('media_item_id');
            expect(movieUpdate?.query).toContain('EXISTS');
            expect(movieUpdate?.values.some((v) => typeof v === 'boolean')).toBe(false);
        });

        it('movie UPDATE (no airDate) derives has_files from EXISTS(media_file_items), not entry.hasFile', async () => {
            sonarrMock.sonarrClient.getCalendar.mockResolvedValueOnce([]);
            sonarrMock.radarrClient.getCalendar.mockResolvedValueOnce([
                makeRadarrEntry({
                    hasFile: true,
                    inCinemas: null,
                    physicalRelease: null,
                    digitalRelease: null,
                }),
            ]);

            const mediaId = 'ccddee00-0000-0000-0000-000000000004';
            lookupMock.resolveExternalIdToUuid.mockResolvedValueOnce(mediaId);

            const { ctx, rec } = makeCtx();
            rec.queueRows([]); // movie UPDATE (no-airDate branch)

            await releaseCalendarSyncTask.execute(ctx);

            const movieUpdate = rec.calls.find(
                (c) => c.query.includes('has_files') && c.query.includes('mi.id ='),
            );
            expect(movieUpdate).toBeDefined();
            expect(movieUpdate?.query).toContain('media_file_items');
            expect(movieUpdate?.query).toContain('media_item_id');
            expect(movieUpdate?.query).toContain('EXISTS');
            expect(movieUpdate?.values.some((v) => typeof v === 'boolean')).toBe(false);
        });
    });
});
