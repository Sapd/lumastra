// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The durable guard for Shape C (2026-09-18 fix-plan-4, Task 2 — see
 * ledger.md "Design rulings (Shape B and Shape C)").
 *
 * C2, C4 and C5 all had the same root cause: `defineEndpoint({ auth: {
 * kind: 'scope', anyOf: [...] } })` reads as an operator-only gate, but
 * `tasks:read`/`runs:read` were auto-granted to every non-admin session
 * (`principal.ts` `expandScopes` — independently re-granted by
 * `tasks/api-auth.ts` `scopeGranted`, see that file's docstring). 2026-09-12
 * C16 fixed this once for six endpoints; C2/C4/C5 were the siblings the
 * one-at-a-time sweep missed. This test makes the NEXT sibling impossible to
 * miss: it fails the moment a new (or edited) def's `anyOf` becomes
 * satisfiable by a plain non-admin session's REAL expanded scope set, unless
 * the scope is on the explicit, justified allowlist below.
 *
 * ## The seam
 *
 * This drives the REAL `expandScopes()` (principal.ts) and the REAL
 * `scopeGranted()` (tasks/api-auth.ts) — the exact two functions
 * `mount.ts`'s `{kind:'scope'}` branch calls in production, never a
 * restated literal. `principal-mintable-scope-invariant.test.ts` is the
 * sibling guard for the analogous admin-equivalence invariant; this test
 * follows the same shape (derive the input set from the live modules, probe
 * the live decision function, assert against a reasoned allowlist).
 *
 * ## Discovering `anyOf` without importing ~600 def modules
 *
 * Like `defs-docs-handler-parity.test.ts` (the sibling guard for
 * docs/handler parity), this reads def SOURCE TEXT rather than importing the
 * modules — importing every def pulls in DB/cache/task-registry side effects
 * at module scope. Unlike that file's `stripCommentsAndStrings` (which
 * blanks strings too, fine when it only needs brace-depth structure), this
 * scanner blanks ONLY comments and keeps string/template literals verbatim —
 * the scope names it is looking for live inside those strings. An earlier
 * version of this file reused a strip-everything helper and matched against
 * the ORIGINAL source at the stripped match's offset; that silently
 * mismatched because collapsing a `/* *\/` block comment to one space
 * shortens the string, so offsets in the stripped text no longer line up
 * with the raw text. It produced a real false positive on
 * `plugins/internal/index.ts`, whose JSDoc contains the OLD inline-auth code
 * (`enforce({kind:'scope', anyOf:['tasks:read']})`) as prose — the misaligned
 * offset walked into that comment and read it as a live auth spec. Caught by
 * re-deriving the file's real auth stanza by hand and finding it said
 * `tasks:admin`, not `tasks:read`, while this test reported the opposite.
 *
 * ## Known boundary — this sweep covers `defs/**` only
 *
 * A def mounted via `mount(def, {surface})` and gated with `{kind:'scope',
 * anyOf:[...]}` is the only shape this test can see. A handful of legacy
 * routes under `src/routes/api/v1/**` enforce scope inline with their own
 * `authenticate()` + `requireScope()` call and never construct a
 * `defineEndpoint` at all — e.g. `src/routes/api/v1/runs/history/+server.ts:52`
 * (`requireScope(auth, 'tasks:admin')`). Those are invisible to this sweep.
 * `requireScope`/`scopeGranted` themselves are still the real, shared
 * decision function in that case, so the underlying invariant this test
 * guards still holds for them — but a new or edited BESPOKE route naming an
 * admin-sounding scope would not be caught here, only a new/edited `def`.
 *
 * ## The allowlist is scope-level, not file-level
 *
 * The brief's wording ("the def is on an explicit allowlist") suggests a
 * per-file list. In practice, a scope's reachability by a non-admin session
 * is a property of the SCOPE (decided once, in `scopeGranted`), not of any
 * individual def that names it — dozens of defs legitimately gate on
 * `media:read`/`sessions:read`/etc., and a per-file allowlist of that size
 * would just repeat the same one-line reason hundreds of times with no
 * additional information. A per-scope allowlist gives the identical
 * guarantee (a NEW scope reachable by a non-admin session, on ANY def, is
 * caught) with a list a human can actually read and review.
 */

import { describe, it, expect } from 'vitest';
import { expandScopes } from './principal.js';
import { scopeGranted, type ApiScope } from '../tasks/api-auth.js';
import { scanDefScopeStanzas } from './defs-scope-stanzas.test-helpers.js';

/**
 * Scopes that are INTENTIONALLY reachable by a plain non-admin session —
 * i.e. `scopeGranted(expandScopes(['read','write']), scope) === true` by
 * design, not by accident. Each entry states why. Adding a scope here is a
 * real, reviewable decision — the same kind of decision C2/C4/C5 show was
 * made silently by naming a scope that merely SOUNDED operator-only.
 */
const SAFE_NON_ADMIN_SCOPES: Record<string, string> = {
    'media:read':
        'User-facing browse/detail scope. Every consumer applies its own library-group ' +
        'and age-rating predicate inside the handler/query (buildLibraryAccessFilter / ' +
        'buildAgeRatingFilter / checkMediaAccess) — the scope gate answers "may this ' +
        'caller use the media API at all", not "which items may they see".',
    'media:write':
        'User-data mutation scope (ratings/watchlist/playlist/etc.) — every consumer ' +
        'resolves and access-gates the specific item via resolveAndGate() before writing.',
    'sessions:read':
        "The caller's OWN playback-session / device data — scoped to the caller's userId " +
        'inside the handler, not a system-wide view.',
    'sessions:write':
        "The caller's OWN playback-session / device data — same rationale as sessions:read.",
    'requests:read':
        "The caller's OWN Jellyseerr media requests — scoped to the caller's userId " +
        'inside the handler. `requests:admin` (system-wide) is a SEPARATE scope that is ' +
        'NOT in this allowlist and is NOT granted by read/write.',
};

describe('Shape C durable guard — no def is reachable by a plain non-admin session via an un-allowlisted scope', () => {
    // Scanner (comment blanking, both property orders, unparsed-shape
    // detection) lives in defs-scope-stanzas.test-helpers.ts, shared with
    // defs-scope-demoted-owner-sweep.test.ts.
    const { files, stanzas, unparsed } = scanDefScopeStanzas();

    it('finds the def corpus', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('the safe-scope allowlist is itself accurate (every listed scope really is non-admin-reachable)', () => {
        const nonAdminExpanded = expandScopes(['read', 'write']);
        for (const scope of Object.keys(SAFE_NON_ADMIN_SCOPES)) {
            expect(
                scopeGranted(nonAdminExpanded, scope as ApiScope),
                `${scope} is in SAFE_NON_ADMIN_SCOPES but scopeGranted() no longer grants ` +
                    `it to a non-admin session — remove the stale allowlist entry.`,
            ).toBe(true);
        }
    });

    it('every def whose auth.anyOf is satisfiable by a non-admin session names only allowlisted scopes', () => {
        const nonAdminExpanded = expandScopes(['read', 'write']);
        const violations: string[] = [];

        // Every `kind: 'scope'` occurrence must be accounted for by exactly
        // one parsed stanza — a mismatch fails loudly rather than letting a
        // scope-gated def in an unrecognised shape go unchecked.
        for (const u of unparsed) {
            violations.push(
                `${u.file}: found ${u.kindScopeCount} occurrence(s) of kind: 'scope' but only ` +
                    `parsed ${u.stanzaCount} into a recognizable auth stanza via ` +
                    `AUTH_SCOPE_STANZA. This file's shape (property order, extra properties, ` +
                    `or unusual spacing between 'kind' and 'anyOf') isn't one this scanner ` +
                    `recognizes — fix AUTH_SCOPE_STANZA rather than let a scope-gated def go ` +
                    `unchecked (this is the exact silent-failure mode this guard exists to close).`,
            );
        }

        for (const { file: rel, anyOf } of stanzas) {
            for (const scope of anyOf) {
                const reachable = scopeGranted(nonAdminExpanded, scope as ApiScope);
                if (reachable && !(scope in SAFE_NON_ADMIN_SCOPES)) {
                    violations.push(
                        `${rel}: auth scope '${scope}' is satisfiable by a plain non-admin ` +
                            `session's real expanded scope set (expandScopes(['read','write'])) ` +
                            `and is NOT in SAFE_NON_ADMIN_SCOPES. Either this scope is meant to ` +
                            `be admin/operator-only — in which case scopeGranted() or ` +
                            `expandScopes() over-grants it and that is the bug (this is exactly ` +
                            `the C2/C4/C5 shape) — or it is deliberately non-admin-reachable, in ` +
                            `which case add it to SAFE_NON_ADMIN_SCOPES here with a stated reason.`,
                    );
                }
            }
        }

        expect(violations, violations.join('\n')).toEqual([]);
    });
});
