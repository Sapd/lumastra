// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('./client.js', () => ({
    apiPost: post,
    apiGet: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
}));
vi.mock('$app/environment', () => ({ version: 'test', browser: false, dev: false }));
import { probePlayability } from './playback.js';

const limited = { data: null, error: 'Too many requests', status: 429, retryAfterMs: 7000 };
const ready = { data: { mediaId: 'test' }, error: null, status: 200 };

beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('player playability probe retry', () => {
    it('keeps the probe pending until Retry-After, then returns the playable response', async () => {
        post.mockResolvedValueOnce(limited).mockResolvedValueOnce(ready);
        const probe = probePlayability('title', {});
        await vi.advanceTimersByTimeAsync(6999);
        expect(post).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await probe).toBe(ready);
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    });

    it('does not issue a waiting retry after the player changes title or is disposed', async () => {
        let current = true;
        post.mockResolvedValue(limited);
        const probe = probePlayability('title', {}, () => current);
        await vi.advanceTimersByTimeAsync(1);
        current = false;
        await vi.advanceTimersByTimeAsync(7000);
        expect(await probe).toBe(limited);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('stops after two retries if the server remains busy', async () => {
        post.mockResolvedValue(limited);
        const probe = probePlayability('title', {});
        await vi.advanceTimersByTimeAsync(14000);
        expect(await probe).toBe(limited);
        expect(post).toHaveBeenCalledTimes(3);
    });

    it('surfaces real refusals without retrying', async () => {
        const missing = { data: null, error: 'Not found', status: 404 };
        post.mockResolvedValue(missing);
        expect(await probePlayability('title', {})).toBe(missing);
        expect(post).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
