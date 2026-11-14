// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Route-level integration test for GET/POST /j/DisplayPreferences/livetv.
//
// Bypasses withJellyfinAuth via vi.mock (middleware behavior is covered in
// middleware.test.ts) and points getDb at the test database, so the real
// handler runs its real queries end-to-end against jellyfin_display_preferences.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../../tests/integration/fixtures/user.fixtures.js';

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

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function buildEvent(userId: string, method: string, query = '', body?: unknown): RequestEvent {
    const url = `http://localhost/j/DisplayPreferences/livetv${query}`;
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        init.headers = { 'content-type': 'application/json' };
    }
    return {
        url: new URL(url),
        request: new Request(url, init),
        locals: {
            user: {
                userId: toUserId(userId),
            },
        },
        params: {},
    } as unknown as RequestEvent;
}

async function call(handler: unknown, event: RequestEvent): Promise<Response> {
    return (handler as (event: RequestEvent) => Promise<Response>)(event);
}

describe.runIf(RUN)('/j/DisplayPreferences/livetv', () => {
    let sql: postgres.Sql;
    const userId = randomUUID();

    beforeAll(async () => {
        sql = getTestDb();
        await ensureTestUser(sql, userId);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['jellyfin_display_preferences']);
    });

    it('GET with no stored row returns the hardcoded default', async () => {
        const { GET } = await import('./+server');
        const res = await call(GET, buildEvent(userId, 'GET'));

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.Id).toBe('livetv');
        expect(body.Client).toBe('emby');
        expect(body.CustomPrefs).toEqual({});
    });

    it('POST a body then GET returns exactly what was posted', async () => {
        const { GET, POST } = await import('./+server');
        const posted = {
            Id: 'livetv',
            SortBy: 'DatePlayed',
            SortOrder: 'Descending',
            Client: 'emby',
        };

        const postRes = await call(POST, buildEvent(userId, 'POST', '', posted));
        expect(postRes.status).toBe(204);

        const getRes = await call(GET, buildEvent(userId, 'GET'));
        const body = (await getRes.json()) as Record<string, unknown>;
        expect(body.SortBy).toBe('DatePlayed');
        expect(body.SortOrder).toBe('Descending');
        expect(body.Id).toBe('livetv');
        expect(body.Client).toBe('emby');
    });

    it('POST with a malformed body returns a client error (ApiResponses.badRequest), not 500', async () => {
        const { POST } = await import('./+server');

        const malformedJson = await call(POST, buildEvent(userId, 'POST', '', 'not json'));
        expect(malformedJson.status).toBe(422);

        const nonObject = await call(POST, buildEvent(userId, 'POST', '', 'true'));
        expect(nonObject.status).toBe(422);
    });

    it('POST with an array body is rejected, not stored', async () => {
        const { POST } = await import('./+server');

        const res = await call(POST, buildEvent(userId, 'POST', '', [1, 2, 3]));
        expect(res.status).toBe(422);
    });

    it('a partial POST does not drop default fields from the next GET', async () => {
        const { GET, POST } = await import('./+server');

        const postRes = await call(POST, buildEvent(userId, 'POST', '', { SortBy: 'DatePlayed' }));
        expect(postRes.status).toBe(204);

        const getRes = await call(GET, buildEvent(userId, 'GET'));
        const body = (await getRes.json()) as Record<string, unknown>;
        expect(body.SortBy).toBe('DatePlayed');
        expect(body.PrimaryImageHeight).toBe(200);
        expect(body.ShowBackdrop).toBe(true);
        expect(body.CustomPrefs).toEqual({});
    });

    it('different client values for the same user do not clobber each other', async () => {
        const { GET, POST } = await import('./+server');

        await call(POST, buildEvent(userId, 'POST', '?client=emby', { SortBy: 'SortName' }));
        await call(POST, buildEvent(userId, 'POST', '?client=androidtv', { SortBy: 'DatePlayed' }));

        const embyRes = await call(GET, buildEvent(userId, 'GET', '?client=emby'));
        const androidRes = await call(GET, buildEvent(userId, 'GET', '?client=androidtv'));

        const embyBody = (await embyRes.json()) as Record<string, unknown>;
        const androidBody = (await androidRes.json()) as Record<string, unknown>;

        expect(embyBody.SortBy).toBe('SortName');
        expect(androidBody.SortBy).toBe('DatePlayed');
    });
});
