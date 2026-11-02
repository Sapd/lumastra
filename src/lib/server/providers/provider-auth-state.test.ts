// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import {
    AUTH_FAILURE_TTL_MS,
    isProviderAuthError,
    isProviderAuthFailed,
    markProviderAuthFailed,
    ProviderAuthError,
    resetProviderAuthStateForTests,
    shouldWarnProviderAuth,
} from './provider-auth-state';

describe('provider-auth-state', () => {
    beforeEach(() => resetProviderAuthStateForTests());

    it('remembers a rejected key per provider and per key', () => {
        markProviderAuthFailed('tmdb-metadata-provider', 'bad-key', 1_000);
        expect(isProviderAuthFailed('tmdb-metadata-provider', 'bad-key', 2_000)).toBe(true);
        // A newly saved key starts clean.
        expect(isProviderAuthFailed('tmdb-metadata-provider', 'new-key', 2_000)).toBe(false);
        expect(isProviderAuthFailed('other-provider', 'bad-key', 2_000)).toBe(false);
    });

    it('forgets a rejection after the TTL so a spurious 401 heals', () => {
        markProviderAuthFailed('tmdb-metadata-provider', 'k', 0);
        expect(isProviderAuthFailed('tmdb-metadata-provider', 'k', AUTH_FAILURE_TTL_MS + 1)).toBe(
            false,
        );
    });

    it('allows one warning per provider per TTL window', () => {
        expect(shouldWarnProviderAuth('tmdb-metadata-provider', 0)).toBe(true);
        expect(shouldWarnProviderAuth('tmdb-metadata-provider', 5_000)).toBe(false);
        expect(shouldWarnProviderAuth('tmdb-metadata-provider', AUTH_FAILURE_TTL_MS + 1)).toBe(
            true,
        );
    });

    it('recognises the error across a module boundary by name', () => {
        expect(isProviderAuthError(new ProviderAuthError('p', 'x'))).toBe(true);
        const cloned = Object.assign(new Error('x'), {
            name: 'ProviderAuthError',
            providerId: 'p',
        });
        expect(isProviderAuthError(cloned)).toBe(true);
        expect(isProviderAuthError(new Error('TMDB API request failed: 500'))).toBe(false);
    });
});
