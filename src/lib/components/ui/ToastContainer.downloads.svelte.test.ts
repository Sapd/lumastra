// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The download queue card lives INSIDE the toast stack, as its bottom item.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '' }));

import ToastContainer from './ToastContainer.svelte';
import { toasts } from '$lib/stores/toast.store';
import { downloadQueue, type QueueItem } from '$lib/downloads/download-queue.svelte';

function qi(over: Partial<QueueItem> = {}): QueueItem {
    return {
        mediaItemId: 'e',
        fileId: 'f-1',
        season: 1,
        episode: 1,
        seasonFolder: 'Season 01',
        fileName: 'one.mkv',
        sizeBytes: 100,
        available: true,
        path: ['one.mkv'],
        status: 'active',
        bytesDone: 0,
        ...over,
    };
}

function run(items: QueueItem[], state: 'running' | 'done' | 'stopped' = 'running') {
    downloadQueue.items = items;
    downloadQueue.current = items.find((i) => i.status === 'active') ?? null;
    downloadQueue.mode = 'folder';
    downloadQueue.bytesTotal = 1000;
    downloadQueue.bytesDone = 420;
    downloadQueue.speed = 12_000_000;
    downloadQueue.state = state;
}

describe('download card in the toast stack', () => {
    beforeAll(() => {
        if (!Element.prototype.animate) {
            Element.prototype.animate = (() => {
                const anim = {
                    cancel: () => {},
                    finished: Promise.resolve(),
                    addEventListener: (_e: string, h: EventListener) =>
                        queueMicrotask(() => h(new Event('finish'))),
                    onfinish: null as EventListener | null,
                } as unknown as Animation;
                queueMicrotask(() => anim.onfinish?.(new Event('finish') as never));
                return anim;
            }) as typeof Element.prototype.animate;
        }
    });
    beforeEach(() => toasts.clear());
    afterEach(() => {
        vi.useRealTimers();
        cleanup();
        toasts.clear();
        downloadQueue.state = 'idle';
        downloadQueue.reset();
    });

    it('renders nothing while the queue is idle and there are no toasts', () => {
        const { container } = render(ToastContainer);
        expect(container.querySelector('.fixed')).toBeNull();
        expect(screen.queryByTestId('download-queue-panel')).toBeNull();
    });

    it('shows the card without any toast, collapsed to one line', () => {
        run([qi({ status: 'done' }), qi({ fileId: 'f-2', status: 'active' })]);
        const { container } = render(ToastContainer);
        const card = screen.getByTestId('download-queue-panel');
        expect(card.getAttribute('data-expanded')).toBe('false');
        expect(container.querySelector('.fixed')?.contains(card)).toBe(true);
        expect(screen.getByTestId('download-summary-line').textContent).toMatch(
            /1\/2\s*·\s*42 %\s*·\s*12 MB\/s/,
        );
    });

    it('is the LAST item of the stack, below the toasts', () => {
        run([qi()]);
        toasts.success('Saved');
        const { container } = render(ToastContainer);
        const stack = container.querySelector('.fixed')!;
        expect(stack.lastElementChild?.getAttribute('data-testid')).toBe('download-queue-panel');
        expect(stack.textContent).toContain('Saved');
    });

    it('expands and collapses on demand', async () => {
        run([qi()]);
        render(ToastContainer);
        await fireEvent.click(screen.getByTestId('download-toggle'));
        expect(screen.getByTestId('download-queue-panel').getAttribute('data-expanded')).toBe(
            'true',
        );
        expect(screen.getByTitle('one.mkv')).toBeTruthy();
        await fireEvent.click(screen.getByTestId('download-toggle'));
        expect(screen.getByTestId('download-queue-panel').getAttribute('data-expanded')).toBe(
            'false',
        );
    });

    it('expands by itself when something failed, and stays until closed', async () => {
        vi.useFakeTimers();
        run([qi({ status: 'failed', reason: 'network' })], 'done');
        render(ToastContainer);
        expect(screen.getByTestId('download-queue-panel').getAttribute('data-expanded')).toBe(
            'true',
        );
        expect(screen.getByTestId('download-failures').textContent).toContain('Network error');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(screen.getByTestId('download-queue-panel')).toBeTruthy();
        await fireEvent.click(screen.getByTestId('download-close'));
        expect(screen.queryByTestId('download-queue-panel')).toBeNull();
    });

    it('a clean "Done" dismisses itself after about 8 seconds', async () => {
        vi.useFakeTimers();
        run([qi({ status: 'done' })], 'done');
        render(ToastContainer);
        expect(screen.getByTestId('download-summary-line').textContent).toContain(
            'Download finished',
        );
        await vi.advanceTimersByTimeAsync(7_000);
        expect(screen.getByTestId('download-queue-panel')).toBeTruthy();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(screen.queryByTestId('download-queue-panel')).toBeNull();
    });

    it('is hidden on the player page but keeps the announcer', () => {
        run([qi()]);
        render(ToastContainer, { hideDownloadQueue: true });
        expect(screen.queryByTestId('download-queue-panel')).toBeNull();
        expect(screen.getByTestId('download-announcer').textContent?.trim()).toBe('one.mkv');
    });

    it('is hidden while an element is fullscreen', async () => {
        run([qi()]);
        render(ToastContainer);
        Object.defineProperty(document, 'fullscreenElement', {
            value: document.body,
            configurable: true,
        });
        document.dispatchEvent(new Event('fullscreenchange'));
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByTestId('download-queue-panel')).toBeNull();
        Reflect.deleteProperty(document, 'fullscreenElement');
    });
});
