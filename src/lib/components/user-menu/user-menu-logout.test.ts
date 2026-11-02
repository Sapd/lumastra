// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveLogoutMode } from './user-menu-logout';

// Security fix C19 (2026-09-16): performNativeSignOut() was extracted out of
// UserMenuPopover.svelte's inline nativeSignOut() so the real sign-out logic
// is directly importable — including by tests/logout-cache-wipe.ui.spec.ts,
// which previously hand-called clearUserClientState() +
// clearServiceWorkerCaches() directly and could not detect a regression in
// nativeSignOut() itself. These mocks let us assert this module calls all
// four steps, in order, even when the server call fails.
const apiPostMock = vi.fn();
vi.mock('$lib/api/client.js', () => ({ apiPost: (...args: unknown[]) => apiPostMock(...args) }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: toastError } }));
const clearUserClientStateMock = vi.fn();
vi.mock('$lib/auth/clear-user-client-state.js', () => ({
    clearUserClientState: () => clearUserClientStateMock(),
}));
const clearServiceWorkerCachesMock = vi.fn(async () => {});
vi.mock('$lib/pwa.js', () => ({
    clearServiceWorkerCaches: () => clearServiceWorkerCachesMock(),
}));
const musicPlayerStopMock = vi.fn();
vi.mock('$lib/stores/music-player.store.js', () => ({
    musicPlayerStore: {
        stop: (clearPersistence?: boolean) => musicPlayerStopMock(clearPersistence),
    },
}));

describe('resolveLogoutMode', () => {
    test('native session login → session POST flow', () => {
        expect(resolveLogoutMode('session', undefined)).toBe('session');
        expect(resolveLogoutMode('session', 'https://auth.example/logout')).toBe('session');
    });

    test('forward-auth with a configured logout URL → forward anchor', () => {
        expect(resolveLogoutMode('forward', 'https://auth.example/logout')).toBe('forward');
        expect(resolveLogoutMode(undefined, 'https://auth.example/logout')).toBe('forward');
    });

    test('no session + no logout URL → guaranteed-floor fallback', () => {
        expect(resolveLogoutMode('forward', undefined)).toBe('fallback');
        expect(resolveLogoutMode(undefined, undefined)).toBe('fallback');
        expect(resolveLogoutMode(undefined, '')).toBe('fallback');
    });
});

describe('performNativeSignOut', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('stops playback, wipes client state, wipes SW caches and redirects after confirmed logout', async () => {
        apiPostMock.mockResolvedValueOnce({ data: {}, error: null, status: 200 });
        const assignSpy = vi.fn();
        vi.stubGlobal('location', { ...window.location, assign: assignSpy });

        const { performNativeSignOut } = await import('./user-menu-logout');
        await performNativeSignOut();

        expect(apiPostMock).toHaveBeenCalledWith(
            '/api/auth/native/logout',
            expect.anything(),
            undefined,
        );
        // Order matters: playback must stop and persistence must be
        // suppressed (musicPlayerStore.stop(true)) BEFORE the curated wipe,
        // per security fix C13 — otherwise a later beforeunload could
        // re-persist the wiped key.
        expect(musicPlayerStopMock).toHaveBeenCalledWith(true);
        expect(clearUserClientStateMock).toHaveBeenCalledTimes(1);
        expect(clearServiceWorkerCachesMock).toHaveBeenCalledTimes(1);
        expect(assignSpy).toHaveBeenCalledWith('/login');

        const stopOrder = musicPlayerStopMock.mock.invocationCallOrder[0];
        const wipeOrder = clearUserClientStateMock.mock.invocationCallOrder[0];
        expect(stopOrder).toBeLessThan(wipeOrder);

        vi.unstubAllGlobals();
    });
});

test('a retryable logout failure wipes local data but does not claim success or navigate away', async () => {
    apiPostMock.mockResolvedValueOnce({
        data: null,
        error: 'Authentication temporarily unavailable',
        status: 503,
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
        const { performNativeSignOut } = await import('./user-menu-logout');
        await performNativeSignOut();
        expect(assign).not.toHaveBeenCalled();
        expect(musicPlayerStopMock).toHaveBeenCalledWith(true);
        expect(clearServiceWorkerCachesMock).toHaveBeenCalled();
        expect(toastError).toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});
