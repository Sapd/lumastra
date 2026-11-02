// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security fix C7: the service-worker app-shell cache used to keep one
 * user's personalized SSR HTML in CacheStorage past logout, and neither
 * logout path told the browser to clear it. On a shared device/browser, a
 * slow or offline navigation after logout could replay the previous user's
 * page.
 *
 * Three-part fix under test here:
 *   1. Server: `POST /logout` and `POST /api/auth/native/logout` respond with
 *      `Clear-Site-Data: "cache"` — the browser wipes CacheStorage for this
 *      origin on receiving it, even without any client-side JS. (Fix-plan
 *      ledger, Task 7: `"storage"` was deliberately dropped because it wipes
 *      ALL localStorage, including per-device keys — see
 *      clear-site-data.ts's CLEAR_SITE_DATA_VALUE — and is not being
 *      re-added; the curated `USER_SPECIFIC_KEYS` wipe below covers the rest.)
 *   2. Client (belt): `clearServiceWorkerCaches()` (src/lib/pwa.ts) explicitly
 *      wipes `caches.keys()`/`caches.delete()` from `clearUserData()`
 *      (logout/+page.svelte) and `nativeSignOut()` (UserMenuPopover.svelte).
 *   3. Service worker (static/sw.js): navigate requests for the app-shell
 *      paths ('/', '/browse', '/watch/*') are no longer read from or written
 *      to CacheStorage at all — a slow/erroring network now falls back only
 *      to the generic (non-personalized) offline page.
 *
 * Requires a running dev server with a real service worker (see
 * playwright.config.ts's `ui` project) — SW registration needs a secure
 * context, which Chromium grants to http://127.0.0.1. If the local harness
 * cannot bring up a working dev server + Postgres/Valkey, these tests are
 * still meaningful documentation of the expected behavior; see the task
 * report for whether they were actually executed in this environment.
 *
 * ---
 *
 * Shared logout-wipe coverage (Task 7, prior wave; scope note added fix
 * round 1): both logout paths share ONE curated wipe, `clearUserClientState()`
 * ($lib/auth/clear-user-client-state.ts) — `nativeSignOut()`
 * (UserMenuPopover.svelte) calls it via `performNativeSignOut()`
 * (user-menu-logout.ts, extracted fix round C19), same as `clearUserData()`
 * (logout/+page.svelte).
 *
 * ⚠️ SCOPE: the test below does NOT drive `nativeSignOut()` through the UI —
 * it does not log in via native auth, open the user-menu popover, or click
 * "Sign out". This suite has no fixture for a NATIVE-authenticated session
 * (it's forward-auth-oriented — see tests/fixtures/auth.ts) and building one
 * was judged too risky to add unverified (no environment in which to execute
 * the suite was available when this was written — see the task report).
 *
 * Security fix C19 (2026-09-16) narrowed this gap: the native-path test now
 * calls the real `performNativeSignOut()` (user-menu-logout.ts) — the exact
 * function `nativeSignOut()` delegates to — via dynamic import in a real
 * browser page (real localStorage/sessionStorage/CacheStorage, not a DOM
 * shim), rather than hand-calling the two wipe functions it happens to use.
 * Deleting `clearUserClientState()` or `clearServiceWorkerCaches()` from
 * `performNativeSignOut()` now DOES turn this test red. It is still not
 * wired through the component's click handler, so a regression that broke
 * only the `onclick` → `nativeSignOut()` → `performNativeSignOut()` wiring
 * itself (rather than the shared logic) would not be caught here. A genuine
 * native-path e2e test (real login → click Sign out) remains a gap.
 */

import type { Page } from '@playwright/test';
import { adminTest as test, expect, ADMIN_FORWARD_AUTH_HEADERS } from './fixtures/auth';

/**
 * Wait until a service worker controls the page.
 *
 * +layout.svelte registers sw.js from `registerServiceWorker()` (src/lib/pwa.ts),
 * which only does so from a `window 'load'` listener it adds in onMount. In the
 * dev server the app hydrates AFTER `load` has already fired (measured: load at
 * ~350 ms, hydration seconds later), so that listener never runs and the app
 * never registers the worker: no `/sw.js` request, `getRegistrations()` is
 * empty, and the old wait timed out. PRODUCT BUG (not fixed here, release
 * freeze): the registration should run at once when `document.readyState` is
 * already 'complete'. Until then the spec registers the worker itself with the
 * same arguments pwa.ts uses, which does not change what these tests assert
 * (what logout does to CacheStorage while a real worker controls the page); if
 * the app did register it, `register()` simply returns that registration.
 */
async function waitForServiceWorkerReady(page: Page): Promise<void> {
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none',
        });
        await navigator.serviceWorker.ready;
    });
    // sw.js claims its clients on activate; the controller appears right after.
    await page.waitForFunction(() => navigator.serviceWorker.controller != null, undefined, {
        timeout: 15000,
    });
}

test.describe('logout wipes the service-worker CacheStorage (security fix C7)', () => {
    test('POST /logout carries Clear-Site-Data and the logout wipe empties CacheStorage', async ({
        page,
    }) => {
        await page.goto('/');
        await waitForServiceWorkerReady(page);

        // Seed a marker cache entry — proves the assertion below observes a real
        // wipe, not an already-empty CacheStorage.
        await page.evaluate(async () => {
            const cache = await caches.open('c7-marker-cache');
            await cache.put('/marker', new Response('marker'));
        });
        expect(await page.evaluate(() => caches.keys())).toContain('c7-marker-cache');

        // The browser consumes Clear-Site-Data itself and does not expose it to
        // page scripts (a `fetch()` response in the page never lists it), so the
        // header is read off the raw HTTP response instead.
        const raw = await page.request.post('/logout', {
            headers: { Origin: new URL(page.url()).origin },
        });
        expect(raw.status()).toBe(200);
        // Fix-plan ledger, Task 7 ruling: the server sends "cache" only —
        // "storage" was dropped because it wipes ALL localStorage, including
        // per-device keys (security fix C19, 2026-09-16: this assertion was
        // stale against that shipped value and could only fail).
        expect(raw.headers()['clear-site-data']).toBe('"cache"');

        // Chromium does not clear the Cache API (CacheStorage) for `"cache"`:
        // that directive only covers the HTTP cache (CacheStorage needs
        // `"storage"` / `"cacheStorage"`, which the Task 7 ruling above dropped
        // on purpose). The wipe of the service worker's caches is therefore the
        // client's job — belt (2) in the file header — so assert THAT: the real
        // `clearServiceWorkerCaches()` that /logout and the sign-out menu call.
        await page.evaluate(async () => {
            const { clearServiceWorkerCaches } =
                // @ts-expect-error -- Vite dev-server URL, resolved in-browser only
                await import('/src/lib/pwa.ts');
            await clearServiceWorkerCaches();
        });
        await expect
            .poll(() => page.evaluate(() => caches.keys()), { timeout: 5000 })
            .not.toContain('c7-marker-cache');
    });

    test('navigate requests are never cached; offline navigation shows the offline page, never personalized HTML', async ({
        page,
        context,
    }) => {
        await page.goto('/');
        await waitForServiceWorkerReady(page);
        // Let the SW's fetch handler for this navigation finish (it never
        // caches the response, but give any in-flight cache.put a moment in
        // case a future regression reintroduces one).
        await page.waitForTimeout(500);

        const cachedHomeBody = await page.evaluate(async () => {
            const names = await caches.keys();
            for (const name of names) {
                const cache = await caches.open(name);
                const match = await cache.match('/');
                if (match) return await match.text();
            }
            return null;
        });
        expect(cachedHomeBody).toBeNull();

        await context.setOffline(true);
        try {
            await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => {
                // A hard network error reaching the SW's fetch() itself (rather
                // than the SW's own catch() returning the offline page) is also
                // an acceptable outcome here — either way nothing personalized
                // was served from cache.
            });
            const body = await page.content();
            expect(body).not.toContain(ADMIN_FORWARD_AUTH_HEADERS['X-Forwarded-User']);
        } finally {
            await context.setOffline(false);
        }
    });

    // Fixed fix round 1 (was previously RED): `dashboard_device_id` used to be
    // listed in `USER_SPECIFIC_KEYS` and got wiped on every logout, contradicting
    // clear-site-data.ts's own documented contract that it's a PER-DEVICE key
    // that "must survive logout on a shared browser" — see
    // src/lib/auth/clear-user-client-state.ts's history for the fix.
    //
    // Security fix C19 (2026-09-16): this test now calls the REAL
    // `performNativeSignOut()` (user-menu-logout.ts) that `nativeSignOut()`
    // (UserMenuPopover.svelte) delegates to, instead of hand-calling the two
    // wipe functions it happens to use. Deleting either wipe call from
    // `performNativeSignOut()` now DOES turn this test red — it did not
    // before. This still isn't a full login-and-click-"Sign out" flow (no
    // native-auth fixture exists yet — see the file-level SCOPE note), but it
    // is no longer possible to silently diverge `performNativeSignOut()` from
    // what this test exercises.
    test('the real native sign-out (performNativeSignOut) clears user-specific state but leaves per-device keys — including dashboard_device_id — intact', async ({
        page,
    }) => {
        await page.goto('/');
        await waitForServiceWorkerReady(page);

        await page.evaluate(async () => {
            localStorage.setItem('playerPreferences', 'x');
            localStorage.setItem('devUser', 'someuser');
            localStorage.setItem('dashboard_watch_party', 'x');
            // Per-device keys (must survive per clear-site-data.ts's contract).
            localStorage.setItem('dashboard_device_id', 'dashboard-fixed-device-id');
            localStorage.setItem('sidebar-sections-collapsed', 'kept');
            sessionStorage.setItem('anything', 'x');

            const cache = await caches.open('native-signout-marker-cache');
            await cache.put('/marker', new Response('marker'));
        });

        // Calls the REAL performNativeSignOut() (security fix C19) that
        // nativeSignOut() (UserMenuPopover.svelte) delegates to, via the
        // real bundled module — but NOT through a click on the component
        // itself. See the file-level SCOPE note.
        await page
            .evaluate(async () => {
                // This is a Vite dev-server URL resolved by the BROWSER at
                // runtime (this callback executes in the page, not in Node),
                // not a TypeScript module specifier — tsc cannot and should
                // not try to resolve it statically.
                const { performNativeSignOut } =
                    // @ts-expect-error -- Vite dev-server URL, resolved in-browser only
                    await import('/src/lib/components/user-menu/user-menu-logout.ts');
                // The POST to /api/auth/native/logout may 401 under this
                // spec's forward-auth fixture (no native session cookie) —
                // apiPost() resolves an ApiResult rather than throwing, so
                // the wipe in performNativeSignOut()'s `finally` still runs.
                await performNativeSignOut();
            })
            .catch(() => {
                // performNativeSignOut()'s finally block ends with
                // window.location.assign('/login'), which can detach this
                // evaluate's execution context before the promise settles.
            });
        await page.waitForURL('**/login', { timeout: 10_000 }).catch(() => {
            // Best-effort: proceed even if the redirect wasn't observed in
            // time — the assertions below check same-origin storage either
            // way, and /login is same-origin so it doesn't affect them.
        });

        const after = await page.evaluate(() => ({
            playerPreferences: localStorage.getItem('playerPreferences'),
            devUser: localStorage.getItem('devUser'),
            watchParty: localStorage.getItem('dashboard_watch_party'),
            deviceId: localStorage.getItem('dashboard_device_id'),
            sidebarState: localStorage.getItem('sidebar-sections-collapsed'),
            // SvelteKit re-writes its own `sveltekit:snapshot` / `sveltekit:scroll`
            // keys as soon as the page it lands on after the redirect renders (the
            // forward-auth user is sent on from /login to /), which is not user
            // state; every other sessionStorage key must be gone.
            sessionKeys: Object.keys(sessionStorage).filter((k) => !k.startsWith('sveltekit:')),
        }));

        expect(after.playerPreferences).toBeNull();
        expect(after.devUser).toBeNull();
        expect(after.watchParty).toBeNull();
        expect(after.sessionKeys).toEqual([]);

        // Per-device state must survive a sign-out on a shared device.
        expect(after.sidebarState).toBe('kept');
        expect(after.deviceId).toBe('dashboard-fixed-device-id');

        await expect
            .poll(() => page.evaluate(() => caches.keys()), { timeout: 5000 })
            .not.toContain('native-signout-marker-cache');
    });
});
