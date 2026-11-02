// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import type * as PlayerStoreModule from '../src/lib/components/player/playerStore.svelte';

// Seed the real controls' store through Vite's dev module. This fixture tests
// browser layout and input without requiring a multi-language media library.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = async function (): Promise<void> {};
    });
    await page.goto(`/watch/${TEST_MEDIA_ITEM_ID}`);
    await expect
        .poll(
            () =>
                page
                    .locator('video')
                    .evaluate(
                        (video: HTMLVideoElement) =>
                            video.currentSrc.length > 0 &&
                            video.readyState >= HTMLMediaElement.HAVE_METADATA,
                    ),
            { timeout: 20000 },
        )
        .toBe(true);
    await page.evaluate(async (moduleUrl) => {
        const { playerStore } = (await import(moduleUrl)) as typeof PlayerStoreModule;
        if (!playerStore.currentMediaSource) throw new Error('Player source is not initialized');
        const audio = playerStore.currentMediaSource.audioStreams[0];
        if (!audio) throw new Error('Missing seeded audio stream');
        playerStore.currentMediaSource = {
            ...playerStore.currentMediaSource,
            audioStreams: Array.from({ length: 3 }, (_, index) => ({
                ...audio,
                index,
                language: index === 0 ? 'deu' : 'eng',
                languageCode: index === 0 ? 'deu' : 'eng',
                displayTitle:
                    index === 2 ? 'Director commentary' : index === 0 ? 'German' : 'English',
            })),
            subtitleStreams: Array.from({ length: 20 }, (_, index) => ({
                index,
                codec: 'subrip',
                language: 'eng',
                languageCode: 'eng',
                displayTitle: `English ${index + 1}`,
                isDefault: false,
                isForced: false,
                isExternal: true,
                isTextSubtitleStream: true,
                supportsExternalStream: true,
                deliveryMethod: 'External' as const,
            })),
        };
    }, '/src/lib/components/player/playerStore.svelte.ts');
    await page.getByRole('button', { name: 'Audio and subtitle tracks', exact: true }).click();
    await expect(page.locator('.track-selector')).toBeVisible();
});

test('one shared body scrolls, preserves its position through appearance, and isolates player input', async ({
    page,
}) => {
    const body = page.locator('.track-content');
    await body.evaluate((node) => {
        node.scrollTop = 0;
    });
    const volume = await page.locator('video').evaluate((video: HTMLVideoElement) => video.volume);
    await body.hover();
    await page.mouse.wheel(0, 350);
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    const appearance = page.getByRole('button', { name: 'Subtitle Appearance', exact: true });
    const scrollBeforeBack = await body.evaluate((node) => node.scrollTop);
    await appearance.click();
    await expect(body).toBeHidden();
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    const size = page.locator('.style-panel-container input[type="range"]').first();
    const sizeBefore = await size.inputValue();
    const playbackBefore = await page.locator('video').evaluate((video: HTMLVideoElement) => ({
        time: video.currentTime,
        paused: video.paused,
    }));
    await size.focus();
    await size.press('ArrowRight');
    await expect(size).not.toHaveValue(sizeBefore);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByRole('button', { name: 'Back', exact: true }).press('Escape');
    await expect(appearance).toBeFocused();
    await expect.poll(() => body.evaluate((node) => node.clientHeight)).toBeGreaterThanOrEqual(44);
    expect(await body.evaluate((node) => node.scrollTop)).toBe(scrollBeforeBack);
    await appearance.press('ArrowDown');
    const off = page.locator('.subtitle-list').getByRole('button', { name: /^OFF(?:\s|$)/ });
    await off.press('Space');
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    expect(
        await page.locator('video').evaluate((video: HTMLVideoElement) => ({
            time: video.currentTime,
            paused: video.paused,
        })),
    ).toEqual(playbackBefore);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.volume)).toBe(
        volume,
    );
    const scrollers = await page.locator('.track-selector').evaluate((node) =>
        Array.from(node.querySelectorAll<HTMLElement>('*'))
            .filter(
                (element) =>
                    ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) &&
                    element.scrollHeight > element.clientHeight,
            )
            .map((element) => element.className),
    );
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]).toContain('track-content');
    for (const edge of ['top', 'bottom']) {
        await body.evaluate((node, edge) => {
            node.scrollTop = edge === 'top' ? 0 : node.scrollHeight;
        }, edge);
        await body.hover();
        const documentScroll = await page.evaluate(() => window.scrollY);
        await page.mouse.wheel(0, edge === 'top' ? -500 : 500);
        await expect
            .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.volume))
            .toBe(volume);
        expect(await page.evaluate(() => window.scrollY)).toBe(documentScroll);
    }
});

for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
]) {
    test(`keeps menu and tracks usable at ${viewport.width}x${viewport.height}`, async ({
        page,
    }) => {
        await page.setViewportSize(viewport);
        await expect
            .poll(async () =>
                page.locator('.track-selector').evaluate((node, viewport) => {
                    const menu = node.getBoundingClientRect();
                    const player = node.closest('.player-container')!.getBoundingClientRect();
                    const controls = node.closest('.controls-container')!.getBoundingClientRect();
                    return (
                        menu.top >= Math.max(0, player.top) + 23 &&
                        menu.bottom <=
                            (viewport.height === 390 ? window.innerHeight - 23 : controls.top) &&
                        menu.height <= 640 &&
                        menu.right <= player.right &&
                        menu.left >= player.left
                    );
                }, viewport),
            )
            .toBe(true);
        await expect(
            page.getByRole('button', { name: 'Subtitle Appearance', exact: true }),
        ).toBeVisible();
        expect(
            await page.locator('.track-content').evaluate((node) => node.clientHeight),
        ).toBeGreaterThanOrEqual(44);
    });
}

test('taller players expose more rows while short lists remain compact', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const menu = page.locator('.track-selector');
    await expect
        .poll(() => menu.evaluate((node) => node.getBoundingClientRect().height))
        .toBeLessThan(500);
    const shortHeight = await menu.evaluate((node) => node.getBoundingClientRect().height);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await expect
        .poll(() => menu.evaluate((node) => node.getBoundingClientRect().height))
        .toBeGreaterThan(shortHeight + 100);
    const expandedHeight = await menu.evaluate((node) => node.getBoundingClientRect().height);
    await page.evaluate(async (moduleUrl) => {
        const { playerStore } = (await import(moduleUrl)) as typeof PlayerStoreModule;
        playerStore.currentMediaSource!.subtitleStreams =
            playerStore.currentMediaSource!.subtitleStreams.slice(0, 1);
    }, '/src/lib/components/player/playerStore.svelte.ts');
    await expect
        .poll(() => menu.evaluate((node) => node.getBoundingClientRect().height))
        .toBeLessThan(expandedHeight - 40);
    await expect
        .poll(() =>
            page
                .locator('.track-content')
                .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
        )
        .toBe(true);
});

test('adapts when an offset embedded player resizes without a viewport resize', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const player = page.locator('.player-container');
    await player.evaluate((node: HTMLElement) => {
        Object.assign(node.style, {
            position: 'absolute',
            top: '60px',
            left: '80px',
            width: '700px',
            height: '600px',
        });
    });
    const menu = page.locator('.track-selector');
    async function fits(): Promise<boolean> {
        return menu.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const bounds = node.closest('.player-container')!.getBoundingClientRect();
            const controls = node.closest('.controls-container')!.getBoundingClientRect();
            return (
                rect.top >= bounds.top + 23 &&
                rect.bottom <= controls.top &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right
            );
        });
    }
    await expect.poll(fits).toBe(true);
    const heightBefore = await menu.evaluate((node) => node.getBoundingClientRect().height);
    await player.evaluate((node: HTMLElement) => {
        node.style.height = '450px';
    });
    await expect
        .poll(() => menu.evaluate((node) => node.getBoundingClientRect().height))
        .toBeLessThan(heightBefore - 100);
    await expect.poll(fits).toBe(true);
    await expect(page.locator('.audio-section .track-chip').first()).toBeInViewport();
    await player.evaluate((node: HTMLElement) => {
        const frame = document.createElement('div');
        frame.dataset.testScrollFrame = '';
        Object.assign(frame.style, {
            position: 'absolute',
            top: '60px',
            left: '80px',
            width: '700px',
            height: '600px',
            overflow: 'auto',
        });
        const content = document.createElement('div');
        Object.assign(content.style, { position: 'relative', height: '1000px' });
        node.before(frame);
        frame.append(content);
        content.append(node);
        Object.assign(node.style, { top: '100px', left: '0px' });
        frame.scrollTop = 25;
    });
    await expect.poll(fits).toBe(true);
    const bottomBeforeScroll = await menu.evaluate((node) => node.getBoundingClientRect().bottom);
    await page.locator('[data-test-scroll-frame]').evaluate((node) => {
        node.scrollTop = 125;
    });
    await expect
        .poll(() => menu.evaluate((node) => node.getBoundingClientRect().bottom))
        .toBeCloseTo(bottomBeforeScroll - 100, 0);
    await expect.poll(fits).toBe(true);
});

test('a tiny embedded player keeps tracks usable in a viewport popup', async ({ page }) => {
    await page.locator('.player-container').evaluate((node: HTMLElement) => {
        Object.assign(node.style, {
            position: 'absolute',
            top: '20px',
            left: '20px',
            width: '350px',
            height: '180px',
        });
    });
    const menu = page.locator('.track-selector');
    await expect
        .poll(() => menu.evaluate((node) => node.getBoundingClientRect().height))
        .toBeGreaterThan(250);
    await expect(page.locator('.audio-section .track-chip').first()).toBeInViewport();
    await page.getByRole('button', { name: 'Subtitle Appearance', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
        page.getByRole('button', { name: 'Subtitle Appearance', exact: true }),
    ).toBeFocused();
});

test('native fullscreen retains menu placement and Close restores the trigger focus', async ({
    page,
}) => {
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Audio and subtitle tracks', exact: true });
    await expect(trigger).toBeFocused();
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await trigger.click();
    await expect
        .poll(() =>
            page.locator('.track-selector').evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const controls = node.closest('.controls-container')!.getBoundingClientRect();
                return rect.top >= 23 && rect.bottom <= controls.top && rect.height <= 640;
            }),
        )
        .toBe(true);
    await page.getByRole('button', { name: 'Close', exact: true }).press('Escape');
    await expect(trigger).toBeFocused();
});
