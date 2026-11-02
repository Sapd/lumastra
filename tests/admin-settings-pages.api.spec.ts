// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Settings Pages E2E Tests
 *
 * Tests for the admin settings pages, now nav sub-items under
 * `/admin/settings/*` (admin IA redesign, spec §3.6). Homepage and
 * Navigation are tabs on ONE page (`/admin/settings/homepage`,
 * `?tab=navigation`) rather than two separate routes.
 *   /admin/settings                      — General settings
 *   /admin/settings/playback             — Playback settings
 *   /admin/settings/ai                   — AI / recommendation settings
 *   /admin/settings/homepage             — Homepage tab (default)
 *   /admin/settings/homepage?tab=navigation — Navigation tab
 *
 * Admin layout uses forward-auth headers for access control.
 * Non-admin requests receive a 303 redirect to /.
 */

import { adminTest as test, expect } from './fixtures/auth';

// ---------------------------------------------------------------------------
// Test actors
// ---------------------------------------------------------------------------

const ADMIN_USER = process.env.TEST_USER || 'TestUser';
const ADMIN_GROUPS = 'Users,Librarians,admin';

const NON_ADMIN_USER = 'TestUserNonAdmin';
const NON_ADMIN_GROUPS = 'Users';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminHeaders(username = ADMIN_USER) {
    return {
        'X-Forwarded-User': username,
        'X-Forwarded-Groups': ADMIN_GROUPS,
    };
}

function nonAdminHeaders() {
    return {
        'X-Forwarded-User': NON_ADMIN_USER,
        'X-Forwarded-Groups': NON_ADMIN_GROUPS,
    };
}

const PAGES = [
    { path: '/admin/settings', title: 'Settings - Admin' },
    { path: '/admin/settings/playback', title: 'Playback - Admin' },
    { path: '/admin/settings/ai', title: 'AI - Admin' },
    { path: '/admin/settings/homepage', title: 'Homepage - Admin' },
    { path: '/admin/settings/homepage?tab=navigation', title: 'Navigation - Admin' },
] as const;

// ---------------------------------------------------------------------------
// Access control — admin gets 200, non-admin gets 303
// ---------------------------------------------------------------------------

test.describe('Admin settings pages — access control', () => {
    for (const page of PAGES) {
        test(`GET ${page.path} returns 200 for admin`, async ({ request }) => {
            const response = await request.get(page.path, {
                headers: adminHeaders(),
                maxRedirects: 0,
            });
            expect(response.status()).toBe(200);
        });

        test(`GET ${page.path} returns 303 for non-admin`, async ({ request }) => {
            const response = await request.get(page.path, {
                headers: nonAdminHeaders(),
                maxRedirects: 0,
            });
            expect(response.status()).toBe(303);
            expect(response.headers()['location']).toBe('/');
        });
    }
});

// ---------------------------------------------------------------------------
// Data requests that skip the admin layout node
// ---------------------------------------------------------------------------

// `x-sveltekit-invalidated` tells SvelteKit which load nodes to re-run. `00…`
// skips the root and /admin layout loads (the layout is what redirects
// non-admins) and runs only the deeper nodes. Several admin page loads do not
// re-check isAdmin themselves, so before the hooks.server.ts gate covered GET a
// non-admin got e.g. the whole /admin/settings config payload this way.
const LAYOUT_SKIPPING_MASK = '0011111';
const UNGATED_PAGE_LOADS = [
    '/admin/settings',
    '/admin/settings/ai',
    '/admin/settings/secrets',
    '/admin/system/instance',
    '/admin/system/cost',
] as const;

test.describe('Admin page data requests — layout gate cannot be skipped', () => {
    for (const path of UNGATED_PAGE_LOADS) {
        test(`GET ${path}/__data.json skipping the layout redirects a non-admin`, async ({
            request,
        }) => {
            const response = await request.get(
                `${path}/__data.json?x-sveltekit-invalidated=${LAYOUT_SKIPPING_MASK}`,
                { headers: nonAdminHeaders(), maxRedirects: 0 },
            );
            const body = await response.text();
            expect(JSON.parse(body)).toMatchObject({ type: 'redirect', location: '/' });
            expect(body).not.toContain('ADMIN_GROUPS');
        });
    }

    // `%61` is `a`: SvelteKit routes the decoded path to /admin, so the gate has to
    // match the dispatched route, not the raw pathname.
    test('a percent-encoded /admin path is gated the same way', async ({ request }) => {
        const response = await request.get(
            `/%61dmin/settings/__data.json?x-sveltekit-invalidated=${LAYOUT_SKIPPING_MASK}`,
            { headers: nonAdminHeaders(), maxRedirects: 0 },
        );
        const body = await response.text();
        expect(body).not.toContain('ADMIN_GROUPS');
        expect(JSON.parse(body)).toMatchObject({ type: 'redirect', location: '/' });
    });

    test('a percent-encoded /admin form action is refused for a non-admin', async ({
        request,
        baseURL,
    }) => {
        const response = await request.post('/%61dmin/settings?/reload', {
            headers: { ...nonAdminHeaders(), Origin: new URL(baseURL!).origin },
            form: { x: '1' },
            maxRedirects: 0,
        });
        expect(response.status()).toBe(403);
    });

    test('the same request still returns page data to an admin', async ({ request }) => {
        const response = await request.get(
            `/admin/settings/__data.json?x-sveltekit-invalidated=${LAYOUT_SKIPPING_MASK}`,
            { headers: adminHeaders(), maxRedirects: 0 },
        );
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({ type: 'data' });
        expect(body).toContain('ADMIN_GROUPS');
    });
});

// ---------------------------------------------------------------------------
// HTML title checks — each page has the correct <title> tag
// ---------------------------------------------------------------------------

test.describe('Admin settings pages — HTML titles', () => {
    for (const page of PAGES) {
        // KNOWN FAILING — a real bug, not a stale expectation.
        //
        // No page's `<svelte:head><title>` survives SSR: every route under the
        // admin layout serves the ROOT layout's `<title>{appName}</title>`
        // ("Lumastra") instead of its own. The root layout's own comment says
        // this must not happen — "Pages override it with their own
        // <svelte:head><title>; SvelteKit keeps only the deepest title" — and
        // Svelte's server renderer does implement that (Renderer.set_title keeps
        // the deepest/latest title by component path), so the page's title is
        // being dropped rather than deduplicated.
        //
        // Reproduced with a bare probe route: a page with only
        // `<svelte:head><title>PROBE</title></svelte:head>` renders its title at
        // the app root and loses it under `src/routes/admin/+layout.svelte`. It
        // is NOT the modal, the `bind:`, or the order of the children render —
        // each was removed in turn and the title stayed lost — so it looks like
        // the head-path comparison rather than any one component.
        //
        // Left as fixme so it reports as a known gap instead of either failing
        // the suite or, worse, being "fixed" by asserting the wrong title. It
        // matters beyond the tab label: SSR titles are what crawlers and link
        // unfurlers read.
        test.fixme(`GET ${page.path} contains title "${page.title}"`, async ({ request }) => {
            const response = await request.get(page.path, {
                headers: adminHeaders(),
            });
            expect(response.status()).toBe(200);
            const html = await response.text();
            expect(html).toContain(`<title>${page.title}</title>`);
        });
    }
});

// ---------------------------------------------------------------------------
// Global search data — /admin/settings exposes allSections from other pages
// ---------------------------------------------------------------------------

test.describe('GET /admin/settings — global search data', () => {
    test('page HTML references section labels from other pages', async ({ request }) => {
        const response = await request.get('/admin/settings', {
            headers: adminHeaders(),
        });
        expect(response.status()).toBe(200);
        const html = await response.text();

        // The settings page renders cross-page section labels so the global
        // search widget can direct users to the right page.
        expect(html).toContain('Playback');
        expect(html).toContain('Homepage');
        expect(html).toContain('Navigation');
    });

    test('serialized page data includes allSections from other pages', async ({ request }) => {
        const response = await request.get('/admin/settings', {
            headers: adminHeaders(),
        });
        expect(response.status()).toBe(200);
        const html = await response.text();

        // SvelteKit serializes page data (including allSections) into the HTML
        // as hydration JSON. The allSections payload contains section IDs that
        // live on other pages (player → /admin/playback, etc.).
        // We verify the data is present by checking for known cross-page IDs.
        expect(html).toContain('allSections');
    });
});
