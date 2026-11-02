// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Does the app hydrate at all?
 *
 * This exists because of what the first-ever `ui` run reported (e2e run 14):
 * 24 failures that looked like 24 unrelated product bugs — a missing settings
 * redirect, a deck that never filled, a mini-player that never appeared, a
 * histogram with no bars — and every one of them needed client-side JavaScript
 * to have run. The one test in a failing file that asserted only SSR-rendered
 * markup (`rate-trainer` › "renders the title") passed.
 *
 * A whole tier failing for one reason should say so ONCE, in a test named after
 * the reason. Triaging it as two dozen separate findings is how a session gets
 * spent on symptoms.
 *
 * `#svelte-announcer` is the marker because it is not ours: SvelteKit's
 * generated root renders it under `{#if mounted}`, so it cannot exist until
 * onMount has run on the client. It is stable across the framework's versions
 * in a way that any app-specific element is not.
 *
 * The generous timeout is deliberate and is the second half of the diagnosis.
 * The dev server Playwright starts compiles on demand, so a cold client module
 * graph is genuinely slow — and "hydration is slow" and "hydration never
 * happens" are different bugs with different fixes. The elapsed time is
 * printed on success for exactly that reason; if this passes at 25s while
 * specs asserting at 5s fail, the answer is the server, not the client.
 */

import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';
import { withoutNetworkChangeErrors } from './helpers/network-changes';

const HYDRATION_BUDGET_MS = 60_000;

test('the app hydrates on the client', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    // SSR first, so a failure here is attributed to the server rather than
    // being reported as a hydration problem.
    await expect(page.locator('main, body')).not.toHaveCount(0);

    const started = Date.now();
    try {
        await expectHydrated(page, HYDRATION_BUDGET_MS);
    } catch (error) {
        if (test.info().expectedStatus === 'skipped') throw error;
        const errors = [
            pageErrors.length ? `pageerror: ${pageErrors.slice(0, 5).join(' | ')}` : null,
            consoleErrors.length ? `console.error: ${consoleErrors.slice(0, 5).join(' | ')}` : null,
        ].filter(Boolean);

        throw new Error(
            `The client never hydrated within ${HYDRATION_BUDGET_MS} ms: SvelteKit's ` +
                '#svelte-announcer (rendered only under {#if mounted}) never appeared, ' +
                'so onMount did not run. Every *.ui spec that clicks, evaluates, or ' +
                'waits on a client store depends on this and will fail for reasons ' +
                'that look unrelated.\n' +
                (errors.length
                    ? errors.join('\n')
                    : 'The page reported NO console errors and NO uncaught exceptions, ' +
                      'so the client bundle most likely never executed at all (it was ' +
                      'not served, not parsed, or still compiling) rather than throwing.'),
            { cause: error },
        );
    }

    // Printed, not asserted: this is the number that separates "slow" from
    // "broken", and a threshold here would just be a flake on a cold runner.
    console.log(`[hydration] #svelte-announcer attached after ${Date.now() - started} ms`);
});

/**
 * Regression guard for the dev-server race that produced the CI-only UI
 * failures.
 *
 * SvelteKit's dev boot script fires TWO dynamic imports in parallel: the kit
 * runtime entry and the generated `app.js`. In dev, Vite does not text-replace
 * `define` values in client modules; `/@vite/env` installs them as globals
 * instead, and it is reached through the HMR import Vite injects into modules
 * that use `import.meta.hot`. The kit entry graph has that import first. Before
 * @sveltejs/kit 2.66.0 the generated `app.js` did NOT, and its graph reaches
 * `$app/paths` through `src/hooks.client.ts` → `api-urls.ts`, whose top level
 * reads `__SVELTEKIT_PAYLOAD__`. Whichever graph finishes loading first
 * evaluates that module — so when the entry module was the slowest response
 * on a loaded runner, the page threw `ReferenceError: __SVELTEKIT_PAYLOAD__ is
 * not defined`, the client never started, and every spec needing client JS
 * timed out. Measured: 3 of 8 cold loads in the CI container.
 *
 * Delaying the entry module makes that ordering deterministic: 2/2 failures at
 * kit 2.55.0, 0/3 at 2.70.3, where `app.js` references `import.meta.hot` so
 * its graph goes through `/@vite/env` first. This test pins the fixed
 * behaviour so a lockfile regression cannot bring the race back unnoticed.
 * Against a production build the route pattern matches nothing and the test
 * reduces to a plain hydration check, which is still correct.
 */
test('the app hydrates even when the kit entry module is the slowest to arrive', async ({
    page,
}) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.route('**/runtime/client/entry.js', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await route.continue();
    });

    await page.goto('/');
    await expectHydrated(page, HYDRATION_BUDGET_MS);
    expect(
        withoutNetworkChangeErrors(page, pageErrors),
        'no uncaught exception while the entry graph was delayed',
    ).toEqual([]);
});
