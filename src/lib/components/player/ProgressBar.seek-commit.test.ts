// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, type RenderResult } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgressBar from './ProgressBar.svelte';
import { playerStore } from './playerStore.svelte';
import { PlayerController } from './player-controller.svelte';
import { TrickplayLoader } from './trickplay/TrickplayLoader';
import { DEFAULT_TRANSCODING_PROFILES } from '$lib/types/playback';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    playerStore.reset();
});

function renderProgressBar(onseek: (time: number) => void): {
    container: HTMLElement;
    progressContainer: HTMLElement;
    rerender: RenderResult<typeof ProgressBar>['rerender'];
    unmount: () => void;
} {
    const { container, rerender, unmount } = render(ProgressBar, {
        props: {
            currentTime: 10,
            duration: 100,
            bufferedPercent: 50,
            progressPercent: 10,
            onseek,
        },
    });
    const progressContainer = container.querySelector<HTMLElement>('.progress-container');
    const progressBar = container.querySelector<HTMLElement>('.progress-bar');
    expect(progressContainer).toBeTruthy();
    expect(progressBar).toBeTruthy();
    progressBar!.getBoundingClientRect = () =>
        ({
            left: 0,
            right: 100,
            top: 0,
            bottom: 4,
            width: 100,
            height: 4,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;
    return { container, progressContainer: progressContainer!, rerender, unmount };
}

function seedTrickplay(): void {
    const manifest = {
        fileId: '12345678-1234-4234-8234-123456789abc',
        width: 320,
        height: 180,
        tileColumns: 10,
        tileRows: 10,
        intervalMs: 10_000,
        thumbnailCount: 100,
        sheets: [{ index: 0, startMs: 0, endMs: 1_000_000, href: '/ready/sheet?grant=opaque' }],
    };
    playerStore.itemId = 'item-1';
    playerStore.currentMediaSource = { id: manifest.fileId } as NonNullable<typeof playerStore.currentMediaSource>;
    playerStore.trickplayVariants = [{ width: 320, manifestHref: '/ready/manifest?grant=opaque' }];
    vi.stubGlobal('fetch', vi.fn(async (href: string) => href.includes('/manifest')
        ? new Response(JSON.stringify(manifest))
        : new Response(new Uint8Array([1]))));
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = vi.fn(() => 'blob:sheet');
        static revokeObjectURL = vi.fn();
    });
}

function dispatchTouch(
    target: EventTarget,
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    touches: Array<{ clientX: number; clientY: number }>,
): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: touches });
    target.dispatchEvent(event);
}

describe('ProgressBar deferred seek', () => {
    it('previews a mouse scrub and seeks once after release settles', async () => {
        const onseek = vi.fn();
        const { container, progressContainer } = renderProgressBar(onseek);

        progressContainer.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, clientX: 20, clientY: 2 }),
        );
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 70, clientY: 2 }));
        await tick();
        // Pausing movement while still held must never start a seek timer.
        vi.advanceTimersByTime(500);

        expect(onseek).not.toHaveBeenCalled();
        expect(container.querySelector<HTMLElement>('.progress-played')?.style.width).toBe('70%');

        window.dispatchEvent(new MouseEvent('mouseup'));

        await tick();
        expect(container.querySelector<HTMLElement>('.progress-played')?.style.width).toBe('70%');
        vi.advanceTimersByTime(149);
        expect(onseek).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onseek).toHaveBeenCalledExactlyOnceWith(70);
    });

    it('previews a touch scrub and seeks once after release settles', async () => {
        const onseek = vi.fn();
        const { container, progressContainer } = renderProgressBar(onseek);

        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 25, clientY: 2 }]);
        dispatchTouch(progressContainer, 'touchmove', [{ clientX: 80, clientY: 2 }]);
        await tick();
        // Pausing movement while still held must never start a seek timer.
        vi.advanceTimersByTime(500);

        expect(onseek).not.toHaveBeenCalled();
        expect(container.querySelector<HTMLElement>('.progress-played')?.style.width).toBe('80%');

        dispatchTouch(progressContainer, 'touchend', []);

        await tick();
        expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe(
            '80',
        );
        vi.advanceTimersByTime(149);
        expect(onseek).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onseek).toHaveBeenCalledExactlyOnceWith(80);
    });

    it('commits a touch tap once when WebKit follows it with compatibility mouse events', () => {
        vi.useFakeTimers();
        const onseek = vi.fn();
        const { progressContainer } = renderProgressBar(onseek);
        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 52.5, clientY: 2 }]);
        dispatchTouch(progressContainer, 'touchend', []);
        vi.advanceTimersByTime(300);
        progressContainer.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                clientX: 52,
                clientY: 2,
            }),
        );
        window.dispatchEvent(new MouseEvent('mouseup'));
        expect(onseek).toHaveBeenCalledExactlyOnceWith(52.5);

        // A later real mouse drag on a hybrid device must still work.
        vi.advanceTimersByTime(1000);
        progressContainer.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                clientX: 70,
                clientY: 2,
            }),
        );
        window.dispatchEvent(new MouseEvent('mouseup'));
        vi.advanceTimersByTime(150);
        expect(onseek.mock.calls.map(([time]) => time)).toEqual([52.5, 70]);
    });

    it('accepts a known real mouse immediately after touch on a hybrid device', () => {
        const onseek = vi.fn();
        const { progressContainer } = renderProgressBar(onseek);
        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 25, clientY: 2 }]);
        dispatchTouch(progressContainer, 'touchend', []);
        const mouse = new MouseEvent('mousedown', { bubbles: true, clientX: 80, clientY: 2 });
        Object.defineProperty(mouse, 'sourceCapabilities', { value: { firesTouchEvents: false } });
        progressContainer.dispatchEvent(mouse);
        window.dispatchEvent(new MouseEvent('mouseup'));
        expect(onseek).not.toHaveBeenCalled();
        vi.advanceTimersByTime(150);
        expect(onseek).toHaveBeenCalledExactlyOnceWith(80);
    });

    it('does not seek when a touch scrub is cancelled', () => {
        const onseek = vi.fn();
        const { progressContainer } = renderProgressBar(onseek);

        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 25, clientY: 2 }]);
        dispatchTouch(progressContainer, 'touchmove', [{ clientX: 80, clientY: 2 }]);
        dispatchTouch(progressContainer, 'touchcancel', []);

        expect(onseek).not.toHaveBeenCalled();
    });

    it('does not seek during upward precision scrubbing until release', async () => {
        seedTrickplay();

        const onseek = vi.fn();
        const { progressContainer } = renderProgressBar(onseek);
        await vi.advanceTimersByTimeAsync(0);
        await tick();

        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 50, clientY: 100 }]);
        dispatchTouch(progressContainer, 'touchmove', [{ clientX: 80, clientY: 30 }]);
        dispatchTouch(progressContainer, 'touchmove', [{ clientX: 100, clientY: 30 }]);
        await tick();

        expect(onseek).not.toHaveBeenCalled();

        dispatchTouch(progressContainer, 'touchend', []);

        vi.advanceTimersByTime(150);
        expect(onseek).toHaveBeenCalledOnce();
        expect(onseek.mock.calls[0][0]).toBeGreaterThan(50);
    });
});

it.each([
    ['ArrowRight', 20],
    ['ArrowLeft', 0],
    ['Home', 0],
    ['End', 100],
])('seeks with focused slider key %s', (key, expected) => {
    const onseek = vi.fn();
    const { container } = renderProgressBar(onseek);
    const event = new KeyboardEvent('keydown', {
        key: String(key),
        bubbles: true,
        cancelable: true,
    });
    container.querySelector('[role="slider"]')!.dispatchEvent(event);
    expect(onseek).toHaveBeenCalledExactlyOnceWith(expected);
    expect(event.defaultPrevented).toBe(true);
});

it('cancels the older target as soon as another gesture starts, even while held', async () => {
    const onseek = vi.fn();
    const { progressContainer } = renderProgressBar(onseek);
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 25, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    vi.advanceTimersByTime(100);
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    vi.advanceTimersByTime(500);
    expect(onseek).not.toHaveBeenCalled();
    dispatchTouch(progressContainer, 'touchend', []);
    vi.advanceTimersByTime(149);
    expect(onseek).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onseek).toHaveBeenCalledExactlyOnceWith(80);
    await tick();
});

describe.each(['held', 'released'] as const)('%s seek cancellation', (stage) => {
    it.each([
        'unmount',
        'cancel',
        'item',
        'source',
        'permission',
        'duration',
        'session',
        'switch',
        'playbackInfo',
        'quality',
        'audio',
        'seek',
    ] as const)('cancels the preview on %s', async (reason) => {
        const onseek = vi.fn();
        const { container, progressContainer, rerender, unmount } = renderProgressBar(onseek);
        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
        if (stage === 'released') dispatchTouch(progressContainer, 'touchend', []);
        await tick();
        if (reason === 'unmount') unmount();
        if (reason === 'cancel') dispatchTouch(progressContainer, 'touchcancel', []);
        if (reason === 'item') playerStore.itemId = 'replacement';
        if (reason === 'source')
            playerStore.currentMediaSource = { id: 'replacement' } as NonNullable<
                typeof playerStore.currentMediaSource
            >;
        if (reason === 'permission') await rerender({ isGuestInWatchParty: true });
        if (reason === 'duration') await rerender({ duration: 0 });
        if (reason === 'session') playerStore.setPlaySessionId('replacement-session');
        if (reason === 'switch') playerStore.setVersionSwitching(true);
        if (reason === 'playbackInfo')
            playerStore.playbackInfo = {} as unknown as NonNullable<
                typeof playerStore.playbackInfo
            >;
        if (reason === 'quality')
            playerStore.currentQualityProfile = DEFAULT_TRANSCODING_PROFILES[1];
        if (reason === 'audio') playerStore.currentAudioTrackIndex = 1;
        if (reason === 'seek') playerStore.setSeeking(true);
        await tick();
        if (stage === 'held') {
            // Later move/release events cannot revive a cancelled gesture.
            dispatchTouch(progressContainer, 'touchmove', [{ clientX: 90, clientY: 2 }]);
            dispatchTouch(progressContainer, 'touchend', []);
        }
        vi.advanceTimersByTime(500);
        expect(onseek).not.toHaveBeenCalled();
        if (reason !== 'unmount') {
            expect(container.querySelector<HTMLElement>('.progress-played')?.style.width).toBe(
                '10%',
            );
        }
    });
});

it('a slider keyboard seek supersedes the pending gesture immediately', () => {
    const onseek = vi.fn();
    const { container, progressContainer } = renderProgressBar(onseek);
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    container
        .querySelector('[role="slider"]')!
        .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
        );
    expect(onseek).toHaveBeenCalledExactlyOnceWith(20);
    vi.advanceTimersByTime(500);
    expect(onseek).toHaveBeenCalledOnce();
});

it('guests cannot seek using touch, mouse or keyboard', async () => {
    const onseek = vi.fn();
    const { container, progressContainer, rerender } = renderProgressBar(onseek);
    await rerender({ isGuestInWatchParty: true });
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    progressContainer.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 80, clientY: 2 }),
    );
    window.dispatchEvent(new MouseEvent('mouseup'));
    container
        .querySelector('[role="slider"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(onseek).not.toHaveBeenCalled();
});

it.each([0, -100, NaN, Infinity])('does not commit with invalid duration %s', async (duration) => {
    const onseek = vi.fn();
    const { progressContainer, rerender } = renderProgressBar(onseek);
    await rerender({ duration });
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    vi.advanceTimersByTime(500);
    expect(onseek).not.toHaveBeenCalled();
});

it('does not commit when bar geometry is invalid', () => {
    const onseek = vi.fn();
    const { container, progressContainer } = renderProgressBar(onseek);
    container.querySelector<HTMLElement>('.progress-bar')!.getBoundingClientRect = () =>
        ({ left: 0, width: 0 }) as DOMRect;
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    vi.advanceTimersByTime(500);
    expect(onseek).not.toHaveBeenCalled();
});

it.each(['held', 'released'] as const)(
    'a real controller seek supersedes a %s timeline intention',
    async (stage) => {
        const video = document.createElement('video');
        video.currentTime = 10;
        const assignedTime = vi.spyOn(video, 'currentTime', 'set');
        const controller = Object.create(PlayerController.prototype) as PlayerController;
        const fields = {
            videoElement: video,
            playbackManager: { isHlsMode: () => true, isNativeEngine: () => true },
            isDirectStreamMode: false,
            isWatchPartyGuest: false,
            canSyncToWatchParty: false,
            telemetryCtrl: { seekStartPosition: 0 },
            log: vi.fn(),
            warn: vi.fn(),
            DEBUG: false,
        };
        for (const [key, value] of Object.entries(fields))
            Object.defineProperty(controller, key, { value, configurable: true });
        playerStore.duration = 100;
        // A second seek while already seeking must still invalidate older intent.
        playerStore.setSeeking(true);
        const onseek = vi.fn((time: number) => controller.seekTo(time));
        const { progressContainer } = renderProgressBar(onseek);
        dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
        if (stage === 'released') dispatchTouch(progressContainer, 'touchend', []);
        controller.seekTo(50, false, 'watch_party_sync');
        // No tick here: the synchronous context guard must also beat effect cleanup.
        if (stage === 'held') {
            dispatchTouch(progressContainer, 'touchmove', [{ clientX: 90, clientY: 2 }]);
            dispatchTouch(progressContainer, 'touchend', []);
        }
        vi.advanceTimersByTime(500);
        expect(onseek).not.toHaveBeenCalled();
        expect(assignedTime).toHaveBeenCalledExactlyOnceWith(50);
        await tick();
    },
);

it('normal time updates preserve a pending preview', async () => {
    const onseek = vi.fn();
    const { container, progressContainer, rerender } = renderProgressBar(onseek);
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    playerStore.setCurrentTime(11);
    await rerender({ currentTime: 11, progressPercent: 11 });
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('80');
    vi.advanceTimersByTime(150);
    expect(onseek).toHaveBeenCalledExactlyOnceWith(80);
});

it('rejects timeline and keyboard input while the source is switching', () => {
    playerStore.setVersionSwitching(true);
    const onseek = vi.fn();
    const { container, progressContainer } = renderProgressBar(onseek);
    dispatchTouch(progressContainer, 'touchstart', [{ clientX: 80, clientY: 2 }]);
    dispatchTouch(progressContainer, 'touchend', []);
    container
        .querySelector('[role="slider"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(onseek).not.toHaveBeenCalled();
});

it('invalid hover geometry clears the preview without requesting trickplay', async () => {
    const request = vi.spyOn(TrickplayLoader.prototype, 'requestSheet');
    const onseek = vi.fn();
    const { container, progressContainer } = renderProgressBar(onseek);
    container.querySelector<HTMLElement>('.progress-bar')!.getBoundingClientRect = () =>
        ({ left: 0, width: 0 }) as DOMRect;
    progressContainer.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 2 }),
    );
    await tick();
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(request).not.toHaveBeenCalled();
});

it.each(['mouse', 'touch', 'filmstrip'] as const)(
    'invalid geometry cancels a %s drag even if it recovers before release',
    async (input) => {
        if (input === 'filmstrip') seedTrickplay();
        const request = vi.spyOn(TrickplayLoader.prototype, 'requestSheet');
        const onseek = vi.fn();
        const { container, progressContainer } = renderProgressBar(onseek);
        if (input === 'filmstrip') {
            await vi.advanceTimersByTimeAsync(0);
            await tick();
        }
        const bar = container.querySelector<HTMLElement>('.progress-bar')!;
        const originalGeometry = bar.getBoundingClientRect;
        if (input === 'mouse')
            progressContainer.dispatchEvent(
                new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 100 }),
            );
        else dispatchTouch(progressContainer, 'touchstart', [{ clientX: 50, clientY: 100 }]);
        if (input === 'filmstrip')
            dispatchTouch(progressContainer, 'touchmove', [{ clientX: 80, clientY: 30 }]);
        request.mockClear();
        bar.getBoundingClientRect = () => ({ left: 0, width: 0 }) as DOMRect;
        if (input === 'mouse')
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 30 }));
        else dispatchTouch(progressContainer, 'touchmove', [{ clientX: 80, clientY: 30 }]);
        await tick();
        expect(container.textContent).not.toMatch(/NaN|Infinity/);
        expect(request).not.toHaveBeenCalled();
        expect(bar.getAttribute('aria-valuenow')).toBe('10');
        bar.getBoundingClientRect = originalGeometry;
        if (input === 'mouse') window.dispatchEvent(new MouseEvent('mouseup'));
        else dispatchTouch(progressContainer, 'touchend', []);
        vi.advanceTimersByTime(500);
        expect(onseek).not.toHaveBeenCalled();
    },
);
