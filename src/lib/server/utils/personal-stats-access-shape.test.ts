// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `accessFingerprint` invariants for the migrated personal-stats service.
 *
 * This file used to assert the OPPOSITE: that `accessFingerprint` threw when
 * handed a new-shape `{library, age}` boundary. That guard existed only because
 * the service still read the legacy `{deniedGroupIds, ageRating}` pair, so a
 * new-shape boundary would have read `undefined` on both fields and silently
 * reported "unrestricted" — for an ORDINARY restricted user, not just denyAll.
 * The service now speaks the boundary natively, so the guard is gone and what
 * needs pinning is the property it was protecting:
 *
 *   the fingerprint is empty IFF the boundary is unrestricted.
 *
 * That biconditional is the module's cache-safety invariant.
 * `hasAccessRestrictions` (module-private) decides whether the title/series
 * access filters run; `accessFingerprint` decides whether the result gets its
 * own cache key. If a boundary could be restrictive AND fingerprint to '', the
 * filtered payload would land on the shared un-fingerprinted key for that
 * type+period and be served to every other viewer.
 *
 * `denyAll` is the case worth naming: it is the one state the legacy shape could
 * not express, and the one most likely to fall through a `kind` switch to the
 * permissive branch. If it fingerprinted to '' it would READ the unrestricted
 * caller's entry — a deny-everything caller served the full result set.
 */

import { describe, it, expect } from 'vitest';
import { accessFingerprint } from '$lib/server/services/personal-stats.service';
import {
    denyAllAccess,
    isUnrestricted,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary';

const BOUNDARIES: Array<{ name: string; boundary: MediaAccessBoundary }> = [
    { name: 'unrestricted', boundary: unrestrictedAccess() },
    { name: 'denyAll', boundary: denyAllAccess() },
    {
        name: 'library-only',
        boundary: restrictedAccess({
            deniedGroupIds: ['g1'],
            maxAgeRating: null,
            allowUnrated: false,
        }),
    },
    {
        name: 'age-only',
        boundary: restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: false,
        }),
    },
    {
        name: 'both axes',
        boundary: restrictedAccess({
            deniedGroupIds: ['g1'],
            maxAgeRating: 12,
            allowUnrated: true,
        }),
    },
    {
        name: 'library denyAll only',
        boundary: { library: { kind: 'denyAll' }, age: { kind: 'any' } },
    },
    { name: 'age denyAll only', boundary: { library: { kind: 'all' }, age: { kind: 'denyAll' } } },
];

describe('accessFingerprint / hasAccessRestrictions lockstep', () => {
    it.each(BOUNDARIES)('$name: empty fingerprint iff unrestricted', ({ boundary }) => {
        expect(accessFingerprint(boundary) === '').toBe(isUnrestricted(boundary));
    });

    it('gives denyAll a fingerprint distinct from unrestricted', () => {
        // The failure this pins: a denyAll boundary falling through to '' would
        // read the UNRESTRICTED caller's cache entry and be served every row.
        expect(accessFingerprint(denyAllAccess())).not.toBe(
            accessFingerprint(unrestrictedAccess()),
        );
    });

    it('gives every distinct boundary a distinct fingerprint', () => {
        const seen = BOUNDARIES.map(({ boundary }) => accessFingerprint(boundary));
        expect(new Set(seen).size).toBe(seen.length);
    });
});

describe('accessFingerprint encoding', () => {
    it('is empty for an explicitly unrestricted boundary', () => {
        // Byte-compatible with what the legacy `{null, null}` boundary produced,
        // so warm cache entries survive the migration.
        expect(accessFingerprint(unrestrictedAccess())).toBe('');
    });

    it('is order-independent over denied group ids', () => {
        const a = accessFingerprint({
            library: { kind: 'denyGroups', ids: ['b', 'a'] },
            age: { kind: 'any' },
        });
        const b = accessFingerprint({
            library: { kind: 'denyGroups', ids: ['a', 'b'] },
            age: { kind: 'any' },
        });
        expect(a).toBe(b);
        expect(a).toBe('d-a,b');
    });

    it('encodes both axes with the legacy tokens', () => {
        expect(
            accessFingerprint(
                restrictedAccess({
                    deniedGroupIds: ['g1'],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            ),
        ).toBe('d-g1|a-12-r');
    });

    it('uses denyAll tokens that cannot collide with value tokens', () => {
        // Library ids are UUIDs and age caps are numbers, so neither axis can
        // ever emit the literal `-none` token.
        expect(accessFingerprint(denyAllAccess())).toBe('d-none|a-none');
    });
});
