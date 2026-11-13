// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * First-Run Onboarding / Setup Wizard — UI Tests
 *
 * Drives the /setup wizard on a fresh (no-admin) Lumastra instance.
 *
 * FILE NAMING — the "00-" numeric prefix ensures Playwright sorts and runs
 * this spec BEFORE all alphabetically-named specs (music-*,
 * settings-*, …). On a fresh instance /setup blocks every other route; if the
 * other specs were to run first they would all 302 to /setup and fail. Running
 * this spec first completes onboarding so the rest of the suite can proceed
 * normally.
 *
 * DETECTION — /setup's page.server.ts issues redirect(303, '/') as soon as an
 * admin exists. The test navigates to /setup and checks the final URL: if the
 * browser was redirected away the instance is already configured, and the whole
 * describe block is skipped cleanly. This keeps the spec green on an already-
 * configured local dev server or pre-prod instance.
 *
 * WIZARD PATH — this spec uses the NATIVE admin creation path (step 2b) because
 * it is the most portable: it requires no reverse-proxy / forward-auth headers
 * and no OIDC provider, so it works on a bare Windows demo box as well as on
 * any CI environment that starts the dev server fresh.
 *
 * PRESET ASSERTION — the training use-case is selected on step 3 (the VOD
 * default is deselected and training toggled on). After finishSetup() the app
 * navigates to /admin/library. We then verify via the root layout __data.json
 * that primaryMode === TRAINING_USE_CASE, confirming the instance-profile POST was
 * applied and persisted.
 *
 * Pre-conditions:
 *   - Dev server running at http://127.0.0.1:5173 (fresh, NO admin in DB).
 *   - OR: instance already configured → entire suite is skipped (green).
 */

import { adminTest as test, expect } from './fixtures/auth';
import type { Page } from '@playwright/test';
import { TRAINING_USE_CASE } from '../src/lib/config/use-case-ids';

// Unique enough to avoid collisions with any real account.
const SETUP_USERNAME = 'e2e_setup_admin';
// Meets the PASSWORD_MIN_LENGTH + acceptable-strength requirements.
// (≥ 10 chars, mixed case, digit, symbol)
const SETUP_PASSWORD = 'E2eSetup!99';

/**
 * Probe whether /setup is live (fresh instance) or redirects away (configured).
 * Returns true when the wizard is shown.
 */
async function isSetupFresh(page: Page): Promise<boolean> {
    // Use maxRedirects: 0 is not available for page.goto; instead navigate and
    // check where we ended up. SvelteKit's redirect(303, '/') is followed by the
    // browser automatically, so a configured instance lands on a non-/setup URL.
    await page.goto('/setup', { waitUntil: 'domcontentloaded' });
    return page.url().includes('/setup');
}

/**
 * Open /setup and pass the "Check your install" overview step, which opens the
 * wizard once per tab (new browser context per test, so every test sees it).
 * Ends on the sign-in method step.
 */
async function openSignInStep(page: Page): Promise<void> {
    await page.goto('/setup', { waitUntil: 'domcontentloaded' });
    const installHeading = page.getByRole('heading', { level: 1, name: /check your install/i });
    await expect(installHeading).toBeVisible({ timeout: 5000 });
    // The server-rendered button is visible before hydration wires its click
    // handler (slow on a cold dev server), so retry until the step changes.
    await expect(async () => {
        await page.getByRole('button', { name: /continue/i }).click();
        await expect(page.locator('button.setup-choice').first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
}

test.describe('onboarding: first-run setup wizard', () => {
    // ─── Skip entire suite when the instance is already configured ───────────
    test.beforeEach(async ({ page }) => {
        const fresh = await isSetupFresh(page);
        if (!fresh) {
            test.skip(
                true,
                'instance already set up — onboarding tests only run on a fresh instance',
            );
        }
    });

    // ─── Step 1: wizard renders ───────────────────────────────────────────────
    test('step 1: /setup renders the wizard card', async ({ page }) => {
        // The wizard opens on the install overview, then the sign-in step.
        await openSignInStep(page);

        // The wizard root element is always present on a fresh instance.
        await expect(page.locator('.setup-card')).toBeVisible({ timeout: 5000 });

        // Step 1 offers auth-method choice cards; the native "Built-in" option
        // must be present so the spec can select it.
        const nativeCard = page.locator('button.setup-choice', { hasText: /built.in/i });
        await expect(nativeCard).toBeVisible({ timeout: 5000 });

        // The stepper shows "1" as the active dot.
        const activeDot = page.locator('.setup-dot.is-active');
        await expect(activeDot).toHaveCount(1);
    });

    // ─── Step 1 → 2B: select native and advance ───────────────────────────────
    test('step 2b: clicking Built-in advances to the admin-creation form', async ({ page }) => {
        await openSignInStep(page);

        // Select the native / built-in method card.
        const nativeCard = page.locator('button.setup-choice', { hasText: /built.in/i });
        await nativeCard.click();
        await expect(nativeCard).toHaveAttribute('aria-pressed', 'true');

        // Click Continue.
        await page.getByRole('button', { name: /continue/i }).click();

        // Step 2B heading: "Create admin account" (i18n key setup_s2b_title)
        // — match on the username input which is always present on 2b.
        await expect(page.locator('#admin-username')).toBeVisible({ timeout: 5000 });
    });

    // ─── Back navigation works within the wizard ─────────────────────────────
    test('step 2b: Back button returns to step 1', async ({ page }) => {
        await openSignInStep(page);

        // Advance to step 2b.
        const nativeCard = page.locator('button.setup-choice', { hasText: /built.in/i });
        await nativeCard.click();
        await page.getByRole('button', { name: /continue/i }).click();

        await expect(page.locator('#admin-username')).toBeVisible({ timeout: 5000 });

        // Click Back — should return to step 1.
        await page.getByRole('button', { name: /back/i }).click();

        // Step 1 is identified by the presence of at least two auth-method choice cards.
        await page.locator('button.setup-choice').first().waitFor({ timeout: 3000 });
        const choiceCount = await page.locator('button.setup-choice').count();
        expect(choiceCount).toBeGreaterThanOrEqual(2);
    });

    // ─── Username validation on step 2b ──────────────────────────────────────
    test('step 2b: invalid username keeps create button disabled', async ({ page }) => {
        await openSignInStep(page);

        const nativeCard = page.locator('button.setup-choice', { hasText: /built.in/i });
        await nativeCard.click();
        await page.getByRole('button', { name: /continue/i }).click();
        await expect(page.locator('#admin-username')).toBeVisible({ timeout: 5000 });

        // Type an invalid username (a space is outside USERNAME_RE's character set).
        await page.locator('#admin-username').fill('bad name');
        await page.locator('#admin-password').fill(SETUP_PASSWORD);
        await page.locator('#admin-confirm').fill(SETUP_PASSWORD);

        const createBtn = page.getByRole('button', { name: /create admin/i });
        await expect(createBtn).toBeDisabled();
    });

    // ─── Full happy-path flow ─────────────────────────────────────────────────
    // Last on purpose: it creates the admin, after which every test above skips.
    test('full wizard: creates admin, selects the training preset, completes setup', async ({
        page,
        request,
    }) => {
        await openSignInStep(page);

        // ── Step 1: choose native login ────────────────────────────────────
        const nativeCard = page.locator('button.setup-choice', { hasText: /built.in/i });
        await nativeCard.click();
        await page.getByRole('button', { name: /continue/i }).click();

        // ── Step 2B: create admin account ─────────────────────────────────
        await expect(page.locator('#admin-username')).toBeVisible({ timeout: 8000 });
        await page.locator('#admin-username').fill(SETUP_USERNAME);
        await page.locator('#admin-password').fill(SETUP_PASSWORD);
        await page.locator('#admin-confirm').fill(SETUP_PASSWORD);

        // Wait for the Create button to become enabled (validation passes).
        const createBtn = page.getByRole('button', { name: /create admin/i });
        await expect(createBtn).toBeEnabled({ timeout: 5000 });
        await createBtn.click();

        // ── Step 3: preferences + use-case selection ───────────────────────
        // After a successful POST to /api/auth/native/setup the wizard advances
        // to step 3 (no page reload — Svelte reactive state transition).
        // The "What is this instance for?" heading is the marker.
        await expect(page.getByText(/what is this instance for/i)).toBeVisible({ timeout: 10000 });

        // The VOD tile is pre-selected (useCaseSelection default = ['vod']).
        // Toggle VOD OFF, then toggle Home videos & training ON — we want that preset only.
        // The tiles are toggle buttons: aria-pressed carries the state.
        const vodCard = page.getByRole('button', { name: /^movies & tv$/i });
        await vodCard.click(); // deselects vod
        await expect(vodCard).toHaveAttribute('aria-pressed', 'false');

        const trainingCard = page.getByRole('button', { name: /home videos.*training/i });
        await trainingCard.click(); // selects the training preset
        await expect(trainingCard).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });

        // ── Finish: "Skip for now" ─────────────────────────────────────────
        // It saves step 3 (preferences + the use-case profile) like "Save &
        // continue", then skips the guided library step and goes to
        // /admin/library/sources (window.location.assign).
        const finishBtn = page.getByRole('button', { name: /skip for now/i });
        await expect(finishBtn).toBeEnabled();

        // Generous timeout: GPU detection + worker check may be in flight.
        await Promise.all([
            page.waitForURL(/\/admin\/library/, { timeout: 20000 }),
            finishBtn.click(),
        ]);

        // ── Assertion 1: setup is complete (wizard no longer reachable) ────
        // /setup must now redirect away because adminExists() returns true.
        await page.goto('/setup', { waitUntil: 'domcontentloaded' });
        expect(page.url()).not.toContain('/setup');

        // ── Assertion 2: training preset was persisted ───────────────────
        // A dry run of the training profile lists what applying it would still
        // change. The wizard applied it, so nothing is left to change, except
        // keys an environment variable locks (saving those is a no-op). The
        // dry run echoes primaryMode from the request, so that alone proves
        // nothing; the empty diff does.
        //
        // The adminTest fixture (tests/fixtures/auth.ts) supplies X-Forwarded-User +
        // admin group headers, so the admin gate lets this through.
        const profileRes = await request.post('/api/admin/instance-profile', {
            data: { useCases: [TRAINING_USE_CASE], dryRun: true },
            headers: { 'content-type': 'application/json' },
        });
        expect(profileRes.status()).toBe(200);
        const profile = (await profileRes.json()) as {
            preview?: boolean;
            primaryMode?: string;
            diff?: { key: string; envLocked?: true }[];
        };
        expect(profile.preview).toBe(true);
        expect(profile.primaryMode).toBe(TRAINING_USE_CASE);
        expect((profile.diff ?? []).filter((d) => !d.envLocked)).toEqual([]);
    });
});
