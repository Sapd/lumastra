// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A provider id that cannot be an upstream path segment ('..') must drain only
 * its own event as skipped; the rest of the batch is still pushed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WatchStateChange } from '@sapd/lumastra-plugin-sdk';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';

const axiosPost = vi.hoisted(() =>
    vi.fn((_url: string, _data?: unknown, _config?: unknown) => Promise.resolve({ data: {} })),
);
const axiosDelete = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: {} })));
const axiosGet = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: {} })));

vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => ({ get: axiosGet, post: axiosPost, delete: axiosDelete }),
        getBaseUrl: () => 'http://jellyfin.local',
        getApiToken: () => 'token-123',
    },
}));
vi.mock('$lib/server/config.js', () => ({
    features: { jellyfinSync: true },
    config: { APP_NAME: 'Lumastra' },
}));
vi.mock('$lib/server/jellyfin/base-client.js', () => ({
    circuitBreaker: {
        shouldAllowRequest: () => true,
        getState: () => ({ isOpen: false, failureCount: 0, timeSinceOpenMs: null }),
    },
}));
vi.mock('$lib/server/jellyfin/retry.js', () => ({
    withJellyfinRetry: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserIdByUserId: vi.fn().mockResolvedValue('jf-user'),
}));
vi.mock('$lib/shared/user-id.js', () => ({ toUserId: (u: string) => u }));
vi.mock('../../index.js', () => ({ registerWatchSyncWithAutoTasks: vi.fn() }));

import { jellyfinWatchSync } from './jellyfin.js';

function change(providerId: string, mediaId: string): WatchStateChange {
    return {
        providerId,
        mediaId,
        username: 'user-uuid',
        isWatched: true,
        resumePositionMs: 0,
        runtimeMs: 3_600_000,
        watchCount: 1,
    } as WatchStateChange;
}

describe('jellyfinWatchSync.pushWatchState with an unusable provider id', () => {
    beforeEach(() => {
        axiosPost.mockClear();
        axiosDelete.mockClear();
    });

    it('skips only that item and still pushes the others', async () => {
        const result = await jellyfinWatchSync.pushWatchState!(mockContext({ input: {} }), [
            change('..', 'bad'),
            change('jf-item-2', 'good'),
        ]);

        expect(result.succeeded).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.drainedAsSkipped).toEqual([{ username: 'user-uuid', mediaId: 'bad' }]);
        expect(axiosPost).toHaveBeenCalledWith(
            'http://jellyfin.local/Users/jf-user/PlayedItems/jf-item-2',
            undefined,
            expect.anything(),
        );
        for (const c of axiosPost.mock.calls) {
            expect(String(c[0]).split('/')).not.toContain('..');
        }
    });
});
