// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the `/api/for-you/taste` def wiring — cursor
 * pagination, explicit status, and typed-reason mapping through the def's
 * exported composition function `getTasteRailPage` (the GET handler is a
 * thin wrapper around it, mirroring `defs/rate/queue.ts`).
 *
 * Seeds persisted `user_suggestions` rows directly (bypassing the AI
 * generation pipeline), same pattern as
 * `defs/recommendations/strategies/ai.strategy.integration.test.ts` — this
 * suite exercises the def's own query→ctx→response wiring, not the
 * strategy's internal page-assembly logic (already covered there).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import { getTasteRailPage, patchIncludeWatchHistory } from './taste.js';
import type { AccessContext } from '../recommendations/recommender.js';
import { toUserId } from '$lib/shared/user-id.js';

const URL = getTestDatabaseUrl();

function ctxFor(userId: string): AccessContext {
    return {
        userId: toUserId(userId),
        username: 'itest-taste-def',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
    };
}

describe('GET /api/for-you/taste — getTasteRailPage (integration)', () => {
    let sql: postgres.Sql;
    let userId: string;
    const mediaIds: string[] = [];

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        userId = generateTestUserId('itest-taste-def');
        await ensureTestUser(sql, userId);

        // seed 3 media + persisted suggestions with strictly decreasing scores
        for (let i = 0; i < 3; i++) {
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES (${'TasteDefTest ' + i}, 'movie', 'active') RETURNING id`;
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

    it('returns a ready page with typed reasons and an opaque cursor', async () => {
        const page1 = await getTasteRailPage(ctxFor(userId), { surface: 'internal', limit: 2 });
        expect(page1.status).toBe('ready');
        expect(page1.items).toHaveLength(2);
        expect(page1.items[0].reason).toEqual({
            kind: 'rated-similar',
            seed: 'Seed Movie',
            label: '9',
        });
        expect(page1.page.nextCursor).toBeTruthy();

        const page2 = await getTasteRailPage(ctxFor(userId), {
            surface: 'internal',
            limit: 2,
            cursor: page1.page.nextCursor,
        });
        expect(page2.items).toHaveLength(1);
        // no duplicate ids across pages
        const ids = [...page1.items, ...page2.items].map((i) => i.media.id);
        expect(new Set(ids).size).toBe(ids.length);

        const page3 = await getTasteRailPage(ctxFor(userId), {
            surface: 'internal',
            limit: 2,
            cursor: page2.page.nextCursor,
        });
        expect(page3.items).toHaveLength(0);
        expect(page3.status).toBe('exhausted');
    });

    it('reports generating for a fresh user with no suggestions/embedding', async () => {
        const freshUser = generateTestUserId('itest-taste-def-fresh');
        await ensureTestUser(sql, freshUser);
        try {
            const page = await getTasteRailPage(ctxFor(freshUser), {
                surface: 'internal',
                limit: 5,
            });
            expect(page.items).toHaveLength(0);
            expect(page.status).toBe('generating');
            expect(page.page.nextCursor).toBeUndefined();
        } finally {
            await sql`DELETE FROM user_profiles WHERE user_id = ${freshUser}`;
            await sql`DELETE FROM users WHERE id = ${freshUser}`;
        }
    });
});

describe('PATCH /api/for-you/taste — patchIncludeWatchHistory (integration)', () => {
    let sql: postgres.Sql;
    let userId: string;

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        userId = generateTestUserId('itest-taste-patch');
        await ensureTestUser(sql, userId);
    });

    afterAll(async () => {
        await sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
        await sql`DELETE FROM users WHERE id = ${userId}`;
        await sql.end();
    });

    it('defaults includeWatchHistory to true when the user has never set it', async () => {
        const page = await getTasteRailPage(ctxFor(userId), { surface: 'internal', limit: 5 });
        expect(page.includeWatchHistory).toBe(true);
    });

    it('persists the toggle and the next GET reflects it', async () => {
        const result = await patchIncludeWatchHistory(toUserId(userId), false);
        expect(result).toEqual({ ok: true });

        // Persisted directly on user_profiles.preferences.
        const [row] = await sql<{ value: string | null }[]>`
            SELECT preferences ->> 'includeWatchHistory' AS value
            FROM user_profiles
            WHERE user_id = ${userId}
        `;
        expect(row?.value).toBe('false');

        // GET reflects the change (additive field on the existing response).
        const page = await getTasteRailPage(ctxFor(userId), { surface: 'internal', limit: 5 });
        expect(page.includeWatchHistory).toBe(false);

        // Flip it back — persists true, not just "unset".
        await patchIncludeWatchHistory(toUserId(userId), true);
        const [rowAfter] = await sql<{ value: string | null }[]>`
            SELECT preferences ->> 'includeWatchHistory' AS value
            FROM user_profiles
            WHERE user_id = ${userId}
        `;
        expect(rowAfter?.value).toBe('true');
        const pageAfter = await getTasteRailPage(ctxFor(userId), { surface: 'internal', limit: 5 });
        expect(pageAfter.includeWatchHistory).toBe(true);
    });
});
