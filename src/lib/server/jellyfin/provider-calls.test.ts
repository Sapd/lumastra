// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
const recordProviderCall = vi.hoisted(() => vi.fn());
const recordProviderRetry = vi.hoisted(() => vi.fn());
vi.mock('../utils/provider-calls.js', () => ({ recordProviderCall, recordProviderRetry }));
vi.mock('../config.js', () => ({
    config: { APP_NAME: 'Lumastra', JELLYFINURL: 'http://jf', JELLYFINAPIKEY: 'test' },
}));
vi.mock('../operation-mode.js', () => ({ operationMode: { isJellyfinEnabled: true } }));
vi.mock('../runtime-optimizations.js', () => ({ configureAxiosWithOptimizedAgents: vi.fn() }));
import { JellyfinBaseClient, resetJellyfinApi, circuitBreaker } from './base-client.js';
import { withJellyfinRetry } from './retry.js';

beforeEach(() => {
    resetJellyfinApi();
    circuitBreaker.reset();
    recordProviderCall.mockClear();
    recordProviderRetry.mockClear();
});
afterEach(() => {
    resetJellyfinApi();
    circuitBreaker.reset();
});

function httpError(config: InternalAxiosRequestConfig, status: number): AxiosError {
    return new AxiosError(
        `HTTP ${status}`,
        undefined,
        config,
        {},
        { data: {}, status, statusText: 'error', headers: {}, config },
    );
}

describe('Jellyfin provider call telemetry', () => {
    it('counts real axios responses and retries, including a 429 before success', async () => {
        const axios = new JellyfinBaseClient().getAxiosInstance()!;
        let calls = 0;
        axios.defaults.adapter = async (config) => {
            if (calls++ === 0) throw httpError(config, 429);
            return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
        };
        await withJellyfinRetry(() => axios.get('/Items'), { sleep: async () => {} });
        expect(recordProviderCall.mock.calls).toEqual([
            ['jellyfin', 429],
            ['jellyfin', 200],
        ]);
        expect(recordProviderRetry).toHaveBeenCalledExactlyOnceWith('jellyfin');
    });
    it('counts network failures but excludes cancellation and open-circuit rejections', async () => {
        const axios = new JellyfinBaseClient().getAxiosInstance()!;
        axios.defaults.adapter = async (config) => {
            throw new AxiosError('connection refused', 'ECONNREFUSED', config, {});
        };
        await expect(axios.get('/Items')).rejects.toThrow('connection refused');
        expect(recordProviderCall).toHaveBeenCalledExactlyOnceWith('jellyfin', null);
        const signal = AbortSignal.abort();
        await expect(axios.get('/Items', { signal })).rejects.toThrow();
        circuitBreaker.isOpen = true;
        circuitBreaker.openedAt = Date.now();
        await expect(axios.get('/Items')).rejects.toThrow('circuit breaker');
        expect(recordProviderCall).toHaveBeenCalledOnce();
    });
});
