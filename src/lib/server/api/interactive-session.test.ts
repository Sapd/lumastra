// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pre-release review 2026-10-21: credential mutations (mint/revoke a PAT,
 * link/unlink an account, notification webhook set/clear) need an interactive
 * session. Every bearer credential is refused with 403 `session_required`.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from './principal.js';
import { denyUnlessInteractiveSession } from './token-minting.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal?: Principal): RequestEvent {
    return {
        request: new Request('http://localhost/api/v1/me/pats', { method: 'POST' }),
        url: new URL('http://localhost/api/v1/me/pats'),
        locals: { principal },
    } as unknown as RequestEvent;
}

const bearerOf = (kind: 'pat' | 'bearer' | 'service_token' | 'stream_token'): Principal =>
    buildPrincipal({
        kind,
        userId: USER_ID,
        username: 'u',
        userGroups: [],
        tokenScopes: ['read', 'write'],
        ownerIsAdmin: false,
    });

describe('denyUnlessInteractiveSession', () => {
    it('allows a session', () => {
        const session = buildPrincipal({
            kind: 'session',
            userId: USER_ID,
            username: 'u',
            userGroups: [],
            sessionIsAdmin: false,
        });
        expect(denyUnlessInteractiveSession(makeEvent(session))).toBeNull();
    });

    it('allows a forward-auth identity', () => {
        const fa = buildPrincipal({
            kind: 'forward_auth',
            userId: USER_ID,
            username: 'u',
            userGroups: [],
            sessionIsAdmin: false,
        });
        expect(denyUnlessInteractiveSession(makeEvent(fa))).toBeNull();
    });

    it.each(['pat', 'bearer', 'service_token', 'stream_token'] as const)(
        'refuses a %s with 403 session_required',
        async (kind) => {
            const res = denyUnlessInteractiveSession(makeEvent(bearerOf(kind)));
            expect(res?.status).toBe(403);
            const body = (await res!.json()) as { code: string; reason: string };
            expect(body.code).toBe('forbidden');
            expect(body.reason).toBe('session_required');
        },
    );

    it('refuses an admin-owned admin-scoped PAT too', () => {
        const adminPat = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'root',
            userGroups: [],
            tokenScopes: ['admin'],
            ownerIsAdmin: true,
        });
        expect(denyUnlessInteractiveSession(makeEvent(adminPat))?.status).toBe(403);
    });

    it('answers 401 without a principal', () => {
        expect(denyUnlessInteractiveSession(makeEvent())?.status).toBe(401);
    });
});
