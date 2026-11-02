// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';

import { expectHydrated } from '../helpers/hydration';
import { ADMIN_FORWARD_AUTH_HEADERS, adminTest, expect, SWEEP_API_BASE_URL } from './identity';
import type { APIRequest, Locator, Page, TestInfo } from '@playwright/test';

interface InventoryPage {
    url: string;
    hasFormActions: boolean;
    actions: string[];
}

interface InventoryCounts {
    pagesWithFormActions: number;
    formActions: number;
}

interface Inventory {
    counts: InventoryCounts;
    pages: InventoryPage[];
}

interface MutatedControl {
    /** Position within SETTING_CONTROL_SELECTOR; the fallback when a control has no id. */
    index: number;
    /** Settings controls now carry their config key as id (FEATURE_*, LUMASTRA_*): stable across reloads. */
    id: string | null;
    control: Locator;
    original: string | number | boolean;
    changed: string | number | boolean;
}

const inventory = readInventory();
const formPages = inventory.pages.filter((page) => page.hasFormActions);
// The Origin the target treats as same-origin (its ORIGIN); see PREPROD.md.
const CSRF_ORIGIN = process.env.SWEEP_CSRF_ORIGIN?.trim() || new URL(SWEEP_API_BASE_URL).origin;

/**
 * Pinned on purpose (see the beforeEach below): a regenerated inventory that
 * gains or loses a form page must be a conscious edit here, not a silent drift.
 * 14 since /admin/settings/ai and /admin/system/instance's reviewSecurity pair
 * joined the inventory (was 12). 15 since /admin/library/media's
 * refreshSingleActQueue action joined it (0e91164f25, 2026-10-25).
 */
const EXPECTED_FORM_PAGES = 15;

/**
 * Can this target accept a form write AT ALL?
 *
 * `csrf.ts` compares the request's Origin host against `url.host`. Through a
 * tunnel the browser sends 127.0.0.1:<port> while the app's ORIGIN is its public
 * hostname, so EVERY form POST is refused with 403 and no round trip can
 * succeed. Discovering that per page cost 90 seconds each — five pages timed out
 * finding out what one probe answers in milliseconds, and the timeout hid the
 * reason behind "Test timeout exceeded".
 *
 * `?/reload` is the right probe: admin-gated, idempotent, and it only re-reads
 * config from disk, so a successful one changes nothing.
 */
let writesRefusedReason: string | null = null;

adminTest.describe('Tier B form-action round trips', () => {
    adminTest.beforeAll(async ({ playwright }) => {
        const probePage = formPages.find((page) => page.actions.includes('reload'));
        if (!probePage) return;
        const ctx = await playwright.request.newContext({
            // Node, not the browser: the project's baseURL may be a host name
            // only Chromium maps to the tunnel (browser-origin.ts).
            baseURL: SWEEP_API_BASE_URL,
            extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
        });
        try {
            const response = await ctx.post(`${probePage.url}?/reload`, {
                // The guard needs a same-origin Origin on a form POST and a Node
                // request context sends none: without it every target answers 403,
                // which reads as "this target refuses writes" and is not.
                headers: { Origin: CSRF_ORIGIN },
                form: {},
                maxRedirects: 0,
            });
            if (response.status() === 403) {
                writesRefusedReason =
                    `form writes are refused on this target: POST ${probePage.url}?/reload returned 403 ` +
                    `(CSRF origin mismatch — the sweep's base URL must match the target's configured ORIGIN). ` +
                    `Reachability and negative-auth tiers are unaffected; only round trips are untestable here.`;
            }
        } finally {
            await ctx.dispose();
        }
    });

    // The inventory is the contract: silently losing a generated page or action
    // makes this suite look healthy while coverage has regressed.
    adminTest.beforeEach(() => {
        expect(formPages).toHaveLength(EXPECTED_FORM_PAGES);
        expect(formPages.reduce((count, page) => count + page.actions.length, 0)).toBe(
            inventory.counts.formActions,
        );
        expect(formPages).toHaveLength(inventory.counts.pagesWithFormActions);
    });

    /*
     * One loud row, not twelve quiet ones.
     *
     * `block()` marks a test PASSED with an annotation, so a target that refuses
     * every write produced 12/12 green — a run in which the round trip, the
     * entire point of this tier, was never exercised. That is the same
     * false-green shape as a `test.skip()` wearing a different badge.
     *
     * So the per-page rows still block (each carrying the reason), and THIS row
     * fails, which makes the tier red and unmistakable. On a target whose ORIGIN
     * matches the sweep's base URL — a fresh local install, which is where the
     * write tier is meant to run — it passes and says nothing.
     */
    adminTest('precondition: the target accepts form writes', () => {
        expect(writesRefusedReason, writesRefusedReason ?? undefined).toBeNull();
    });

    for (const pageDefinition of formPages) {
        adminTest(pageDefinition.url, async ({ page, playwright }, testInfo) => {
            if (writesRefusedReason !== null) {
                block(testInfo, writesRefusedReason);
                return;
            }
            await page.goto(pageDefinition.url, { waitUntil: 'domcontentloaded' });
            await expectHydrated(page);

            for (const action of pageDefinition.actions) {
                if (action === 'reload') {
                    await exerciseReload(page);
                } else if (action === 'save') {
                    await exerciseSettingsSave(page, testInfo);
                } else if (action === 'clear') {
                    await exerciseInstanceLicenseRoundTrip(page, testInfo);
                } else if (action === 'assignPrice') {
                    await exerciseCostPriceRoundTrip(page, testInfo);
                } else if (action === 'reviewSecurity' || action === 'unreviewSecurity') {
                    // Toggles the operator-wide "security update reviewed" flag that
                    // quiets the red update notice for every admin; flipping it from a
                    // sweep would hide a real notice, so it is not exercised here.
                    block(testInfo, `${action} changes a shared admin notice state`);
                } else if (action === 'refreshSingleActQueue') {
                    await exerciseReadOnlyAction(playwright, pageDefinition.url, action);
                } else if (action === 'revoke') {
                    // Revocation has no inverse API and deleting a real user's
                    // credential cannot be made safe by inventing a replacement.
                    block(testInfo, 'revoke is destructive and has no reversible round-trip');
                } else {
                    throw new Error(`No Tier B handler exists for inventory action ${action}.`);
                }
            }
        });
    }
});

function readInventory(): Inventory {
    const raw: unknown = JSON.parse(
        readFileSync(new URL('./inventory.generated.json', import.meta.url), 'utf8'),
    );
    if (!isRecord(raw) || !isRecord(raw.counts) || !Array.isArray(raw.pages)) {
        throw new Error('Route-sweep inventory has an unexpected shape.');
    }
    const counts = raw.counts;
    const pages = raw.pages;
    if (
        typeof counts.pagesWithFormActions !== 'number' ||
        typeof counts.formActions !== 'number' ||
        !pages.every(isInventoryPage)
    ) {
        throw new Error('Route-sweep inventory is missing form-action metadata.');
    }
    return {
        counts: {
            pagesWithFormActions: counts.pagesWithFormActions,
            formActions: counts.formActions,
        },
        pages,
    };
}

function isInventoryPage(value: unknown): value is InventoryPage {
    return (
        isRecord(value) &&
        typeof value.url === 'string' &&
        typeof value.hasFormActions === 'boolean' &&
        Array.isArray(value.actions) &&
        value.actions.every((action) => typeof action === 'string')
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/*
 * `count()` is a single instantaneous read with no retry, unlike
 * `expect(locator).toBeAttached()`. These settings pages finish hydrating —
 * `#svelte-announcer` appears — and only then render their forms once the
 * settings payload resolves, so an immediate count() sees zero and the tier
 * reported "the page has no rendered save form" for six pages that plainly do
 * render one. Verified by hand: /admin/settings/homepage serves
 * form[action="?/save"] with 8 inputs and a "Save Changes" button.
 *
 * That mistake was worse than a plain failure, because it surfaced as a BLOCKED
 * row — the tier looked like it had run and consciously excluded those pages,
 * rather than like it had missed them.
 */
const FORM_TIMEOUT_MS = 15_000;

async function waitForForm(page: Page, action: string): Promise<boolean> {
    try {
        await page.locator(`form[action="${action}"]`).first().waitFor({
            state: 'attached',
            timeout: FORM_TIMEOUT_MS,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * An action that only re-reads (the single-act review queue refresh): its own source
 * says it never changes catalog state, so the round trip is "the POST succeeds and
 * answers the action's success payload", with nothing to restore. Sent from a Node
 * context with the same-origin Origin the CSRF guard needs, like the write probe.
 */
async function exerciseReadOnlyAction(
    playwright: { request: APIRequest },
    url: string,
    action: string,
): Promise<void> {
    const ctx = await playwright.request.newContext({
        baseURL: SWEEP_API_BASE_URL,
        extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
    });
    try {
        const response = await ctx.post(`${url}?/${action}`, {
            headers: { Origin: CSRF_ORIGIN },
            form: {},
        });
        expect(response.status(), `POST ${url}?/${action}`).toBe(200);
        const body: unknown = await response.json();
        expect(isRecord(body) ? body.type : null, `${action} action result type`).toBe('success');
    } finally {
        await ctx.dispose();
    }
}

async function exerciseReload(page: Page): Promise<void> {
    if (!(await waitForForm(page, '?/reload'))) {
        throw new Error('Inventory declares reload, but the reload form is not rendered.');
    }
    await page
        .locator('form[action="?/reload"]')
        .locator('button[type="submit"]:visible')
        .first()
        .click();
    await expectHydrated(page);
    // The reload action navigates. `save` runs next against this same page, so
    // let the form come back before the next handler looks for it.
    await waitForForm(page, '?/save');
}

async function exerciseSettingsSave(page: Page, testInfo: TestInfo): Promise<void> {
    if (!(await waitForForm(page, '?/save'))) {
        block(testInfo, `no save form rendered within ${FORM_TIMEOUT_MS}ms`);
        return;
    }
    // `method` and `enctype` are deliberately NOT asserted. They are decided by
    // SvelteKit for an action form, not by this application, so they test the
    // framework rather than the page — and asserting them was actively harmful:
    // the `reload` action runs first, POSTs, and re-renders, so the form element
    // these assertions had just found was detached by the time they read it
    // ("element(s) not found" on a locator that resolved moments earlier).
    // The round trip below is the assertion that carries the meaning.

    // Not every enabled control is a setting: pages also carry "add an item" inputs
    // (e.g. a group-name box) and per-device toggles that never dirty the form. Try
    // the candidates in page order and keep the first one that does.
    const saveProbe = saveButtonOf(page);
    let mutation: MutatedControl | null = null;
    let candidates = 0;
    const tried: string[] = [];
    // Free-text fields last: a suffixed value is often invalid (a language code, a path)
    // and a rejected save reads as "does not persist".
    const order = [
        ...Array.from({ length: 10 }, (_, skip) => ({ skip, kind: 'structured' as const })),
        ...Array.from({ length: 4 }, (_, skip) => ({ skip, kind: 'text' as const })),
    ];
    for (const { skip, kind } of order) {
        if (mutation !== null) break;
        const candidate = await chooseReversibleControl(page, skip, kind);
        if (candidate === null) continue;
        candidates += 1;
        await setControl(candidate.control, candidate.changed);
        const dirtied = await expect(saveProbe)
            .toBeEnabled({ timeout: 1_500 })
            .then(
                () => true,
                () => false,
            );
        if (dirtied) mutation = candidate;
        else {
            tried.push(
                await candidate.control
                    .evaluate((element) => element.outerHTML.slice(0, 160))
                    .catch(() => `index ${candidate.index}`),
            );
            await setControl(candidate.control, candidate.original);
        }
    }
    if (mutation === null && candidates > 0) {
        throw new Error(
            `none of the first ${candidates} setting controls enabled Save when changed: ${tried.join(' | ')}`,
        );
    }
    if (mutation === null) {
        const lockedCount = await page.locator('main [disabled]').count();
        block(
            testInfo,
            lockedCount > 0
                ? 'all rendered setting controls are deployment-locked by environment configuration'
                : 'no enabled, reversible setting control was rendered',
        );
        return;
    }

    try {
        // Re-query rather than reusing a handle: the reload action re-renders
        // the page, so a form located earlier may already be detached.
        // Save is disabled until the form is dirty. Clicking a disabled button
        // does not fail — Playwright waits for it to become enabled and burns
        // the entire test timeout, which is how every page here reported a 90s
        // "timeout" that was really "the change never registered".
        const saveButton = saveButtonOf(page);
        await expect(
            saveButton,
            'changing a setting must enable Save; if it does not, the change never registered',
        ).toBeEnabled({ timeout: 10_000 });
        // Capture the save POST. A 403 here is the CSRF guard rejecting the
        // request's Origin, NOT the application failing to persist — and the
        // two are indistinguishable from the reloaded value alone. Through a
        // tunnel the browser sends Origin: http://127.0.0.1:<port> while the
        // app's ORIGIN is its public hostname, so EVERY save is refused and the
        // value reverts. Without this branch the tier reports a fleet of
        // "settings do not persist" defects that do not exist.
        const [saveResponse] = await Promise.all([
            page
                .waitForResponse((r) => r.request().method() === 'POST', { timeout: 20_000 })
                .catch(() => null),
            saveButton.click(),
        ]);
        await page.waitForTimeout(750);

        if (saveResponse?.status() === 403) {
            block(
                testInfo,
                `save POST was refused with 403 (CSRF origin mismatch): the sweep's base URL must match the target's configured ORIGIN for write tests. ${page.url()}`,
            );
            return;
        }
        await reloadSettled(page);
        await expectHydrated(page);
        // The advanced section collapses on reload and controls are addressed
        // positionally, so it has to be re-expanded before re-reading.
        await revealAdvancedSettings(page);
        await expectControlValue(mutation.control, mutation.changed);
    } finally {
        // Restoration is deliberately independent of the assertion above: this
        // suite runs against shared preprod state, where a failed assertion must
        // not leave an operator setting changed for the next test.
        //
        // The control is addressed BY INDEX, never by id. These settings
        // controls carry no `id` at all, so the previous `#${escapeCssId(id)}`
        // locator was built from null and waited on a selector that can never
        // match — which is where every Tier B test spent its 90 second timeout.
        // The assertion above fails whenever a save does not persist, so every
        // test reached this block and hung there.
        await reloadSettled(page);
        await expectHydrated(page);
        await revealAdvancedSettings(page);
        const restoreControl = locateControl(page, mutation);
        await setControl(restoreControl, mutation.original);
        // Same disabled-button trap as the save path, second location: if the
        // restore change does not dirty the form (or the original value was
        // already current), Save stays disabled and clicking it waits out the
        // whole test timeout. Nothing to restore is a perfectly good outcome,
        // so check first and move on.
        const restoreButton = saveButtonOf(page);
        if ((await restoreButton.count()) > 0 && (await restoreButton.isEnabled())) {
            await restoreButton.click();
            await page.waitForTimeout(750);
        }
    }
}

/*
 * Settings controls live OUTSIDE the save form.
 *
 * `form[action="?/save"]` contains exactly one input — a hidden `updates`
 * field. The UI keeps settings state in JS and serializes it into that field on
 * submit, so a form-scoped control search finds the hidden input and nothing
 * else. The previous selector, `[id^="setting-"]`, matched nothing at all: that
 * string appears nowhere in this codebase. It was invented, could never match,
 * and the tier reported "no enabled, reversible setting control was rendered"
 * for six pages instead of failing.
 */
type PickedControl = {
    id: string | null;
    index: number;
    original: string | number | boolean;
    changed: string | number | boolean;
};

const SETTING_CONTROL_SELECTOR = [
    'main select:not([disabled])',
    'main input[type="number"]:not([disabled])',
    'main input[type="text"]:not([disabled]):not([aria-label="Search"])',
    'main input[type="url"]:not([disabled])',
    'main textarea:not([disabled])',
    // Excludes the advanced toggle: it is a section expander, not a setting.
    'main button[role="switch"]:not([disabled]):not([aria-label^="Show advanced settings"])',
].join(', ');

/**
 * Most settings sit behind a "Show advanced settings" toggle, so a page can
 * present as few as two controls -- a search box and the toggle itself -- until
 * it is expanded. /admin/settings/media is the clearest case: three controls
 * total before expanding.
 *
 * This must run again after every reload, because the section collapses back
 * and the controls are re-identified positionally.
 */
// A prefix match: the label became "Show advanced settings (remembered on this device)".
// With the exact match the toggle was picked as a "setting", and flipping it (a per-device
// preference, not part of the form) never dirtied the form.
const ADVANCED_TOGGLE = 'button[role="switch"][aria-label^="Show advanced settings"]';

async function revealAdvancedSettings(page: Page): Promise<void> {
    // It is role="switch", NOT role="button", so getByRole('button', ...)
    // matched nothing and this silently revealed nothing for every run.
    const toggle = page.locator(ADVANCED_TOGGLE);
    if ((await toggle.count()) === 0) return;
    if ((await toggle.first().getAttribute('aria-checked')) === 'true') return;
    await toggle.first().click();
    await page.waitForTimeout(400);
}

/**
 * Pick a control to flip, deciding entirely IN THE PAGE.
 *
 * The previous version walked the matches with Playwright calls — tagName,
 * getAttribute, inputValue, option counts — several round trips per control.
 * Against a remote target through a tunnel that is ruinous: every settings page
 * blew the 90s test timeout and the run took 8.2 minutes to pass one test. The
 * earlier selector was fast only because it matched nothing.
 *
 * One `evaluate` does the whole selection and returns an INDEX into the same
 * selector, which is then the only thing driven from the test side.
 */
async function chooseReversibleControl(
    page: Page,
    skip = 0,
    kind: 'structured' | 'text' = 'structured',
): Promise<MutatedControl | null> {
    await revealAdvancedSettings(page);

    const picked = await page.evaluate(
        ({ selector, skip: toSkip, kind: wanted }): PickedControl | null => {
            let seen = 0;
            const nodes = [...document.querySelectorAll(selector)];
            for (let index = 0; index < nodes.length; index += 1) {
                const node = nodes[index];
                const tag = node.tagName.toLowerCase();
                // Hidden controls (collapsed sections, the other breakpoint's copy)
                // cannot be driven: Playwright would wait out the whole test timeout.
                const box = (node as HTMLElement).getBoundingClientRect();
                if (box.width === 0 || box.height === 0) continue;
                if (getComputedStyle(node).visibility === 'hidden') continue;
                // Filter boxes are not settings.
                if (/filter|search/i.test(node.getAttribute('placeholder') ?? '')) continue;
                // A URL field rejects a suffixed value, which reads as "does not persist".
                if (node.getAttribute('inputmode') === 'url' || node.getAttribute('type') === 'url')
                    continue;

                const isText =
                    tag === 'textarea' ||
                    (tag === 'input' && node.getAttribute('type') !== 'number');
                if ((wanted === 'text') !== isText) continue;
                if (tag === 'button') {
                    const original = node.getAttribute('aria-checked') === 'true';
                    if (seen++ < toSkip) continue;
                    return { index, id: node.id || null, original, changed: !original };
                }
                if (tag === 'select') {
                    const select = node as HTMLSelectElement;
                    if (select.options.length < 2) continue;
                    const original = select.value;
                    // Prefer a NON-EMPTY alternative. The first option is often an
                    // empty placeholder ("Never", "None"), and picking it makes a
                    // "changed" value that several pages treat as no change at all —
                    // so the form never goes dirty and the result is indistinguishable
                    // from a broken control.
                    const alternative =
                        [...select.options].find((o) => o.value !== original && o.value !== '') ??
                        [...select.options].find((o) => o.value !== original);
                    if (!alternative) continue;
                    if (seen++ < toSkip) continue;
                    return { index, id: node.id || null, original, changed: alternative.value };
                }
                const input = node as HTMLInputElement | HTMLTextAreaElement;
                const type = node.getAttribute('type');
                if (type === 'number') {
                    const original = Number(input.value);
                    if (!Number.isFinite(original)) continue;
                    const max = Number(node.getAttribute('max'));
                    const min = Number(node.getAttribute('min'));
                    const candidate =
                        Number.isFinite(max) && original >= max ? original - 1 : original + 1;
                    if (Number.isFinite(min) && candidate < min) continue;
                    if (seen++ < toSkip) continue;
                    return { index, id: node.id || null, original, changed: candidate };
                }
                if (type === 'text' || type === 'url' || tag === 'textarea') {
                    const original = input.value;
                    if (original.length > 180) continue;
                    // Path-like fields (landing path) reject a suffixed value.
                    if (original.startsWith('/')) continue;
                    if (seen++ < toSkip) continue;
                    return {
                        index,
                        id: node.id || null,
                        original,
                        changed: `${original}-route-sweep`,
                    };
                }
            }
            return null;
        },
        { selector: SETTING_CONTROL_SELECTOR, skip, kind },
    );

    if (picked === null) return null;
    return {
        index: picked.index,
        id: picked.id,
        control: locateControl(page, picked),
        original: picked.original,
        changed: picked.changed,
    };
}

/**
 * The visible Save control. Most settings pages render a submit button inside
 * `form[action="?/save"]` (disabled until dirty); /admin/settings/appearance renders
 * nothing until it is dirty and then shows the sticky bar's Save (a type=button).
 */
function saveButtonOf(page: Page): Locator {
    return page
        .locator(
            'form[action="?/save"] button[type="submit"]:visible, div.fixed.bottom-0 button.bg-yellow-500',
        )
        .first();
}

/** The control again after a reload: by id when it has one, by position otherwise. */
function locateControl(page: Page, control: { id: string | null; index: number }): Locator {
    return control.id
        ? page.locator(`[id=${JSON.stringify(control.id)}]`)
        : page.locator(SETTING_CONTROL_SELECTOR).nth(control.index);
}

/**
 * A reload right after a save can be aborted by the navigation the save itself
 * triggers ("net::ERR_ABORTED; maybe frame was detached"). That is a race in the
 * test, and in the restore path it would leave a changed setting on the target.
 */
async function reloadSettled(page: Page): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await page.reload({ waitUntil: 'domcontentloaded' });
            return;
        } catch (error) {
            if (attempt >= 4) throw error;
            await page.waitForTimeout(1_000);
        }
    }
}

async function setControl(control: Locator, value: string | number | boolean): Promise<void> {
    const tagName = await control.evaluate((element) => element.tagName.toLowerCase());
    if (tagName === 'button') {
        const current = (await control.getAttribute('aria-checked')) === 'true';
        if (current !== value) await control.click();
        return;
    }
    if (typeof value === 'boolean') {
        await control.setChecked(value);
        return;
    }
    // A <select> must go through selectOption. `fill()` rejects it ("Element is
    // not an <input>, <textarea> or [contenteditable]") and Playwright RETRIES
    // that check until the test timeout rather than failing fast — so every page
    // whose first reversible control was a select burned the full 90s and was
    // reported as a timeout. The settings pages are mostly selects, which is why
    // this looked like the whole tier hanging.
    if (tagName === 'select') {
        await control.selectOption(String(value));
        return;
    }
    await control.fill(String(value));
    await control.dispatchEvent('change');
}

async function expectControlValue(
    control: Locator,
    value: string | number | boolean,
): Promise<void> {
    const tagName = await control.evaluate((element) => element.tagName.toLowerCase());
    if (tagName === 'button') {
        await expect(control).toHaveAttribute('aria-checked', String(value));
    } else {
        await expect(control).toHaveValue(String(value));
    }
}

async function exerciseInstanceLicenseRoundTrip(page: Page, testInfo: TestInfo): Promise<void> {
    const saveForm = page.locator('form[action="?/save"]');
    const clearButton = page.locator('button[formaction="?/clear"]');
    if ((await saveForm.count()) === 0) {
        block(testInfo, 'the instance license form is not rendered');
        return;
    }
    if ((await clearButton.count()) > 0) {
        block(testInfo, 'an existing license secret cannot be captured for safe restoration');
        return;
    }
    try {
        await saveForm.locator('input[name="licenseKey"]').fill('route-sweep-temporary-license');
        // Re-query rather than reusing a handle: the reload action re-renders
        // the page, so a form located earlier may already be detached.
        await page
            .locator('form[action="?/save"]')
            .first()
            .locator('button[type="submit"]')
            .click();
        await page.waitForTimeout(750);
        await reloadSettled(page);
        await expectHydrated(page);
        await expect(page.locator('button[formaction="?/clear"]')).toBeVisible();
    } finally {
        await page.locator('button[formaction="?/clear"]').click();
        await page.waitForTimeout(750);
        await reloadSettled(page);
        await expectHydrated(page);
        await expect(page.locator('button[formaction="?/clear"]')).toHaveCount(0);
    }
}

async function exerciseCostPriceRoundTrip(page: Page, testInfo: TestInfo): Promise<void> {
    const form = page.locator('form[action="?/assignPrice"]');
    if ((await form.count()) === 0) {
        block(testInfo, 'no unpriced embedding model is available for assignPrice');
        return;
    }
    const input = form.locator('input[name="pricePerMillion"]');
    const original = Number(await input.inputValue());
    if (!Number.isFinite(original)) {
        throw new Error('assignPrice rendered a non-numeric price input.');
    }
    const changed = original === 0 ? 0.0001 : original + 0.0001;
    try {
        await input.fill(String(changed));
        await form.locator('button[type="submit"]').click();
        await page.waitForTimeout(750);
        await reloadSettled(page);
        await expectHydrated(page);
        await expect(page.getByText(String(changed))).toBeVisible();
    } finally {
        // The cost page accepts the same form for an update after the first save.
        const restoreForm = page.locator('form[action="?/assignPrice"]');
        await restoreForm.locator('input[name="pricePerMillion"]').fill(String(original));
        await restoreForm.locator('button[type="submit"]').click();
        await page.waitForTimeout(750);
        await reloadSettled(page);
        await expectHydrated(page);
    }
}

function block(testInfo: TestInfo, reason: string): void {
    testInfo.annotations.push({ type: 'BLOCKED', description: reason });
    console.warn(`BLOCKED route-sweep form row: ${testInfo.title} — ${reason}`);
}
