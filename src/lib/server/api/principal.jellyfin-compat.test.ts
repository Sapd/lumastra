// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildPrincipal } from './principal.js';
import { deriveSurface } from './play-surface.js';
import type { UserId } from '$lib/shared/user-id.js';

const base = {
    kind: 'jellyfin_compat' as const,
    userId: '11111111-1111-4111-8111-111111111111' as UserId,
    username: 'alice',
    userGroups: ['admins'],
};

describe("principal kind 'jellyfin_compat'", () => {
    it('a /j password session of an admin owner is admin', () => {
        expect(buildPrincipal({ ...base, sessionIsAdmin: true }).isAdmin).toBe(true);
    });

    it('a /j API key is never admin, even for an admin owner', () => {
        const p = buildPrincipal({
            ...base,
            sessionIsAdmin: false,
            ownerIsAdmin: true,
            tokenScopes: ['read', 'write'],
        });
        expect(p.isAdmin).toBe(false);
    });

    it('keeps the play surface it had without a principal', () => {
        expect(deriveSurface(buildPrincipal({ ...base, sessionIsAdmin: true }))).toBe('unknown');
    });
});
