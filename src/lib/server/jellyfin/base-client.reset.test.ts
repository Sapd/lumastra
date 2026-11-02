// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for resetJellyfinApi() — proves that a runtime change to the
 * Jellyfin URL/API key takes effect WITHOUT a process restart.
 *
 * The bug: getOrInitApi() latches `apiInitAttempted` on first use, so creds
 * saved later (admin Settings / setup wizard) stayed inert until restart. These
 * tests mock config/operation-mode/SDK so the latch behaviour is exercised
 * deterministically with no real Jellyfin.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable config holder the mocks read from (hoisted so the vi.mock factories
// can close over it).
const cfg = vi.hoisted(() => ({ url: '', key: '' }));

// Track how many times interceptors were armed, to prove the rebuilt client
// re-arms them after a reset.
const interceptorArmings = vi.hoisted(() => ({ count: 0 }));

vi.mock('../config.js', () => ({
    config: {
        get JELLYFINURL() {
            return cfg.url;
        },
        get JELLYFINAPIKEY() {
            return cfg.key;
        },
        APP_NAME: 'TestApp',
    },
}));

vi.mock('../operation-mode.js', () => ({
    operationMode: {
        get isJellyfinEnabled() {
            return Boolean(cfg.url && cfg.key);
        },
    },
}));

vi.mock('../runtime-optimizations.js', () => ({
    configureAxiosWithOptimizedAgents: () => {},
}));

vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    },
}));

vi.mock('@jellyfin/sdk', () => ({
    Jellyfin: class {
        // Mirrors the real signature: SDK 1.0 takes the token here, because
        // `Api#accessToken` became a read-only getter.
        createApi(url: string, accessToken?: string) {
            return {
                basePath: url,
                accessToken,
                axiosInstance: {
                    interceptors: {
                        // Count request-interceptor installs as the "armed" signal.
                        request: {
                            use: () => {
                                interceptorArmings.count++;
                            },
                        },
                        response: { use: () => {} },
                    },
                },
            };
        }
    },
}));

import { JellyfinBaseClient, resetJellyfinApi } from './base-client.js';

describe('resetJellyfinApi — live credential reload', () => {
    beforeEach(() => {
        cfg.url = '';
        cfg.key = '';
        interceptorArmings.count = 0;
        resetJellyfinApi(); // clear the module latch between tests
    });

    it('pins the not-configured result until reset, then loads new creds live', () => {
        const client = new JellyfinBaseClient();

        // Booted with no Jellyfin config.
        expect(client.getBaseUrl()).toBeNull();

        // Creds are saved at runtime — WITHOUT a reset the latch keeps the stale
        // (null) result. This is the bug the reset fixes.
        cfg.url = 'http://jf:8096';
        cfg.key = 'secret';
        expect(client.getBaseUrl()).toBeNull();

        // After reset the client rebuilds from current config — no restart.
        resetJellyfinApi();
        expect(client.getBaseUrl()).toBe('http://jf:8096');
        expect(client.getAccessToken()).toBe('secret');
    });

    it('reflects a CHANGED url on an already-initialized client (getter not pinned)', () => {
        cfg.url = 'http://old:8096';
        cfg.key = 'k1';
        resetJellyfinApi();
        const client = new JellyfinBaseClient();
        expect(client.getBaseUrl()).toBe('http://old:8096');

        // Change creds + reset → the cached instance must not pin the old client.
        cfg.url = 'http://new:8096';
        cfg.key = 'k2';
        resetJellyfinApi();
        expect(client.getBaseUrl()).toBe('http://new:8096');
        expect(client.getAccessToken()).toBe('k2');
    });

    it('re-arms the axios interceptors on the rebuilt client', () => {
        cfg.url = 'http://jf:8096';
        cfg.key = 'k';
        resetJellyfinApi();
        const client = new JellyfinBaseClient();
        client.getBaseUrl(); // forces build #1
        expect(interceptorArmings.count).toBe(1);

        // A reset must let the next build re-arm interceptors (circuit breaker +
        // timeout) on the new axios instance.
        resetJellyfinApi();
        client.getBaseUrl(); // build #2
        expect(interceptorArmings.count).toBe(2);
    });

    it('returns to not-configured when creds are cleared + reset', () => {
        cfg.url = 'http://jf:8096';
        cfg.key = 'secret';
        resetJellyfinApi();
        const client = new JellyfinBaseClient();
        expect(client.getBaseUrl()).toBe('http://jf:8096');

        cfg.url = '';
        cfg.key = '';
        resetJellyfinApi();
        expect(client.getBaseUrl()).toBeNull();
    });
});
