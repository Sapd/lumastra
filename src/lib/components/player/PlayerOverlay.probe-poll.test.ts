// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import * as m from '$lib/paraglide/messages.js';
import PlayerOverlay from './PlayerOverlay.svelte';
import { playerStore } from './playerStore.svelte';

// Prod 2026-09-25: one stuck player sent 4,949 GET /probe-status in 83 minutes,
// every answer `{"probing":false}`. The seam is the component's own loop: mount
// it in a long buffering window where no probe ever runs and count requests.
describe('PlayerOverlay /probe-status polling', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock = vi.fn(async () => new Response('{"probing":false}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        playerStore.isLoading = false;
        playerStore.isBuffering = true;
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        playerStore.isBuffering = false;
        playerStore.isLoading = true;
    });

    it('stops polling within a bounded number of requests when no probe ever runs', async () => {
        render(PlayerOverlay, { props: { itemId: 'item-1' } });
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        const probeCalls = fetchMock.mock.calls.filter(([url]) =>
            String(url).includes('/probe-status'),
        );
        expect(probeCalls.length).toBeGreaterThan(0);
        // Old behavior: one request every 600ms for the whole window (~1,000).
        expect(probeCalls.length).toBeLessThan(60);
    });

    it('treats a missing item as terminal across buffering windows, but polls a new item', async () => {
        fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
        const view = render(PlayerOverlay, { props: { itemId: 'missing-item' } });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        playerStore.isBuffering = false;
        await vi.advanceTimersByTimeAsync(1);
        playerStore.isBuffering = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await view.rerender({ itemId: 'another-item' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('backs off and gives up on transient HTTP failures', async () => {
        fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
        render(PlayerOverlay, { props: { itemId: 'unavailable-item' } });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
        expect(fetchMock.mock.calls.length).toBeLessThan(60);
    });

    it.each(['http', 'network'])('bounds %s failures even after a probe started', async (kind) => {
        fetchMock.mockImplementationOnce(async () => new Response('{"probing":true}'));
        fetchMock.mockImplementation(async () => {
            if (kind === 'network') throw new TypeError('Failed to fetch');
            return new Response(null, { status: 503 });
        });
        render(PlayerOverlay, { props: { itemId: 'started-probe' } });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
        expect(fetchMock.mock.calls.length).toBeLessThan(60);
    });

    // Prod 2026-10-21: Live TV played at /watch/<station id> polled
    // /api/playback/<station id>/probe-status every 1-2 s and got 404 each time
    // (a station id is a backup-group id, not a media item). Live TV has no
    // keyframe probe, so the loop must not start at all.
    it('does not poll /probe-status during Live TV playback', async () => {
        playerStore.isLive = true;
        try {
            render(PlayerOverlay, { props: { itemId: 'station-1' } });
            await vi.advanceTimersByTimeAsync(60_000);
            const probeCalls = fetchMock.mock.calls.filter(([url]) =>
                String(url).includes('/probe-status'),
            );
            expect(probeCalls).toHaveLength(0);
        } finally {
            playerStore.isLive = false;
        }
    });

    describe('encoder notice before the first heartbeat', () => {
        const SESSION = '0d6c0f8e-7a4b-4c55-9a7e-2f1c3b4d5e6f';
        afterEach(() => {
            playerStore.playSessionId = null;
            playerStore.transcodeProgress = null;
        });

        it('asks for this session and shows the busy-encoder notice while buffering', async () => {
            fetchMock.mockImplementation(
                async () =>
                    new Response('{"probing":false,"encoder":{"slowReason":"gpu_busy"}}', {
                        status: 200,
                    }),
            );
            playerStore.playSessionId = SESSION;
            const view = render(PlayerOverlay, { props: { itemId: 'item-1' } });
            await vi.advanceTimersByTimeAsync(1000);

            const urls = fetchMock.mock.calls.map(([url]) => String(url));
            expect(urls.some((u) => u.includes(`/probe-status?session=${SESSION}`))).toBe(true);
            expect(view.getByText(m.player_notice_encoder_busy())).toBeTruthy();

            // Playback resumes: the poll's last answer is stale, the notice goes.
            playerStore.isBuffering = false;
            await vi.advanceTimersByTimeAsync(100);
            expect(view.queryByText(m.player_notice_encoder_busy())).toBeNull();
        });

        it('keeps polling (bounded) after a keyframe probe finished, for the encoder notice', async () => {
            let call = 0;
            fetchMock.mockImplementation(async () => {
                call++;
                const body =
                    call <= 2
                        ? '{"probing":true,"phase":"probing","startedAt":1,"currentSeconds":1}'
                        : call < 10
                          ? '{"probing":false}'
                          : '{"probing":false,"encoder":{"slowReason":"cpu_slow"}}';
                return new Response(body, { status: 200 });
            });
            playerStore.playSessionId = SESSION;
            const view = render(PlayerOverlay, { props: { itemId: 'item-1' } });
            await vi.advanceTimersByTimeAsync(40_000);
            expect(view.getByText(m.player_notice_cpu_slow())).toBeTruthy();

            await vi.advanceTimersByTimeAsync(10 * 60_000);
            const probeCalls = fetchMock.mock.calls.filter(([url]) =>
                String(url).includes('/probe-status'),
            );
            expect(probeCalls.length).toBeLessThan(60);
        });

        it('a fallback seen once does not show again when the first heartbeat takes over', async () => {
            fetchMock.mockImplementation(
                async () =>
                    new Response(
                        '{"probing":false,"encoder":{"softwareFallbackFrom":"hevc_nvenc"}}',
                        {
                            status: 200,
                        },
                    ),
            );
            playerStore.playSessionId = SESSION;
            const view = render(PlayerOverlay, { props: { itemId: 'item-1' } });
            await vi.advanceTimersByTimeAsync(1000);
            expect(view.getByText(m.player_notice_software_fallback())).toBeTruthy();

            await vi.advanceTimersByTimeAsync(11_000);
            expect(view.queryByText(m.player_notice_software_fallback())).toBeNull();
            playerStore.isBuffering = false;
            playerStore.setTranscodeProgress({
                progressPercent: 10,
                segmentsReady: 3,
                totalSegments: 100,
                elapsedSeconds: 20,
                softwareFallbackFrom: 'hevc_nvenc',
            });
            await vi.advanceTimersByTimeAsync(1000);
            expect(view.queryByText(m.player_notice_software_fallback())).toBeNull();
        });
    });
});
