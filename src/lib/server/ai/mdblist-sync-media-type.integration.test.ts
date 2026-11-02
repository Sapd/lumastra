// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for the MDBList series/`show` media-type mismatch.
 *
 * PROD INCIDENT (2026-07-08 → 2026-07-15): `processBatch` took MDBList's own
 * media-type vocabulary (`'movie' | 'show'`) and derived the DB media_type with
 * `isSeries(mediaType) ? 'tv' : 'movie'`. `isSeries()` accepts only
 * 'SERIES'/'TV' — never 'show' — so EVERY series resolved to `'movie'`:
 *
 *   A) The upsert filtered `external_ids.media_type = 'movie'` for a series'
 *      TMDB id and matched nothing → returned null → nothing persisted, yet
 *      `result.updated++` ran unconditionally and the run reported success.
 *      The coverage row stayed `pending` forever, so stage-sweep re-enqueued
 *      the task every 60s: 1,037 runs/day against a 12h schedule, which
 *      exhausted the MDBList daily quota.
 *
 *   B) Worse — TMDB ids are NOT unique across media types. Where a series' id
 *      collided with a movie's, the 'movie' lookup SUCCEEDED and wrote the
 *      series' ratings onto the movie. Prod had 28 such rows: a movie
 *      (tmdb 1417) served the same-id series' MDBList score.
 *
 * These tests use the real collision (tmdb 1417) as the fixture.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';

// The batch lookup is the only network edge — stub it, run everything else real.
const providerBatchMock = vi.hoisted(() => ({ invokeProviderBatchLookup: vi.fn() }));
vi.mock('$lib/server/tasks/plugin-context.js', () => providerBatchMock);

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn(() => 'tmdb'),
}));

import { syncMDBListRatings } from './mdblist-sync.js';
import { mdblistApi } from '../services/mdblist-api.js';

const TEST_TABLES = ['provider_metadata', 'external_ids', 'media_items', 'media_item_stage_state'];

// The real prod collision: tmdb 1417 is BOTH a series and a movie (titles invented here).
const COLLIDING_TMDB_ID = 1417;
const TV_ID = '11111111-1111-1111-1111-111111111111';
const MOVIE_ID = '22222222-2222-2222-2222-222222222222';

function mdblistItem(type: 'movie' | 'show', score: number): Record<string, unknown> {
    return {
        title: type === 'show' ? 'Choir Hours' : "The Faun's Garden",
        year: 2009,
        released: '2009-05-19',
        description: 'fixture',
        runtime: 44,
        score,
        score_average: score,
        ids: { tmdb: COLLIDING_TMDB_ID, imdb: 'tt0000000' },
        type,
        ratings: [{ source: 'imdb', value: 6.7, votes: 100, popular: 0 }],
        genres: [],
        streams: [],
        watch_providers: [],
        production_companies: [],
        language: 'en',
        spoken_language: 'en',
        country: 'US',
        certification: '',
        commonsense: null,
        age_rating: null,
        status: 'released',
    };
}

async function seedCollision(sql: postgres.Sql): Promise<void> {
    for (const [id, title, mediaType] of [
        [TV_ID, 'Choir Hours', 'tv'],
        [MOVIE_ID, "The Faun's Garden", 'movie'],
    ] as const) {
        await sql`
            INSERT INTO media_items (id, title, media_type, year, status, has_files)
            VALUES (${id}::uuid, ${title}, ${mediaType}, 2009, 'active', true)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${id}::uuid, 'tmdb', ${String(COLLIDING_TMDB_ID)}, ${mediaType}, true)
        `;
    }
}

async function mdblistScoreFor(sql: postgres.Sql, mediaId: string): Promise<string | null> {
    const rows = await sql<{ score: string | null }[]>`
        SELECT metadata->>'mdblist_score' AS score
        FROM provider_metadata WHERE media_id = ${mediaId}::uuid AND provider = 'mdblist'
    `;
    return rows.length > 0 ? rows[0].score : null;
}

describe('mdblist-sync media-type mapping (regression)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = await getTestDb();
        vi.spyOn(mdblistApi, 'isAvailable').mockReturnValue(true);
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES);
        providerBatchMock.invokeProviderBatchLookup.mockReset();
        await seedCollision(sql);
    });

    it('writes a series’ ratings to the series row, not the movie sharing its TMDB id', async () => {
        providerBatchMock.invokeProviderBatchLookup.mockResolvedValue([mdblistItem('show', 69)]);

        const result = await syncMDBListRatings({ sql, mediaType: 'tv', onlyMissing: true });

        // The series got its data...
        expect(await mdblistScoreFor(sql, TV_ID)).toBe('69');
        // ...and the movie that merely shares tmdb 1417 was left untouched.
        // Before the fix this asserted the corruption: the movie held the series' 69.
        expect(await mdblistScoreFor(sql, MOVIE_ID)).toBeNull();
        expect(result.updated).toBe(1);
    });

    it('requests the series using DB vocabulary (tv), never MDBList’s "show"', async () => {
        providerBatchMock.invokeProviderBatchLookup.mockResolvedValue([mdblistItem('show', 69)]);

        await syncMDBListRatings({ sql, mediaType: 'tv', onlyMissing: true });

        // The provider translates tv → show at the HTTP boundary; internal code
        // must never speak the provider's dialect.
        const compositeIds = providerBatchMock.invokeProviderBatchLookup.mock.calls[0][1];
        expect(compositeIds).toEqual([`tmdb:${COLLIDING_TMDB_ID}:tv`]);
    });

    it('does not count an item as updated when the upsert matches no media item', async () => {
        // Data for a tmdb id that no media_item carries — the upsert matches
        // nothing. This MUST NOT report `updated`, otherwise a run that
        // persisted nothing looks successful and its coverage row never clears.
        const orphan = mdblistItem('show', 55);
        (orphan.ids as Record<string, unknown>).tmdb = 999999;
        providerBatchMock.invokeProviderBatchLookup.mockResolvedValue([orphan]);

        await sql`DELETE FROM external_ids WHERE media_id = ${TV_ID}::uuid`;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${TV_ID}::uuid, 'tmdb', '999999', 'season', true)
        `;

        const result = await syncMDBListRatings({ sql, mediaType: 'tv', onlyMissing: true });

        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(1);
    });

    // C3 fix-round-2 (2026-09-25 security review): `upsertMdblistMetadata`
    // resolves a locked item's media_id even though it skips the write, so a
    // naive caller can mistake "matched but locked" for "matched and
    // written" and over-count `updated` / call `onSuccess` (which marks the
    // coverage row `completed` for a write that never landed). The
    // candidate query itself now excludes `metadata_locked` items too, so
    // this exercises the TOCTOU race the runtime fix guards: the item is
    // still unlocked when the candidate query runs, but gets locked before
    // `storeMDBListData` actually writes (simulated here by locking it as a
    // side effect of the provider batch-lookup response, which always fires
    // after candidate selection and before the write).
    it('does not count a locked item as updated when the lock lands after candidate selection (TOCTOU)', async () => {
        // Drop the unrelated `seedCollision` movie fixture — it would
        // otherwise also match the 'movie' candidate query and inflate
        // `result.skipped` via its own "no data upstream" branch.
        await sql`DELETE FROM media_items WHERE id = ${MOVIE_ID}::uuid`;

        const raceId = '33333333-3333-3333-3333-333333333333';
        await sql`
            INSERT INTO media_items (id, title, media_type, year, status, has_files)
            VALUES (${raceId}::uuid, 'Race Movie', 'movie', 2020, 'active', true)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${raceId}::uuid, 'tmdb', '777777', 'movie', true)
        `;
        const item = mdblistItem('movie', 80);
        (item.ids as Record<string, unknown>).tmdb = 777777;
        // The 'movie' query also picks up `seedCollision`'s movie
        // fixture (tmdb 1417) — align the mocked response with the actual
        // requested composite ids (index-aligned) instead of assuming a
        // single-item batch, or that unrelated fixture item gets counted as
        // an extra `skipped` and the assertion below over-counts.
        providerBatchMock.invokeProviderBatchLookup.mockImplementation(
            async (_providerId: string, compositeIds: string[]) => {
                await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${raceId}::uuid`;
                return compositeIds.map((id) => (id === 'tmdb:777777:movie' ? item : null));
            },
        );

        const onSuccess = vi.fn();
        const result = await syncMDBListRatings({
            sql,
            mediaType: 'movie',
            onlyMissing: true,
            onSuccess,
        });

        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(onSuccess).not.toHaveBeenCalled();
        expect(await mdblistScoreFor(sql, raceId)).toBeNull();
    });

    // C3 fix-round-3 (2026-09-25 security review): the TOCTOU test above only
    // proves `upsertMdblistMetadata`'s WRITE guard refuses a lock landing mid-
    // batch. It never proves the round-2 CANDIDATE-QUERY filter
    // (`AND mi.metadata_locked = false`, all 4 branches in mdblist-sync.ts)
    // ever excludes anything: reverting all 4 filters to `AND TRUE` left every
    // existing test in this file green, because none of them seed an item that
    // is ALREADY locked before candidate selection with no mdblist data yet.
    // These do — and assert the provider is never even called, not just that
    // the write is discarded.
    describe('a locked item lacking mdblist data is excluded from the candidate query itself', () => {
        const LOCKED_ID = '44444444-4444-4444-4444-444444444444';

        beforeEach(async () => {
            // seedCollision's fixtures are unlocked and also lack mdblist data,
            // so they'd otherwise match the same candidate query and get
            // fetched, contaminating the "provider never called" assertion.
            await sql`DELETE FROM media_items WHERE id IN (${TV_ID}::uuid, ${MOVIE_ID}::uuid)`;
            await sql`
                INSERT INTO media_items (id, title, media_type, year, status, has_files, metadata_locked)
                VALUES (${LOCKED_ID}::uuid, 'Locked No-Data Movie', 'movie', 2020, 'active', true, true)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${LOCKED_ID}::uuid, 'tmdb', '424242', 'movie', true)
            `;
        });

        it('legacy mode, onlyMissing: never selects the locked item, never calls the provider', async () => {
            const result = await syncMDBListRatings({ sql, mediaType: 'movie', onlyMissing: true });

            expect(providerBatchMock.invokeProviderBatchLookup).not.toHaveBeenCalled();
            expect(result.processed).toBe(0);
            expect(result.updated).toBe(0);
            expect(await mdblistScoreFor(sql, LOCKED_ID)).toBeNull();
        });

        it('legacy mode, full-sweep (onlyMissing:false): never selects the locked item, never calls the provider', async () => {
            const result = await syncMDBListRatings({
                sql,
                mediaType: 'movie',
                onlyMissing: false,
            });

            expect(providerBatchMock.invokeProviderBatchLookup).not.toHaveBeenCalled();
            expect(result.processed).toBe(0);
            expect(result.updated).toBe(0);
        });

        // Coverage mode: the same 4 queries also serve as the scoped query
        // (candidateIds filter). A locked candidate that a coverage-table
        // caller still hands in via `candidateSource` never matches the
        // movie/TV fetch query either, so it falls into the drift-reconcile
        // branch (mdblist-sync.ts ~:420) and is marked skipped_transient with
        // reason 'ineligible-by-legacy-filter' — assert that path is benign:
        // no provider call, no error, just a disposition write.
        it('coverage mode: a locked candidate never reaches the provider and is reconciled to skipped_transient (ineligible-by-legacy-filter)', async () => {
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, updated_at)
                VALUES (${LOCKED_ID}::uuid, 'mdblist-sync', 1, 'pending', now())
            `;

            const result = await syncMDBListRatings({
                sql,
                mediaType: 'movie',
                onlyMissing: true,
                candidateSource: async () => [{ id: LOCKED_ID }],
                stageId: 'mdblist-sync',
            });

            expect(providerBatchMock.invokeProviderBatchLookup).not.toHaveBeenCalled();
            expect(result.updated).toBe(0);
            expect(result.errors).toEqual([]);

            const [row] = await sql<
                { status: string; skipped_reason: string | null; next_eligible_at: Date | null }[]
            >`
                SELECT status, skipped_reason, next_eligible_at FROM media_item_stage_state
                WHERE media_item_id = ${LOCKED_ID}::uuid AND stage_id = 'mdblist-sync'
            `;
            expect(row.status).toBe('skipped_transient');
            expect(row.skipped_reason).toBe('ineligible-by-legacy-filter');
            expect(row.next_eligible_at).not.toBeNull();
            expect(row.next_eligible_at!.getTime()).toBeGreaterThan(Date.now());
        });
    });
});
