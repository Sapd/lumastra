// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-config, real-PG regression test for the reverse-proxy guide finding
 * (2026-10-06): with TRUSTED_PROXY_IPS set only to get real client IPs, an
 * anonymous request through a proxy that does not strip identity headers sent
 * `X-Forwarded-User: <admin>` and was signed in as that admin.
 *
 * Nothing about forward auth is mocked here: the REAL config (FORWARD_AUTH_ENABLED
 * unset, so its default), the real client-ip allowlist (127.0.0.1 trusted), real
 * Postgres. Only `$app/environment` is mocked, to reach the non-dev path. The
 * flag-ON path with real PG is covered by the other forward-auth
 * *.integration.test.ts files, which set FORWARD_AUTH_ENABLED=true.
 *
 * Run:
 *   npm run test:integration -- src/lib/server/middleware/forward-auth-enabled-default.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

// client-ip.ts and config.ts snapshot process.env at module load — set before
// any import resolves. The local dev .env trusts any proxy and CI trusts none;
// pin both so this file behaves the same everywhere.
vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
    delete process.env.FORWARD_AUTH_ENABLED;
});

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    resolveAuth,
    readTrustedForwardAuthIdentity,
    readDisabledForwardAuthHeaders,
} from '$lib/server/middleware/forward-auth.js';
import { config } from '$lib/server/config.js';

const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const noopMigration = async (): Promise<void> => undefined;
const adminUsername = `fadef_admin_${randomUUID().slice(0, 8)}`;
const unknownUsername = `fadef_new_${randomUUID().slice(0, 8)}`;

function forgedEvent(
    username: string,
    opts: { path?: string; accept?: string; peer?: string } = {},
): RequestEvent {
    const url = new URL(`http://localhost${opts.path ?? '/api/user'}`);
    const headers = new Headers({ accept: opts.accept ?? 'application/json' });
    headers.set(config.USERHEADER, username);
    headers.set(config.GROUPHEADER, ADMIN_GROUP);
    return {
        request: new Request(url, { headers }),
        url,
        params: {},
        locals: {},
        route: { id: url.pathname },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => opts.peer ?? '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

beforeAll(async () => {
    const sql = getTestDb();
    await sql`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${adminUsername}, true, true, ${[ADMIN_GROUP]}::text[])
        ON CONFLICT (username) DO NOTHING
    `;
});

afterAll(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM users WHERE username IN (${adminUsername}, ${unknownUsername})`;
});

describe('forward auth off by default: forged identity headers from a trusted peer', () => {
    it('the shipped default is off', () => {
        expect(config.FORWARD_AUTH_ENABLED).toBe(false);
    });

    it("naming an existing pinned admin → 401, not that admin's session", async () => {
        const event = forgedEvent(adminUsername);
        const res = await resolveAuth(event, noopMigration, true);

        expect(res).toBeInstanceOf(Response);
        expect(res?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
        expect(event.locals.authMethod).toBeUndefined();
    });

    it('naming an unknown user provisions no account', async () => {
        const event = forgedEvent(unknownUsername);
        await resolveAuth(event, noopMigration, true);
        // Provisioning runs fire-and-forget on the accept path; give it a beat.
        await new Promise((r) => setTimeout(r, 200));

        const sql = getTestDb();
        const rows = await sql`SELECT 1 FROM users WHERE username = ${unknownUsername}`;
        expect(rows).toHaveLength(0);
        expect(event.locals.user).toBeUndefined();
    });

    it('an HTML page gets no identity either', async () => {
        const event = forgedEvent(adminUsername, { path: '/admin', accept: 'text/html' });
        const res = await resolveAuth(event, noopMigration, true);
        expect(res).toBeInstanceOf(Response);
        expect(event.locals.user).toBeUndefined();
    });

    it('the setup wizard / setup completion reader sees no identity, and says why', () => {
        const event = forgedEvent(adminUsername);
        expect(readTrustedForwardAuthIdentity(event)).toBeNull();
        expect(readDisabledForwardAuthHeaders(event)).toBe(true);
    });
});
