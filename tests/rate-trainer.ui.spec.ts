// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import type { Page } from '@playwright/test';

// First assertion after every goto gets a generous timeout: the dev server
// Playwright auto-starts compiles routes on demand, and a cold /rate load
// (SSR compile + client module graph + hydration) can exceed the default 5s.
const COLD_LOAD_TIMEOUT = 60_000;

// The first test in a fresh dev server (CI runs workers=1, and a spec can be the
// first to touch /rate) pays the whole on-demand compile. A 30s default test
// timeout cannot hold even one 30s cold-load wait, so size the budget to the
// waits below. The assertions themselves are unchanged: a page that never
// renders still fails, just after the cold-load budget instead of 30s.
test.describe.configure({ timeout: 120_000 });

test.describe('/rate trainer route scaffold', () => {
    test('renders the title and suppresses the app sidebar', async ({ page }) => {
        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);

        await expect(page.getByRole('heading', { name: 'Teach your taste' })).toBeVisible({
            timeout: COLD_LOAD_TIMEOUT,
        });

        // Watch-style chrome suppression. Assert the actual layout contract:
        // the APP sidebar (Sidebar.svelte renders `aside.icon-dock`) must not
        // be in the DOM — a bare `aside` count would trip on any unrelated
        // complementary landmark — and main-content must not carry the
        // with-sidebar/with-miniplayer gutter classes.
        await expect(page.locator('aside.icon-dock')).toHaveCount(0);
        await expect(page.locator('main.main-content')).not.toHaveClass(/with-sidebar/);
        await expect(page.locator('main.main-content')).not.toHaveClass(/with-miniplayer/);
    });

    test('back link returns to the home page', async ({ page }) => {
        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);

        // The header link ("← Back"). The exhausted-state card (no queue is
        // mocked here) renders a second link named exactly "Back".
        await page.getByRole('link', { name: '← Back' }).click();
        await expect(page).toHaveURL(/\/$/);
    });
});

// -----------------------------------------------------------------------
// Task 5: deck assembly — session store wired to the real API.
//
// Route interception keeps these deterministic and avoids real writes: the
// queue is served as an already-`exhausted` 2-item page (so the background
// refill in rate-session.svelte.ts never fires) and every POST to
// /api/ai/rate is intercepted and fulfilled instead of hitting the DB.
// -----------------------------------------------------------------------

const CANDIDATE_ALPHA = {
    externalIds: { internal: '11111111-1111-4111-8111-111111111111' },
    mediaType: 'movie',
    title: 'Rate Trainer Fixture Alpha',
    year: 2020,
    genres: ['Drama'],
    overview: 'A familiar title helps you teach Lumastra what you enjoy watching.',
};

const CANDIDATE_BRAVO = {
    externalIds: { internal: '22222222-2222-4222-8222-222222222222' },
    mediaType: 'series',
    title: 'Rate Trainer Fixture Bravo',
};

async function mockRateQueue(
    page: Page,
    items: object[] = [CANDIDATE_ALPHA, CANDIDATE_BRAVO],
): Promise<void> {
    await page.route('**/api/rate/skip', async (route) => {
        await route.fulfill({ json: { success: true } });
    });
    await page.route('**/api/rate/queue**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'exhausted',
                items,
                page: { limit: 2, hasMore: false, nextCursor: 'e2e-rate-queue' },
            }),
        });
    });
}

async function mockUserStats(page: Page): Promise<void> {
    await page.route('**/api/ai/user-stats**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ stats: { totalRatings: 3, todayRatings: 0 } }),
        });
    });
}

test.describe('/rate trainer deck assembly', () => {
    test('deck renders the first candidate after load', async ({ page }) => {
        await mockRateQueue(page);
        await mockUserStats(page);

        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);

        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Alpha', exact: true }),
        ).toBeVisible({
            timeout: COLD_LOAD_TIMEOUT,
        });

        // Guard against the 0-height regression: `toBeVisible` passes even when a
        // 0px overflow-hidden ancestor clips all painting (shipped once — the deck's
        // h-full collapsed under a flex/min-height parent). Assert real pixels.
        const deckBox = await page.getByTestId('swipe-deck').boundingBox();
        expect(deckBox).not.toBeNull();
        expect(deckBox!.height).toBeGreaterThan(300);
        expect(deckBox!.width).toBeGreaterThan(200);
        expect(deckBox!.width).toBeLessThan(500); // was 1729px wide pre-fix
    });

    test('Space skips the front card without submitting a rating', async ({ page }) => {
        await mockRateQueue(page);
        await mockUserStats(page);
        let ratePosts = 0;
        await page.route('**/api/ai/rate', (route) => {
            ratePosts += 1;
            void route.fulfill({ json: { totalRatings: 236 } });
        });

        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Alpha', exact: true }),
        ).toBeVisible({
            timeout: COLD_LOAD_TIMEOUT,
        });

        await page.keyboard.press(' ');
        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Bravo', exact: true }),
        ).toBeVisible();
        expect(ratePosts).toBe(0);
    });

    test('slow submit: swiped card never reappears before removal lands', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await mockRateQueue(page);
        await mockUserStats(page);
        await page.route('**/api/ai/rate', async (route) => {
            // Simulate a prod-like slow round-trip, LONGER than the 400ms exit
            // animation — regression guard for the ghost-lifecycle bug where the
            // committed card popped back onto the stack until the server confirmed.
            await new Promise((r) => setTimeout(r, 900));
            await route.fulfill({ json: { totalRatings: 236 } });
        });

        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Alpha', exact: true }),
        ).toBeVisible({
            timeout: COLD_LOAD_TIMEOUT,
        });

        await page.keyboard.press('ArrowRight');
        const liveTitle = page
            .getByTestId('swipe-live-card')
            .getByText(CANDIDATE_ALPHA.title, { exact: true });
        await expect(page.getByTestId('swipe-ghost')).toHaveCount(1);
        // aria-hidden must not mask a visually reappearing card. The intentional ghost
        // is excluded; the committed title must leave every live wrapper immediately.
        await expect(liveTitle).toHaveCount(0);
        for (let i = 0; i < 4; i++) {
            await page.waitForTimeout(150);
            await expect(liveTitle).toHaveCount(0);
        }
        await expect(page.getByTestId('swipe-ghost')).toHaveCount(0);
        await expect(page.getByRole('status')).toContainText(
            `Saved: ${CANDIDATE_ALPHA.title} — 8/10`,
        );
        await expect(page.getByRole('heading', { name: CANDIDATE_BRAVO.title })).toBeVisible();
        await expect(liveTitle).toHaveCount(0);
    });

    test('ArrowRight advances the deck and submits a quick rating', async ({ page }) => {
        await mockRateQueue(page);
        await mockUserStats(page);

        let ratePosts = 0;
        await page.route('**/api/ai/rate**', async (route) => {
            ratePosts += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ totalRatings: 4 }),
            });
        });

        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Alpha', exact: true }),
        ).toBeVisible({
            timeout: COLD_LOAD_TIMEOUT,
        });

        await page.keyboard.press('ArrowRight');

        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Bravo', exact: true }),
        ).toBeVisible();
        expect(ratePosts).toBe(1);
    });

    test('ArrowDown (skip) advances the deck without submitting a rating', async ({ page }) => {
        await mockRateQueue(page);
        await mockUserStats(page);

        let ratePosts = 0;
        await page.route('**/api/ai/rate**', async (route) => {
            ratePosts += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({}),
            });
        });

        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Alpha', exact: true }),
        ).toBeVisible({
            timeout: COLD_LOAD_TIMEOUT,
        });

        await page.keyboard.press('ArrowDown');

        await expect(
            page.getByRole('heading', { name: 'Rate Trainer Fixture Bravo', exact: true }),
        ).toBeVisible();
        expect(ratePosts).toBe(0);
    });

    test('Tab skips rear-card details and reaches the rating controls', async ({ page }) => {
        await mockRateQueue(page);
        await mockUserStats(page);
        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        const details = page.getByRole('button', { name: 'View details', exact: true });
        await details.focus();
        await expect(details).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Not for me', exact: true })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(details).toBeFocused();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('help is optional, closes and reopens without submitting ratings', async ({ page }) => {
        await mockRateQueue(page);
        await mockUserStats(page);
        let ratePosts = 0;
        await page.route('**/api/ai/rate', async (route) => {
            ratePosts += 1;
            await route.fulfill({ json: { totalRatings: 4 } });
        });
        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        await expect(page.getByRole('button', { name: 'Meh', exact: true })).toBeEnabled();
        await expect(page.getByRole('dialog', { name: 'Swipe to rate' })).toHaveCount(0);
        const help = page.locator('details.rate-trainer-help');
        await expect(help).not.toHaveAttribute('open');
        await page.getByText('How to rate', { exact: true }).click();
        await expect(help).toHaveAttribute('open', '');
        await page.keyboard.press('Space');
        await expect(help).not.toHaveAttribute('open');
        await page.keyboard.press('Enter');
        await expect(help).toHaveAttribute('open', '');
        expect(ratePosts).toBe(0);
    });
});

async function expectCompactStack(page: Page, count: number): Promise<void> {
    await expect(page.getByTestId('swipe-live-card')).toHaveCount(count);
    const geometry = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-testid="swipe-live-card"]')].map(
            (card) => card.getBoundingClientRect(),
        );
        const actions = [...document.querySelectorAll('.rate-quick-actions button')].map((button) =>
            button.getBoundingClientRect(),
        );
        return {
            gap:
                Math.min(...actions.map((box) => box.top)) -
                Math.max(...cards.map((box) => box.bottom)),
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            targets: actions.every((box) => box.width >= 44 && box.height >= 44),
        };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.targets).toBe(true);
    expect(geometry.gap).toBeGreaterThanOrEqual(24);
    expect(geometry.gap).toBeLessThanOrEqual(36);
}

for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'phone', width: 390, height: 844 },
    { name: 'short-phone', width: 375, height: 667 },
]) {
    test(`compact ${viewport.name} composition and final-card recovery`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const firstCandidate =
            viewport.name === 'desktop'
                ? CANDIDATE_ALPHA
                : {
                      ...CANDIDATE_ALPHA,
                      title: 'Rate Trainer Fixture Alpha: A Very Long Title About Finding Your Next Favourite Story',
                      genres: [
                          'Drama',
                          'AReallyLongUnbrokenGenreNameForLayoutCoverage',
                          'Adventure',
                      ],
                      overview:
                          'A familiar title helps you teach Lumastra what you enjoy watching. '.repeat(
                              8,
                          ),
                  };
        const finalCandidate = {
            ...CANDIDATE_BRAVO,
            externalIds: { internal: '33333333-3333-4333-8333-333333333333' },
            title: 'Rate Trainer Fixture Charlie',
        };
        await mockRateQueue(page, [firstCandidate, CANDIDATE_BRAVO, finalCandidate]);
        await mockUserStats(page);
        const ratings: number[] = [];
        let undoPosts = 0;
        await page.route('**/api/ai/rate', async (route) => {
            const body = route.request().postDataJSON() as { rating?: number; clear?: boolean };
            if (body.clear) undoPosts += 1;
            else if (body.rating !== undefined) ratings.push(body.rating);
            await route.fulfill({
                json: { totalRatings: 3 + ratings.length - undoPosts },
            });
        });
        await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
        await expect(page.getByRole('heading', { name: firstCandidate.title })).toBeVisible();
        await expect(page.getByTestId('session-count')).toHaveText('+0 this session');
        await expect(
            page.getByTestId('swipe-deck').getByText('Movie', { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByTestId('swipe-deck').getByText('2020', { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'View details', exact: true })).toHaveCount(
            1,
        );
        const detailsBox = await page
            .getByRole('button', { name: 'View details', exact: true })
            .boundingBox();
        const cardBox = await page.getByTestId('swipe-deck').boundingBox();
        expect(detailsBox!.height).toBeGreaterThanOrEqual(44);
        expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(
            cardBox!.y + cardBox!.height,
        );
        expect(detailsBox!.y).toBeGreaterThanOrEqual(cardBox!.y);
        await expectCompactStack(page, 3);
        await page.screenshot({
            path: testInfo.outputPath(`rate-${viewport.name}.png`),
            fullPage: true,
        });
        await page.getByRole('button', { name: 'Meh', exact: true }).click();
        await expect.poll(() => ratings).toEqual([5]);
        await expect(page.getByRole('status')).toContainText(
            `Saved: ${firstCandidate.title} — 5/10`,
        );
        await expect(page.getByTestId('session-count')).toHaveText('+1 this session');
        await expectCompactStack(page, 2);
        await expect(page.getByRole('heading', { name: CANDIDATE_BRAVO.title })).toBeInViewport({
            ratio: 1,
        });
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeInViewport();
        await expect(
            page
                .locator('[data-testid="swipe-live-card"]:not([aria-hidden="true"])')
                .getByText('Series', { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId('swipe-deck').getByText('2020', { exact: true })).toHaveCount(
            0,
        );
        await page.getByRole('button', { name: 'Exact rating', exact: true }).click();
        const exactButtons = page.getByRole('group', { name: 'Exact rating' }).getByRole('button');
        await expect(exactButtons).toHaveCount(10);
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.getByRole('button', { name: '7 of 10', exact: true }).click();
        await expect(page.getByRole('heading', { name: finalCandidate.title })).toBeInViewport({
            ratio: 1,
        });
        await expectCompactStack(page, 1);
        await expect(page.getByRole('status')).toContainText(
            `Saved: ${CANDIDATE_BRAVO.title} — 7/10`,
        );
        await expect(page.getByTestId('session-count')).toHaveText('+2 this session');
        await page.getByRole('button', { name: 'Liked it', exact: true }).click();
        await expect(page.getByRole('heading', { name: "You're all caught up" })).toBeVisible();
        await expect(page.getByRole('status')).toContainText(
            `Saved: ${finalCandidate.title} — 8/10`,
        );
        await expect(page.getByTestId('session-count')).toHaveText('+3 this session');
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeInViewport();
        await page.waitForTimeout(5200);
        await page.screenshot({
            path: testInfo.outputPath(`rate-${viewport.name}-exhausted.png`),
            fullPage: true,
        });
        const undo = page.getByRole('button', { name: 'Undo', exact: true });
        await undo.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: finalCandidate.title })).toBeVisible();
        await expect(page.locator('main.rate-trainer-main')).toBeFocused();
        await expect(page.getByTestId('session-count')).toHaveText('+2 this session');
        await expect(page.getByRole('status')).toHaveText('');
        // Focus repair must keep the page's non-interactive keyboard shortcuts usable.
        expect(ratings).toEqual([5, 7, 8]);
        await page.keyboard.press('m');
        await expect.poll(() => ratings).toEqual([5, 7, 8, 5]);
        expect(undoPosts).toBe(1);
    });
}

test('failed keyboard Undo keeps focus and can be retried with Enter', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockRateQueue(page);
    await mockUserStats(page);
    let undoCalls = 0;
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
    });
    await page.route('**/api/ai/rate', async (route) => {
        const body = route.request().postDataJSON() as { clear?: boolean };
        if (body.clear) {
            undoCalls += 1;
            if (undoCalls === 1) {
                await failureGate;
                await route.fulfill({ status: 500, json: { error: 'Temporary failure' } });
                return;
            }
        }
        await route.fulfill({ json: { totalRatings: body.clear ? 3 : 4 } });
    });
    await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
    await page.getByRole('button', { name: 'Meh', exact: true }).click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => undoCalls).toBe(1);
    await expect(undo).toHaveAttribute('aria-disabled', 'true');
    await expect(undo).toBeFocused();
    releaseFailure?.();
    await expect(undo).toHaveAttribute('aria-disabled', 'false');
    await expect(undo).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: CANDIDATE_ALPHA.title })).toBeVisible();
    expect(undoCalls).toBe(2);
});

test('320px viewport with enlarged text keeps the entire card info readable and scrollable', async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 320, height: 667 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockRateQueue(page, [
        {
            ...CANDIDATE_ALPHA,
            communityRating: 8.4,
            source: 'watched',
            title: 'A Very Long Title That Must Remain Readable With Enlarged Text',
            genres: ['Drama', 'AReallyLongUnbrokenGenreNameForLayoutCoverage', 'Adventure'],
            overview:
                'A synopsis with enough words to fill both visible lines while text is enlarged. '.repeat(
                    6,
                ),
        },
    ]);
    let mutations = 0;
    await page.route('**/api/ai/rate', async (route) => {
        mutations += 1;
        await route.fulfill({ json: { totalRatings: 4 } });
    });
    await page.route('**/api/rate/skip', async (route) => {
        mutations += 1;
        await route.fulfill({ json: { success: true } });
    });
    await mockUserStats(page);
    await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    for (const filter of await page.locator('.rate-trainer-filter button').all()) {
        const box = await filter.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    const badge = await page.getByTestId('swipe-seen-badge').boundingBox();
    const title = await page.getByRole('heading', { name: /A Very Long Title/ }).boundingBox();
    expect(badge!.y + badge!.height).toBeLessThanOrEqual(title!.y);
    const info = await page.getByTestId('swipe-card-info').boundingBox();
    const card = await page.getByTestId('swipe-deck').boundingBox();
    expect(info!.y).toBeGreaterThanOrEqual(card!.y);
    expect(info!.y + info!.height).toBeLessThanOrEqual(card!.y + card!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    const scroller = page.locator('main.main-content');
    expect(await scroller.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    // Real touch input must scroll over the oversized card without rating or skipping it.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const details = page.getByRole('button', { name: 'View details', exact: true });
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    let detailsReached = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
        const detailsBox = await details.boundingBox();
        detailsReached ||=
            !!detailsBox && detailsBox.y >= 0 && detailsBox.y + detailsBox.height <= 667;
        const skipBox = await skip.boundingBox();
        if (skipBox && skipBox.y >= 0 && skipBox.y + skipBox.height <= 667) break;
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: 160, y: 560 }],
        });
        for (let step = 1; step <= 10; step += 1) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ x: 160, y: 560 - step * 32 }],
            });
            await page.waitForTimeout(25);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(150);
    }
    expect(detailsReached).toBe(true);
    await expect(skip).toBeInViewport();
    expect(mutations).toBe(0);
    await cdp.detach();
    await page.screenshot({ path: testInfo.outputPath('rate-enlarged-text.png'), fullPage: true });
});

test('an enlarged card keeps its original height while exiting over a shorter card', async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 667 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mockRateQueue(page, [
        {
            ...CANDIDATE_ALPHA,
            source: 'watched',
            communityRating: 8.4,
            title: 'A Very Long Title That Must Remain Readable With Enlarged Text',
            genres: ['Drama', 'Adventure', 'Comedy'],
        },
        CANDIDATE_BRAVO,
    ]);
    await mockUserStats(page);
    await page.route('**/api/ai/rate', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.fulfill({ json: { totalRatings: 4 } });
    });
    await gotoHydrated(page, '/rate', COLD_LOAD_TIMEOUT);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const height = await page.getByTestId('swipe-deck').evaluate((node) => node.clientHeight);
    await page.keyboard.press('ArrowRight');
    const ghostHeight = await page.getByTestId('swipe-ghost').evaluate((node) => node.clientHeight);
    expect(ghostHeight).toBe(height);
    expect(
        await page.getByTestId('swipe-deck').evaluate((node) => node.clientHeight),
    ).toBeGreaterThanOrEqual(height);
    await expect(page.getByRole('heading', { name: CANDIDATE_BRAVO.title })).toBeVisible();
});
