// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Route-level integration test for GET/POST /j/DisplayPreferences/{id}.
//
// Bypasses withJellyfinAuth via vi.mock (middleware behavior is covered in
// middleware.test.ts) and points getDb at the test database, so the real
// handler runs its real queries end-to-end against jellyfin_display_preferences.
//
// This route previously exported no POST handler at all — a client saving to
// a custom/non-standard display-prefs id got a 405. The POST tests here cover
// that gap directly.

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

function buildEvent(
    userId: string,
    id: string,
    method: string,
    query = '',
    body?: unknown,
): RequestEvent {
    const url = `http://localhost/j/DisplayPreferences/${id}${query}`;
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
        params: { id },
    } as unknown as RequestEvent;
}

async function call(handler: unknown, event: RequestEvent): Promise<Response> {
    return (handler as (event: RequestEvent) => Promise<Response>)(event);
}

describe.runIf(RUN)('/j/DisplayPreferences/{id}', () => {
    let sql: postgres.Sql;
    const userId = randomUUID();
    const customId = 'customview-abc123';

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

    it('GET with no stored row returns the hardcoded default with Id: params.id', async () => {
        const { GET } = await import('./+server');
        const res = await call(GET, buildEvent(userId, customId, 'GET'));

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.Id).toBe(customId);
        expect(body.Client).toBe('emby');
        expect(body.CustomPrefs).toEqual({});
    });

    it('POST now persists instead of 405ing', async () => {
        const { GET, POST } = await import('./+server');
        const posted = {
            Id: customId,
            SortBy: 'SortName',
            CustomPrefs: { homesection0: 'resume' },
            Client: 'emby',
        };

        const postRes = await call(POST, buildEvent(userId, customId, 'POST', '', posted));
        expect(postRes.status).toBe(204);

        const getRes = await call(GET, buildEvent(userId, customId, 'GET'));
        const body = (await getRes.json()) as Record<string, unknown>;
        expect(body.CustomPrefs).toEqual({ homesection0: 'resume' });
        expect(body.Id).toBe(customId);
    });

    it('POST with a malformed body returns a client error (ApiResponses.badRequest), not 500', async () => {
        const { POST } = await import('./+server');

        const malformedJson = await call(
            POST,
            buildEvent(userId, customId, 'POST', '', 'not json'),
        );
        expect(malformedJson.status).toBe(422);

        const nonObject = await call(POST, buildEvent(userId, customId, 'POST', '', 42));
        expect(nonObject.status).toBe(422);
    });

    it('POST with an array body is rejected, not stored', async () => {
        const { POST } = await import('./+server');

        const res = await call(POST, buildEvent(userId, customId, 'POST', '', ['x']));
        expect(res.status).toBe(422);
    });

    it('POST with a body under the app-level byte cap but over the DB CHECK (pg_column_size) returns 413, not 500', async () => {
        // Measured against this real PG: a JSON array of 6,000 zeros is only
        // ~12KB of raw UTF-8 text (comfortably under the app-level cap — it
        // would even pass the pre-fix 64KB cap), but jsonb stores each small
        // number with enough per-element overhead that pg_column_size comes out
        // around 72KB — over the migration 16.250.0 CHECK's 65,536 limit. This
        // is the case the app-level byte cap can never catch on its own: jsonb
        // storage overhead is shape-dependent, not a fixed fraction of the raw
        // byte count. Only converting the DB's own CHECK violation (23514 /
        // jellyfin_display_preferences_data_size_check) closes it.
        const { POST } = await import('./+server');
        const pathologicalBody = { CustomPrefs: { flags: new Array(6000).fill(0) } };

        const res = await call(POST, buildEvent(userId, customId, 'POST', '', pathologicalBody));

        expect(res.status).toBe(413);
    });

    it('a partial POST does not drop default fields from the next GET', async () => {
        const { GET, POST } = await import('./+server');

        const postRes = await call(
            POST,
            buildEvent(userId, customId, 'POST', '', { SortBy: 'DateCreated' }),
        );
        expect(postRes.status).toBe(204);

        const getRes = await call(GET, buildEvent(userId, customId, 'GET'));
        const body = (await getRes.json()) as Record<string, unknown>;
        expect(body.SortBy).toBe('DateCreated');
        expect(body.PrimaryImageHeight).toBe(200);
        expect(body.ShowBackdrop).toBe(true);
        expect(body.CustomPrefs).toEqual({});
    });

    it('different client values for the same user/id do not clobber each other', async () => {
        const { GET, POST } = await import('./+server');

        await call(
            POST,
            buildEvent(userId, customId, 'POST', '?client=emby', {
                CustomPrefs: { homesection0: 'resume' },
            }),
        );
        await call(
            POST,
            buildEvent(userId, customId, 'POST', '?client=androidtv', {
                CustomPrefs: { homesection0: 'livetv' },
            }),
        );

        const embyRes = await call(GET, buildEvent(userId, customId, 'GET', '?client=emby'));
        const androidRes = await call(
            GET,
            buildEvent(userId, customId, 'GET', '?client=androidtv'),
        );

        const embyBody = (await embyRes.json()) as Record<string, unknown>;
        const androidBody = (await androidRes.json()) as Record<string, unknown>;

        expect(embyBody.CustomPrefs).toEqual({ homesection0: 'resume' });
        expect(androidBody.CustomPrefs).toEqual({ homesection0: 'livetv' });
    });
});
