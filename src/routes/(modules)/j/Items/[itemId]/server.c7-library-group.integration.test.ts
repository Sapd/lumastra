// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for GET /j/Items/{itemId} when {itemId} is a
 * library_group_id (C7, 2026-09-18 fix plan 4 task 6).
 *
 * `getLibraryGroupInfo` was a raw lookup with no user/access parameter, and
 * `checkMediaAccess` passes vacuously for a library-group id (it is never a
 * `media_items.id`, so the query's `NOT EXISTS` branch fires unconditionally)
 * — a denied user who had ever learned the group's UUID could still fetch its
 * Name/ChildCount indefinitely. The fix threads the
 * caller's denied-group set into `getLibraryGroupInfo` so a denied group and
 * a nonexistent one produce the exact same response.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

// The Live TV standalone provider (reached in the not-found fallback chain)
// imports getDb from connection.js directly, not the barrel above — mock it
// too or it throws "Database connection not available" (no DATABASE_URL is
// set in this test process).
vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function buildEvent(
    itemId: string,
    user: { userGroups: string[]; isAdmin?: boolean },
): RequestEvent<{ itemId: string }, '/(modules)/j/Items/[itemId]'> {
    return {
        url: new URL(`http://localhost/j/Items/${itemId}`),
        request: new Request(`http://localhost/j/Items/${itemId}`),
        locals: {
            user: {
                username: 'route-c7-test',
                userId: toUserId(randomUUID()),
                groups: '',
                userGroups: user.userGroups,
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: user.isAdmin ?? false,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        },
        params: { itemId },
        route: { id: '/(modules)/j/Items/[itemId]' },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent<{ itemId: string }, '/(modules)/j/Items/[itemId]'>;
}

describe.runIf(RUN)('GET /j/Items/{itemId} for a library_group_id (C7)', () => {
    let sql: postgres.Sql;
    let deniedGroupId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function cleanup(): Promise<void> {
        if (deniedGroupId) {
            await deleteLibraryGroupPermission(sql, deniedGroupId);
            await sql`DELETE FROM library_paths WHERE library_group_id = ${deniedGroupId}::uuid`;
            await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
        }
        invalidateLibraryGroupPermissionsCache();
    }

    it('returns a body/status byte-identical to an unknown id for a denied library group, and real data when allowed', async () => {
        deniedGroupId = randomUUID();
        try {
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C7 Denied Group')`;
            await sql`
                INSERT INTO library_paths (library_group_id, path, media_type, enabled)
                VALUES (${deniedGroupId}::uuid, '/data/route-c7-denied', 'movie', true)
            `;
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: deniedGroupId,
                allowedGroups: ['adults'],
            });
            invalidateLibraryGroupPermissionsCache();

            const { GET } = await import('./+server.js');

            // Nonexistent id — the baseline "not found" shape.
            const unknownId = randomUUID();
            const unknownResp = await GET(buildEvent(unknownId, { userGroups: ['kids'] }));
            const unknownBody = await unknownResp.text();

            // Denied caller against a library group that DOES exist.
            const deniedResp = await GET(buildEvent(deniedGroupId, { userGroups: ['kids'] }));
            const deniedBody = await deniedResp.text();

            expect(deniedResp.status).toBe(unknownResp.status);
            expect(deniedResp.status).toBe(404);
            expect(deniedBody).toBe(unknownBody);
            expect([...deniedResp.headers].sort()).toEqual([...unknownResp.headers].sort());

            // Allowed caller — real CollectionFolder data still flows through.
            const allowedResp = await GET(buildEvent(deniedGroupId, { userGroups: ['adults'] }));
            expect(allowedResp.status).toBe(200);
            const allowedBody = (await allowedResp.json()) as {
                Id: string;
                Type: string;
                Name: string;
            };
            expect(allowedBody.Id).toBe(deniedGroupId);
            expect(allowedBody.Type).toBe('CollectionFolder');
        } finally {
            await cleanup();
        }
    });

    it('denies a dashless UUID identically to the dashed form — the native Jellyfin client spelling', async () => {
        // Round-1 CRITICAL: the denial check must live in SQL
        // (`!= ALL(deniedGroupIds::uuid[])`), not as a JS
        // `.includes(groupId)` against the raw request string.
        // `getDeniedLibraryGroups` returns canonical lowercase-dashed ids;
        // `isUuid()` (and this route) also accept the dashless 32-hex form
        // Jellyfin clients natively send. Postgres treats both spellings as
        // the same value under `::uuid`, so a JS string comparison would
        // silently miss and fail OPEN for a denied group requested in its
        // dashless form.
        deniedGroupId = randomUUID();
        try {
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C7 Dashless Group')`;
            await sql`
                INSERT INTO library_paths (library_group_id, path, media_type, enabled)
                VALUES (${deniedGroupId}::uuid, '/data/route-c7-dashless', 'movie', true)
            `;
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: deniedGroupId,
                allowedGroups: ['adults'],
            });
            invalidateLibraryGroupPermissionsCache();

            const { GET } = await import('./+server.js');

            const dashlessDenied = deniedGroupId.replace(/-/g, '');
            expect(dashlessDenied).not.toContain('-');

            const unknownId = randomUUID();
            const unknownResp = await GET(buildEvent(unknownId, { userGroups: ['kids'] }));
            const unknownBody = await unknownResp.text();

            const deniedResp = await GET(buildEvent(dashlessDenied, { userGroups: ['kids'] }));
            const deniedBody = await deniedResp.text();

            expect(deniedResp.status).toBe(404);
            expect(deniedResp.status).toBe(unknownResp.status);
            expect(deniedBody).toBe(unknownBody);
        } finally {
            await cleanup();
        }
    });
});
