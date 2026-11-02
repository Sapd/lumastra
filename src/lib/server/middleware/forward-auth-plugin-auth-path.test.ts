// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security test — the auth-provider login carve-out is exactly one prefix.
 *
 * These routes must be pre-auth: they exist to establish a session. The risk a
 * carve-out always carries is over-reach, and here over-reach means an
 * unauthenticated hole in the auth surface itself — so the anchoring is pinned
 * rather than trusted.
 */

import { describe, it, expect } from 'vitest';
import { isPluginAuthPublicPath } from './forward-auth.js';

describe('isPluginAuthPublicPath', () => {
    it('opens a provider login route', () => {
        expect(isPluginAuthPublicPath('/api/auth/plugin/ldap/login')).toBe(true);
    });

    it.each([
        // The classic missing-trailing-slash bug: without anchoring, every one
        // of these would be unauthenticated.
        '/api/auth/plugin-admin/secrets',
        '/api/auth/plugins',
        '/api/auth/pluginx',
        // Neighbours that must stay gated.
        '/api/auth/native/login',
        '/api/admin/plugins',
        '/api/plugins/shoutbox/messages',
        // The bare collection path is not a login route.
        '/api/auth/plugin',
    ])('does NOT open %s', (path) => {
        expect(isPluginAuthPublicPath(path)).toBe(false);
    });
});
