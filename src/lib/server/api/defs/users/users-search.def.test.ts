// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * users/search — auth-shape pins.
 *
 * This endpoint serves an admin directory picker AND a peer invite picker off
 * one def. The auth spec is the only thing keeping those apart, so it is
 * pinned here rather than left to be re-derived by whoever touches it next.
 *
 * The ordering assertion is not pedantry: `kind:'any'` returns the LAST
 * failure (`mount.ts:186`), so putting the feature gate second is what makes a
 * playlists-disabled instance answer 404 to a non-admin instead of 403.
 */

import { describe, it, expect } from 'vitest';
import { def } from './search.js';

describe('users/search def', () => {
    // A single AuthSpec, not a per-method map — `defineEndpoint` accepts both
    // (`define.ts:302`), and this def applies one spec to its only method.
    const authSpec = def.auth as {
        kind: string;
        specs: Array<Record<string, unknown>>;
    };

    it('is an OR of admin and the playlists-gated user spec', () => {
        expect(authSpec).toMatchObject({
            kind: 'any',
            specs: [
                { kind: 'admin' },
                { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
            ],
        });
    });

    it('lists the feature gate LAST so feature-off reads as 404, not 403', () => {
        expect(authSpec.specs).toHaveLength(2);
        expect(authSpec.specs[authSpec.specs.length - 1]).toMatchObject({ kind: 'feature' });
    });

    it('is NOT a bare {kind:"user"} — that gate was wrong for both callers', () => {
        expect(authSpec.kind).not.toBe('user');
    });

    it('stays off the public surface', () => {
        expect(def.visibility).toBe('internal');
    });
});
