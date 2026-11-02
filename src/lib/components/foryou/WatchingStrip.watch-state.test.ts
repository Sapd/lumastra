// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import { tick } from 'svelte';

const { pageStore } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writable: makeStore } = require('svelte/store') as typeof import('svelte/store');
    return {
        pageStore: makeStore({
            data: {} as Record<string, unknown>,
            url: new URL('http://localhost/'),
        }),
    };
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', () => ({ page: pageStore, navigating: readable(null) }));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    beforeNavigate: vi.fn(),
    afterNavigate: vi.fn(),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/for-you', () => ({
    getWatching: vi.fn().mockResolvedValue({ data: { sections: [] }, error: null }),
    getNewEpisodes: vi.fn().mockResolvedValue({ data: { items: [] }, error: null }),
}));
// Keep the subscription test independent of carousel layout and card APIs.
vi.mock('$lib/components/sections', async () => ({
    SectionRenderer: (await import('../ui/Card.svelte')).default,
}));
const { eventHandlers } = vi.hoisted(() => ({
    eventHandlers: new Map<string, () => void>(),
}));
vi.mock('$lib/stores/user-events.js', () => ({
    userEvents: {
        subscribe: vi.fn((kind: string, fn: () => void) => {
            eventHandlers.set(kind, fn);
            return () => {
                eventHandlers.delete(kind);
            };
        }),
        onConnectedChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
    },
}));
vi.mock('$lib/utils/invalidate-when-idle', () => ({ invalidateWhenIdle: vi.fn() }));
vi.mock('./item-handlers', () => ({
    handleItemClick: vi.fn(),
    handleItemPlay: vi.fn(),
    handleItemRequest: vi.fn(),
    handleItemMore: vi.fn(),
    handleNavigateToWatch: vi.fn(),
}));

import WatchingStrip from './WatchingStrip.svelte';
import { getWatching, getNewEpisodes } from '$lib/api/for-you';
import { watchStateSSE } from '$lib/services/sse/watch-state-sse';
import { bumpWatchStateVersion, watchStateVersion } from '$lib/stores/watch-state-version';

afterEach(() => {
    cleanup();
    watchStateSSE.stop();
});
beforeEach(() => {
    vi.clearAllMocks();
    watchStateVersion.set(0);
    watchStateSSE.start();
});

describe('WatchingStrip local watch-state refresh', () => {
    const section = {
        id: 'continue-watching',
        type: 'continue-watching',
        title: 'Continue Watching',
        items: [],
    };
    test.each([
        ['null', null, false],
        ['absent', undefined, false],
        ['empty', [], false],
        ['stale', [section], true],
    ] as const)(
        'refetches client-owned sections for an actual store revision (%s seed)',
        async (_name, seed, stale) => {
            pageStore.set({
                data: { watchingSections: seed, ssrRenderedAt: Date.now() - (stale ? 120_000 : 0) },
                url: new URL('http://localhost/'),
            });
            const view = render(WatchingStrip);
            await waitFor(() => expect(getWatching).toHaveBeenCalledExactlyOnceWith(10, false));
            await tick();
            bumpWatchStateVersion();
            await waitFor(() => expect(getWatching).toHaveBeenLastCalledWith(10, true), {
                timeout: 3000,
            });
            expect(getWatching).toHaveBeenCalledTimes(2);
            expect(getNewEpisodes).toHaveBeenCalledOnce();
            view.unmount();
            bumpWatchStateVersion();
            await tick();
            expect(getWatching).toHaveBeenCalledTimes(2);
        },
    );

    test.each([['null', null], ['empty', []], ['stale', 'stale']] as const)(
        'refetches client-owned CW and Next Up on a user SSE revision (%s seed)',
        async (_name, seed) => {
            pageStore.set({
                data: {
                    watchingSections: seed === 'stale' ? [section] : seed,
                    ssrRenderedAt: Date.now() - (seed === 'stale' ? 120_000 : 0),
                },
                url: new URL('http://localhost/'),
            });
            const view = render(WatchingStrip);
            await waitFor(() => expect(getWatching).toHaveBeenCalledOnce());
            await tick();
            for (let i = 0; i < 20; i++) eventHandlers.get('watch_state_set_changed')?.();
            await waitFor(() => expect(getWatching).toHaveBeenLastCalledWith(10, true), {
                timeout: 3000,
            });
            expect(getWatching).toHaveBeenCalledTimes(2);
            expect(getNewEpisodes).toHaveBeenCalledOnce();
            view.unmount();
            eventHandlers.get('watch_state_set_changed')?.();
            await tick();
            expect(getWatching).toHaveBeenCalledTimes(2);
        },
    );

    test('skips duplicate fetching when the loader owns a fresh nonempty SSR seed', async () => {
        pageStore.set({
            data: { watchingSections: [section], ssrRenderedAt: Date.now() },
            url: new URL('http://localhost/'),
        });
        render(WatchingStrip);
        await waitFor(() => expect(getNewEpisodes).toHaveBeenCalledOnce());
        await tick();
        expect(getWatching).not.toHaveBeenCalled();
        bumpWatchStateVersion();
        await tick();
        expect(getWatching).not.toHaveBeenCalled();
    });

    test('uses current loader ownership after a client-owned mount', async () => {
        pageStore.set({
            data: { watchingSections: null, ssrRenderedAt: Date.now() },
            url: new URL('http://localhost/'),
        });
        render(WatchingStrip);
        await waitFor(() => expect(getWatching).toHaveBeenCalledOnce());
        pageStore.set({
            data: { watchingSections: [section], ssrRenderedAt: Date.now() },
            url: new URL('http://localhost/'),
        });
        await tick();
        bumpWatchStateVersion();
        await tick();
        expect(getWatching).toHaveBeenCalledTimes(1);
    });
});
