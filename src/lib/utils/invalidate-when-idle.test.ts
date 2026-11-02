// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable } from 'svelte/store';

const invalidateMock = vi.fn();
const navigatingStore = writable<{ type: string } | null>(null);

vi.mock('$app/navigation', () => ({
    invalidate: (resource: string) => {
        invalidateMock(resource);
        return Promise.resolve();
    },
}));

vi.mock('$app/stores', () => ({
    navigating: {
        subscribe: (fn: (v: { type: string } | null) => void) => navigatingStore.subscribe(fn),
    },
}));

const { invalidateWhenIdle } = await import('./invalidate-when-idle');

/** The helper settles on a macrotask, so let one elapse. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('invalidateWhenIdle', () => {
    beforeEach(() => {
        invalidateMock.mockClear();
        navigatingStore.set(null);
    });

    it('invalidates immediately when the router is idle', () => {
        invalidateWhenIdle('app:watch-state');
        expect(invalidateMock).toHaveBeenCalledWith('app:watch-state');
    });

    it('defers while a navigation is in flight, then invalidates once it settles', async () => {
        navigatingStore.set({ type: 'goto' });

        invalidateWhenIdle('app:watch-state');
        // Invalidating here would steal SvelteKit's navigation token and abort
        // the in-flight navigation, which leaves `navigating` non-null forever.
        expect(invalidateMock).not.toHaveBeenCalled();

        navigatingStore.set(null);
        await tick();
        expect(invalidateMock).toHaveBeenCalledExactlyOnceWith('app:watch-state');
    });

    it('keeps waiting when another navigation starts in the same tick', async () => {
        navigatingStore.set({ type: 'goto' });
        invalidateWhenIdle('app:watch-state');

        // End of one navigation, immediate start of the next - invalidating
        // into that would strand the new one exactly as the original bug did.
        navigatingStore.set(null);
        navigatingStore.set({ type: 'goto' });
        await tick();
        expect(invalidateMock).not.toHaveBeenCalled();

        navigatingStore.set(null);
        await tick();
        expect(invalidateMock).toHaveBeenCalledExactlyOnceWith('app:watch-state');
    });

    it('fires only once even if further navigations follow', async () => {
        navigatingStore.set({ type: 'goto' });
        invalidateWhenIdle('app:watch-state');

        navigatingStore.set(null);
        await tick();
        navigatingStore.set({ type: 'link' });
        navigatingStore.set(null);
        await tick();

        expect(invalidateMock).toHaveBeenCalledTimes(1);
    });
});
