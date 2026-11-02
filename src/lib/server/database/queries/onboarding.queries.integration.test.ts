// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Onboarding Query Module
 *
 * Tests step retrieval, auto-detection, dismissals, and hero state helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getOnboardingSteps,
    autoDetectOnboardingCompletion,
    dismissOnboardingStep,
    dismissAllOnboarding,
    determineHeroState,
    getOnboardingState,
    getRandomMediaItems,
    getRecentlyAddedItems,
    getRandomPickItems,
    isFirstRunSetupOlderThan,
} from './onboarding.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('Onboarding Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'onboarding_state']);
        // Re-seed onboarding steps because truncate wiped them
        await sql`
            INSERT INTO onboarding_state (step_key)
            VALUES ('library_paths'), ('tmdb_config'), ('library_scan'), ('ai_config'), ('onboarding_dismissed')
            ON CONFLICT (step_key) DO NOTHING
        `;
    });

    // ========================================================================
    // getOnboardingSteps
    // ========================================================================

    describe('getOnboardingSteps', () => {
        it('returns all seeded steps', async () => {
            const steps = await getOnboardingSteps(sql);
            const keys = steps.map((s) => s.step_key);
            expect(keys).toContain('library_paths');
            expect(keys).toContain('tmdb_config');
            expect(keys).toContain('library_scan');
            expect(keys).toContain('ai_config');
            expect(keys).toContain('onboarding_dismissed');
        });
    });

    // ========================================================================
    // autoDetectOnboardingCompletion
    // ========================================================================

    describe('autoDetectOnboardingCompletion', () => {
        it('returns mediaCount even when steps already completed', async () => {
            // If no media, count is 0
            const result = await autoDetectOnboardingCompletion(sql);
            expect(result.mediaCount).toBe(0);
        });

        it('marks library_scan complete when active media exists', async () => {
            await createAndInsertTestMovie(sql);
            await autoDetectOnboardingCompletion(sql);

            const steps = await getOnboardingSteps(sql);
            const scanStep = steps.find((s) => s.step_key === 'library_scan');
            expect(scanStep?.completed).toBe(true);
        });

        it('marks tmdb_config / ai_config complete from plugin_secrets keys', async () => {
            // Provider keys live in env (config) or plugin_secrets — NOT the
            // removed provider_configuration table. A UI-set key lands here.
            await sql`
                INSERT INTO plugin_secrets (plugin_id, key, value_encrypted)
                VALUES ('tmdb', 'TMDB_API_KEY', ${Buffer.from([0])}),
                       ('openai', 'OPENAI_API_KEY', ${Buffer.from([0])})
                ON CONFLICT (plugin_id, key) DO NOTHING
            `;
            try {
                await autoDetectOnboardingCompletion(sql);

                const steps = await getOnboardingSteps(sql);
                expect(steps.find((s) => s.step_key === 'tmdb_config')?.completed).toBe(true);
                expect(steps.find((s) => s.step_key === 'ai_config')?.completed).toBe(true);
            } finally {
                // beforeEach doesn't truncate plugin_secrets — clean up so the
                // keys don't leak into other tests' detection.
                await sql`DELETE FROM plugin_secrets WHERE plugin_id IN ('tmdb', 'openai')`;
            }
        });
    });

    // ========================================================================
    // dismissOnboardingStep
    // ========================================================================

    describe('dismissOnboardingStep', () => {
        it('marks a step as dismissed', async () => {
            await dismissOnboardingStep(sql, 'library_paths', 'admin');

            const steps = await getOnboardingSteps(sql);
            const step = steps.find((s) => s.step_key === 'library_paths');
            expect(step?.dismissed).toBe(true);
            expect(step?.dismissed_by).toBe('admin');
        });
    });

    // ========================================================================
    // dismissAllOnboarding
    // ========================================================================

    describe('dismissAllOnboarding', () => {
        it('marks the master dismissal step', async () => {
            await dismissAllOnboarding(sql, 'admin');

            const steps = await getOnboardingSteps(sql);
            const step = steps.find((s) => s.step_key === 'onboarding_dismissed');
            expect(step?.dismissed).toBe(true);
        });
    });

    // ========================================================================
    // determineHeroState
    // ========================================================================

    describe('determineHeroState', () => {
        it('returns onboarding when no media and not dismissed', async () => {
            const result = await determineHeroState(sql, true);
            expect(result.heroState).toBe('onboarding');
            expect(result.mediaCount).toBe(0);
        });

        it('returns full-metadata when media and TMDB ids exist', async () => {
            await createAndInsertTestMovie(sql, { tmdbId: 990099 });
            await createAndInsertTestTvShow(sql, { tmdbId: 880088 });

            const result = await determineHeroState(sql, true);
            expect(result.heroState).toBe('full-metadata');
            expect(result.mediaCount).toBeGreaterThan(0);
        });
    });

    describe('getOnboardingState', () => {
        it('reports the active item count and TMDB presence, also once all steps are complete', async () => {
            const empty = await getOnboardingState(sql);
            expect(empty.mediaCount).toBe(0);
            expect(empty.hasTmdbIds).toBe(false);

            await createAndInsertTestMovie(sql, { tmdbId: 990101 });
            await createAndInsertTestTvShow(sql, { tmdbId: 880101 });
            const [{ count }] = await sql<[{ count: number }]>`
                SELECT COUNT(*)::int AS count FROM media_items WHERE status = 'active'`;

            const filled = await getOnboardingState(sql);
            expect(filled.mediaCount).toBe(count);
            expect(filled.hasTmdbIds).toBe(true);

            // All actionable steps complete: autoDetect takes its short-circuit
            // path, whose count getOnboardingState reuses.
            await sql`UPDATE onboarding_state SET completed = true WHERE step_key <> 'onboarding_dismissed'`;
            const done = await getOnboardingState(sql);
            expect(done.mediaCount).toBe(count);
            expect(done.hasTmdbIds).toBe(true);
        });
    });

    // ========================================================================
    // getRandomMediaItems
    // ========================================================================

    describe('getRandomMediaItems', () => {
        it('returns up to limit random active movie/tv items', async () => {
            // getRandomMediaItems filters has_files = true (catalog ghosts must
            // not surface), so the fixtures need real files.
            const { id: movieId } = await createAndInsertTestMovie(sql, {
                withFileItem: true,
            });
            const { id: tvId } = await createAndInsertTestTvShow(sql);
            await sql`UPDATE media_items SET has_files = true WHERE id IN (${movieId}::uuid, ${tvId}::uuid)`;

            // The boundary is REQUIRED — this call site genuinely wants every
            // row, so it says so explicitly rather than omitting the argument.
            const items = await getRandomMediaItems(sql, 5, unrestrictedAccess());
            expect(items.length).toBeGreaterThanOrEqual(1);
            expect(items.length).toBeLessThanOrEqual(5);
        });

        it('respects the limit', async () => {
            const items = await getRandomMediaItems(sql, 6, unrestrictedAccess());
            expect(items.length).toBeLessThanOrEqual(6);
        });
    });

    // ========================================================================
    // getRecentlyAddedItems
    // ========================================================================

    describe('getRecentlyAddedItems', () => {
        it('returns recently added items with files', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                withFileItem: true,
            });
            // Update has_files to true explicitly
            await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;

            const items = await getRecentlyAddedItems(sql, 10, unrestrictedAccess());
            expect(items.some((i) => i.id === id)).toBe(true);
        });
    });

    // ========================================================================
    // getRandomPickItems
    // ========================================================================

    describe('getRandomPickItems', () => {
        it('returns random active items with files', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                withFileItem: true,
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;

            const items = await getRandomPickItems(sql, 10, unrestrictedAccess());
            expect(items.some((i) => i.id === id)).toBe(true);
        });

        it('applies media-type filtering before the randomized limit', async () => {
            const { id } = await createAndInsertTestMovie(sql, { withFileItem: true });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;

            const items = await getRandomPickItems(sql, 10, unrestrictedAccess(), ['movie']);

            expect(items.some((i) => i.id === id)).toBe(true);
            expect(items.every((i) => i.media_type === 'movie')).toBe(true);
        });
    });
});

// ---------------------------------------------------------------------------
// Access-boundary differential coverage
// ---------------------------------------------------------------------------

/**
 * Differential tests for all three access-scoped item queries: run the same
 * fixture twice — once unrestricted, once restricted — and assert the restricted
 * result is a STRICT SUBSET of the unrestricted one, plus that a denyAll
 * boundary is EMPTY.
 *
 * Subset-plus-strictness is what catches the failure modes a "returns some rows"
 * assertion cannot: a boundary argument that arrived but was never spliced into
 * the SQL (restricted == unrestricted), and a predicate bound to the wrong alias
 * (restricted empty for the wrong reason — caught by pinning the exact surviving
 * id as a positive control).
 *
 * All calls use a limit far above the fixture count. That matters for the two
 * TABLESAMPLE queries: an under-filled sample falls back to a full random scan,
 * so the result set is the complete match set and the assertions are
 * deterministic despite `ORDER BY RANDOM()`.
 */
const DENIED_GROUP_NAME = 'Denied Onboarding Group';
const BIG_LIMIT = 50;

describe('onboarding item queries access boundary (differential)', () => {
    let sql: postgres.Sql;
    let deniedGroup: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    /**
     * Remove only THIS suite's fixtures. A blanket `DELETE FROM library_groups`
     * throws against a shared test database where another suite left a
     * `library_paths` row behind (`fk_library_paths_library_group` is RESTRICT).
     * `TEST_TABLES.media` already covers `media_files` / `media_file_items`, and
     * it must run BEFORE the group delete — those rows carry the group FK.
     */
    async function cleanupSuiteFixtures(): Promise<void> {
        await truncateTables(sql, [...TEST_TABLES.media]);
        await sql`DELETE FROM library_groups WHERE name = ${DENIED_GROUP_NAME}`;
    }

    afterAll(async () => {
        await cleanupSuiteFixtures();
        await closeTestDb();
    });

    beforeEach(async () => {
        await cleanupSuiteFixtures();
        deniedGroup = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${deniedGroup}::uuid, ${DENIED_GROUP_NAME})
        `;
    });

    /** Deny exactly these library groups; age axis left unrestricted. */
    function denyGroups(...ids: string[]): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
    }

    /** Cap the age axis; library axis left unrestricted. */
    function ageLimit(maxAgeRating: number, allowUnrated: boolean): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: [], maxAgeRating, allowUnrated });
    }

    /**
     * Seed one active, top-level movie with files.
     *
     * `libraryGroupId` attaches a media_files row in that group — WITHOUT a file
     * row the library predicate always admits the item (it explicitly passes rows
     * that have no media_file_items at all), so a denied-group test would
     * silently prove nothing.
     */
    async function seed(opts: {
        libraryGroupId?: string | null;
        ageRating?: number | null;
    }): Promise<string> {
        const item = createTestMediaItem({ media_type: 'movie', has_files: true });
        await insertTestMediaItem(sql, item);
        await sql`
            UPDATE media_items
               SET has_files = true,
                   age_rating = ${opts.ageRating ?? null}
             WHERE id = ${item.id}::uuid
        `;
        if (opts.libraryGroupId) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/onboarding/${item.id}.mkv`}, ${opts.libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${item.id}::uuid)
            `;
        }
        return item.id;
    }

    /**
     * The three queries share a row shape, so one differential contract covers
     * all of them. Running it per-query is what catches a reshape that converted
     * only some call paths.
     */
    const queries: Array<{
        name: string;
        run: (access: MediaAccessBoundary) => Promise<string[]>;
    }> = [
        {
            name: 'getRandomMediaItems',
            run: async (access) =>
                (await getRandomMediaItems(sql, BIG_LIMIT, access)).map((r) => r.id),
        },
        {
            name: 'getRecentlyAddedItems',
            run: async (access) =>
                (await getRecentlyAddedItems(sql, BIG_LIMIT, access)).map((r) => r.id),
        },
        {
            name: 'getRandomPickItems',
            run: async (access) =>
                (await getRandomPickItems(sql, BIG_LIMIT, access)).map((r) => r.id),
        },
    ];

    for (const { name, run } of queries) {
        describe(name, () => {
            it('restricted library scope is a STRICT subset of unrestricted', async () => {
                const allowedId = await seed({ libraryGroupId: null });
                const deniedId = await seed({ libraryGroupId: deniedGroup });

                const unrestricted = await run(unrestrictedAccess());
                const restricted = await run(denyGroups(deniedGroup));

                // Positive control: both rows are visible without a boundary.
                expect(unrestricted).toHaveLength(2);
                expect(unrestricted).toEqual(expect.arrayContaining([allowedId, deniedId]));

                // Subset...
                expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
                // ...and STRICTLY so — the denied row is the one that disappeared.
                expect(restricted.length).toBeLessThan(unrestricted.length);
                expect(restricted).toEqual([allowedId]);
                expect(restricted).not.toContain(deniedId);
            });

            it('restricted age scope is a STRICT subset of unrestricted', async () => {
                const kidsId = await seed({ ageRating: 6 });
                const adultId = await seed({ ageRating: 18 });

                const unrestricted = await run(unrestrictedAccess());
                const restricted = await run(ageLimit(12, false));

                expect(unrestricted).toEqual(expect.arrayContaining([kidsId, adultId]));
                expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
                expect(restricted.length).toBeLessThan(unrestricted.length);
                expect(restricted).toEqual([kidsId]);
            });

            it('allowUnrated flips whether NULL-age-rating rows survive', async () => {
                const unratedId = await seed({ ageRating: null });

                expect(await run(ageLimit(12, true))).toEqual([unratedId]);
                expect(await run(ageLimit(12, false))).toEqual([]);
            });

            it('denyAll returns EMPTY even though rows exist and are otherwise visible', async () => {
                await seed({ libraryGroupId: null });
                expect(await run(unrestrictedAccess())).toHaveLength(1);
                expect(await run(denyAllAccess())).toEqual([]);
            });
        });
    }

    // ========================================================================
    // isFirstRunSetupOlderThan
    // ========================================================================

    describe('isFirstRunSetupOlderThan', () => {
        const DAY = 24 * 60 * 60 * 1000;

        beforeEach(async () => {
            await sql`DELETE FROM setup_lock`;
        });

        afterAll(async () => {
            await sql`DELETE FROM setup_lock`;
        });

        it('is false before first-run setup completed', async () => {
            expect(await isFirstRunSetupOlderThan(sql, DAY)).toBe(false);
        });

        it('is false right after the first admin was created', async () => {
            await sql`INSERT INTO setup_lock (id) VALUES (1)`;
            expect(await isFirstRunSetupOlderThan(sql, DAY)).toBe(false);
        });

        it('is true once setup completed longer ago than the given age', async () => {
            await sql`INSERT INTO setup_lock (id, completed_at) VALUES (1, now() - interval '25 hours')`;
            expect(await isFirstRunSetupOlderThan(sql, DAY)).toBe(true);
        });

        it('CONTROL: an age of 0 accepts a setup completed just now', async () => {
            await sql`INSERT INTO setup_lock (id) VALUES (1)`;
            expect(await isFirstRunSetupOlderThan(sql, 0)).toBe(true);
        });
    });
});
