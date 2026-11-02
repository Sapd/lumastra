// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * authenticate() must distinguish "valid credential, wrong kind" (403) from
 * "bad token" (401).
 *
 * A 401 whose body carries `error: "invalid_token"` is the conventional
 * dead-session signal; clients log the user out on it. Emitting that for a
 * permanent capability gap bounces users to a login screen for something
 * re-authenticating can never fix. Reported by a tvOS client that logs out on
 * exactly that shape.
 *
 * The inverse must keep working: a genuinely bad/absent token still gets 401,
 * or a client with an expired session would never re-authenticate.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));

import { authenticate, ApiAuthError } from './api-auth.js';
import { buildPrincipal } from '$lib/server/api/principal.js';

function makeEvent(opts: { authHeader?: string; bearerPrincipal?: boolean }): RequestEvent {
    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);

    const principal = opts.bearerPrincipal
        ? buildPrincipal({
              kind: 'bearer',
              userId: toUserId('00000000-0000-0000-0000-000000000001'),
              username: 'tv-user',
              userGroups: [],
              tokenScopes: [],
              sessionIsAdmin: false,
              ownerIsAdmin: false,
          })
        : undefined;

    return {
        url: new URL('https://x/api/v1/libraries/ingest'),
        request: new Request('https://x/api/v1/libraries/ingest', { method: 'POST', headers }),
        params: {},
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

async function statusOf(event: RequestEvent): Promise<number> {
    try {
        await authenticate(event);
        return 200;
    } catch (e) {
        if (e instanceof ApiAuthError) return e.statusCode;
        throw e;
    }
}

describe('authenticate(): credential-kind vs invalid-token', () => {
    it('a VALID device-flow JWT gets 403, not 401 — it is a capability gap, not a dead session', async () => {
        const event = makeEvent({
            authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0diJ9.sig',
            bearerPrincipal: true, // forward-auth already verified it upstream
        });
        expect(await statusOf(event)).toBe(403);
    });

    it('the 403 message tells the client re-authenticating will not help', async () => {
        const event = makeEvent({
            authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0diJ9.sig',
            bearerPrincipal: true,
        });
        await expect(authenticate(event)).rejects.toThrow(
            /re-authenticating will not grant access/,
        );
    });

    it('a bearer with NO verified principal still gets 401 (genuinely bad token)', async () => {
        // No principal → forward-auth never validated it → really is invalid.
        const event = makeEvent({ authHeader: 'Bearer garbage-not-a-jwt' });
        expect(await statusOf(event)).toBe(401);
    });

    it('a missing Authorization header still gets 401', async () => {
        expect(await statusOf(makeEvent({}))).toBe(401);
    });

    it('an invalid pat_ token still gets 401, not 403', async () => {
        // Expired/revoked PATs must stay 401 so clients re-auth rather than
        // treating it as a permanent capability gap.
        const event = makeEvent({ authHeader: 'Bearer pat_deadbeef', bearerPrincipal: true });
        expect(await statusOf(event)).toBe(401);
    });
});
