// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for AiStrategy — cursor pagination, explicit status,
 * structured reasons.
 *
 * Seeds persisted `user_suggestions` rows directly (bypassing the AI
 * generation pipeline entirely) so the tests exercise ONLY the
 * page-assembly / cursor / status logic in `AiStrategy.fetch`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../../tests/integration/fixtures/user.fixtures.js';
import { aiStrategy, aiAccessBoundary, filterSuggestionsByAccess } from './ai.strategy.js';
import type { AccessContext } from '../recommender.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getUserSuggestions } from '$lib/server/database/queries/suggestion-management.queries.js';
import type { UserSuggestionRow } from '$lib/server/database/queries/suggestion-management.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

const URL = getTestDatabaseUrl();

function ctxFor(userId: string): AccessContext {
    return {
        userId,
        username: 'itest-ai-strategy',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
    } as AccessContext;
}

describe('AiStrategy cursor/status (integration)', () => {
    let sql: postgres.Sql;
    let userId: string;
    const mediaIds: string[] = [];

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        userId = generateTestUserId('itest-ai-strategy');
        await ensureTestUser(sql, userId);

        // seed 3 media + persisted suggestions with strictly decreasing scores
        for (let i = 0; i < 3; i++) {
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES (${'AiStratTest ' + i}, 'movie', 'active') RETURNING id`;
            mediaIds.push(id);
            await sql`
                INSERT INTO user_suggestions (user_id, media_id, combined_score, explanation, reason_data, expires_at)
                VALUES (${userId}, ${id}, ${0.9 - i * 0.1}, 'legacy text',
                        ${sql.json({ kind: 'rated-similar', title: 'Seed Movie', rating: 9 })},
                        now() + interval '1 day')`;
        }
    });

    afterAll(async () => {
        await sql`DELETE FROM user_suggestions WHERE user_id = ${userId}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds})`;
        await sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
        await sql`DELETE FROM users WHERE id = ${userId}`;
        await sql.end();
    });

    it('pages with an opaque cursor and reports exhausted at the end', async () => {
        const page1 = await aiStrategy.fetch(ctxFor(userId), { surface: 'internal', limit: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
        expect(page1.nextCursor).toBeTruthy();
        expect(page1.status).toBe('ready');

        const page2 = await aiStrategy.fetch(ctxFor(userId), {
            surface: 'internal',
            limit: 2,
            cursor: page1.nextCursor,
        });
        expect(page2.items).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
        expect(page2.nextCursor).toBeTruthy(); // issued whenever items > 0

        const page3 = await aiStrategy.fetch(ctxFor(userId), {
            surface: 'internal',
            limit: 2,
            cursor: page2.nextCursor,
        });
        expect(page3.items).toHaveLength(0);
        expect(page3.status).toBe('exhausted');
        // no duplicate ids across pages
        const ids = [...page1.items, ...page2.items].map((i) => i.media.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('reports exhausted (not a wrong page) when the suggestion batch regenerates between pages', async () => {
        // Own user + media so mutating `created_at` here can't perturb the
        // other tests in this describe block, which share `userId`/`mediaIds`.
        const regenUser = generateTestUserId('itest-ai-regen');
        const regenMediaIds: string[] = [];
        await ensureTestUser(sql, regenUser);
        try {
            for (let i = 0; i < 3; i++) {
                const [{ id }] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, status)
                    VALUES (${'AiRegenTest ' + i}, 'movie', 'active') RETURNING id`;
                regenMediaIds.push(id);
                await sql`
                    INSERT INTO user_suggestions (user_id, media_id, combined_score, explanation, expires_at)
                    VALUES (${regenUser}, ${id}, ${0.9 - i * 0.1}, 'legacy text', now() + interval '1 day')`;
            }

            const page1 = await aiStrategy.fetch(ctxFor(regenUser), {
                surface: 'internal',
                limit: 2,
            });
            expect(page1.items).toHaveLength(2);
            expect(page1.status).toBe('ready');
            expect(page1.nextCursor).toBeTruthy();

            // Simulate the every-5th-rating regen cadence deleting+reinserting
            // `user_suggestions` between this page and the next: bump the
            // top-ranked row's `created_at` (its combined_score keeps it
            // first in the ORDER BY, so this changes ONLY the gen token, not
            // the ranking) without a real delete+reinsert cycle.
            await sql`
                UPDATE user_suggestions
                SET created_at = now() + interval '1 hour'
                WHERE user_id = ${regenUser} AND media_id = ${regenMediaIds[0]}
            `;

            const page2 = await aiStrategy.fetch(ctxFor(regenUser), {
                surface: 'internal',
                limit: 2,
                cursor: page1.nextCursor,
            });

            expect(page2.items).toHaveLength(0);
            expect(page2.hasMore).toBe(false);
            expect(page2.status).toBe('exhausted');
        } finally {
            await sql`DELETE FROM user_suggestions WHERE user_id = ${regenUser}`;
            await sql`DELETE FROM media_items WHERE id = ANY(${regenMediaIds})`;
            await sql`DELETE FROM user_profiles WHERE user_id = ${regenUser}`;
            await sql`DELETE FROM users WHERE id = ${regenUser}`;
        }
    });

    it('maps reason_data to a typed reason', async () => {
        const page = await aiStrategy.fetch(ctxFor(userId), { surface: 'internal', limit: 1 });
        expect(page.items[0].reason).toEqual({
            kind: 'rated-similar',
            seed: 'Seed Movie',
            label: '9',
        });
    });

    it('excludes a suggestion whose media has been marked watched', async () => {
        const watchUser = generateTestUserId('itest-ai-watched');
        const watchMediaIds: string[] = [];
        await ensureTestUser(sql, watchUser);
        try {
            for (let i = 0; i < 2; i++) {
                const [{ id }] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, status)
                    VALUES (${'AiWatchedTest ' + i}, 'movie', 'active') RETURNING id`;
                watchMediaIds.push(id);
                await sql`
                    INSERT INTO user_suggestions (user_id, media_id, combined_score, explanation, expires_at)
                    VALUES (${watchUser}, ${id}, ${0.9 - i * 0.1}, 'legacy text', now() + interval '1 day')`;
            }
            // Mark the first (top-ranked) suggestion as watched.
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched)
                VALUES (${watchUser}, ${watchMediaIds[0]}, true)`;

            const page = await aiStrategy.fetch(ctxFor(watchUser), {
                surface: 'internal',
                limit: 5,
            });

            expect(page.items.map((i) => i.media.id)).not.toContain(watchMediaIds[0]);
            expect(page.items.map((i) => i.media.id)).toContain(watchMediaIds[1]);
        } finally {
            await sql`DELETE FROM user_media_state WHERE user_id = ${watchUser}`;
            await sql`DELETE FROM user_suggestions WHERE user_id = ${watchUser}`;
            await sql`DELETE FROM media_items WHERE id = ANY(${watchMediaIds})`;
            await sql`DELETE FROM user_profiles WHERE user_id = ${watchUser}`;
            await sql`DELETE FROM users WHERE id = ${watchUser}`;
        }
    });

    it('reports generating for a profile without suggestions/embedding', async () => {
        const freshUser = generateTestUserId('itest-ai-fresh');
        await ensureTestUser(sql, freshUser);
        try {
            const res = await aiStrategy.fetch(ctxFor(freshUser), {
                surface: 'internal',
                limit: 5,
            });
            expect(res.items).toHaveLength(0);
            expect(res.status).toBe('generating');
        } finally {
            await sql`DELETE FROM user_profiles WHERE user_id = ${freshUser}`;
            await sql`DELETE FROM users WHERE id = ${freshUser}`;
        }
    });
});

// =============================================================================
// Access-boundary differential suite
//
// The boundary is now a REQUIRED argument to `filterSuggestionsByAccess`. That
// makes it impossible to *omit*, but not impossible to ignore — an argument can
// still arrive and never be used, or be applied to the wrong alias. These tests
// run the same fixture under several boundaries and assert the restricted
// results are STRICT subsets of the unrestricted one, which is what catches
// that class of bug.
// =============================================================================

describe('AiStrategy access boundary (differential, integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;
    let allowedGroupId: string;
    let deniedGroupId: string;
    /** In `deniedGroupId`, age_rating 6. */
    let deniedGroupItem: string;
    /** In `allowedGroupId`, age_rating 18. */
    let adultItem: string;
    /** In `allowedGroupId`, age_rating NULL. */
    let unratedItem: string;

    async function attachFile(mediaItemId: string, libraryGroupId: string): Promise<void> {
        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${`/data/ai-boundary-${mediaItemId}.mkv`}, ${libraryGroupId}::uuid)
            ON CONFLICT (file_path) DO UPDATE SET library_group_id = EXCLUDED.library_group_id
            RETURNING id`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
            ON CONFLICT DO NOTHING`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
    }

    async function seedSuggestion(
        title: string,
        ageRating: number | null,
        libraryGroupId: string,
        score: number,
    ): Promise<string> {
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, age_rating)
            VALUES (${title}, 'movie', 'active', ${ageRating}) RETURNING id`;
        await attachFile(id, libraryGroupId);
        await sql`
            INSERT INTO user_suggestions (user_id, media_id, combined_score, explanation, expires_at)
            VALUES (${userId}, ${id}, ${score}, 'legacy text', now() + interval '1 day')`;
        return id;
    }

    /** Read the persisted batch exactly as `AiStrategy.fetch` does. */
    async function rawRows(): Promise<UserSuggestionRow[]> {
        return getUserSuggestions(sql, userId, 50, {});
    }

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        userId = generateTestUserId('itest-ai-boundary') as UserId;
        await ensureTestUser(sql, userId);

        allowedGroupId = crypto.randomUUID();
        deniedGroupId = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${allowedGroupId}::uuid, ${'ai-bnd-allowed-' + allowedGroupId})`;
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, ${'ai-bnd-denied-' + deniedGroupId})`;

        deniedGroupItem = await seedSuggestion('AiBoundary Denied Group', 6, deniedGroupId, 0.9);
        adultItem = await seedSuggestion('AiBoundary Adult', 18, allowedGroupId, 0.8);
        unratedItem = await seedSuggestion('AiBoundary Unrated', null, allowedGroupId, 0.7);
    });

    afterAll(async () => {
        const ids = [deniedGroupItem, adultItem, unratedItem];
        await sql`DELETE FROM user_suggestions WHERE user_id = ${userId}`;
        await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM media_files WHERE file_path LIKE '/data/ai-boundary-%'`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
        await sql`DELETE FROM users WHERE id = ${userId}`;
        await sql`DELETE FROM library_groups WHERE id = ANY(${[allowedGroupId, deniedGroupId]}::uuid[])`;
        await sql.end();
    });

    it('unrestricted keeps every persisted suggestion', async () => {
        const rows = await rawRows();
        const kept = await filterSuggestionsByAccess(sql, rows, unrestrictedAccess());
        expect(kept.map((r) => r.media_id).sort()).toEqual(
            [deniedGroupItem, adultItem, unratedItem].sort(),
        );
    });

    it('a denied library group yields a STRICT subset of the unrestricted result', async () => {
        const rows = await rawRows();
        const unrestricted = new Set(
            (await filterSuggestionsByAccess(sql, rows, unrestrictedAccess())).map(
                (r) => r.media_id,
            ),
        );
        const restricted = await filterSuggestionsByAccess(
            sql,
            rows,
            restrictedAccess({
                deniedGroupIds: [deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        const restrictedIds = restricted.map((r) => r.media_id);

        expect(restrictedIds.length).toBeGreaterThan(0);
        expect(restrictedIds.length).toBeLessThan(unrestricted.size);
        for (const id of restrictedIds) expect(unrestricted.has(id)).toBe(true);
        expect(restrictedIds).not.toContain(deniedGroupItem);
    });

    it('an age limit drops over-age and (when disallowed) unrated items', async () => {
        const rows = await rawRows();

        const withUnrated = await filterSuggestionsByAccess(
            sql,
            rows,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true }),
        );
        expect(withUnrated.map((r) => r.media_id).sort()).toEqual(
            [deniedGroupItem, unratedItem].sort(),
        );

        const withoutUnrated = await filterSuggestionsByAccess(
            sql,
            rows,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
        );
        expect(withoutUnrated.map((r) => r.media_id)).toEqual([deniedGroupItem]);
        // Strict subset of the allowUnrated variant, which is itself a subset
        // of unrestricted.
        expect(withoutUnrated.length).toBeLessThan(withUnrated.length);
    });

    it('both axes compose — neither is silently dropped', async () => {
        const rows = await rawRows();
        const kept = await filterSuggestionsByAccess(
            sql,
            rows,
            restrictedAccess({
                deniedGroupIds: [deniedGroupId],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );
        // The library axis removes the only item the age axis would have kept
        // besides the unrated one; the adult item stays out via the age axis.
        expect(kept.map((r) => r.media_id)).toEqual([unratedItem]);
    });

    it('a denyAll boundary returns EMPTY', async () => {
        const rows = await rawRows();
        expect(rows.length).toBeGreaterThan(0);
        expect(await filterSuggestionsByAccess(sql, rows, denyAllAccess())).toEqual([]);
    });

    it('fetch() carries the boundary through: a denied group shrinks the rail', async () => {
        const open = await aiStrategy.fetch(ctxFor(userId), { surface: 'internal', limit: 10 });
        const restrictedCtx: AccessContext = {
            ...ctxFor(userId),
            deniedGroupIds: [deniedGroupId],
        };
        const closed = await aiStrategy.fetch(restrictedCtx, { surface: 'internal', limit: 10 });

        const openIds = new Set(open.items.map((i) => i.media.id));
        const closedIds = closed.items.map((i) => i.media.id);

        expect(openIds.has(deniedGroupItem)).toBe(true);
        expect(closedIds).not.toContain(deniedGroupItem);
        expect(closedIds.length).toBeLessThan(openIds.size);
        for (const id of closedIds) expect(openIds.has(id)).toBe(true);
    });

    it('aiAccessBoundary maps AccessContext without a permissive default', () => {
        expect(aiAccessBoundary(ctxFor(userId))).toEqual({
            library: { kind: 'all' },
            age: { kind: 'any' },
        });
        expect(
            aiAccessBoundary({
                ...ctxFor(userId),
                deniedGroupIds: [deniedGroupId],
                maxAgeRating: 12,
                allowUnrated: false,
            }),
        ).toEqual({
            library: { kind: 'denyGroups', ids: [deniedGroupId] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
        // A null denied list (no DB during context build) is NOT a hidden
        // permissive default sneaking in — it maps to the explicit `all`.
        expect(aiAccessBoundary({ ...ctxFor(userId), deniedGroupIds: null }).library).toEqual({
            kind: 'all',
        });
    });
});
