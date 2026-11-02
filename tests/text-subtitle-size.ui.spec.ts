// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CDPSession, Page } from '@playwright/test';
import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import { PlayabilityResponseSchema } from '../src/lib/schemas/api-playability';
import {
    PlaybackStartRequestSchema,
    PlaybackStartResponseSchema,
} from '../src/lib/schemas/playback-start';

// Give the real player an owned track; arbitrary browser tracks must stay Off.
async function installTextSubtitle(page: Page): Promise<void> {
    const subtitle = {
        id: 'caption-regression',
        index: 1000,
        absoluteIndex: 1000,
        codec: 'srt',
        language: 'en',
        title: 'Caption regression',
        default: true,
        forced: false,
        format: 'text' as const,
        source: 'sidecar' as const,
        method: 'external_vtt' as const,
    };
    await page.route('**/api/media/*/playability', async (route) => {
        const response = await route.fetch();
        const probe = PlayabilityResponseSchema.parse(await response.json());
        for (const version of probe.versions) version.tracks.subtitles = [subtitle];
        if (probe.recommended) probe.recommended.subtitleId = subtitle.id;
        await route.fulfill({ response, json: probe });
    });
    await page.route('**/api/play-sessions', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const request = PlaybackStartRequestSchema.parse(route.request().postDataJSON());
        const response = await route.fetch({ postData: { ...request, subtitleId: 'none' } });
        expect(response.status(), await response.text()).toBe(201);
        const start = PlaybackStartResponseSchema.parse(await response.json());
        if ('playMethod' in start.delivery) {
            start.delivery.applied = { ...start.delivery.applied, subtitleId: subtitle.id };
            if (start.delivery.tracks) start.delivery.tracks.subtitles = [subtitle];
            Object.assign(start.delivery, {
                subtitles: [
                    {
                        ...subtitle,
                        kind: 'external',
                        hrefs: { text: '/caption-regression.vtt' },
                    },
                ],
            });
        }
        await route.fulfill({ response, json: PlaybackStartResponseSchema.parse(start) });
    });
    // Seeking reloads VTT with a cache-buster. Match that resource too; an
    // exact glob passed only before the post-seek reload reached the server.
    await page.route(/\/caption-regression\.vtt(?:\?|$)/, (route) =>
        route.fulfill({
            contentType: 'text/vtt',
            body: 'WEBVTT\n\n00:00.000 --> 00:05.000\nSubtitle size regression\n',
        }),
    );
}

// Native captions live inside Chromium's user-agent shadow tree. Inspect the
// painted cue, not getComputedStyle(video, '::cue'), which describes the host.
async function paintedCueSize(cdp: CDPSession): Promise<string | undefined> {
    const tree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    type TreeNode = typeof tree.root;
    function findCue(node: TreeNode): TreeNode | undefined {
        if (node.nodeValue === 'Subtitle size regression') return node;
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
            const found = findCue(child);
            if (found) return found;
        }
        return undefined;
    }
    const cue = findCue(tree.root);
    if (!cue?.parentId) return undefined;
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: cue.parentId });
    if (model.width <= 0 || model.height <= 0) return undefined;
    const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', {
        nodeId: cue.parentId,
    });
    return computedStyle.find((property) => property.name === 'font-size')?.value;
}

for (const { scale, initialSize, resizedSize } of [
    { scale: 1, initialSize: 34, resizedSize: 22 },
    { scale: 1.5, initialSize: 50, resizedSize: 34 },
]) {
    test(`native subtitle paint follows player size at ${scale}x user scale`, async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await installTextSubtitle(page);
        await page.route('**/api/me/playback-preferences', async (route) => {
            const response = await route.fetch();
            const preferences = await response.json();
            await route.fulfill({
                response,
                json: {
                    ...preferences,
                    updatedAt: '2099-10-04T00:00:00.000Z',
                    subtitlesEnabled: true,
                    subtitleLanguage: 'en',
                    subtitleTrackHint: null,
                    subtitleStyle: {
                        preset: 'default',
                        fontFamily: 'system',
                        textColor: '#FFFFFF',
                        backgroundColor: 'rgba(0, 0, 0, 0.75)',
                        outlineColor: '#000000',
                        outlineWidth: 0,
                        shadowBlur: 4,
                        positionY: 85,
                        ...preferences.subtitleStyle,
                        fontSize: scale,
                    },
                },
            });
        });
        // Keep the seeded five-second video paused while inspecting a real cue.
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = async function (): Promise<void> {};
        });
        await page.goto(`/watch/${TEST_MEDIA_ITEM_ID}`);
        const video = page.locator('video');
        await expect
            .poll(
                () =>
                    video.evaluate(
                        (element: HTMLVideoElement) =>
                            element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
                    ),
                { timeout: 20000 },
            )
            .toBe(true);
        const reloadedCaptions = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.pathname === '/caption-regression.vtt' && url.searchParams.has('_t');
        });
        await video.evaluate((element: HTMLVideoElement) => {
            // Always move, including when the shared fixture has saved progress.
            element.currentTime = element.currentTime < 2 ? 2 : 1;
        });
        expect((await reloadedCaptions).status()).toBe(200);
        await expect
            .poll(() =>
                video.evaluate((element: HTMLVideoElement) =>
                    Array.from(element.textTracks).map((track) => ({
                        mode: track.mode,
                        cues: Array.from(track.activeCues ?? []).map((cue) => (cue as VTTCue).text),
                    })),
                ),
            )
            .toEqual([{ mode: 'showing', cues: ['Subtitle size regression'] }]);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        try {
            await expect.poll(() => paintedCueSize(cdp)).toBe(`${initialSize}px`);
            await page.setViewportSize({ width: 1280, height: 720 });
            await expect.poll(() => paintedCueSize(cdp)).toBe(`${resizedSize}px`);
        } finally {
            await cdp.detach();
        }
    });
}

test('late browser captions cannot bypass Off at startup', async ({ page }) => {
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = async function (): Promise<void> {};
    });
    await page.goto(`/watch/${TEST_MEDIA_ITEM_ID}`);
    const video = page.locator('video');
    await expect
        .poll(
            () =>
                video.evaluate(
                    (element: HTMLVideoElement) =>
                        element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
                ),
            { timeout: 20000 },
        )
        .toBe(true);
    await video.evaluate((element: HTMLVideoElement) => {
        const track = element.addTextTrack('captions', 'Late browser caption', 'en');
        track.addCue(new VTTCue(0, 5, 'Should remain off'));
        track.mode = 'showing';
        element.currentTime = 1;
    });
    await expect
        .poll(() =>
            video.evaluate(
                (element: HTMLVideoElement) =>
                    Array.from(element.textTracks).find(
                        (track) => track.label === 'Late browser caption',
                    )?.mode,
            ),
        )
        .toBe('disabled');
});
