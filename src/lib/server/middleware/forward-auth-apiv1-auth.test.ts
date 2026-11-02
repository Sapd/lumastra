// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `resolveSessionVsForwardAuth` — how a present-and-valid native
 * session cookie reconciles with a *trusted* forward-auth header on the SAME
 * request (the native/OIDC + forward-auth coexistence rule on the regular,
 * authenticated app surface).
 *
 * Invariant: a live, trusted proxy header is authoritative for the request, so a
 * session cookie's login-time group snapshot can never shadow live IdP groups.
 * Same user → defer to the header but keep the cookie; different user → clear the
 * (stale/wrong) cookie and defer; no trusted header → use the session.
 */

import { describe, it, expect } from 'vitest';
import { resolveSessionVsForwardAuth } from './forward-auth';

describe('resolveSessionVsForwardAuth — live proxy header wins over a stale session cookie', () => {
    it('uses the session when no trusted forward-auth header is present (native-only deployment)', () => {
        expect(
            resolveSessionVsForwardAuth({ sessionUsername: 'denis', forwardUsername: null }),
        ).toBe('use-session');
    });

    it('defers to the live header for the SAME user, keeping the cookie (the /livetv stale-groups bug)', () => {
        // Regression: a session cookie capturing `{admins}` at login must NOT
        // shadow the live header's current groups (which include LiveTV). Same
        // user → defer to header, but keep the cookie for header-less surfaces.
        expect(
            resolveSessionVsForwardAuth({ sessionUsername: 'denis', forwardUsername: 'denis' }),
        ).toBe('defer-keep-cookie');
    });

    it('matches the same user case-insensitively (header "Denis" → lowercased "denis")', () => {
        // readTrustedForwardAuthIdentity lowercases the header username; the
        // session username may be stored in any case.
        expect(
            resolveSessionVsForwardAuth({ sessionUsername: 'Denis', forwardUsername: 'denis' }),
        ).toBe('defer-keep-cookie');
    });

    it('clears the cookie and defers when the proxy names a DIFFERENT user (shared browser / re-auth)', () => {
        expect(
            resolveSessionVsForwardAuth({ sessionUsername: 'denis', forwardUsername: 'marc' }),
        ).toBe('clear-and-defer');
    });
});
