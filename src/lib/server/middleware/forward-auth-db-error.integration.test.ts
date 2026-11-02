// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';

vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
});
vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => getTestDb() },
}));
vi.mock('$lib/server/database/queries/users.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/users.queries.js')>()),
    // Isolate the steady-state auth lookup from setup and asynchronous writers.
    adminExists: vi.fn(async () => true),
    upsertUser: vi.fn(),
}));

import { config } from '$lib/server/config.js';
import * as users from '$lib/server/database/queries/users.queries.js';
import { resolveAuth, invalidateAdminExistsCache } from './forward-auth.js';
import {
    setCachedUserId,
    setCachedIsAdmin,
    setCachedAdminPinned,
    invalidateUserAdminCache,
} from '$lib/server/cache/user-admin-cache.js';
import {
    setCachedMaxAge,
    invalidateUserMaxAgeCache,
} from '$lib/server/cache/user-max-age-cache.js';

afterEach(() => {
    vi.restoreAllMocks();
});

it('B-3 follow-up: a real PostgreSQL statement timeout with unknown disabled state returns retryable 503', async () => {
    const sql = getTestDb();
    const id = randomUUID();
    const username = `db_error_${id.replaceAll('-', '')}`;
    await sql`INSERT INTO users (id, username, groups) VALUES (${id}, ${username}, ARRAY[]::text[])`;
    vi.spyOn(config, 'FORWARD_AUTH_ENABLED', 'get').mockReturnValue(true);
    vi.spyOn(config, 'FORWARD_AUTH_GROUPS_ALWAYS_SENT', 'get').mockReturnValue(false);
    invalidateAdminExistsCache();
    invalidateUserAdminCache(username);
    setCachedUserId(username, id);
    setCachedIsAdmin(username, false);
    setCachedAdminPinned(username, true);
    setCachedMaxAge(username, null);
    let observedCode: unknown;
    const lookup = vi.spyOn(users, 'getUserByUsername').mockImplementationOnce(async () => {
        try {
            return await sql.begin(async (tx) => {
                await tx`SET LOCAL statement_timeout = '10ms'`;
                await tx`SELECT pg_sleep(0.1)`;
                return null;
            });
        } catch (error) {
            observedCode = (error as { code?: unknown }).code;
            throw error;
        }
    });
    const url = new URL('http://localhost/api/auth/check');
    const event = {
        url,
        request: new Request(url, {
            headers: { accept: 'application/json', [config.USERHEADER]: username },
        }),
        route: { id: '/api/auth/check' },
        params: {},
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
    try {
        const response = await resolveAuth(event, async () => undefined, true);
        expect(lookup).toHaveBeenCalled();
        expect(observedCode).toBe('57014');
        expect(response?.status).toBe(503);
        expect(response?.headers.get('X-Lumastra-Auth-Retry')).toBe('true');
        expect(event.locals.user).toBeUndefined();
        expect(users.upsertUser).not.toHaveBeenCalled();
    } finally {
        invalidateUserAdminCache(username);
        invalidateUserMaxAgeCache(username);
        await sql`DELETE FROM users WHERE id = ${id}`;
    }
});
