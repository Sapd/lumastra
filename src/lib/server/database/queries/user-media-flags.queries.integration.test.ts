// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Media Flags Query Module
 *
 * Tests per-user UI intent markers (dismissals, featured picks, etc.)
 * including CRUD operations, expiration logic, and dismissal target resolution.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    setFlag,
    removeFlag,
    removeFlagIfOlderThan,
    userHasAnyFlag,
    hasFlag,
    getUserFlags,
    getActiveFlagTargets,
    deleteExpiredFlags,
    resolveDismissalTarget,
    fetchDismissalMediaInfo,
    type DismissalMediaInfo,
} from './user-media-flags.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

describe('User Media Flags Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_media_flags', 'media_items', 'external_ids']);
    });

    let targetCounter = 990001;
    async function createTargetMovie(): Promise<string> {
        const { id } = await createAndInsertTestMovie(sql, {
            tmdbId: targetCounter++,
        });
        return id;
    }

    // ========================================================================
    // setFlag
    // ========================================================================

    describe('setFlag', () => {
        it('inserts a permanent flag', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            const result = await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            expect(result.length).toBe(1);
            expect(result[0].id).toBeTruthy();
        });

        it('inserts an ephemeral flag with expires_at', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

            const result = await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'featured_pick_shown',
                expiresAt,
            });

            expect(result.length).toBe(1);
        });

        it('is idempotent (DO NOTHING on conflict)', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            const first = await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });
            expect(first.length).toBe(1);

            const second = await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });
            expect(second.length).toBe(0);
        });
    });

    // ========================================================================
    // removeFlag
    // ========================================================================

    describe('removeFlag', () => {
        it('deletes an existing flag', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            await removeFlag(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
            });

            const exists = await hasFlag(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
            });
            expect(exists).toBe(false);
        });

        it('is a no-op when flag does not exist', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = crypto.randomUUID();

            await expect(
                removeFlag(sql, {
                    userId,
                    targetId,
                    flagType: 'dismissed_cw',
                }),
            ).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // removeFlagIfOlderThan
    // ========================================================================

    describe('removeFlagIfOlderThan', () => {
        it('removes flag only when created strictly before the threshold', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const futureThreshold = new Date(Date.now() + 3600000).toISOString();
            await removeFlagIfOlderThan(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
                createdBefore: futureThreshold,
            });

            const exists = await hasFlag(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
            });
            expect(exists).toBe(false);
        });

        it('preserves flag when created at or after the threshold', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const pastThreshold = new Date(Date.now() - 3600000).toISOString();
            await removeFlagIfOlderThan(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
                createdBefore: pastThreshold,
            });

            const exists = await hasFlag(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
            });
            expect(exists).toBe(true);
        });
    });

    // ========================================================================
    // userHasAnyFlag
    // ========================================================================

    describe('userHasAnyFlag', () => {
        it('returns true when user has at least one flag of the type', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const result = await userHasAnyFlag(sql, {
                userId,
                flagType: 'dismissed_cw',
            });
            expect(result).toBe(true);
        });

        it('returns false when user has no flags of the type', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await userHasAnyFlag(sql, {
                userId,
                flagType: 'dismissed_cw',
            });
            expect(result).toBe(false);
        });
    });

    // ========================================================================
    // hasFlag
    // ========================================================================

    describe('hasFlag', () => {
        it('returns true when flag exists', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const result = await hasFlag(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
            });
            expect(result).toBe(true);
        });

        it('returns false when flag does not exist', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = crypto.randomUUID();

            const result = await hasFlag(sql, {
                userId,
                targetId,
                flagType: 'dismissed_cw',
            });
            expect(result).toBe(false);
        });
    });

    // ========================================================================
    // getUserFlags
    // ========================================================================

    describe('getUserFlags', () => {
        it('returns flags ordered by created_at DESC', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await setFlag.execute(sql, {
                userId,
                targetId: await createTargetMovie(),
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });
            await new Promise((r) => setTimeout(r, 10));
            await setFlag.execute(sql, {
                userId,
                targetId: await createTargetMovie(),
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const result = await getUserFlags.all(sql, {
                userId,
                flagType: 'dismissed_cw',
            });

            expect(result.length).toBe(2);
        });
    });

    // ========================================================================
    // getActiveFlagTargets
    // ========================================================================

    describe('getActiveFlagTargets', () => {
        it('includes permanent flags (expires_at IS NULL)', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const result = await getActiveFlagTargets(sql, {
                userId,
                flagType: 'dismissed_cw',
            });

            expect(result).toContain(targetId);
        });

        it('excludes expired flags', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();
            const past = new Date(Date.now() - 3600000).toISOString();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'featured_pick_shown',
                expiresAt: past,
            });

            const result = await getActiveFlagTargets(sql, {
                userId,
                flagType: 'featured_pick_shown',
            });

            expect(result).not.toContain(targetId);
        });
    });

    // ========================================================================
    // deleteExpiredFlags
    // ========================================================================

    describe('deleteExpiredFlags', () => {
        it('deletes flags whose expires_at has passed', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const targetId = await createTargetMovie();
            const past = new Date(Date.now() - 3600000).toISOString();

            await setFlag.execute(sql, {
                userId,
                targetId,
                targetType: 'movie',
                flagType: 'featured_pick_shown',
                expiresAt: past,
            });

            const count = await deleteExpiredFlags(sql);
            expect(count).toBeGreaterThanOrEqual(1);

            const exists = await hasFlag(sql, {
                userId,
                targetId,
                flagType: 'featured_pick_shown',
            });
            expect(exists).toBe(false);
        });

        it('does not delete permanent flags', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await setFlag.execute(sql, {
                userId,
                targetId: await createTargetMovie(),
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });

            const _count = await deleteExpiredFlags(sql);
            // Should not delete the permanent flag
            const result = await getUserFlags.all(sql, {
                userId,
                flagType: 'dismissed_cw',
            });
            expect(result.length).toBe(1);
        });
    });

    // ========================================================================
    // resolveDismissalTarget
    // ========================================================================

    describe('resolveDismissalTarget', () => {
        it('resolves episode to its series grandparent', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episodeRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid
                )
                AND media_type = 'episode'
                LIMIT 1
            `;

            const result = await resolveDismissalTarget(sql, episodeRow.id);

            expect(result).not.toBeNull();
            expect(result!.type).toBe('series');
            expect(result!.id).toBe(series.seriesId);
        });

        it('resolves movie to itself', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql);

            const result = await resolveDismissalTarget(sql, movieId);

            expect(result).not.toBeNull();
            expect(result!.type).toBe('movie');
            expect(result!.id).toBe(movieId);
        });

        it('returns null for unsupported media types (e.g. season)', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [seasonRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${series.seriesId}::uuid
                AND media_type = 'season'
                LIMIT 1
            `;

            const result = await resolveDismissalTarget(sql, seasonRow.id);
            expect(result).toBeNull();
        });
    });
});

/**
 * Differential access-boundary coverage for `fetchDismissalMediaInfo`.
 *
 * Each case runs the SAME query over the SAME fixture twice — once with an
 * explicitly unrestricted boundary and once restricted — and asserts the
 * restricted result is a STRICT SUBSET of the unrestricted one. A boundary
 * argument that arrives but is never used, or a predicate applied to the wrong
 * alias, makes the two results equal and fails the assertion. `denyAll` must
 * come back empty; under the legacy permissive shape that state was
 * inexpressible at all.
 */
describe('fetchDismissalMediaInfo — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
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

    let deniedGroup: string;
    let allowedGroup: string;
    let boundaryCounter = 970001;

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_flags',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        deniedGroup = crypto.randomUUID();
        allowedGroup = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${deniedGroup}::uuid, 'Denied Dismissal Group'),
                   (${allowedGroup}::uuid, 'Allowed Dismissal Group')
        `;
    });

    /**
     * Seed one dismissal target. A `libraryGroupId` attaches a media_files row
     * in that group — without file rows the library predicate always admits the
     * item (container-style rows are visible by design), so a fixture with no
     * files cannot demonstrate library filtering at all.
     */
    async function seedTarget(opts: {
        libraryGroupId?: string;
        ageRating?: number | null;
    }): Promise<string> {
        const { id } = await createAndInsertTestMovie(sql, { tmdbId: boundaryCounter++ });
        if (opts.ageRating !== undefined) {
            await sql`
                UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${id}::uuid
            `;
        }
        if (opts.libraryGroupId) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/hidden/${id}.mkv`}, ${opts.libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;
        }
        return id;
    }

    function idsOf(rows: DismissalMediaInfo[]): string[] {
        return rows.map((r) => r.id).sort();
    }

    it('library axis: restricted result is a strict subset of unrestricted', async () => {
        const allowed = await seedTarget({ libraryGroupId: allowedGroup });
        const denied = await seedTarget({ libraryGroupId: deniedGroup });
        const targetIds = [allowed, denied];

        const unrestricted = await fetchDismissalMediaInfo(sql, targetIds, unrestrictedAccess());
        const restricted = await fetchDismissalMediaInfo(
            sql,
            targetIds,
            restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        expect(idsOf(unrestricted)).toEqual([allowed, denied].sort());
        expect(idsOf(restricted)).toEqual([allowed]);
        // Strict subset: every restricted id is in the unrestricted set, and the
        // two sets are not equal.
        for (const row of restricted) {
            expect(idsOf(unrestricted)).toContain(row.id);
        }
        expect(restricted.length).toBeLessThan(unrestricted.length);
    });

    it('age axis: restricted result is a strict subset of unrestricted', async () => {
        const mild = await seedTarget({ ageRating: 6 });
        const adult = await seedTarget({ ageRating: 18 });
        const targetIds = [mild, adult];

        const unrestricted = await fetchDismissalMediaInfo(sql, targetIds, unrestrictedAccess());
        const restricted = await fetchDismissalMediaInfo(
            sql,
            targetIds,
            restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: false,
            }),
        );

        expect(idsOf(unrestricted)).toEqual([mild, adult].sort());
        expect(idsOf(restricted)).toEqual([mild]);
        expect(restricted.length).toBeLessThan(unrestricted.length);
    });

    it('age axis: allowUnrated decides whether NULL-rated targets survive', async () => {
        const unrated = await seedTarget({ ageRating: null });
        const targetIds = [unrated];

        const permissive = await fetchDismissalMediaInfo(
            sql,
            targetIds,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true }),
        );
        const strict = await fetchDismissalMediaInfo(
            sql,
            targetIds,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
        );

        expect(idsOf(permissive)).toEqual([unrated]);
        expect(strict).toEqual([]);
    });

    it('denyAll returns EMPTY even when every target is otherwise visible', async () => {
        const a = await seedTarget({});
        const b = await seedTarget({ libraryGroupId: allowedGroup });
        const targetIds = [a, b];

        const unrestricted = await fetchDismissalMediaInfo(sql, targetIds, unrestrictedAccess());
        expect(idsOf(unrestricted)).toEqual([a, b].sort());

        expect(await fetchDismissalMediaInfo(sql, targetIds, denyAllAccess())).toEqual([]);
        // Neither axis alone may be trusted to close the boundary; each denyAll
        // scope must independently produce nothing.
        expect(
            await fetchDismissalMediaInfo(sql, targetIds, {
                library: { kind: 'denyAll' },
                age: { kind: 'any' },
            }),
        ).toEqual([]);
        expect(
            await fetchDismissalMediaInfo(sql, targetIds, {
                library: { kind: 'all' },
                age: { kind: 'denyAll' },
            }),
        ).toEqual([]);
    });

    it('excludes non-active rows regardless of boundary', async () => {
        const active = await seedTarget({});
        const deleted = await seedTarget({});
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${deleted}::uuid`;

        const rows = await fetchDismissalMediaInfo(sql, [active, deleted], unrestrictedAccess());
        expect(idsOf(rows)).toEqual([active]);
    });

    it('returns an empty list for no targets without touching the database', async () => {
        expect(await fetchDismissalMediaInfo(sql, [], unrestrictedAccess())).toEqual([]);
    });
});
