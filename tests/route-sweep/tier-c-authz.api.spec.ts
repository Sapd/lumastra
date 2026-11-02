// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tier C route sweep: prove that the negative-auth boundary is real.
 *
 * This file deliberately uses request contexts only. A browser follows a 303
 * to the login page and turns an auth failure into an apparently successful
 * HTTP 200 navigation, hiding the defect this tier is meant to find.
 */
import { readFileSync } from 'node:fs';
import {
    ADMIN_FORWARD_AUTH_HEADERS,
    NON_ADMIN_FORWARD_AUTH_HEADERS,
    anonymousTest,
    expect,
    nonAdminTest,
} from './identity';

type DeclaredSecurity = string[];
type Page = {
    url: string;
    gate: string;
    hasFormActions: boolean;
    actions: string[];
};
type ApiOperation = {
    path: string;
    method: string;
    surface: 'v1' | 'internal';
    mutating: boolean;
    declaredSecurity: DeclaredSecurity;
};
type Inventory = {
    pages: Page[];
    api: ApiOperation[];
    counts: {
        pagesWithFormActions: number;
        formActions: number;
        apiMutating: number;
    };
};

const inventory = readInventory();
const adminPages = inventory.pages.filter((page) => page.gate === 'admin');
const actionPages = inventory.pages.filter((page) => page.hasFormActions);
const formActions = actionPages.flatMap((page) => page.actions.map((action) => ({ page, action })));
const mutatingOperations = inventory.api.filter((operation) => operation.mutating);
/*
 * Classify by PATH, not by which OpenAPI document the operation came from.
 *
 * `internal-api.yaml` documents plenty of `/api/v1/...` paths — /api/v1/library-groups,
 * /api/v1/library-paths, /api/v1/media/{id}/metadata — so `surface: 'internal'`
 * does not mean "reachable with forward-auth". Anything under /api/v1 needs a
 * bearer credential, and treating the doc's surface tag as the discriminator
 * produced 32 failures that were this misclassification rather than the app.
 */
const requiresBearer = (operation: ApiOperation): boolean => operation.path.startsWith('/api/v1/');

const anonymousOperations = mutatingOperations.filter(requiresBearer);
const documentedSecurityGaps = new Set<string>();

/*
 * Counts come from the INVENTORY, not from literals.
 *
 * Hardcoding them looked like the stronger guard and was the weaker one: a peer
 * session added three /api/v1/diagnostics/* endpoints and every count assertion
 * went red on drift that was correct and none of this tier's business. Worse,
 * the fix for that red is to bump a number, which trains everyone to bump
 * numbers.
 *
 * Comparing the tier's own filters against the generator's counts is NOT
 * tautological — it is the assertion that matters. It catches the tier silently
 * covering FEWER operations than the surface has, which is the false-green this
 * guard exists for, while an endpoint added upstream simply gets swept.
 */
const EXPECTED_ADMIN_PAGES = inventory.pages.filter((page) => page.gate === 'admin').length;
const EXPECTED_ACTION_PAGES = inventory.counts.pagesWithFormActions;
const EXPECTED_FORM_ACTIONS = inventory.counts.formActions;
const EXPECTED_MUTATING_OPERATIONS = inventory.counts.apiMutating;
const EXPECTED_BEARER_OPERATIONS = inventory.api.filter(
    (operation) => operation.mutating && requiresBearer(operation),
).length;
// Derived, like the counts above: the literal (43) went stale as admin endpoints were
// added (61 on 2026-11-02) and a stale literal fails a whole tier on correct drift.
const EXPECTED_ADMIN_OPERATIONS = inventory.api.filter(
    (operation) => operation.mutating && isAdminScoped(operation),
).length;

/**
 * The origin the app itself is served on. Mutating internal requests made
 * through a tunnel carry the tunnel's origin, which the CSRF guard rejects
 * with "Cross-site DELETE form submissions are forbidden" — a 403 that looks
 * exactly like an authorization failure and is not one.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The Origin the target treats as same-origin (its ORIGIN). Defaults to the base URL's origin;
// set SWEEP_CSRF_ORIGIN when the sweep reaches the target through a tunnel.
const CSRF_ORIGIN =
    process.env.SWEEP_CSRF_ORIGIN ??
    new URL(process.env.SWEEP_BASE_URL ?? 'http://localhost').origin;

nonAdminTest.describe('Tier C: admin page routes as non-admin', () => {
    nonAdminTest.beforeAll(() => {
        expect(adminPages).toHaveLength(EXPECTED_ADMIN_PAGES);
    });

    for (const page of adminPages) {
        nonAdminTest(`denies admin page ${page.url}`, async ({ request }) => {
            const response = await request.get(page.url, { maxRedirects: 0 });
            const body = await response.text();
            const location = response.headers().location;

            expect(
                [302, 303, 401, 403].includes(response.status()),
                `Admin page ${page.url} rendered for non-admin: HTTP ${response.status()}`,
            ).toBe(true);

            if (response.status() === 302 || response.status() === 303) {
                // The app redirects non-admins to the root, not /login. Following
                // that redirect yields HTTP 200 and a large home page, so status
                // and response size cannot distinguish denial from access here;
                // the landing URL is the signal.
                expect(
                    location,
                    `Admin page ${page.url} returned no redirect target.`,
                ).toBeTruthy();
                expect(
                    routeFromLocation(location),
                    `Admin page ${page.url} redirected back to the requested admin route.`,
                ).not.toBe(routeFromLocation(page.url));
            } else {
                expect(body).not.toMatch(/<main[^>]*>.*admin/i);
            }
            expect(body).not.toMatch(/<main[^>]*>.*admin/i);
        });
    }
});

nonAdminTest.describe('Tier C: form actions as non-admin', () => {
    nonAdminTest.beforeAll(() => {
        expect(actionPages).toHaveLength(EXPECTED_ACTION_PAGES);
        expect(formActions).toHaveLength(EXPECTED_FORM_ACTIONS);
    });

    for (const { page, action } of formActions) {
        nonAdminTest(`denies ${page.url} form action ${action}`, async ({ request }) => {
            const response = await request.post(`${page.url}?/${action}`, {
                form: {},
                maxRedirects: 0,
            });
            await assertAuthDenied(response, `form action ${page.url}?/${action}`, expect);
        });
    }
});

nonAdminTest.describe('Tier C: mutating API operations as non-admin', () => {
    nonAdminTest.beforeAll(() => {
        expect(mutatingOperations).toHaveLength(EXPECTED_MUTATING_OPERATIONS);
        expect(mutatingOperations.filter(isAdminScoped)).toHaveLength(EXPECTED_ADMIN_OPERATIONS);
    });

    for (const operation of mutatingOperations) {
        nonAdminTest(
            `${isAdminScoped(operation) ? 'denies' : 'observes'} ${operation.method} ${operation.path} (${operation.surface})`,
            async ({ request }, testInfo) => {
                const response = await request.fetch(toSafePath(operation.path), {
                    method: operation.method,
                    data: safeRequestBody(operation.method),
                    maxRedirects: 0,
                });
                const result = await observeAuth(response);
                if (isAdminScoped(operation)) {
                    assertExpectedAuth(
                        result,
                        true,
                        `${operation.method} ${operation.path} as non-admin`,
                        expect,
                    );
                    if (result.denied && operation.declaredSecurity.length === 0) {
                        recordDocumentationGap(operation, 'non-admin');
                    }
                    return;
                }

                // NOT asserted: that a non-admin must REACH this handler.
                //
                // That claim needs to know the endpoint is user-level, and we do
                // not know it. `isAdminScoped` only recognises `/admin/` in the
                // path, but plenty of admin-gated endpoints do not say so —
                // /api/plugins/holidays and /api/v1/library-groups among them.
                // Asserting reachability produced 32 failures that were the
                // heuristic being wrong, not the application.
                //
                // The denial direction above is the one this tier can ground.
                // Here we record what happened and fail only on a server error,
                // which is a defect under any reading.
                expect(
                    response.status(),
                    `${operation.method} ${operation.path} as non-admin returned a server error`,
                ).toBeLessThan(500);
                testInfo.annotations.push({
                    type: 'OBSERVED',
                    description: `${operation.method} ${operation.path} as non-admin -> ${response.status()}${result.denied ? ' (denied)' : ''}`,
                });
            },
        );
    }
});

anonymousTest.describe('Tier C: v1 mutating API operations as anonymous', () => {
    anonymousTest.beforeAll(() => {
        // Internal blank-auth requests resolve to DEFAULT_USER/admin. Keeping
        // the filter structural makes that false-green request impossible.
        expect(anonymousOperations).toHaveLength(EXPECTED_BEARER_OPERATIONS);
        // Structural, so the false-green request cannot be made: every operation
        // in this group must be a /api/v1 PATH. The document's surface tag is
        // NOT the discriminator — 56 of these are tagged 'internal'.
        expect(anonymousOperations.every((op) => op.path.startsWith('/api/v1/'))).toBe(true);
        // The non-bearer remainder (was a literal 21, 33 on 2026-11-02): together with the
        // bearer group it must account for every mutating operation.
        expect(mutatingOperations.filter((op) => !requiresBearer(op))).toHaveLength(
            EXPECTED_MUTATING_OPERATIONS - EXPECTED_BEARER_OPERATIONS,
        );
    });

    for (const operation of anonymousOperations) {
        anonymousTest(
            `denies ${operation.method} ${operation.path} (${operation.surface})`,
            async ({ request }) => {
                const response = await request.fetch(toSafePath(operation.path), {
                    method: operation.method,
                    data: safeRequestBody(operation.method),
                    maxRedirects: 0,
                });
                const result = await observeAuth(response);
                if (operation.declaredSecurity.includes('bearerAuth')) {
                    assertExpectedAuth(
                        result,
                        true,
                        `${operation.method} ${operation.path} as anonymous`,
                        expect,
                    );
                    return;
                }

                // No declared security means anonymous denial is not required.
                // If the running server denies it anyway, retain that as one
                // consolidated documentation finding rather than a red test.
                if (result.denied) recordDocumentationGap(operation, 'anonymous');
            },
        );
    }
});

anonymousTest.afterAll(({ request }, testInfo) => {
    void request;
    if (documentedSecurityGaps.size === 0) return;
    const summary =
        `${documentedSecurityGaps.size} operations are denied at runtime but declare no security in the generated OpenAPI document: ` +
        [...documentedSecurityGaps].sort().join(', ');
    testInfo.annotations.push({ type: 'REPORTED_FINDING', description: summary });
    console.warn(`REPORTED FINDING — OpenAPI security documentation gap: ${summary}`);
});

function readInventory(): Inventory {
    const source = readFileSync(new URL('./inventory.generated.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(source);
    if (!isInventory(parsed)) throw new Error('Route-sweep inventory has an unexpected shape.');
    return parsed;
}

function isInventory(value: unknown): value is Inventory {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as { pages?: unknown; api?: unknown };
    return (
        Array.isArray(candidate.pages) &&
        candidate.pages.every(isPage) &&
        Array.isArray(candidate.api) &&
        candidate.api.every(isApiOperation)
    );
}

function isPage(value: unknown): value is Page {
    if (typeof value !== 'object' || value === null) return false;
    const page = value as Partial<Page>;
    return (
        typeof page.url === 'string' &&
        typeof page.gate === 'string' &&
        typeof page.hasFormActions === 'boolean' &&
        Array.isArray(page.actions) &&
        page.actions.every((action) => typeof action === 'string')
    );
}

function isApiOperation(value: unknown): value is ApiOperation {
    if (typeof value !== 'object' || value === null) return false;
    const operation = value as Partial<ApiOperation>;
    return (
        typeof operation.path === 'string' &&
        typeof operation.method === 'string' &&
        (operation.surface === 'v1' || operation.surface === 'internal') &&
        typeof operation.mutating === 'boolean' &&
        Array.isArray(operation.declaredSecurity) &&
        operation.declaredSecurity.every((security) => typeof security === 'string')
    );
}

function toSafePath(path: string): string {
    // Well-formed nonexistent identifiers keep an accidental pass from
    // changing a real record while still exercising the route's auth layer.
    return path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
}

function safeRequestBody(method: string): Record<string, string> | undefined {
    return method === 'DELETE' ? undefined : { routeSweep: 'authorization-probe' };
}

function isAdminScoped(operation: ApiOperation): boolean {
    // The generated OpenAPI contains `bearerAuth: []`, so it does not expose
    // per-operation scopes. The route namespace is therefore the honest proxy;
    // it also covers nested admin namespaces such as `/api/v1/livetv/admin/`.
    return operation.path.includes('/admin/');
}

function routeFromLocation(location: string | undefined): string {
    return new URL(location ?? '', 'http://route-sweep.invalid').pathname;
}

interface AuthObservation {
    denied: boolean;
    validation: boolean;
    status: number;
}

async function observeAuth(response: {
    status(): number;
    text(): Promise<string>;
    headers(): Record<string, string>;
}): Promise<AuthObservation> {
    const body = await response.text();
    const status = response.status();
    const location = response.headers().location;
    const csrf = /csrf/i.test(body);
    const validation = status === 400 || status === 422;
    const redirectDenied =
        [302, 303].includes(status) && Boolean(location && !/\/admin\//.test(location));
    const statusDenied = [401, 403].includes(status) && !csrf;
    return {
        denied: !validation && !csrf && (redirectDenied || statusDenied),
        validation,
        status,
    };
}

function assertExpectedAuth(
    result: AuthObservation,
    expectedDenied: boolean,
    operation: string,
    assertion: typeof expect,
): void {
    assertion(
        result.denied,
        result.validation
            ? `${operation} reached the handler and returned HTTP ${result.status}; validation is not an auth denial.`
            : `${operation} returned HTTP ${result.status}; expected ${expectedDenied ? 'an auth denial' : 'the authenticated non-admin to reach the handler'}.`,
    ).toBe(expectedDenied);
}

function recordDocumentationGap(
    operation: ApiOperation,
    principal: 'non-admin' | 'anonymous',
): void {
    documentedSecurityGaps.add(`${principal} ${operation.method} ${operation.path}`);
}

async function assertAuthDenied(
    response: { status(): number; text(): Promise<string>; headers(): Record<string, string> },
    operation: string,
    assertion: typeof expect,
): Promise<void> {
    const result = await observeAuth(response);
    assertExpectedAuth(result, true, operation, assertion);
}

/*
 * v1 needs a BEARER credential, and without one this whole group is vacuous.
 *
 * /api/v1 does not accept forward-auth identity. Measured on one endpoint with
 * three principals: admin, non-admin and anonymous all receive 401. "Denied" is
 * therefore true regardless of who asks, so the anonymous group above proves
 * only that v1 refuses forward-auth headers — it would pass unchanged if
 * authorization were completely broken.
 *
 * The contrast is what carries meaning, so this group mints a real
 * read-scope token through the internal surface (which DOES honour forward-auth)
 * and shows v1 answering differently for it:
 *
 *     GET  /api/v1/playlists   anonymous 401   read-token 200
 *     POST /api/v1/playlists   anonymous 401   read-token 403  (scope enforced)
 *
 * The control assertion below is the guard against this group quietly going
 * vacuous again: if the token ever stops being honoured, the control fails
 * loudly instead of every operation "passing" on a uniform 401.
 */
nonAdminTest.describe('Tier C: v1 mutating operations with a real bearer credential', () => {
    let token: string | null = null;
    let tokenId: number | null = null;

    nonAdminTest.beforeAll(async ({ playwright, baseURL }) => {
        const ctx = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
        });
        try {
            // The mint addresses its owner by user id (the body schema has no
            // `username`). Forward-auth provisions the non-admin on first
            // request, so ask /api/me AS that principal for its id.
            const me = await ctx.get('/api/me', { headers: NON_ADMIN_FORWARD_AUTH_HEADERS });
            expect(me.ok(), 'resolving the sweep non-admin user id via /api/me').toBe(true);
            const meBody: unknown = await me.json();
            const ownerId = isRecord(meBody) && typeof meBody.id === 'string' ? meBody.id : null;
            expect(ownerId, '/api/me must carry the non-admin user id').not.toBeNull();
            const created = await ctx.post('/api/admin/pats', {
                data: {
                    userId: ownerId,
                    name: `route-sweep-${Date.now()}`,
                    scopes: ['read'],
                },
            });
            expect(created.ok(), 'minting the sweep bearer token').toBe(true);
            const body: unknown = await created.json();
            if (isRecord(body) && typeof body.token === 'string' && typeof body.id === 'number') {
                token = body.token;
                tokenId = body.id;
            }
            expect(token, 'the mint response must carry a token').not.toBeNull();
        } finally {
            await ctx.dispose();
        }
    });

    nonAdminTest.afterAll(async ({ playwright, baseURL }) => {
        if (tokenId === null) return;
        const ctx = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
        });
        try {
            // Revoke by path (`DELETE /api/admin/pats/{id}`; the collection route
            // no longer allows DELETE). The CSRF guard rejects a cross-site
            // DELETE, so the app's own origin must be sent. Without it this is a
            // 403 and the token is left behind on the target.
            await ctx.delete(`/api/admin/pats/${tokenId}`, {
                headers: { Origin: CSRF_ORIGIN },
            });
        } finally {
            await ctx.dispose();
        }
    });

    nonAdminTest(
        'control: the bearer token is live and v1 honours it',
        async ({ playwright, baseURL }) => {
            expect(token).not.toBeNull();
            const ctx = await playwright.request.newContext({
                baseURL,
                extraHTTPHeaders: { Authorization: `Bearer ${token ?? ''}` },
            });
            try {
                const withToken = await ctx.get('/api/v1/playlists');
                expect(withToken.status(), 'a read-scope token must be able to READ v1').toBe(200);
            } finally {
                await ctx.dispose();
            }
        },
    );

    for (const operation of anonymousOperations) {
        nonAdminTest(
            `scope-gates ${operation.method} ${operation.path}`,
            async ({ playwright, baseURL }) => {
                expect(token).not.toBeNull();
                const ctx = await playwright.request.newContext({
                    baseURL,
                    extraHTTPHeaders: { Authorization: `Bearer ${token ?? ''}` },
                });
                try {
                    const response = await ctx.fetch(toSafePath(operation.path), {
                        method: operation.method,
                        data: safeRequestBody(operation.method),
                        maxRedirects: 0,
                    });
                    // The point is the CONTRAST with anonymous, which is 401
                    // everywhere. A credential that is honoured produces
                    // anything but 401 — 403 for insufficient scope, or a
                    // validation response once it reaches the handler.
                    expect(
                        response.status(),
                        `${operation.method} ${operation.path} returned 401 WITH a valid bearer token; ` +
                            'either the token was rejected or this group is measuring nothing',
                    ).not.toBe(401);
                } finally {
                    await ctx.dispose();
                }
            },
        );
    }
});
