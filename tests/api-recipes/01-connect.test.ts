// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 13/7. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, expectOk } from './client';
test('01 connect: one bootstrap call, then me', async () => {
    // Package 13: GET /server is the single pre-login probe (replaces /config, /server/capabilities
    // and the HEAD /oauth/device probe). It tells a client how to sign in and what the caller may do.
    const server = expectOk('GET', '/server', await client.GET('/api/v1/server'));
    expect(server.auth.deviceFlow.enabled).toBe(true);
    expect(server.apiVersions).toContain('v1');
    // The response is a union: only an authenticated call carries `caller`.
    if (!('caller' in server))
        throw new Error('GET /server with a bearer token must include caller');
    expect(server.caller.isAdmin).toBe(false);
    const me = expectOk('GET', '/me', await client.GET('/api/v1/me'));
    expect(me.username).toBe(process.env.RECIPES_FORWARD_USER ?? 'sweepuser');
});
