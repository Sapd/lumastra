// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam guard: an admin-scoped token whose OWNER is no longer admin reaches
 * NO `{kind:'scope'}` def (2026-10-02, found while building
 * GET /api/v1/integrations/homepage).
 *
 * The hole: `buildPrincipal()` set `scopes = expandScopes(rawTokenScopes)`
 * and stripped admin-class scopes only for `forceNonAdmin`. `deriveIsAdmin()`
 * already refused `isAdmin` to an `['admin']` PAT/service token of a demoted
 * owner, so `{kind:'admin'}` defs were safe (admin-kind-v1-dual-mount.test.ts)
 * — but `mount.ts`'s `case 'scope'` reads `principal.scopes`, which still
 * held the whole `expandScopes(['admin'])` set (`metrics:read`,
 * `tasks:admin`, `users:read`, …). `narrowAdminScopedCredentialsForUser()`
 * only runs on an explicit `setIsAdmin(false)`/unpin; losing the admin GROUP
 * narrowed nothing.
 *
 * Driven at the seam, not at `scopeGranted()`:
 *   1. Principal path — the REAL `enforce()` (what `mount()` calls) with a
 *      REAL `buildPrincipal()` Principal, for every scope stanza under
 *      `defs/**` (source-scanned, see defs-scope-stanzas.test-helpers.ts).
 *   2. Fallback path — no Principal, Bearer header: the REAL `authenticate()`
 *      in tasks/api-auth.ts (only the token-identity producer's DB leaves are
 *      mocked) feeding the REAL `enforce()`.
 *   3. One real def end to end: `defs/system-metrics.ts` (`metrics:read`)
 *      through `mount(def, {surface:'v1'})` — the original repro.
 *
 * Each arm has a positive control (same token, owner still admin → granted)
 * so a 403 cannot come from the sweep failing to grant anything at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { buildPrincipal, expandScopes, type Principal } from './principal.js';
import type { AuthSpec } from './define.js';
import { scanDefScopeStanzas } from './defs-scope-stanzas.test-helpers.js';

const mocks = vi.hoisted(() => ({
    validateBearerCredential: vi.fn(),
    resolveTokenIdentity: vi.fn(),
    adminSystemMetricsGET: vi.fn(),
}));

vi.mock('$lib/server/auth/token-identity.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/auth/token-identity.js')>();
    return {
        ...actual,
        validateBearerCredential: mocks.validateBearerCredential,
        resolveTokenIdentity: mocks.resolveTokenIdentity,
    };
});
vi.mock('$lib/server/utils/client-ip.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/client-ip.js')>();
    return { ...actual, getClientIpStrict: () => '127.0.0.1' };
});
vi.mock('../../../routes/api/admin/system-metrics/+server.js', () => ({
    GET: mocks.adminSystemMetricsGET,
}));

import { enforce, mount } from './mount.js';
import { def as systemMetricsDef } from './defs/system-metrics.js';

type TokenKind = 'pat' | 'service_token';

/** A token as resolved by the token layer, with its RAW minted scopes. */
function tokenPrincipal(kind: TokenKind, scopes: string[], ownerIsAdmin: boolean): Principal {
    return buildPrincipal({
        kind,
        userId: 'usr_owner' as never,
        username: 'demoted-owner',
        userGroups: [],
        tokenScopes: scopes,
        sessionIsAdmin: false,
        ownerIsAdmin,
    });
}

function makeEvent(opts: { principal?: Principal; bearer?: string; path?: string }): RequestEvent {
    const url = new URL(`http://localhost${opts.path ?? '/api/v1/x'}`);
    const headers = new Headers();
    if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
    return {
        url,
        params: {},
        route: { id: url.pathname },
        request: new Request(url.toString(), { headers }),
        locals: opts.principal
            ? {
                  principal: opts.principal,
                  user: {
                      userId: opts.principal.userId,
                      username: opts.principal.username,
                      userGroups: opts.principal.userGroups,
                      ownerIsAdmin: opts.principal.isAdmin,
                      maxAgeRating: null,
                  },
              }
            : {},
        cookies: { get: () => undefined } as unknown as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** Fake the token-identity producer's two steps for the fallback arm. */
function stubTokenLayer(kind: TokenKind, scopes: string[], ownerIsAdmin: boolean) {
    const validated =
        kind === 'pat'
            ? { id: 7, username: 'demoted-owner', scopes, forceNonAdmin: false }
            : { id: 9, name: 'svc', scopes, forceNonAdmin: false, actAsUser: null };
    mocks.validateBearerCredential.mockResolvedValue({
        ok: true,
        credential: { kind, validated },
    });
    mocks.resolveTokenIdentity.mockResolvedValue({
        ok: true,
        identity: {
            userContext: {
                userId: 'usr_owner',
                username: 'demoted-owner',
                userGroups: [],
                // The producer's live Formula-A verdict (for a service token:
                // creator/target admin AND literal 'admin' scope).
                ownerIsAdmin: ownerIsAdmin,
            },
            principal: tokenPrincipal(kind, scopes, ownerIsAdmin),
        },
    });
}

const { files, stanzas, unparsed } = scanDefScopeStanzas();
/** Unique anyOf sets, each tagged with one def that declares it. */
const SPECS = [
    ...new Map(stanzas.map((s) => [[...s.anyOf].sort().join(','), s] as const)).values(),
];
const TOKEN_KINDS: TokenKind[] = ['pat', 'service_token'];

beforeEach(() => {
    vi.clearAllMocks();
});

describe('scope stanza corpus', () => {
    it('scans the real def tree and parses every scope stanza', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(SPECS.length).toBeGreaterThan(10);
        expect(unparsed).toEqual([]);
    });
});

describe('Principal path — demoted owner admin token vs every {kind:"scope"} def', () => {
    it.each(TOKEN_KINDS)(
        "%s ['admin'], owner no longer admin: Principal carries no admin-class scope",
        (kind) => {
            const p = tokenPrincipal(kind, ['admin'], false);
            expect(p.isAdmin).toBe(false);
            expect(p.scopes).toEqual([]);
        },
    );

    it.each(TOKEN_KINDS)(
        '%s: every scope def 403s for ["admin"] of a demoted owner',
        async (kind) => {
            const denied: string[] = [];
            const granted: string[] = [];
            for (const { file, anyOf } of SPECS) {
                const spec: AuthSpec = { kind: 'scope', anyOf } as AuthSpec;
                const res = await enforce(
                    spec,
                    makeEvent({ principal: tokenPrincipal(kind, ['admin'], false) }),
                );
                (res?.status === 403 ? denied : granted).push(`${file} [${anyOf.join(',')}]`);
            }
            expect(
                granted,
                `granted to a demoted owner's admin token:\n${granted.join('\n')}`,
            ).toEqual([]);
            expect(denied.length).toBe(SPECS.length);
        },
    );

    it.each(TOKEN_KINDS)(
        '%s: positive control — the same token passes every scope def while the owner IS admin',
        async (kind) => {
            const refused: string[] = [];
            for (const { file, anyOf } of SPECS) {
                const res = await enforce(
                    { kind: 'scope', anyOf } as AuthSpec,
                    makeEvent({ principal: tokenPrincipal(kind, ['admin'], true) }),
                );
                if (res !== null) refused.push(`${file} [${anyOf.join(',')}] → ${res.status}`);
            }
            expect(refused).toEqual([]);
        },
    );

    /**
     * Raw scope sets a demoted owner's token might carry: the mintable ones
     * plus legacy/fine-grained admin-class rows (not mintable today, but the
     * strip must not depend on that). Each must reach EXACTLY what its
     * non-admin remainder reaches — never more (the hole), never less (an
     * over-strip would also drop the token's explicit read/write).
     */
    const DEMOTED_SCOPE_SETS: string[][] = [
        ['admin'],
        ['admin', 'read'],
        ['admin', 'read', 'write'],
        ['users:admin'],
        ['tasks:admin', 'read'],
        ['access:admin', 'tokens:admin', 'library:admin', 'write'],
    ];

    async function grantedSpecs(principal: Principal): Promise<Set<string>> {
        const out = new Set<string>();
        for (const { file, anyOf } of SPECS) {
            const res = await enforce(
                { kind: 'scope', anyOf } as AuthSpec,
                makeEvent({ principal }),
            );
            if (res === null) out.add(`${file} [${anyOf.join(',')}]`);
        }
        return out;
    }

    describe.each(TOKEN_KINDS)('%s of a demoted owner', (kind) => {
        it.each(DEMOTED_SCOPE_SETS)(
            'raw %j reaches exactly what its non-admin remainder reaches',
            async (...raw: string[]) => {
                const remainder = raw.filter((sc) => sc !== 'admin' && !sc.endsWith(':admin'));
                const demoted = tokenPrincipal(kind, raw, false);
                expect(demoted.scopes.sort()).toEqual(expandScopes(remainder).sort());
                // An empty remainder must reach nothing. (Not a token built
                // from `[]`: buildPrincipal() reads empty tokenScopes as "no
                // stored scopes" and derives read/write.)
                const expected =
                    remainder.length === 0
                        ? []
                        : [...(await grantedSpecs(tokenPrincipal(kind, remainder, true)))].sort();
                expect([...(await grantedSpecs(demoted))].sort()).toEqual(expected);
            },
        );
    });

    it.each(TOKEN_KINDS)(
        "%s ['admin','read','write'] of a demoted owner reaches exactly what a plain non-admin session reaches",
        async (kind) => {
            const session = buildPrincipal({
                kind: 'session',
                userId: 'usr_owner' as never,
                username: 'demoted-owner',
                userGroups: [],
                sessionIsAdmin: false,
            });
            expect(session.scopes.sort()).toEqual(expandScopes(['read', 'write']).sort());

            const token = await grantedSpecs(
                tokenPrincipal(kind, ['admin', 'read', 'write'], false),
            );
            const plain = await grantedSpecs(session);
            // Non-vacuous: a non-admin session does reach some scope defs.
            expect(plain.size).toBeGreaterThan(0);
            expect([...token].sort()).toEqual([...plain].sort());
        },
    );
});

describe('authenticate() fallback — no Principal, Bearer token', () => {
    it.each(TOKEN_KINDS)(
        '%s: every scope def 403s for ["admin"] of a demoted owner',
        async (kind) => {
            stubTokenLayer(kind, ['admin'], false);
            const granted: string[] = [];
            for (const { file, anyOf } of SPECS) {
                const event = makeEvent({
                    bearer: kind === 'pat' ? 'pat_x' : 'svc_x',
                    path: '/api/admin/x',
                });
                const res = await enforce({ kind: 'scope', anyOf } as AuthSpec, event);
                if (res?.status !== 403)
                    granted.push(`${file} [${anyOf.join(',')}] → ${res?.status}`);
                // A denied fallback must not leave an identity behind either.
                expect(event.locals.principal).toBeUndefined();
            }
            expect(granted).toEqual([]);
            expect(mocks.resolveTokenIdentity).toHaveBeenCalled();
        },
    );

    it.each(TOKEN_KINDS)(
        "%s: ['admin','read','write'] of a demoted owner keeps its read/write reach (no over-strip)",
        async (kind) => {
            stubTokenLayer(kind, ['admin', 'read', 'write'], false);
            const spec = { kind: 'scope', anyOf: ['media:read'] } as AuthSpec;
            const ok = await enforce(
                spec,
                makeEvent({ bearer: `${kind === 'pat' ? 'pat' : 'svc'}_x` }),
            );
            expect(ok).toBeNull();
            const denied = await enforce(
                { kind: 'scope', anyOf: ['metrics:read'] } as AuthSpec,
                makeEvent({ bearer: `${kind === 'pat' ? 'pat' : 'svc'}_x` }),
            );
            expect(denied?.status).toBe(403);
        },
    );

    it.each(TOKEN_KINDS)('%s: positive control — owner still admin passes', async (kind) => {
        stubTokenLayer(kind, ['admin'], true);
        const refused: string[] = [];
        for (const { file, anyOf } of SPECS) {
            const res = await enforce(
                { kind: 'scope', anyOf } as AuthSpec,
                makeEvent({ bearer: kind === 'pat' ? 'pat_x' : 'svc_x', path: '/api/admin/x' }),
            );
            if (res !== null) refused.push(`${file} [${anyOf.join(',')}] → ${res.status}`);
        }
        expect(refused).toEqual([]);
    });
});

describe('real def end to end — GET /api/v1/system-metrics (metrics:read)', () => {
    const { GET } = mount(systemMetricsDef, { surface: 'v1' });

    it.each(TOKEN_KINDS)("403s %s ['admin'] of a demoted owner, never delegates", async (kind) => {
        const res = await GET!(
            makeEvent({
                principal: tokenPrincipal(kind, ['admin'], false),
                path: '/api/v1/system-metrics',
            }),
        );
        expect(res.status).toBe(403);
        expect(mocks.adminSystemMetricsGET).not.toHaveBeenCalled();
    });

    it.each(TOKEN_KINDS)(
        'positive control — %s of an admin owner reaches the handler',
        async (kind) => {
            mocks.adminSystemMetricsGET.mockResolvedValue(
                new Response(JSON.stringify({}), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
            // Response-contract checks on the stub body are not under test.
            await Promise.resolve(
                GET!(
                    makeEvent({
                        principal: tokenPrincipal(kind, ['admin'], true),
                        path: '/api/v1/system-metrics',
                    }),
                ),
            ).catch(() => undefined);
            expect(mocks.adminSystemMetricsGET).toHaveBeenCalledTimes(1);
        },
    );
});
