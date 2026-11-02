// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * H3 — unit tests for deriveIsAdmin() and buildPrincipal() in principal.ts.
 *
 * expandScopes() has its own dedicated privilege-boundary suite in
 * expand-scopes.test.ts (G5) — NOT duplicated here. This file only exercises
 * the two-condition admin rule (deriveIsAdmin) across all six PrincipalKinds,
 * and buildPrincipal()'s scope-derivation + field passthrough.
 */

import { describe, it, expect } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import {
    deriveIsAdmin,
    buildPrincipal,
    stripAdminScopes,
    type PrincipalKind,
} from './principal.js';

const USER_ID = toUserId('11111111-1111-1111-1111-111111111111');

// ---------------------------------------------------------------------------
// deriveIsAdmin() — session / forward_auth: DB-authoritative verdict passthrough
// ---------------------------------------------------------------------------

describe('deriveIsAdmin — session / forward_auth kinds use the DB-authoritative verdict', () => {
    const sessionLikeKinds: PrincipalKind[] = ['session', 'forward_auth'];

    it.each(sessionLikeKinds)(
        '%s: sessionIsAdmin=true -> true (ignores tokenScopes/ownerIsAdmin)',
        (kind) => {
            expect(
                deriveIsAdmin({
                    kind,
                    sessionIsAdmin: true,
                    ownerIsAdmin: false,
                    tokenScopes: [],
                    forceNonAdmin: false,
                }),
            ).toBe(true);
        },
    );

    it.each(sessionLikeKinds)('%s: sessionIsAdmin=false -> false', (kind) => {
        expect(
            deriveIsAdmin({
                kind,
                sessionIsAdmin: false,
                ownerIsAdmin: true, // must be ignored for session/forward_auth
                tokenScopes: ['admin'],
                forceNonAdmin: false,
            }),
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// deriveIsAdmin() — stream_token: never admin, regardless of any other input
// ---------------------------------------------------------------------------

describe('deriveIsAdmin — stream_token is never admin', () => {
    it('ignores sessionIsAdmin/ownerIsAdmin/tokenScopes and returns false', () => {
        expect(
            deriveIsAdmin({
                kind: 'stream_token',
                sessionIsAdmin: true,
                ownerIsAdmin: true,
                tokenScopes: ['admin'],
                forceNonAdmin: false,
            }),
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// deriveIsAdmin() — token kinds (bearer/pat/service_token): the two-condition
// rule (ownerIsAdmin AND an explicit admin-equivalent scope).
// ---------------------------------------------------------------------------

describe('deriveIsAdmin — token kinds (bearer/pat/service_token): ownerIsAdmin x scope matrix', () => {
    const tokenKinds: PrincipalKind[] = ['bearer', 'pat', 'service_token'];

    for (const kind of tokenKinds) {
        describe(`kind=${kind}`, () => {
            it("ownerIsAdmin=true, tokenScopes=['admin'] -> true", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: true,
                        tokenScopes: ['admin'],
                        forceNonAdmin: false,
                    }),
                ).toBe(true);
            });

            it("ownerIsAdmin=true, tokenScopes=['tasks:admin'] -> true (admin-equivalent scope)", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: true,
                        tokenScopes: ['tasks:admin'],
                        forceNonAdmin: false,
                    }),
                ).toBe(true);
            });

            it("ownerIsAdmin=true, tokenScopes=['read'] -> false (no admin-equivalent scope)", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: true,
                        tokenScopes: ['read'],
                        forceNonAdmin: false,
                    }),
                ).toBe(false);
            });

            it("ownerIsAdmin=false, tokenScopes=['admin'] -> false (low-owner PAT/svc with admin scope must NOT be admin)", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: false,
                        tokenScopes: ['admin'],
                        forceNonAdmin: false,
                    }),
                ).toBe(false);
            });

            it("ownerIsAdmin=false, tokenScopes=['tasks:admin'] -> false", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: false,
                        tokenScopes: ['tasks:admin'],
                        forceNonAdmin: false,
                    }),
                ).toBe(false);
            });

            it("ownerIsAdmin=false, tokenScopes=['read'] -> false", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: false,
                        tokenScopes: ['read'],
                        forceNonAdmin: false,
                    }),
                ).toBe(false);
            });

            it("forceNonAdmin=true kill-switch -> false even with ownerIsAdmin=true and tokenScopes=['admin']", () => {
                expect(
                    deriveIsAdmin({
                        kind,
                        sessionIsAdmin: false,
                        ownerIsAdmin: true,
                        tokenScopes: ['admin'],
                        forceNonAdmin: true,
                    }),
                ).toBe(false);
            });
        });
    }
});

// ---------------------------------------------------------------------------
// Security review 2026-09-13, C1: `users:admin` is a fine-grained delegation
// scope, NOT admin-equivalent. Pinning this here guards the admin-ceiling
// fix in defs/users/[id].ts, defs/admin/users/[username]/index.ts,
// defs/users/index.ts, and the two password-reset defs, which all rely on
// `users:admin` alone never being treated as admin.
// ---------------------------------------------------------------------------

describe("C1 — a ['users:admin'] principal is never admin-equivalent", () => {
    it('deriveIsAdmin: tokenScopes=[users:admin], ownerIsAdmin=true -> false', () => {
        expect(
            deriveIsAdmin({
                kind: 'pat',
                sessionIsAdmin: false,
                ownerIsAdmin: true,
                tokenScopes: ['users:admin'],
                forceNonAdmin: false,
            }),
        ).toBe(false);
    });

    it('buildPrincipal: a pat with only users:admin scope has isAdmin === false even when the owner is an admin', () => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'ops',
            userGroups: ['admins'],
            tokenScopes: ['users:admin'],
            ownerIsAdmin: true,
        });
        expect(principal.isAdmin).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// buildPrincipal() — scope derivation for session vs token, admin vs non-admin
// ---------------------------------------------------------------------------

describe('buildPrincipal — scope derivation', () => {
    it('session, admin -> scopes derived from the "admin" alias (expanded superset)', () => {
        const principal = buildPrincipal({
            kind: 'session',
            userId: USER_ID,
            username: 'alice',
            userGroups: ['admins'],
            sessionIsAdmin: true,
        });
        expect(principal.isAdmin).toBe(true);
        expect(principal.scopes).toContain('admin');
        expect(principal.scopes).toContain('read');
        expect(principal.scopes).toContain('write');
        expect(principal.scopes).toContain('tasks:admin');
    });

    it('session, non-admin -> scopes derived from read+write (no admin-class scopes)', () => {
        const principal = buildPrincipal({
            kind: 'session',
            userId: USER_ID,
            username: 'bob',
            userGroups: [],
            sessionIsAdmin: false,
        });
        expect(principal.isAdmin).toBe(false);
        expect(principal.scopes).toContain('read');
        expect(principal.scopes).toContain('write');
        expect(principal.scopes).not.toContain('admin');
        expect(principal.scopes).not.toContain('tasks:admin');
    });

    it('token (pat), admin scope + ownerIsAdmin -> scopes are the expanded EXPLICIT token scopes, not a synthesized admin/read/write pair', () => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'alice',
            userGroups: ['admins'],
            tokenScopes: ['admin'],
            ownerIsAdmin: true,
        });
        expect(principal.isAdmin).toBe(true);
        expect(principal.scopes).toContain('admin');
        expect(principal.scopes).toContain('tasks:admin');
    });

    it('token (pat), narrow explicit scope -> expanded set does not silently widen to admin/write', () => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'alice',
            userGroups: ['admins'], // ownerIsAdmin alone must not confer admin without the scope
            tokenScopes: ['read'],
            ownerIsAdmin: true,
        });
        expect(principal.isAdmin).toBe(false); // no admin-equivalent scope present
        expect(principal.scopes).toContain('read');
        expect(principal.scopes).not.toContain('write');
        expect(principal.scopes).not.toContain('admin');
    });

    it('token (service_token), empty explicit scopes -> falls back to the session-style read/write default', () => {
        // buildPrincipal treats an empty tokenScopes array the same as a
        // session/forward-auth credential for scope-derivation purposes.
        const principal = buildPrincipal({
            kind: 'service_token',
            userId: USER_ID,
            username: 'service:monitor',
            userGroups: [],
            tokenScopes: [],
            ownerIsAdmin: false,
        });
        expect(principal.isAdmin).toBe(false);
        expect(principal.scopes).toContain('read');
        expect(principal.scopes).toContain('write');
    });

    it('stream_token -> never admin, non-admin scope default', () => {
        const principal = buildPrincipal({
            kind: 'stream_token',
            userId: USER_ID,
            username: 'carol',
            userGroups: [],
            sessionIsAdmin: true, // must be ignored — stream_token is never admin
            ownerIsAdmin: true,
        });
        expect(principal.isAdmin).toBe(false);
        expect(principal.scopes).toContain('read');
        expect(principal.scopes).not.toContain('admin');
    });
});

// ---------------------------------------------------------------------------
// buildPrincipal() — userId is the users.id UUID, passed through unchanged
// ---------------------------------------------------------------------------

describe('buildPrincipal — userId passthrough', () => {
    it('carries the users.id UUID through unchanged (never re-derived or coerced)', () => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'alice',
            userGroups: [],
            tokenScopes: ['read'],
            ownerIsAdmin: false,
        });
        expect(principal.userId).toBe(USER_ID);
    });

    it('kind and username are also passed through unchanged', () => {
        const principal = buildPrincipal({
            kind: 'service_token',
            userId: USER_ID,
            username: 'service:ci-bot',
            userGroups: ['ops'],
            tokenScopes: ['write'],
            ownerIsAdmin: false,
        });
        expect(principal.kind).toBe('service_token');
        expect(principal.username).toBe('service:ci-bot');
        expect(principal.userGroups).toEqual(['ops']);
    });
});

// ── C2 (security review 2026-09-12): forceNonAdmin must also strip the SCOPES ──
//
// `deriveIsAdmin` already returns false for a forceNonAdmin token, but the admin
// plane is overwhelmingly gated by `{kind:'scope'}` (users:admin, livetv:admin, …),
// which reads `principal.scopes`. A forceNonAdmin token that kept `admin` in its
// expanded scope set therefore still passed ~140 admin endpoints.

describe('stripAdminScopes', () => {
    it('removes the admin alias and every *:admin scope, keeps the rest in order', () => {
        expect(
            stripAdminScopes(['read', 'admin', 'users:admin', 'library:read', 'tasks:admin']),
        ).toEqual(['read', 'library:read']);
    });

    it('is a no-op on a set without admin scopes', () => {
        expect(stripAdminScopes(['read', 'write', 'tasks:run'])).toEqual([
            'read',
            'write',
            'tasks:run',
        ]);
    });
});

describe('buildPrincipal — forceNonAdmin strips admin-class scopes (C2)', () => {
    const base = {
        kind: 'service_token' as const,
        userId: USER_ID,
        username: 'monitor',
        userGroups: ['admins'],
        ownerIsAdmin: true,
        forceNonAdmin: true,
    };

    it("tokenScopes=['admin'] -> stripped to nothing (X2 fix, security review 2026-09-23 final wave)", () => {
        // FIX (X2): buildPrincipal() used to expand FIRST, strip SECOND, so a
        // narrowed ['admin'] token kept every admin-only AREA scope 'admin'
        // expanded into (tasks:run, webhooks:write, users:read, metrics:read,
        // …) — isAdminClassScope() only strips the literal 'admin'/'*:admin'
        // entries, not their non-':admin'-suffixed siblings. The raw scope is
        // now stripped BEFORE expansion, so a token minted with nothing but
        // the coarse 'admin' alias ends up with NOTHING once narrowed — it
        // must be re-minted with explicit scopes to keep any access.
        const principal = buildPrincipal({ ...base, tokenScopes: ['admin'] });
        expect(principal.isAdmin).toBe(false);
        expect(principal.scopes).toEqual([]);
    });

    it("tokenScopes=['users:admin','library:read'] -> users:admin (and its read half) gone, library:read kept", () => {
        // FIX (X2): 'users:admin' is itself admin-class (isAdminClassScope),
        // so it is stripped before expansion — 'users:read' no longer
        // survives via users:admin's hierarchical expansion either, since
        // expansion never sees users:admin at all once narrowed. The
        // INDEPENDENT, non-admin-class 'library:read' scope is untouched.
        const principal = buildPrincipal({
            ...base,
            tokenScopes: ['users:admin', 'library:read'],
        });
        expect(principal.scopes).not.toContain('users:admin');
        expect(principal.scopes).not.toContain('users:read');
        expect(principal.scopes).toContain('library:read');
    });

    it('forceNonAdmin=false leaves the admin scopes in place', () => {
        const principal = buildPrincipal({ ...base, forceNonAdmin: false, tokenScopes: ['admin'] });
        expect(principal.isAdmin).toBe(true);
        expect(principal.scopes).toContain('admin');
        expect(principal.scopes).toContain('users:admin');
    });

    it('a forceNonAdmin token with NO scopes does not inherit the session read+write fallback', () => {
        // The empty-scope fallback exists for session/forward-auth credentials.
        // A token that was minted with no scopes has no scopes.
        const principal = buildPrincipal({ ...base, tokenScopes: [] });
        expect(principal.isAdmin).toBe(false);
        expect(principal.scopes).not.toContain('admin');
    });
});
