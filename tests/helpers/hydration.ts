// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wait until the client has actually hydrated.
 *
 * Every `.ui` spec that drives a control, or reads state a `$effect` writes,
 * needs this. Waiting for a heading or a nav landmark does NOT do it: those are
 * server-rendered, so they are visible long before `onMount` runs. A spec that
 * waits on SSR markup and then clicks is asserting against a page whose
 * handlers are not attached yet — Playwright clicks the element, nothing
 * happens, and the failure reads like a dead button or a missing redirect.
 *
 * Three specs failed exactly that way and were triaged as product bugs before
 * this helper existed (settings "close button leaves the overlay", the footer
 * avatar popup, and the MiniPlayer offset var, which reads `0px` pre-hydration
 * and `calc(3.5rem + 0px)` after).
 *
 * `#svelte-announcer` is the marker for the reason `00-hydration.ui.spec.ts`
 * gives: SvelteKit's generated root renders it under `{#if mounted}`, so it
 * cannot exist before `onMount`, and it is not ours to accidentally rename.
 *
 * The budget is generous because the dev server Playwright starts compiles
 * routes on demand — a cold client module graph on a container runner is
 * genuinely slow (measured: 2.5s warm, ~9s cold on the `/rate` graph).
 */

import { expect, test, type Page } from '@playwright/test';

import { networkQuarantineReason } from './network-changes';

/** Default budget for a cold client module graph on the on-demand dev server. */
export const HYDRATION_TIMEOUT_MS = 30_000;

export async function expectHydrated(
    page: Page,
    timeout: number = HYDRATION_TIMEOUT_MS,
): Promise<void> {
    let quarantine: string | undefined;
    await expect
        .poll(
            async () => {
                if (
                    (await page.locator('#svelte-announcer').count()) &&
                    !(await page.locator('.error-container.server-error').count())
                )
                    return true;
                if (process.env.PLAYWRIGHT_ENVIRONMENT_QUARANTINE === '1') {
                    quarantine = networkQuarantineReason(page);
                }
                return Boolean(quarantine);
            },
            { timeout, message: 'Client hydration marker #svelte-announcer must attach' },
        )
        .toBe(true);
    if (quarantine) {
        test.info().annotations.push({ type: 'environment-quarantine', description: quarantine });
        test.skip(true, quarantine);
    }
}
