// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { adminTest as test, expect } from './identity';
import { paceNavigation } from './pacing';
import { expectHydrated } from '../helpers/hydration';
import {
    resolveParamFixtures,
    VALID_SYMPTOMS,
    type ParamFixture,
    type ParamFixtureInventory,
    type ResolvedParamFixtures,
} from './param-fixtures';

interface InventoryPage {
    routeId: string;
    url: string;
    params: Array<{ name: string; kind: 'required' | 'optional' }>;
    inPublicBuild: boolean;
}

interface Inventory {
    counts: { pages: number; pagesWithParams: number };
    pages: InventoryPage[];
    paramFixtures: ParamFixtureInventory;
}

interface RouteCase {
    page: InventoryPage;
    variant: 'valid' | 'nonexistent';
}

const inventory = readInventory();
const routeCases = inventory.pages.flatMap((page): RouteCase[] =>
    page.params.length === 0
        ? [{ page, variant: 'valid' }]
        : [
              { page, variant: 'valid' },
              { page, variant: 'nonexistent' },
          ],
);
const expectedTestCount = inventory.counts.pages + inventory.counts.pagesWithParams;
const build = process.env.SWEEP_BUILD === 'public' ? 'public' : 'full';
const EXPECTED_ABSENT_IMAGE =
    /\/api\/media\/[0-9a-f-]{36}\/images\/(?:logo|backdrop)\?(?=.*\bfallback=none\b)/;
let resolvedFixtures: Promise<ResolvedParamFixtures> | undefined;

test.beforeAll(() => {
    // This is deliberately an import-time/run-setup assertion: a partial
    // inventory must fail before 158 navigations can report a false green.
    expect(routeCases).toHaveLength(expectedTestCount);
});

test.beforeEach(async ({ request }) => {
    resolvedFixtures ??= resolveParamFixtures(request, inventory.paramFixtures);
    await resolvedFixtures;
});

for (const routeCase of routeCases) {
    test(`${routeCase.variant}: ${routeCase.page.url}`, async ({ page }, testInfo) => {
        const fixtures = await resolvedFixtures;
        const fixtureResult = buildRoutes(routeCase, fixtures ?? { routes: {}, libraryTypes: [] });
        if (fixtureResult.blockedReason) {
            testInfo.annotations.push({
                type: 'BLOCKED',
                description: fixtureResult.blockedReason,
            });
            // Valid empty-library slots are not failures and are not skips: the
            // nonexistent case still exercises the route's missing-data path.
            expect(fixtureResult.blockedReason).toContain('unresolved');
            return;
        }

        const consoleErrors: string[] = [];
        const failedRequests: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        let expectedAbsentImages = 0;
        const sse: { retryAfterSeconds: number | null } = { retryAfterSeconds: null };
        page.on('response', (response) => {
            if (response.status() >= 500)
                failedRequests.push(`${response.status()} ${response.url()}`);
            // The per-user SSE connect limiter (pacing.ts) answered 429. Not a page
            // defect: remember the Retry-After and load the page again below.
            if (
                response.status() === 429 &&
                new URL(response.url()).pathname === '/api/events/user'
            )
                sse.retryAfterSeconds = Number(response.headers()['retry-after'] ?? 15) || 15;
            // EXPECTED 404 class: a library/entity logo requested with
            // `fallback=none`. That flag means "answer 404 instead of the
            // placeholder when the item has no image" (see
            // src/lib/server/api/defs/media/[id]/images/[role].ts) and the UI
            // hides the <img> in that case. Seen on /, /login, /logout, /setup and
            // /setup/locked (the shell's library-logo strip, and the home hero's
            // backdrop for an item without artwork, such as the imageless preprod
            // fixtures). Deliberately NOT a general "images may 404" rule: the
            // pattern needs the image route, role `logo` or `backdrop` AND
            // `fallback=none`, so a broken poster or any other 404 still fails.
            if (response.status() === 404 && EXPECTED_ABSENT_IMAGE.test(response.url()))
                expectedAbsentImages++;
        });
        page.on('requestfailed', (request) => {
            // The page's long-lived SSE stream is cancelled (net::ERR_ABORTED) when
            // the navigation it belongs to is replaced, which /logout (a redirect)
            // does every time. An aborted stream is not a failed page request; any
            // other failure on it, and any other aborted URL, is still reported.
            if (
                request.failure()?.errorText === 'net::ERR_ABORTED' &&
                new URL(request.url()).pathname === '/api/events/user'
            )
                return;
            // The home hero's preview-session heartbeat (POST .../keepalive) is
            // cancelled by the browser when the navigation it belongs to is replaced
            // or the page closes inside the settle window. The server never answered
            // it, so there is no response to be a 5xx; a keepalive the server
            // REFUSES (403/5xx) still fails through the response handler above.
            if (
                request.failure()?.errorText === 'net::ERR_ABORTED' &&
                request.method() === 'POST' &&
                /^\/api\/playback\/previews\/[^/]+\/keepalive$/.test(
                    new URL(request.url()).pathname,
                )
            )
                return;
            // The file-health panel on /admin/system/health cancels its own list
            // request when a newer refresh supersedes it (AbortController in
            // FileHealthListPanel.svelte `load()`). The server answered that
            // endpoint 200 in ~10 ms when measured; the abort is the client's.
            if (
                request.failure()?.errorText === 'net::ERR_ABORTED' &&
                request.method() === 'GET' &&
                new URL(request.url()).pathname === '/api/admin/media/file-health'
            )
                return;
            failedRequests.push(
                `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
            );
        });

        for (const [index, url] of fixtureResult.urls.entries()) {
            // Retry loop (max 3 tries) for two causes that are not the page's fault.
            // 1) The SSE limiter is shared with Tier B's browser and anyone else on
            //    the account, so pacing alone can still be overrun: when the stream
            //    request was throttled, wait out Retry-After and reload. A 429 on
            //    any other URL is never retried or filtered.
            // 2) Host network churn, see below.
            let response: Awaited<ReturnType<typeof page.goto>>;
            for (let attempt = 1; ; attempt++) {
                sse.retryAfterSeconds = null;
                consoleErrors.length = 0;
                failedRequests.length = 0;
                expectedAbsentImages = 0;
                await paceNavigation();
                response = await page.goto(url, { waitUntil: 'domcontentloaded' });
                // Settle window: see the note below.
                await page.waitForTimeout(1000);
                // Chromium fails every in-flight request with ERR_NETWORK_CHANGED
                // when a network interface appears or disappears. The runner is
                // shared with other sessions starting/stopping docker containers
                // (veth churn), so this is host noise, not the page. Reload the
                // page; the same error on all 3 tries still fails.
                const networkChanged = consoleErrors.some((text) =>
                    text.includes('net::ERR_NETWORK_CHANGED'),
                );
                if ((sse.retryAfterSeconds === null && !networkChanged) || attempt >= 3) break;
                await page.waitForTimeout(((sse.retryAfterSeconds ?? 1) + 1) * 1000);
            }
            // 100ms was not enough and the failure mode was a FALSE GREEN.
            // /admin/users issues one avatar request per listed user, and four
            // of them 404 (see F6) — that was caught on one run and missed on
            // the next, purely because the requests landed after the assertion
            // window had closed. `networkidle` is not available as a substitute
            // here: the app holds a watch-state SSE stream open, so it never
            // fires. A fixed, more generous settle window is the pragmatic
            // answer; the residual risk is an error arriving even later, which
            // is why console assertions are a floor on this tier, not a proof.
            const baseURL = testInfo.project.use.baseURL;
            if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.');
            const requested = new URL(url, baseURL).toString();
            const landed = page.url();
            const landedPath = new URL(landed).pathname;
            const requestedPath = new URL(requested).pathname;

            // A route that moved the browser somewhere else is not automatically
            // broken. Three redirects here are the application behaving
            // correctly, and asserting a bare URL equality reported all three as
            // failures on the first live run:
            //
            //  - /admin/developer/* -> /admin when config.SHOW_DEVELOPER_TOOLS is
            //    off (src/routes/admin/developer/+layout.server.ts). Deployment
            //    configuration, not a defect: recorded BLOCKED so the row says
            //    "not exercised here" rather than "broken".
            //  - /login and /setup -> / for a caller who is ALREADY an admin.
            //    /setup redirects as soon as an admin exists, which
            //    00-onboarding.ui.spec.ts documents; the sweep always runs
            //    authenticated, so this is the only possible outcome.
            //  - a nonexistent id redirecting to its own list page (e.g.
            //    /admin/courses/<missing> -> /admin/courses). Degrading to the
            //    collection is a reasonable answer to a missing row, and is
            //    strictly better than the 500 this sweep exists to hunt.
            if (landed !== requested) {
                const gatedToAdminRoot =
                    requestedPath.startsWith('/admin/') && landedPath === '/admin';
                const authStateRedirect =
                    (requestedPath === '/login' ||
                        requestedPath === '/setup' ||
                        // /setup/locked is shown only while no admin can be found;
                        // with an admin (always the case here) its load sends home.
                        requestedPath === '/setup/locked') &&
                    landedPath === '/';
                // /settings is the section list on phones; on desktop its layout
                // client-redirects to the first section (settings/+page.ts).
                // /logout ends the session with a hard client-side redirect on mount
                // (logout/+page.svelte), so where the browser is after the settle
                // window depends on timing: still /logout, or already home/login.
                const logoutRedirect =
                    requestedPath === '/logout' && (landedPath === '/' || landedPath === '/login');
                const settingsRootRedirect =
                    requestedPath === '/settings' && landedPath.startsWith('/settings/');
                const gracefulParentRedirect =
                    routeCase.variant === 'nonexistent' && requestedPath.startsWith(landedPath);

                if (gatedToAdminRoot) {
                    testInfo.annotations.push({
                        type: 'BLOCKED',
                        description: `config-gated: ${requestedPath} redirected to ${landedPath} (SHOW_DEVELOPER_TOOLS or equivalent is off on this target)`,
                    });
                    continue;
                }
                // A 307/308 is an EXPLICIT, method-preserving redirect: the route
                // exists purely to forward somewhere else. /browse/az and
                // /browse/filter both do this (`307 -> /browse?...&mode=az`), and
                // each has its own unit test pinning that exact target, so
                // failing them here was a false red on designed behaviour.
                const chainStatuses: number[] = [];
                for (let r = response?.request().redirectedFrom(); r; r = r.redirectedFrom()) {
                    const prior = await r.response();
                    if (prior) chainStatuses.push(prior.status());
                }
                const explicitAlias = chainStatuses.some((code) => code === 307 || code === 308);

                if (explicitAlias) {
                    testInfo.annotations.push({
                        type: 'OBSERVED',
                        description: `route alias: ${requestedPath} -> ${landedPath} (${chainStatuses.join(',')})`,
                    });
                } else if (
                    !authStateRedirect &&
                    !gracefulParentRedirect &&
                    !settingsRootRedirect &&
                    !logoutRedirect
                ) {
                    expect(landed, `unexpected redirect from ${requestedPath}`).toBe(requested);
                }
            }

            // On the nonexistent variant the page is SUPPOSED to ask for a row
            // that is not there, so a 404 in the console is the test working
            // rather than a defect. Only non-404 console errors matter here --
            // which is where a missing Paraglide key (a runtime crash in this
            // app) would still surface.
            //
            // Chromium's "Failed to load resource" message carries no URL, so the
            // expected-absent image 404s counted above are subtracted one for one:
            // a SECOND 404 from anything else on the page still fails.
            let remainingExpected = expectedAbsentImages;
            const withoutExpectedImages = consoleErrors.filter((text) => {
                if (remainingExpected > 0 && /Failed to load resource.*\b404\b/.test(text)) {
                    remainingExpected--;
                    return false;
                }
                return true;
            });
            const meaningfulConsoleErrors =
                routeCase.variant === 'nonexistent'
                    ? withoutExpectedImages.filter((text) => !/\b404\b/.test(text))
                    : withoutExpectedImages;
            expect(meaningfulConsoleErrors, 'console errors').toEqual([]);
            expect(failedRequests, 'failed requests and 5xx responses').toEqual([]);

            const isExpectedPublicAbsence = build === 'public' && !routeCase.page.inPublicBuild;
            if (isExpectedPublicAbsence) {
                expect(response?.status()).toBe(404);
            } else {
                expect(response?.status()).not.toBeGreaterThanOrEqual(500);
                await expectHydrated(page);
                // `.first()`: several pages nest a second <main> inside the shell
                // one, and a bare locator('main') is a strict-mode violation that
                // fails before it can assert anything. Two <main> elements is
                // itself a (minor) markup defect -- recorded in the internal
                // route-sweep findings, not asserted here.
                await expect(page.locator('main').first()).not.toBeEmpty();
                // A missing row may answer 404 or degrade to its parent; both are
                // acceptable. The failure this variant hunts is a 5xx, already
                // asserted above.
            }

            // Page titles are intentionally not asserted: SSR titles are missing
            // on 89 known admin/music routes, a user-invisible defect tracked
            // separately; asserting them would drown the reachability findings.
            await page.screenshot({
                path: testInfo.outputPath(`route-${index}.png`),
                fullPage: true,
            });
        }
    });
}

function readInventory(): Inventory {
    const path = new URL('./inventory.generated.json', import.meta.url);
    return JSON.parse(readFileSync(path, 'utf8')) as Inventory;
}

function buildRoutes(
    routeCase: RouteCase,
    fixtures: ResolvedParamFixtures,
): { urls: string[]; blockedReason?: string } {
    let url = routeCase.page.url;
    const routeFixtures = fixtures.routes[routeCase.page.routeId];
    for (const param of routeCase.page.params) {
        const fixture: ParamFixture | undefined = routeFixtures?.[param.name];
        const value = fixture?.[routeCase.variant];
        if (value === null || value === undefined) {
            return {
                urls: [url],
                blockedReason: `${routeCase.page.routeId} ${param.name} valid fixture unresolved`,
            };
        }
        url = url.replace(`[${param.name}]`, encodeURIComponent(value));
    }
    if (
        routeCase.variant === 'valid' &&
        routeCase.page.params.some((param) => param.name === 'symptom')
    ) {
        return {
            urls: VALID_SYMPTOMS.map((symptom) => routeCase.page.url.replace('[symptom]', symptom)),
        };
    }
    if (
        routeCase.variant === 'valid' &&
        routeCase.page.params.some((param) => param.name === 'libraryType')
    ) {
        return {
            urls: (fixtures.libraryTypes.length > 0 ? fixtures.libraryTypes : [url]).map(
                (libraryType) =>
                    routeCase.page.url.replace('[libraryType]', encodeURIComponent(libraryType)),
            ),
        };
    }
    return { urls: [url] };
}
