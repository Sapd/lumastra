// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

for (const width of [390, 1066]) {
    test(`hero actions stay aligned and right-side swipes work at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await expectHydrated(page);
        const hero = page.locator('.hero-carousel');
        await expect(hero).toBeVisible();
        const slides = hero.locator('.hero-slide');
        await expect(slides.nth(1)).toBeAttached();
        await page.evaluate(() => document.fonts.ready);

        const layout = await hero.evaluate((root) => {
            const bounds = root.getBoundingClientRect();
            return [...root.querySelectorAll('.hero-actions')].map((actions) => {
                const rect = actions.getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom, heroBottom: bounds.bottom };
            });
        });
        expect(layout.length).toBeGreaterThan(1);
        for (const action of layout) {
            expect(Math.abs(action.top - layout[0].top)).toBeLessThanOrEqual(1);
            expect(action.bottom).toBeLessThanOrEqual(action.heroBottom);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
            width,
        );

        const active = hero.locator('.hero-slide.is-active');
        const previousLabel = await active.getAttribute('aria-label');
        const bounds = await hero.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) throw new Error('Hero has no bounds');
        const x = bounds.x + bounds.width - 24;
        const y = bounds.y + Math.min(220, bounds.height / 2);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 100, y, { steps: 10 });
        await page.mouse.up();
        await expect(active).not.toHaveAttribute('aria-label', previousLabel!);
    });
}
