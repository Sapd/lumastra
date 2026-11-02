// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Binge-Worthy Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    insertTestEmbedding,
    ensureTestUser,
    insertTestWatchStateEntry,
    insertTestRating,
    createTestRating,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { cacheManager, CACHE_NAMESPACES } from '../../cache/index.js';
import { TasteDamperService } from '../../services/taste-damper.service.js';

import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

import { getBingeWorthySeries } from './binge-worthy.queries.js';

describe('Binge-Worthy Queries', () => {
    let sql: postgres.Sql;
    const userId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        // The damper context centers cosines against a cached global embedding
        // mean (see TasteDamperService.getGlobalMean) — clear it so a prior
        // test/file's seeded embeddings can't leak into this run's mean.
        await cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean).delete('global-mean:v1');
    });

    describe('getBingeWorthySeries', () => {
        it('returns empty array when no matching series', async () => {
            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: new Date().toISOString(),
                access: unrestrictedAccess(),
            });
            expect(result).toEqual([]);
        });

        it('excludes already-watched series', async () => {
            await ensureTestUser(sql, userId);
            const series = createTestMediaItem({
                media_type: 'tv',
                title: 'Watched Show',
                year: 2020,
            });
            await insertTestMediaItem(sql, series);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(series.id, {
                    tmdbId: 900001,
                    mediaType: 'tv',
                }),
            );
            await insertTestWatchStateEntry(sql, {
                user_id: userId,
                media_id: series.id,
                watched_at: new Date(),
            });

            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: '2020-01-01',
                access: unrestrictedAccess(),
            });
            expect(result.some((r) => r.internal_id === series.id)).toBe(false);
        });

        it('returns a qualifying series via the inverted media_scalars scan', async () => {
            // A well-rated series, ≥6 months old, unwatched. Exercises the
            // inverted `FROM media_scalars` scan + winning-source filter: the
            // quality gate (mdblist_score) reads the winning media_scalars row,
            // and an item with no media_scalars row (below) must not appear.
            const series = createTestMediaItem({
                media_type: 'tv',
                title: 'Binge Candidate',
                year: 2020,
            });
            await insertTestMediaItem(sql, series);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(series.id, { tmdbId: 900010, mediaType: 'tv' }),
            );
            // provider_metadata write → trigger populates media_scalars (source 'tmdb').
            // has_files defaults false, so the requestable threshold (>= 70) applies.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'tmdb',
                    ${sql.json({ mdblist_score: 80, overview: 'Bingeable.' })}, NOW())
            `;

            // A second series with NO media_scalars row → dropped by the inverted
            // scan exactly as the old LATERAL's NULL scalars failed every quality
            // branch.
            const noScalars = createTestMediaItem({
                media_type: 'tv',
                title: 'No Scalars',
                year: 2020,
            });
            await insertTestMediaItem(sql, noScalars);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(noScalars.id, { tmdbId: 900011, mediaType: 'tv' }),
            );

            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: '2024-06-01',
                access: unrestrictedAccess(),
            });

            const hit = result.find((r) => r.internal_id === series.id);
            expect(hit).toBeDefined();
            expect(hit?.quality_score).toBe(80);
            expect(result.some((r) => r.internal_id === noScalars.id)).toBe(false);
        });

        it('excludes disliked series (rating <= 4)', async () => {
            await ensureTestUser(sql, userId);
            const series = createTestMediaItem({
                media_type: 'tv',
                title: 'Disliked Show',
                year: 2020,
            });
            await insertTestMediaItem(sql, series);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(series.id, { tmdbId: 900020, mediaType: 'tv' }),
            );
            // High-quality, unwatched series that would otherwise qualify...
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'tmdb',
                    ${sql.json({ mdblist_score: 85, overview: 'Bingeable but disliked.' })}, NOW())
            `;
            // ...but the user rated it 2 (a dislike) → must be excluded.
            await insertTestRating(sql, createTestRating(userId, series.id, 2));

            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: '2024-06-01',
                access: unrestrictedAccess(),
            });

            expect(result.some((r) => r.internal_id === series.id)).toBe(false);
        });

        it('keeps a series the user rated highly (rating > 4)', async () => {
            await ensureTestUser(sql, userId);
            const series = createTestMediaItem({
                media_type: 'tv',
                title: 'Liked Show',
                year: 2020,
            });
            await insertTestMediaItem(sql, series);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(series.id, { tmdbId: 900021, mediaType: 'tv' }),
            );
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'tmdb',
                    ${sql.json({ mdblist_score: 85, overview: 'Bingeable and liked.' })}, NOW())
            `;
            // A positive rating (8) must NOT trigger the dislike exclusion.
            await insertTestRating(sql, createTestRating(userId, series.id, 8));

            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: '2024-06-01',
                access: unrestrictedAccess(),
            });

            expect(result.some((r) => r.internal_id === series.id)).toBe(true);
        });

        it('per-class window: requestable series survive even when outnumbered and outscored by available ones', async () => {
            // Regression for the bug fixed by the `availability_ranked` window: a
            // single combined `ORDER BY is_available DESC, quality_score DESC
            // LIMIT limit + 5` let available series evict every requestable
            // (is_available = false) row once they filled the window. Seed MORE
            // available candidates than the window (limit + 5) and give every one
            // of them a higher quality_score than every requestable candidate —
            // under the old single-window LIMIT this must return zero
            // requestable rows; under the fix each availability class gets its
            // own window.
            const limit = 5;
            const perClassWindow = limit + 5;

            const AVAILABLE_COUNT = perClassWindow + 5; // 10 + 5 = 15
            const availableTmdbIds: number[] = [];
            for (let i = 0; i < AVAILABLE_COUNT; i++) {
                const tmdbId = 900100 + i;
                availableTmdbIds.push(tmdbId);
                const series = createTestMediaItem({
                    media_type: 'tv',
                    title: `Available ${i}`,
                    year: 2020,
                    has_files: true,
                });
                await insertTestMediaItem(sql, series);
                await insertTestExternalIds(
                    sql,
                    createTestExternalIds(series.id, { tmdbId, mediaType: 'tv' }),
                );
                // Strictly decreasing, all well above every requestable
                // candidate's score below (75/74/73).
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                    VALUES (${series.id}::uuid, 'tmdb',
                        ${sql.json({ mdblist_score: 99 - i, overview: 'Available.' })}, NOW())
                `;
            }

            const REQUESTABLE_COUNT = 3;
            const requestableTmdbIds: number[] = [];
            for (let i = 0; i < REQUESTABLE_COUNT; i++) {
                const tmdbId = 900200 + i;
                requestableTmdbIds.push(tmdbId);
                const series = createTestMediaItem({
                    media_type: 'tv',
                    title: `Requestable ${i}`,
                    year: 2020,
                    has_files: false,
                });
                await insertTestMediaItem(sql, series);
                await insertTestExternalIds(
                    sql,
                    createTestExternalIds(series.id, { tmdbId, mediaType: 'tv' }),
                );
                // has_files = false requires mdblist_score >= 70 to qualify.
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                    VALUES (${series.id}::uuid, 'tmdb',
                        ${sql.json({ mdblist_score: 75 - i, overview: 'Requestable.' })}, NOW())
                `;
            }

            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit,
                sixMonthsAgo: '2024-06-01',
                access: unrestrictedAccess(),
            });

            const availableRows = result.filter((r) => r.is_available);
            const requestableRows = result.filter((r) => !r.is_available);

            // All 3 requestable candidates must survive — not evicted by the
            // far-more-numerous, higher-scoring available ones.
            expect(requestableRows.map((r) => r.primary_ext_id).sort()).toEqual(
                requestableTmdbIds.map(String).sort(),
            );

            // Available candidates must also be present (a per-class window,
            // not an availability filter), capped at limit + 5 — with 15
            // seeded and a window of 10, exactly 10 survive.
            expect(availableRows.length).toBe(perClassWindow);
            expect(availableRows.length).toBeLessThanOrEqual(perClassWindow);
            expect(requestableRows.length).toBeLessThanOrEqual(perClassWindow);
        });
    });

    describe('getBingeWorthySeries — taste-damper penalty', () => {
        const DIM = 1024;

        function axis(i: number): number[] {
            const v = new Array<number>(DIM).fill(0);
            v[i] = 1;
            return v;
        }

        /** Seed a qualifying, unwatched TV series with an embedding + quality score. */
        async function seedBingeSeries(
            title: string,
            tmdbId: number,
            embedding: number[],
            mdblistScore = 80,
        ): Promise<string> {
            const series = createTestMediaItem({ media_type: 'tv', title, year: 2020 });
            await insertTestMediaItem(sql, series);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(series.id, { tmdbId, mediaType: 'tv' }),
            );
            // provider_metadata write → trigger populates media_scalars (source 'tmdb').
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'tmdb',
                    ${sql.json({ mdblist_score: mdblistScore, overview: 'Bingeable.' })}, NOW())
            `;
            await insertTestEmbedding(sql, {
                media_id: series.id,
                embedding,
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            return series.id;
        }

        it('demotes a series in an active damper neighborhood below an equally-rated, unrelated series', async () => {
            await ensureTestUser(sql, userId);

            // Background embeddings so the global mean is well-separated from any
            // single candidate/damper vector below (mirrors
            // for-you-damper-ranking.integration.test.ts).
            for (let i = 10; i < 16; i++) {
                const bg = createTestMediaItem({ media_type: 'movie', title: `bg-${i}` });
                await insertTestMediaItem(sql, bg);
                await insertTestEmbedding(sql, {
                    media_id: bg.id,
                    embedding: axis(i),
                    source: EMBEDDING_SOURCE.LIBRARY,
                });
            }

            // Two equally-qualified (same mdblist_score) candidates: one sits in
            // the damper's neighborhood (axis 0), the other is unrelated (axis 2).
            const damped = await seedBingeSeries('Damped Show', 910001, axis(0));
            const unrelated = await seedBingeSeries('Unrelated Show', 910002, axis(2));
            // The damper target needs its own media item + embedding —
            // TasteDamperService.recordDamper reads the embedding back from
            // media_embeddings.
            const damperTarget = await seedBingeSeries('Damper Seed', 910003, axis(0));

            const damperService = new TasteDamperService(sql);
            await damperService.recordDamper(userId, damperTarget, 'tv');
            const damper = await damperService.getDamperContext(userId);
            expect(damper).not.toBeNull();

            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: '2024-06-01',
                access: unrestrictedAccess(),
                damper,
            });

            const damperIdx = result.findIndex((r) => r.internal_id === damped);
            const unrelatedIdx = result.findIndex((r) => r.internal_id === unrelated);
            expect(damperIdx).toBeGreaterThanOrEqual(0);
            expect(unrelatedIdx).toBeGreaterThanOrEqual(0);
            // Equal mdblist_score → equal quality_score, but the damped item's
            // ranking score is attenuated by DAMPER_LAMBDA — it must sort
            // strictly below the unrelated one despite the tie.
            expect(unrelatedIdx).toBeLessThan(damperIdx);
        });

        it('leaves ranking unattenuated when no damper context is passed', async () => {
            await ensureTestUser(sql, userId);
            const id = await seedBingeSeries('No Damper Series', 910010, axis(0));

            // `damper` omitted entirely — must default to null and behave exactly
            // as the pre-existing (no-damper) query path.
            const result = await getBingeWorthySeries(sql, {
                userId,
                excludeTmdbIds: [],
                limit: 10,
                sixMonthsAgo: '2024-06-01',
                access: unrestrictedAccess(),
            });

            expect(result.some((r) => r.internal_id === id)).toBe(true);
        });
    });
});

/**
 * Differential access-boundary coverage.
 *
 * Runs the SAME fixture twice — once unrestricted, once restricted — and asserts
 * the restricted result is a STRICT SUBSET of the unrestricted one. That is what
 * catches a boundary argument that arrived but was never threaded into the SQL,
 * or a predicate applied to the wrong `media_items` alias (this query binds `mi`
 * twice: once in the `user_watched` exclusion CTE and once in `candidates`).
 *
 * Note the two axes need different fixtures: the library axis can only exclude
 * an item that HAS a media_files row (the predicate always admits items with no
 * file rows), while the age axis keys off media_items.age_rating.
 */
describe('binge-worthy queries — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;
    const boundaryUser = toUserId(randomUUID());
    let deniedGroup: string;

    let openItemId: string; // no files, no age rating — always visible
    let groupItemId: string; // file in `deniedGroup` — hidden by the library axis
    let adultItemId: string; // age_rating 18 — hidden by the age axis

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await ensureTestUser(sql, boundaryUser);

        deniedGroup = randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${deniedGroup}::uuid, 'Denied Binge Group')
        `;

        openItemId = await seedBoundarySeries(920001, { libraryGroupId: null, ageRating: null });
        groupItemId = await seedBoundarySeries(920002, {
            libraryGroupId: deniedGroup,
            ageRating: null,
        });
        adultItemId = await seedBoundarySeries(920003, { libraryGroupId: null, ageRating: 18 });
    });

    /** Seed a qualifying, unwatched TV series (mdblist_score 80 clears both thresholds). */
    async function seedBoundarySeries(
        tmdbId: number,
        opts: { libraryGroupId: string | null; ageRating: number | null },
    ): Promise<string> {
        const series = createTestMediaItem({
            media_type: 'tv',
            title: `Boundary ${tmdbId}`,
            year: 2020,
        });
        await insertTestMediaItem(sql, series);
        await insertTestExternalIds(
            sql,
            createTestExternalIds(series.id, { tmdbId, mediaType: 'tv' }),
        );
        // 80 clears the requestable (>= 70) and available (>= 65) quality gates,
        // so the fixture qualifies regardless of has_files.
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${series.id}::uuid, 'tmdb',
                ${sql.json({ mdblist_score: 80, overview: 'Boundary fixture.' })}, NOW())
        `;

        if (opts.ageRating !== null) {
            await sql`
                UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${series.id}::uuid
            `;
        }

        // Only an item reachable by the library predicate can be excluded by it —
        // it admits every item with no file rows where it looks. For a `tv`
        // container it looks at the SEASON -> EPISODE descendants' files, never
        // at files attached to the series row itself, so placement goes through
        // the shared helper that builds that chain.
        if (opts.libraryGroupId) {
            await placeInLibraryGroup(sql, {
                mediaItemId: series.id,
                mediaType: 'tv',
                libraryGroupId: opts.libraryGroupId,
            });
        }

        return series.id;
    }

    async function idsFor(access: MediaAccessBoundary): Promise<Set<string>> {
        const rows = await getBingeWorthySeries(sql, {
            userId: boundaryUser,
            excludeTmdbIds: [],
            limit: 50,
            sixMonthsAgo: '2024-06-01',
            access,
        });
        return new Set(rows.map((r) => r.internal_id));
    }

    it('unrestricted access sees every seeded item', async () => {
        const all = await idsFor(unrestrictedAccess());
        expect(all).toContain(openItemId);
        expect(all).toContain(groupItemId);
        expect(all).toContain(adultItemId);
    });

    it('a denied library group yields a strict subset missing that item', async () => {
        const all = await idsFor(unrestrictedAccess());
        const restricted = await idsFor(
            restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        for (const id of restricted) expect(all).toContain(id);
        expect(restricted.size).toBeLessThan(all.size);
        expect(restricted).not.toContain(groupItemId);
        // The other axis must be untouched.
        expect(restricted).toContain(openItemId);
        expect(restricted).toContain(adultItemId);
    });

    it('an age limit yields a strict subset missing the over-limit item', async () => {
        const all = await idsFor(unrestrictedAccess());
        const restricted = await idsFor(
            restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        for (const id of restricted) expect(all).toContain(id);
        expect(restricted.size).toBeLessThan(all.size);
        expect(restricted).not.toContain(adultItemId);
        expect(restricted).toContain(openItemId);
        expect(restricted).toContain(groupItemId);
    });

    it('a denyAll boundary returns nothing', async () => {
        expect(
            await getBingeWorthySeries(sql, {
                userId: boundaryUser,
                excludeTmdbIds: [],
                limit: 50,
                sixMonthsAgo: '2024-06-01',
                access: denyAllAccess(),
            }),
        ).toEqual([]);
    });
});
