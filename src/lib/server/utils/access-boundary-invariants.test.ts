// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structural invariants for the media access boundary.
 *
 * These guard properties that are easy to regress and that no type check would
 * catch — the repo has no working typecheck gate (tsc OOMs, svelte-check is
 * broken, `vite build` only transpiles), so a permissive access argument or a
 * resurrected fail-open helper ships silently.
 *
 * They assert on module exports and on route source text rather than on
 * behaviour, because the failure mode being guarded is "a caller reaches for the
 * wrong helper", not "a helper computes the wrong answer".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as libraryGroupCache from '$lib/server/cache/library-group-permissions-cache';

const repoRoot = resolve(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

/**
 * Strip block and line comments so an assertion targets executable code.
 * Several of these invariants forbid a helper name that the surrounding prose
 * legitimately mentions ("this replaced buildSearchAccessContext").
 */
const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('there is exactly one filterAccessibleMediaIds', () => {
    it('library-group-permissions-cache no longer exports a name-identical copy', () => {
        // The deleted copy was fail-open by construction: `!user` returned every
        // id, and a null denied list returned every id. It had no age parameter,
        // so the age axis was structurally unenforceable through it. Being
        // name-identical to the hardened export, importing the wrong one was a
        // one-keystroke autocomplete mistake with no type error.
        expect(libraryGroupCache).not.toHaveProperty('filterAccessibleMediaIds');
    });

    it('only media-access-batch defines the symbol', () => {
        expect(read('src/lib/server/cache/library-group-permissions-cache.ts')).not.toMatch(
            /export async function filterAccessibleMediaIds/,
        );
        expect(read('src/lib/server/utils/media-access-batch.ts')).toMatch(
            /export async function filterAccessibleMediaIds/,
        );
    });
});

describe('isMediaAccessible is never used as a standalone gate', () => {
    // isMediaAccessible covers the LIBRARY-GROUP axis only, and returns true
    // early whenever getDeniedLibraryGroups yields null — the common case when
    // no library_group_permissions rows exist. A route gating solely on it
    // serves 18-rated items to an age-restricted user. checkMediaAccess
    // composes it with the age gate.
    const gatedRoutes = [
        'src/routes/watch/[itemId]/+page.server.ts',
        'src/lib/server/api/defs/playback/previews/index.ts',
        'src/lib/server/jellyfin-compat/item-image-handler.ts',
    ];

    for (const route of gatedRoutes) {
        it(`${route} calls checkMediaAccess, not isMediaAccessible`, () => {
            const src = read(route);
            expect(src).toMatch(/\bcheckMediaAccess\s*\(/);
            expect(src).not.toMatch(/\bawait isMediaAccessible\s*\(/);
        });
    }

    it('the /watch route fails closed when there is no user', () => {
        const src = read('src/routes/watch/[itemId]/+page.server.ts');
        // The old shape was a ternary falling back to an always-true promise,
        // which granted access to any item by UUID when locals.user was absent.
        // Match the code, not the prose: strip line comments first.
        const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
        expect(code).not.toMatch(/:\s*Promise\.resolve\(true\)/);
        expect(src).toMatch(/if \(!locals\.user\) throw error\(404/);
    });
});

describe('access-boundary consumers fail closed when the boundary cannot be built', () => {
    it('watch-together session listing does not skip filtering on error', () => {
        // Both handlers now delegate to ONE shared implementation. The v1 copy is
        // allowlisted as v1-native by tests/api-v1-parity.test.ts, so the parity
        // suite would NOT notice the two drifting apart — pinning both to the
        // shared helper is what keeps a fix to one a fix to both.
        const files = [
            'src/lib/server/api/defs/watch-together/parties.ts',
            'src/routes/api/v1/watch-together/parties/+server.ts',
        ];
        for (const file of files) {
            const src = read(file);
            // The fail-open shape: swallow the error, then guard the whole
            // filtering block on the now-undefined context.
            expect(src).not.toMatch(
                /buildSearchAccessContext[\s\S]{0,120}catch\([\s\S]{0,20}undefined/,
            );
            // Neither handler may re-inline its own boundary resolution.
            expect(src).toContain('resolveWatchTogetherBoundary');
            expect(src).toContain('filterSessionsByAccess');
            // Assert on code, not prose — the comments legitimately name the
            // helper they replaced.
            expect(stripComments(src)).not.toContain('buildSearchAccessContext');
        }
    });

    it('the shared watch-together boundary resolver fails closed on both degraded paths', () => {
        const code = stripComments(read('src/lib/server/utils/watch-together-access.ts'));
        // Missing db handle AND a throw while building the context must both
        // yield denyAll, never an unrestricted or skipped filter.
        expect(code).toContain('denyAllAccess()');
        expect(code).not.toMatch(/unrestrictedAccess\(\)/);
        // The boundary parameter must be required — no permissive default.
        expect(code).not.toMatch(/boundary\s*\??\s*:\s*[^,)]*=\s*/);
        expect(code).toMatch(/boundary: MediaAccessBoundary/);
    });

    it('stats endpoints mark access-sensitive metrics unavailable without a boundary', () => {
        for (const file of [
            'src/lib/server/api/defs/stats/me.ts',
            'src/lib/server/api/defs/stats/users-id.ts',
        ]) {
            const src = read(file);
            expect(src).toContain('accessCtxUnavailable');
            // An undefined boundary must never reach computeOneStat: it skipped
            // filtering AND produced an empty fingerprint, so the unfiltered
            // payload was cached under the shared un-fingerprinted key.
            expect(src).toMatch(/isAccessSensitive && accessCtxUnavailable/);
            // The residual "no boundary" fallback must name denyAll, never an
            // unrestricted default. Asserted on source rather than behaviour
            // because the gate above makes it unreachable by construction — a
            // behavioural test would need two simultaneous mutations to fail,
            // so flipping it back to unrestricted is otherwise invisible.
            expect(src).toMatch(/\w*[aA]ccessCtx \?\? denyAllAccess\(\)/);
        }
    });

    it('stats endpoints derive the cache fingerprint from a boundary, never from nothing', () => {
        // A hardcoded '' collapses restricted and unrestricted callers onto the
        // same per-user key, so a restricted caller reads back their own
        // unfiltered titles for the full TTL. Entries are user-scoped, so this
        // is a self-leak rather than a cross-user one — real, not catastrophic.
        for (const file of [
            'src/lib/server/api/defs/stats/me.ts',
            'src/lib/server/api/defs/stats/my-stats.ts',
            'src/lib/server/api/defs/stats/username.ts',
            'src/lib/server/api/defs/stats/users-id.ts',
        ]) {
            expect(read(file)).toMatch(/accessFingerprint\(/);
        }
    });
});
