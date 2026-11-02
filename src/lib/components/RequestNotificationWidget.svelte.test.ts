// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * [degraded-modal-fix] "Watch now" on a request notification.
 *
 * When the notification carries no internal UUID there is nothing to navigate
 * to, so the handler opens the media modal instead. It used to hand-roll that
 * open: fetch `/media/{key}` WITHOUT `?include=details` and forward four fields
 * (title, overview, mediaType, isAvailable) plus the notification's own
 * external ids. Everything the modal needs to be a real detail view — the
 * merged `ids` map (so no internal/jellyfin id → no seasons picker → no Watch
 * button), genres, year, cast, ratings, canRequest — was dropped on the floor,
 * so the same series rendered as a stub from the toast and in full from an
 * episode card.
 *
 * `openMediaModalFromUrl` is the shared hydrated opener (it is what the
 * `?modal=` deep link and the admin panels use). These cases pin that the toast
 * goes through it rather than re-deriving a thinner payload.
 */

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import type { RequestNotification } from '$lib/types/notifications';
import * as m from '$lib/paraglide/messages';

const goto = vi.fn(async (_url: string) => {});
const openMediaModal = vi.fn((..._args: unknown[]) => undefined);
const openMediaModalFromUrl = vi.fn(async (..._args: unknown[]) => true);
const toastError = vi.fn((..._args: unknown[]) => undefined);
let notifications: RequestNotification[] = [];

vi.mock('$app/navigation', () => ({ goto: (url: string) => goto(url) }));
vi.mock('$app/stores', () => ({
    page: readable({
        data: { features: { requests: true }, user: { username: 'tester' } },
        url: new URL('http://localhost/'),
    }),
}));
vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: (...args: unknown[]) => openMediaModal(...args),
    openMediaModalFromUrl: (...args: unknown[]) => openMediaModalFromUrl(...args),
}));
vi.mock('$lib/stores/playerNavigation', () => ({ saveReturnPath: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: {
        success: vi.fn(),
        error: (...args: unknown[]) => toastError(...args),
        info: vi.fn(),
        warning: vi.fn(),
    },
}));
vi.mock('$lib/stores/request-notifications', async () => {
    const { readable: r, derived } = await import('svelte/store');
    const store = r({ notifications: [] as RequestNotification[], lastPoll: 0 });
    return {
        requestNotifications: {
            ...store,
            setUser: vi.fn(),
            syncFromServer: vi.fn(async () => {}),
            dismiss: vi.fn(),
            dismissAll: vi.fn(async () => {}),
            remove: vi.fn(),
        },
        visibleNotifications: derived(store, () => notifications),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
        installNotificationListeners: vi.fn(() => () => {}),
    };
});

import RequestNotificationWidget from './RequestNotificationWidget.svelte';

function seriesNotification(overrides: Partial<RequestNotification> = {}): RequestNotification {
    return {
        id: 'tmdb:247718:tv',
        externalIds: { tmdb: '247718' },
        mediaType: 'series',
        title: 'Lanterns',
        status: 'available',
        createdAt: 0,
        ...overrides,
    } as RequestNotification;
}

async function clickWatchNow() {
    const { findByText } = render(RequestNotificationWidget);
    const button = await findByText(m.req_watch_now());
    await fireEvent.click(button);
    // The handler awaits before opening; let its microtasks drain.
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    vi.clearAllMocks();
    openMediaModalFromUrl.mockResolvedValue(true);
    // happy-dom's Storage is not usable here, and `getEffectiveUsername()` reads
    // localStorage directly under `import.meta.env.DEV` (which vitest sets). An
    // unusable stub throws inside an $effect, which tears down the render before
    // any card is painted.
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
            clear: () => store.clear(),
            key: () => null,
            length: 0,
        },
    });
});
afterEach(cleanup);

describe('[degraded-modal-fix] RequestNotificationWidget "Watch now"', () => {
    test('opens the HYDRATED modal for a series that has no internal id', async () => {
        notifications = [seriesNotification()];

        await clickWatchNow();

        expect(openMediaModalFromUrl).toHaveBeenCalledWith(
            expect.objectContaining({ tmdb: '247718' }),
            'tv',
        );
        // The stub opener (four fields, no `include=details`) is exactly the
        // degraded render the user reported. It must not be reachable here.
        expect(openMediaModal).not.toHaveBeenCalled();
    });

    test('maps a movie notification to the movie media type', async () => {
        notifications = [
            seriesNotification({
                id: 'tmdb:550:movie',
                mediaType: 'movie',
                title: 'Quiet Orbit',
                externalIds: { tmdb: '550' },
            }),
        ];

        await clickWatchNow();

        expect(openMediaModalFromUrl).toHaveBeenCalledWith(
            expect.objectContaining({ tmdb: '550' }),
            'movie',
        );
    });

    test('still navigates straight to playback when an internal id is present', async () => {
        notifications = [
            seriesNotification({ externalIds: { tmdb: '247718', internal: 'uuid-lanterns' } }),
        ];

        await clickWatchNow();

        expect(goto).toHaveBeenCalledWith(expect.stringContaining('/watch/'));
        expect(openMediaModalFromUrl).not.toHaveBeenCalled();
    });
});

describe('[degraded-modal-fix] a failed open must not look like a dead button', () => {
    test('toasts when the hydrated opener reports failure', async () => {
        notifications = [seriesNotification()];
        openMediaModalFromUrl.mockResolvedValue(false);

        await clickWatchNow();

        // openMediaModalFromUrl swallows its own errors and reports them as a
        // `false` return, so a discarded return value means the click does
        // nothing observable at all.
        expect(toastError).toHaveBeenCalled();
    });
});
