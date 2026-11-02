// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the load-bearing invariant documented on `deriveIsAdmin()` in
 * principal.ts (the comment above its JSDoc, "LOAD-BEARING INVARIANT (fix
 * round 1, Important #4, 2026-09-13 deferred fix)"):
 *
 * `deriveIsAdmin()` treats a token as admin-equivalent when it carries
 * `'admin'` OR `'tasks:admin'`. That verdict is safe ONLY because neither
 * mintable-scope enum (`patScopeSchema`, `serviceTokenScopeSchema` in
 * schemas/admin.ts) admits `'tasks:admin'` today. If either enum is ever
 * widened to include an admin-equivalent scope without also revisiting
 * `deriveIsAdmin()`, a token carrying only that scope — owned by an admin —
 * would silently acquire every legacy `requireAdmin()` route (~50 files
 * under src/routes/) AND the token-minting ceiling in token-minting.ts,
 * not just the narrow surface its name suggests.
 *
 * This file lives next to principal.ts (rather than inside the existing
 * principal.test.ts, which only exercises deriveIsAdmin in isolation) because
 * it is a CROSS-MODULE check: it reads the live enum options off
 * schemas/admin.ts and probes the live deriveIsAdmin() behaviour, so it is
 * findable by someone editing either side — a schema author extending
 * patScopeSchema/serviceTokenScopeSchema, or a principal.ts author changing
 * the admin-equivalence rule.
 *
 * Both the "admin-conferring" set and the "mintable" set below are derived
 * from the real modules, not hard-coded — the test tracks the code, not a
 * restated copy of it that could silently drift out of sync.
 */

import { describe, it, expect } from 'vitest';
import { deriveIsAdmin, type PrincipalKind } from './principal.js';
import { patScopeSchema, serviceTokenScopeSchema } from '$lib/schemas/admin.js';

/**
 * Does `deriveIsAdmin` treat `scope` as admin-equivalent, for a token owned
 * by an admin? Probes the real function rather than restating its rule.
 */
function confersAdmin(kind: PrincipalKind, scope: string): boolean {
    return deriveIsAdmin({
        kind,
        sessionIsAdmin: false,
        ownerIsAdmin: true,
        tokenScopes: [scope],
        forceNonAdmin: false,
    });
}

const TOKEN_KINDS: PrincipalKind[] = ['bearer', 'pat', 'service_token'];

describe('mintable-scope / admin-equivalence invariant', () => {
    it.each(TOKEN_KINDS)(
        "patScopeSchema ∩ deriveIsAdmin-admin-equivalent scopes (kind=%s) is exactly {'admin'}",
        (kind) => {
            const mintable = patScopeSchema.options;
            const adminConferring = mintable.filter((scope) => confersAdmin(kind, scope));

            expect(
                adminConferring,
                `patScopeSchema now admits an admin-equivalent scope beyond 'admin': ` +
                    `${JSON.stringify(adminConferring)}. deriveIsAdmin() in principal.ts treats ` +
                    `these as admin-equivalent for a token owned by an admin. Minting one of ` +
                    `them would silently grant every legacy requireAdmin() route (~50 files ` +
                    `under src/routes/) plus the token-minting ceiling in token-minting.ts — ` +
                    `not just the surface the scope's name suggests. Revisit the admin-equivalence ` +
                    `decision documented on deriveIsAdmin() in principal.ts before widening ` +
                    `patScopeSchema to include it.`,
            ).toEqual(['admin']);
        },
    );

    it.each(TOKEN_KINDS)(
        "serviceTokenScopeSchema ∩ deriveIsAdmin-admin-equivalent scopes (kind=%s) is exactly {'admin'}",
        (kind) => {
            const mintable = serviceTokenScopeSchema.options;
            const adminConferring = mintable.filter((scope) => confersAdmin(kind, scope));

            expect(
                adminConferring,
                `serviceTokenScopeSchema now admits an admin-equivalent scope beyond 'admin': ` +
                    `${JSON.stringify(adminConferring)}. deriveIsAdmin() in principal.ts treats ` +
                    `these as admin-equivalent for a token owned by an admin. Minting one of ` +
                    `them would silently grant every legacy requireAdmin() route (~50 files ` +
                    `under src/routes/) plus the token-minting ceiling in token-minting.ts — ` +
                    `not just the surface the scope's name suggests. Revisit the admin-equivalence ` +
                    `decision documented on deriveIsAdmin() in principal.ts before widening ` +
                    `serviceTokenScopeSchema to include it.`,
            ).toEqual(['admin']);
        },
    );
});
