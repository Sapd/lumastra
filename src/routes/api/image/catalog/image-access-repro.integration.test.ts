// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F3 — Existence leaks: 403 returned instead of 404 after
 * checkMediaAccess.
 *
 * Finding: When checkMediaAccess fails on a resolved media item, routes return
 * ApiResponses.forbidden() instead of ApiResponses.notFound(). A restricted
 * caller can probe IDs and distinguish "exists but denied" from "does not exist".
 *
 * Citation: src/routes/api/image/catalog/[id]/[type]/+server.ts:80
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('F3 — Image route leaks existence via 403 instead of 404', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
        } catch {
            throw new Error('media_items table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'repro-f3-%'`;
        await sql`DELETE FROM users WHERE username LIKE 'repro-f3-%'`;
    });

    async function insertRestrictedUser(): Promise<{
        id: string;
        username: string;
        maxAgeRating: number;
    }> {
        const id = crypto.randomUUID();
        const username = `repro-f3-user-${id.slice(0, 6)}`;
        await sql`
            INSERT INTO users (id, username, is_admin, max_age_rating)
            VALUES (${id}::uuid, ${username}, false, ${8})
        `;
        return { id, username, maxAgeRating: 8 };
    }

    async function insertAdultMediaItem(): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, media_type, title, age_rating)
            VALUES (${id}::uuid, ${'movie'}, ${'repro-f3-adult-movie'}, ${18})
        `;
        return id;
    }

    it('returns 403 for a media item that exists but is age-restricted', async () => {
        const { checkMediaAccess } = await import('$lib/server/middleware/media-access.js');
        const user = await insertRestrictedUser();
        const mediaId = await insertAdultMediaItem();

        const allowed = await checkMediaAccess(sql, mediaId, {
            id: user.id,
            username: user.username,
            isAdmin: false,
            isAgeRestricted: true,
            maxAgeRating: user.maxAgeRating,
        } as never);

        // The item exists but is denied.
        expect(allowed).toBe(false);

        // BUG: The route returns 403 (forbidden) which leaks that the item
        // EXISTS. A 404 (not found) would not leak existence.
        // We verify this by importing the route handler and exercising it.
        const { GET } = await import('./[id]/[type]/+server.js');

        const res = await GET({
            url: new URL(`http://localhost/api/image/catalog/${mediaId}/poster`),
            request: new Request(`http://localhost/api/image/catalog/${mediaId}/poster`, {
                method: 'GET',
            }),
            locals: {
                user: {
                    id: user.id,
                    username: user.username,
                    ownerIsAdmin: false,
                    isAgeRestricted: true,
                    maxAgeRating: user.maxAgeRating,
                },
            },
            params: { id: mediaId, type: 'poster' },
            route: { id: null },
            cookies: {} as never,
            fetch,
            getClientAddress: () => '127.0.0.1',
            platform: undefined,
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: () => undefined,
            depends: () => undefined,
            untrack: <T>(fn: () => T) => fn(),
        } as unknown as import('./[id]/[type]/$types').RequestEvent);

        // CORRECT behavior: For a media item that exists but is denied,
        // the route should return 404 (not found) to avoid leaking existence.
        // BUG: The route either returns 403 or throws a 500 error.
        expect(res.status).toBe(404);
    });
});
