// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';

// Keep the seeded five-second fixture on screen while exercising the controls.
// These checks target browser keyboard activation, not media decoding.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = async function (): Promise<void> {};
    });
    await page.goto(`/watch/${TEST_MEDIA_ITEM_ID}`);
    await expect(page.getByRole('toolbar', { name: 'Video controls' })).toBeVisible();
    // The toolbar is server-rendered before hydration and asynchronous player
    // initialization. A loaded source proves the controls are ready for input.
    // A cold dev server can re-optimise dependencies during this load; SvelteKit
    // then reloads the page, which destroys the evaluate's execution context.
    // That attempt reads as "not ready yet" and the poll tries again on the new
    // document; the assertion (source loaded, metadata ready) is unchanged.
    await expect
        .poll(
            () =>
                page
                    .locator('video')
                    .evaluate(
                        (video: HTMLVideoElement) =>
                            video.currentSrc.length > 0 &&
                            video.readyState >= HTMLMediaElement.HAVE_METADATA,
                    )
                    .catch((error: unknown) => {
                        if (/Execution context was destroyed|navigation/i.test(String(error))) {
                            return false;
                        }
                        throw error;
                    }),
            { timeout: 20000 },
        )
        .toBe(true);
});

test('keyboard opens the speed menu and activates mute', async ({ page }) => {
    const speed = page.getByRole('button', { name: 'Playback speed', exact: true });
    await speed.focus();
    await speed.press('Enter');
    await expect(page.getByRole('button', { name: '1.5x', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '1.5x', exact: true }).press('Enter');
    await expect(speed).toContainText('1.5x');
    const mute = page.getByRole('button', { name: 'Mute (drag to adjust)', exact: true });
    await mute.press('Enter');
    await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible();
});

test('a rejected fullscreen request leaves the enter-fullscreen control available', async ({
    page,
}) => {
    await page.evaluate(() => {
        Element.prototype.requestFullscreen = () =>
            Promise.reject(new DOMException('Denied', 'NotAllowedError'));
    });
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enter fullscreen', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toHaveCount(0);
});

for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
]) {
    test(`mobile sound control remains available at ${viewport.width}x${viewport.height}`, async ({
        page,
    }) => {
        await page.setViewportSize(viewport);
        const volume = page.getByRole('group', { name: 'Volume control' });
        await expect(volume.getByRole('slider', { name: 'Volume' })).toBeHidden();
        await volume.getByRole('button', { name: 'Mute (drag to adjust)', exact: true }).click();
        await expect
            .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.muted))
            .toBe(true);
        await volume.getByRole('button', { name: 'Unmute', exact: true }).click();
        await expect
            .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.muted))
            .toBe(false);
        await expect(
            volume.getByRole('button', { name: 'Mute (drag to adjust)', exact: true }),
        ).toBeVisible();
    });
}

// Observe actual custom-slider controller assignments while keeping the seeded
// fixture paused. The original setter still runs; this covers browser input
// timing and real currentTime writes, rather than asserting video decoding.
test.describe('settled custom timeline commits', () => {
    test.beforeEach(async ({ page }) => {
        await page.clock.install({ time: new Date('2026-10-03T12:00:00Z') });
        await page.clock.pauseAt(new Date('2026-10-03T12:00:01Z'));
        await page.locator('video').evaluate((video: HTMLVideoElement) => {
            const descriptor = Object.getOwnPropertyDescriptor(
                HTMLMediaElement.prototype,
                'currentTime',
            );
            if (!descriptor?.get || !descriptor.set)
                throw new Error('Missing native media time accessors');
            const read = descriptor.get;
            const write = descriptor.set;
            const assignments: number[] = [];
            video.dataset.seekAssignments = '[]';
            Object.defineProperty(video, 'currentTime', {
                configurable: true,
                get: () => read.call(video),
                set: (time: number) => {
                    assignments.push(time);
                    video.dataset.seekAssignments = JSON.stringify(assignments);
                    write.call(video, time);
                },
            });
        });
    });

    test('a real mouse drag retains the preview and commits once at 150 ms', async ({ page }) => {
        const slider = page.getByRole('slider', { name: 'Video progress', exact: true });
        const box = await slider.boundingBox();
        if (!box) throw new Error('Missing progress slider geometry');
        const duration = Number(await slider.getAttribute('aria-valuemax'));
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width * 0.2, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.7, y);
        await expect
            .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
            .toBeCloseTo(duration * 0.7, 1);
        await expect(page.locator('video')).toHaveAttribute('data-seek-assignments', '[]');
        const preview = await slider.getAttribute('aria-valuenow');
        await page.mouse.up();
        await expect(slider).toHaveAttribute('aria-valuenow', preview!);
        await page.clock.runFor(149);
        await expect(page.locator('video')).toHaveAttribute('data-seek-assignments', '[]');
        await page.clock.runFor(1);
        const assignments = await page
            .locator('video')
            .evaluate((video) => JSON.parse(video.dataset.seekAssignments ?? '[]') as number[]);
        expect(assignments).toHaveLength(1);
        expect(assignments[0]).toBeCloseTo(duration * 0.7, 1);
    });

    test('a second held gesture cancels the first target until its own release settles', async ({
        page,
    }) => {
        const slider = page.getByRole('slider', { name: 'Video progress', exact: true });
        const box = await slider.boundingBox();
        if (!box) throw new Error('Missing progress slider geometry');
        const duration = Number(await slider.getAttribute('aria-valuemax'));
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width * 0.3, y);
        await page.mouse.down();
        await page.mouse.up();
        await page.clock.runFor(100);
        await page.mouse.move(box.x + box.width * 0.8, y);
        await page.mouse.down();
        await page.clock.runFor(500);
        await expect(page.locator('video')).toHaveAttribute('data-seek-assignments', '[]');
        await page.mouse.up();
        await page.clock.runFor(149);
        await expect(page.locator('video')).toHaveAttribute('data-seek-assignments', '[]');
        await page.clock.runFor(1);
        const assignments = await page
            .locator('video')
            .evaluate((video) => JSON.parse(video.dataset.seekAssignments ?? '[]') as number[]);
        expect(assignments).toHaveLength(1);
        expect(assignments[0]).toBeCloseTo(duration * 0.8, 1);
    });

    test('a global percentage shortcut supersedes a released timeline target', async ({ page }) => {
        const slider = page.getByRole('slider', { name: 'Video progress', exact: true });
        const box = await slider.boundingBox();
        if (!box) throw new Error('Missing progress slider geometry');
        const duration = Number(await slider.getAttribute('aria-valuemax'));
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
        await page.clock.runFor(100);
        const speed = page.getByRole('button', { name: 'Playback speed', exact: true });
        await speed.focus();
        await speed.press('5');
        await page.clock.runFor(500);
        const assignments = await page
            .locator('video')
            .evaluate((video) => JSON.parse(video.dataset.seekAssignments ?? '[]') as number[]);
        expect(assignments).toEqual([duration * 0.5]);
    });

    test('real browser touch drag commits only after release settles', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const touch = await page.context().newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled', {
            enabled: true,
            maxTouchPoints: 1,
        });
        const slider = page.getByRole('slider', { name: 'Video progress', exact: true });
        const box = await slider.boundingBox();
        if (!box) throw new Error('Missing progress slider geometry');
        const duration = Number(await slider.getAttribute('aria-valuemax'));
        const y = box.y + box.height / 2;
        await touch.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: box.x + box.width * 0.2, y }],
        });
        await touch.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: box.x + box.width * 0.65, y }],
        });
        await page.clock.runFor(500);
        await expect(page.locator('video')).toHaveAttribute('data-seek-assignments', '[]');
        await expect
            .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
            .toBeCloseTo(duration * 0.65, 1);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.clock.runFor(149);
        await expect(page.locator('video')).toHaveAttribute('data-seek-assignments', '[]');
        await page.clock.runFor(1);
        const assignments = await page
            .locator('video')
            .evaluate((video) => JSON.parse(video.dataset.seekAssignments ?? '[]') as number[]);
        expect(assignments).toHaveLength(1);
        expect(assignments[0]).toBeCloseTo(duration * 0.65, 1);
        await touch.detach();
    });
});
