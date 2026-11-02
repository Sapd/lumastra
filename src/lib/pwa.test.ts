// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Security fix C7: the service-worker app-shell cache could keep one user's
 * personalized SSR HTML in CacheStorage across logout. clearServiceWorkerCaches()
 * is the client-side belt (alongside the server's Clear-Site-Data header and the
 * SW no longer caching personalized HTML at all) — called from both logout paths
 * before the redirect. It must wipe every CacheStorage cache and notify the
 * active service worker, and never throw even when those APIs are unavailable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, version: 'test-version' }));
vi.mock('$app/paths', () => ({ base: '' }));

const { clearServiceWorkerCaches, registerServiceWorker, SERVICE_WORKER_DISABLED_KEY } =
    await import('./pwa.js');

describe('clearServiceWorkerCaches', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('deletes every named cache and notifies the SW controller', async () => {
        const deleteCache = vi.fn().mockResolvedValue(true);
        vi.stubGlobal('caches', {
            keys: vi.fn().mockResolvedValue(['media-dashboard-v1.1.204-dev', 'other-cache']),
            delete: deleteCache,
        });
        const postMessage = vi.fn();
        Object.defineProperty(window.navigator, 'serviceWorker', {
            value: { controller: { postMessage } },
            configurable: true,
        });

        await clearServiceWorkerCaches();

        expect(deleteCache).toHaveBeenCalledWith('media-dashboard-v1.1.204-dev');
        expect(deleteCache).toHaveBeenCalledWith('other-cache');
        expect(postMessage).toHaveBeenCalledWith({ type: 'clearCache' });
    });

    it('never throws when CacheStorage is unavailable', async () => {
        vi.stubGlobal('caches', undefined);
        Object.defineProperty(window.navigator, 'serviceWorker', {
            value: undefined,
            configurable: true,
        });

        await expect(clearServiceWorkerCaches()).resolves.toBeUndefined();
    });

    it('never throws when caches.keys() itself rejects', async () => {
        vi.stubGlobal('caches', {
            keys: vi.fn().mockRejectedValue(new Error('boom')),
            delete: vi.fn(),
        });
        Object.defineProperty(window.navigator, 'serviceWorker', {
            value: undefined,
            configurable: true,
        });

        await expect(clearServiceWorkerCaches()).resolves.toBeUndefined();
    });
});

describe('registerServiceWorker with the diagnostic disable switch', () => {
    afterEach(() => {
        localStorage.removeItem(SERVICE_WORKER_DISABLED_KEY);
        vi.restoreAllMocks();
    });

    it('unregisters existing workers and registers none', async () => {
        localStorage.setItem(SERVICE_WORKER_DISABLED_KEY, '1');
        const unregister = vi.fn().mockResolvedValue(true);
        const register = vi.fn();
        Object.defineProperty(window.navigator, 'serviceWorker', {
            value: {
                controller: null,
                register,
                getRegistrations: vi.fn().mockResolvedValue([{ unregister }, { unregister }]),
                addEventListener: vi.fn(),
            },
            configurable: true,
        });
        vi.spyOn(console, 'log').mockImplementation(() => {});

        registerServiceWorker();
        await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(2));
        window.dispatchEvent(new Event('load'));
        expect(register).not.toHaveBeenCalled();
    });
});

describe('registerServiceWorker by platform', () => {
    const realUserAgent = navigator.userAgent;
    // registerServiceWorker leaves a window 'load' listener behind; without
    // removing it, the next test's load event would register twice.
    type Listener = Parameters<typeof window.removeEventListener>[1];
    const loadListeners: Listener[] = [];
    beforeEach(() => {
        const add = window.addEventListener.bind(window);
        vi.spyOn(window, 'addEventListener').mockImplementation(
            (...args: Parameters<typeof window.addEventListener>) => {
                if (args[0] === 'load') loadListeners.push(args[1]);
                add(...args);
            },
        );
    });
    afterEach(() => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: realUserAgent,
            configurable: true,
        });
        vi.restoreAllMocks();
        for (const listener of loadListeners.splice(0)) {
            window.removeEventListener('load', listener);
        }
    });

    function stubServiceWorker() {
        const unregister = vi.fn().mockResolvedValue(true);
        const register = vi.fn().mockResolvedValue({ addEventListener: vi.fn(), scope: '/' });
        Object.defineProperty(window.navigator, 'serviceWorker', {
            value: {
                controller: null,
                register,
                getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
                addEventListener: vi.fn(),
            },
            configurable: true,
        });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        return { unregister, register };
    }

    it('registers the worker on an iPhone too', async () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1',
            configurable: true,
        });
        const { unregister, register } = stubServiceWorker();
        registerServiceWorker();
        window.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
        expect(unregister).not.toHaveBeenCalled();
    });

    it('still registers the worker on desktop', async () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
            configurable: true,
        });
        const { unregister, register } = stubServiceWorker();
        registerServiceWorker();
        window.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
        expect(unregister).not.toHaveBeenCalled();
    });
});
