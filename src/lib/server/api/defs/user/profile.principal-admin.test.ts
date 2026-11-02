// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /me and GET /user/settings: `isAdmin` (on /me) and
 * `profile.isAdmin` (on /user/settings) report the CREDENTIAL's admin authority
 * (`locals.principal`), not the token owner's `locals.user.isAdmin` (spec
 * 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => vi.fn(async () => []) }));
vi.mock('$lib/server/database/queries/index.js', () => ({
    getWidgetOrder: { one: vi.fn(async () => null) },
    getPlaybackPreferences: { one: vi.fn(async () => null) },
}));

const { def: profileDef } = await import('./profile.js');
const { def: settingsDef } = await import('./settings.js');
const ctx = { surface: 'v1' } as never;

const eventFor = (locals: RequestEvent['locals']): RequestEvent =>
    ({
        locals,
        params: {},
        url: new URL('http://localhost/api/v1/me'),
    }) as unknown as RequestEvent;

async function profileIsAdmin(locals: RequestEvent['locals']): Promise<boolean> {
    const body = (await (await profileDef.handlers.GET!(eventFor(locals), ctx)).json()) as {
        isAdmin: boolean;
    };
    return body.isAdmin;
}

async function settingsIsAdmin(locals: RequestEvent['locals']): Promise<boolean> {
    const res = await settingsDef.handlers.GET!(eventFor(locals), ctx);
    const body = (await res.json()) as { profile: { isAdmin: boolean } };
    return body.profile.isAdmin;
}

describe.each([
    ['GET /me', profileIsAdmin],
    ['GET /user/settings', settingsIsAdmin],
] as const)('%s profile.isAdmin', (_name, read) => {
    it("an admin owner's device token is not reported as admin", async () => {
        expect(await read(adminOwnersDeviceToken())).toBe(false);
    });

    it("an admin owner's read/write PAT is not reported as admin", async () => {
        expect(await read(adminOwnersReadWritePat())).toBe(false);
    });

    it('a request without a principal is not reported as admin', async () => {
        expect(await read(adminUserWithoutPrincipal())).toBe(false);
    });

    it('control: an admin session is reported as admin', async () => {
        expect(await read(adminSession())).toBe(true);
    });
});

it('returns the authenticated user UUID', async () => {
    const locals = adminSession();
    const response = await profileDef.handlers.GET!(eventFor(locals), ctx);
    expect(await response.json()).toMatchObject({ id: locals.user?.userId });
});
