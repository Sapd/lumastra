// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign, spec §6: "Toasts stack in a corner that never overlaps
 * panel headers or tab strips ... and error toasts require acknowledge
 * rather than lingering ambiguously." Two things are worth a component-level
 * test beyond `toast.store.test.ts`'s store-only coverage:
 *   1. Placement — the `corner` prop actually changes which fixed corner
 *      renders (the admin layout mounts `corner="bottom-left"` specifically
 *      so the stack can never sit under the right-side DetailPanel).
 *   2. Acknowledge — an error toast renders with a working dismiss control,
 *      and clicking it removes exactly that toast from the store (the DOM
 *      counterpart of the store-level "never auto-times-out" guarantee).
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ToastContainer from './ToastContainer.svelte';
import { toasts } from '$lib/stores/toast.store';

describe('ToastContainer', () => {
    beforeAll(() => {
        // happy-dom has no Web Animations API; Svelte's `fly` in/out transition
        // calls `element.animate()` — stub it so an outro (toast dismissal)
        // doesn't crash the render tree. Not asserting on the transition itself.
        if (typeof Element !== 'undefined' && !Element.prototype.animate) {
            const stubAnimate = (): Animation => {
                const finishEvent = Object.assign(new Event('finish'), {
                    currentTime: 0,
                    timelineTime: 0,
                }) as AnimationPlaybackEvent;
                const anim = {
                    cancel: () => {},
                    finished: Promise.resolve(),
                    addEventListener: (event: string, handler: EventListener) => {
                        if (event === 'finish') queueMicrotask(() => handler(finishEvent));
                    },
                    onfinish: null as EventListener | null,
                } as unknown as Animation;
                // Svelte's transition engine also polls `onfinish` directly.
                queueMicrotask(() => anim.onfinish?.(finishEvent));
                return anim;
            };
            Element.prototype.animate = stubAnimate as typeof Element.prototype.animate;
        }
    });

    beforeEach(() => {
        toasts.clear();
    });

    afterEach(() => {
        cleanup();
        toasts.clear();
    });

    it('renders nothing when there are no toasts', () => {
        const { container } = render(ToastContainer);
        expect(container.querySelector('.fixed')).toBeNull();
    });

    it('defaults to the bottom-right corner', () => {
        toasts.success('Saved');
        const { container } = render(ToastContainer);
        const stack = container.querySelector('.fixed');
        expect(stack?.className).toContain('right-4');
        expect(stack?.className).not.toContain('left-4');
    });

    it('renders in the bottom-left corner when corner="bottom-left" (admin layout)', () => {
        toasts.success('Saved');
        const { container } = render(ToastContainer, { corner: 'bottom-left' });
        const stack = container.querySelector('.fixed');
        expect(stack?.className).toContain('left-4');
        expect(stack?.className).not.toContain('right-4');
    });

    it('an error toast renders with a dismiss control the user can acknowledge', async () => {
        toasts.error('Something broke');
        render(ToastContainer);

        expect(screen.getByText('Something broke')).toBeTruthy();
        const dismiss = screen.getByText('Close').closest('button');
        expect(dismiss).toBeTruthy();

        await fireEvent.click(dismiss!);

        await waitFor(() => expect(screen.queryByText('Something broke')).toBeNull());
    });

    it('a toast with no timeout (the store\'s "acknowledge required" state) shows no progress bar', () => {
        // The store forces `timeout: 0` for error toasts on /admin pages (see
        // toast.store.test.ts for that routing rule) — asserted here directly
        // on the prop so this test doesn't depend on happy-dom's location.
        toasts.error('Something broke', { timeout: 0 });
        const { container } = render(ToastContainer);
        expect(container.querySelector('.h-1')).toBeNull();
    });

    it('a success toast (timed) does show a progress bar', () => {
        toasts.success('Saved', { timeout: 5000 });
        const { container } = render(ToastContainer);
        expect(container.querySelector('.h-1')).toBeTruthy();
    });

    it('dismissing one toast leaves the others untouched', async () => {
        toasts.error('First problem');
        toasts.error('Second problem');
        render(ToastContainer);

        const closeButtons = screen.getAllByText('Close').map((el) => el.closest('button')!);
        await fireEvent.click(closeButtons[0]);

        await waitFor(() => expect(screen.queryByText('First problem')).toBeNull());
        expect(screen.getByText('Second problem')).toBeTruthy();
    });
});
