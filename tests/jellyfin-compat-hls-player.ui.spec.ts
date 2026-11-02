// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E in a real browser: hls.js plays the /j HLS transcode through the seek
 * patterns players actually use, against the real server and FFmpeg.
 *
 * The HLS engine is shared by every client, and 2026-10-02 changed how it
 * handles a backward seek away from a generation that never served a segment
 * (parked, then reclaimed when the player returns — jellyfin-androidtv resumes
 * by fetching segment 0 first and jumping to the resume point) and made the /j
 * playlist cover the whole item when PlaybackInfo carries StartTimeTicks. Each
 * test asserts what a viewer sees: the duration is the whole film, frames
 * decode, and the playhead advances from where it was put — without a fatal
 * hls.js error.
 *
 * hls.js is served from node_modules into a page on the server's origin, so the
 * segment requests are the browser's own (same-origin, api_key in the URL, as
 * Jellyfin clients send it).
 *
 * Run with: npx playwright test tests/jellyfin-compat-hls-player.ui.spec.ts
 */

import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { sameOriginAdminTest as test, expect } from './fixtures/auth';
import {
    LONG_FIXTURE_SECONDS,
    endJellyfinPlayback,
    jellyfinToken,
    seedLongFixtureMovie,
    transcodingUrl,
} from './helpers/jellyfin-compat';

const ITEM_ID = 'e2e00000-0000-4000-8000-0000000000ac';
const RESUME_SECONDS = 120;
const HLS_JS = createRequire(import.meta.url).resolve('hls.js/dist/hls.min.js');

interface PlayerState {
    currentTime: number;
    duration: number;
    readyState: number;
    paused: boolean;
    fatal: string | null;
    decodedFrames: number;
}

/** A blank same-origin page with hls.js and a muted, autoplaying <video>. */
async function openPlayer(page: Page): Promise<void> {
    await page.goto('/j/System/Info/Public');
    await page.setContent(
        '<!doctype html><html><body><video id="v" muted playsinline width="640"></video></body></html>',
    );
    await page.addScriptTag({ path: HLS_JS });
}

async function load(page: Page, url: string, startPosition: number): Promise<void> {
    await page.evaluate(
        ({ url, startPosition }) => {
            const w = window as unknown as {
                Hls: new (cfg: object) => {
                    loadSource(u: string): void;
                    attachMedia(v: HTMLVideoElement): void;
                    on(
                        e: string,
                        cb: (ev: string, d: { fatal?: boolean; details?: string }) => void,
                    ): void;
                    destroy(): void;
                };
                __hls?: { destroy(): void };
                __fatal?: string | null;
            };
            w.__hls?.destroy();
            w.__fatal = null;
            const video = document.getElementById('v') as HTMLVideoElement;
            const hls = new w.Hls({ startPosition, maxBufferLength: 20 });
            hls.on('hlsError', (_e, data) => {
                if (data.fatal) w.__fatal = data.details ?? 'fatal';
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            void video.play().catch(() => {});
            w.__hls = hls;
        },
        { url, startPosition },
    );
}

async function state(page: Page): Promise<PlayerState> {
    return page.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement;
        const quality = v.getVideoPlaybackQuality?.();
        return {
            currentTime: v.currentTime,
            duration: v.duration,
            readyState: v.readyState,
            paused: v.paused,
            fatal: (window as unknown as { __fatal?: string | null }).__fatal ?? null,
            decodedFrames: quality?.totalVideoFrames ?? 0,
        };
    });
}

/** Wait until the playhead has played `seconds` past `from` (decoding frames all along). */
async function expectPlaysFrom(page: Page, from: number, seconds = 4, timeoutMs = 90_000) {
    await expect
        .poll(
            async () => {
                const s = await state(page);
                if (s.fatal) throw new Error(`hls.js fatal error: ${s.fatal}`);
                return s.currentTime;
            },
            { timeout: timeoutMs, intervals: [500] },
        )
        .toBeGreaterThan(from + seconds);
    const s = await state(page);
    expect(s.readyState).toBeGreaterThanOrEqual(2);
    expect(s.decodedFrames).toBeGreaterThan(0);
}

async function seek(page: Page, to: number): Promise<void> {
    await page.evaluate((to) => {
        (document.getElementById('v') as HTMLVideoElement).currentTime = to;
    }, to);
}

test.describe('/j HLS transcode in a real browser (hls.js)', () => {
    test.describe.configure({ mode: 'serial', timeout: 300_000 });

    let token: string;
    const sessions: string[] = [];

    test.beforeAll(async ({ request }) => {
        await seedLongFixtureMovie(ITEM_ID, 'E2E HLS Player Video');
        token = await jellyfinToken(request, 'e2e-hls-player');
    });

    test.afterEach(async ({ request }) => {
        for (const sid of sessions.splice(0)) {
            await endJellyfinPlayback(request, token, ITEM_ID, sid);
        }
    });

    test('resume: starts at the resume point and the film is full length', async ({
        page,
        request,
    }) => {
        const { url, playSessionId } = await transcodingUrl(
            request,
            token,
            ITEM_ID,
            RESUME_SECONDS,
        );
        sessions.push(playSessionId);
        await openPlayer(page);
        await load(page, url, RESUME_SECONDS);

        await expectPlaysFrom(page, RESUME_SECONDS);
        expect((await state(page)).currentTime).toBeGreaterThanOrEqual(RESUME_SECONDS);
        // The whole item, not "item minus resume point".
        expect((await state(page)).duration).toBeGreaterThanOrEqual(LONG_FIXTURE_SECONDS - 6);
    });

    test('Android TV pattern: start at 0, then jump to the resume point', async ({
        page,
        request,
    }) => {
        const { url, playSessionId } = await transcodingUrl(
            request,
            token,
            ITEM_ID,
            RESUME_SECONDS,
        );
        sessions.push(playSessionId);
        await openPlayer(page);
        await load(page, url, 0);

        // The probe: the player reads from 0 first…
        await expectPlaysFrom(page, 0, 1);
        // …then jumps to where it should resume.
        await seek(page, RESUME_SECONDS);
        await expectPlaysFrom(page, RESUME_SECONDS);

        const jobs = (await (await request.get('/api/admin/ffmpeg-jobs')).json()) as {
            jobs: Array<{ playSessionId: string; seekCount: number }>;
        };
        const fold = (id: string) => id.replace(/-/g, '').toLowerCase();
        const job = jobs.jobs.find((j) => fold(j.playSessionId) === fold(playSessionId));
        expect(job, 'the session is still transcoding').toBeTruthy();
        // Started at T, probed 0, back to T: never a third encode.
        expect(job!.seekCount).toBeLessThanOrEqual(1);
    });

    test('seeks back to the start and forward again keep playing', async ({ page, request }) => {
        const { url, playSessionId } = await transcodingUrl(
            request,
            token,
            ITEM_ID,
            RESUME_SECONDS,
        );
        sessions.push(playSessionId);
        await openPlayer(page);
        await load(page, url, RESUME_SECONDS);
        await expectPlaysFrom(page, RESUME_SECONDS);

        // A real seek to 0: playback continues from the start.
        await seek(page, 0);
        await expectPlaysFrom(page, 0);
        expect((await state(page)).currentTime).toBeLessThan(RESUME_SECONDS);

        // And far forward again.
        await seek(page, 200);
        await expectPlaysFrom(page, 200, 3);
    });

    test('a fresh PlaybackInfo at the current position (track switch) resumes there', async ({
        page,
        request,
    }) => {
        const first = await transcodingUrl(request, token, ITEM_ID, 0);
        sessions.push(first.playSessionId);
        await openPlayer(page);
        await load(page, first.url, 0);
        await expectPlaysFrom(page, 0, 2);
        await seek(page, 60);
        await expectPlaysFrom(page, 60, 2);

        // An audio/subtitle switch: the client stops and asks again at its position.
        const position = Math.floor((await state(page)).currentTime);
        const second = await transcodingUrl(request, token, ITEM_ID, position);
        sessions.push(second.playSessionId);
        await load(page, second.url, position);
        await expectPlaysFrom(page, position, 3);
    });
});
