// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the AGPL-core / module registry that lets
 * `credential-revocation.service.ts` reach the /j (Jellyfin-
 * compat) live-session store without importing it directly (the license
 * boundary only permits module → core registration, never the reverse).
 * Had no dedicated test at all — this pins what it registers, what a
 * `getJellyfinCompatRevocationProvider()` caller sees before/after
 * registration, and that a revocation call actually reaches the registered
 * provider and returns its count.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    registerJellyfinCompatRevocationProvider,
    getJellyfinCompatRevocationProvider,
    __resetJellyfinCompatRevocationProviderForTests,
    type JellyfinCompatRevocationProvider,
} from './jellyfin-compat-revocation.js';

afterEach(() => {
    __resetJellyfinCompatRevocationProviderForTests();
});

describe('jellyfin-compat-revocation registry', () => {
    it('returns null when nothing has registered (AGPL-only build, safe no-op)', () => {
        expect(getJellyfinCompatRevocationProvider()).toBeNull();
    });

    it('returns the registered provider after registration', () => {
        const provider: JellyfinCompatRevocationProvider = {
            revokeSessionsForUser: async () => 0,
        };

        registerJellyfinCompatRevocationProvider(provider);

        expect(getJellyfinCompatRevocationProvider()).toBe(provider);
    });

    it('a later registration replaces the earlier one', () => {
        const first: JellyfinCompatRevocationProvider = { revokeSessionsForUser: async () => 0 };
        const second: JellyfinCompatRevocationProvider = { revokeSessionsForUser: async () => 0 };

        registerJellyfinCompatRevocationProvider(first);
        registerJellyfinCompatRevocationProvider(second);

        expect(getJellyfinCompatRevocationProvider()).toBe(second);
    });

    it('calling revokeSessionsForUser through the registered provider actually revokes and returns the count', async () => {
        const revoked: string[] = [];
        registerJellyfinCompatRevocationProvider({
            revokeSessionsForUser: async (userId: string) => {
                revoked.push(userId);
                return 3;
            },
        });

        const provider = getJellyfinCompatRevocationProvider();
        const count = await provider!.revokeSessionsForUser('user-123');

        expect(count).toBe(3);
        expect(revoked).toEqual(['user-123']);
    });

    it('__resetJellyfinCompatRevocationProviderForTests clears the registration back to null', () => {
        registerJellyfinCompatRevocationProvider({ revokeSessionsForUser: async () => 0 });
        expect(getJellyfinCompatRevocationProvider()).not.toBeNull();

        __resetJellyfinCompatRevocationProviderForTests();

        expect(getJellyfinCompatRevocationProvider()).toBeNull();
    });
});
