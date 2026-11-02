// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { compile } from 'svelte/compiler';

// Exercise the production component's compiled CSS in a real browser. The
// isolated root avoids media/API fixtures; this suite covers motion, not data.
const source = readFileSync(new URL('../src/lib/ModalMovie.svelte', import.meta.url), 'utf8');
const compiled = compile(source, {
    filename: 'ModalMovie.svelte',
    cssHash: () => 'svelte-modal-opening-test',
});

test.describe('movie detail opening motion', () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.setContent(`<style>${compiled.css?.code}</style>`);
    });

    async function open(page: Page, mobile = false): Promise<void> {
        await page.evaluate((mobile) => {
            const root = document.createElement('div');
            root.className = 'modal-root svelte-modal-opening-test';
            const scope = 'svelte-modal-opening-test';
            root.innerHTML = mobile
                ? `<div class="mobile-backdrop-strip ${scope}"><img class="${scope}" alt="Artwork"><h1>Movie title</h1></div><button>Close</button>`
                : `<div class="poster-pane ${scope}"><img class="poster-sharp ${scope}" alt="Artwork"></div><h1>Movie title</h1><button>Close</button>`;
            document.body.append(root);
            // Pause synchronously so assertions never race a 200ms animation.
            for (const animation of root.getAnimations({ subtree: true })) {
                animation.pause();
                animation.currentTime = 0;
            }
        }, mobile);
    }

    for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
    ]) {
        test(`enlarges for 200ms and releases its scale at ${viewport.width} px`, async ({
            page,
        }) => {
            await page.setViewportSize(viewport);
            await open(page, viewport.width < 1024);
            const start = await page.getByRole('img').evaluate((root) => ({
                scale: getComputedStyle(root).scale,
                duration: root.getAnimations()[0]?.effect?.getTiming().duration,
            }));
            expect(start).toEqual({ scale: '0.88', duration: 200 });
            for (const selector of ['.modal-root', 'h1', 'button']) {
                expect(
                    await page.locator(selector).evaluate((element) => ({
                        scale: getComputedStyle(element).scale,
                        animations: element.getAnimations().length,
                    })),
                ).toEqual({ scale: 'none', animations: 0 });
            }
            await page.getByRole('img').evaluate((root) => {
                root.getAnimations()[0].finish();
            });
            expect(
                await page.getByRole('img').evaluate((root) => getComputedStyle(root).scale),
            ).toBe('none');
        });
    }

    test('preserves swipe translation during opening and restarts on remount', async ({ page }) => {
        await open(page);
        expect(
            await page.locator('.modal-root').evaluate((root) => {
                (root as HTMLElement).style.cssText =
                    'transition: none; transform: translateX(40px)';
                return getComputedStyle(root).transform;
            }),
        ).toBe('matrix(1, 0, 0, 1, 40, 0)');
        await page.locator('.modal-root').evaluate((root) => root.remove());
        await open(page);
        expect(await page.getByRole('img').evaluate((root) => getComputedStyle(root).scale)).toBe(
            '0.88',
        );
    });

    for (const mobile of [false, true]) {
        test(`skips motion with reduced motion (mobile: ${mobile})`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await open(page, mobile);
            expect(
                await page.locator('.modal-root').evaluate((root) => ({
                    animations: root.getAnimations({ subtree: true }).length,
                    scale: getComputedStyle(root).scale,
                })),
            ).toEqual({ animations: 0, scale: 'none' });
            await page.getByRole('button', { name: 'Close' }).focus();
            expect(
                await page
                    .getByRole('button')
                    .evaluate((button) => document.activeElement === button),
            ).toBe(true);
        });

        test(`cancels enlargement when reduced motion changes (mobile: ${mobile})`, async ({
            page,
        }) => {
            await open(page, mobile);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            expect(
                await page.getByRole('img').evaluate((root) => getComputedStyle(root).scale),
            ).toBe('none');
        });
    }
});
