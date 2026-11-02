// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for the "watched but still in Continue Watching" bug.
 *
 * Jellyfin's `POST /Users/{u}/PlayedItems/{id}` sets Played=true but does NOT
 * reset PlaybackPositionTicks. Jellyfin's Resume ("Continue Watching") rail keys
 * off PlaybackPositionTicks > 0 independently of the Played flag, so an item that
 * still carries a stale resume position keeps appearing in Continue Watching with
 * a progress bar even after we mark it watched.
 *
 * The outbound push must therefore ALSO zero the position when marking watched —
 * exactly as the unwatched branch and the inbound /j/UserPlayedItems compat handler
 * already do. This test locks that companion write in.
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

// Import under test AFTER mocks.
import { jellyfinWatchSync } from './jellyfin.js';

function makeCtx() {
    return mockContext({ input: {} });
}

const WATCHED: WatchStateChange = {
    providerId: 'jf-item-1',
    mediaId: 'internal-uuid',
    username: 'user-uuid',
    isWatched: true,
    resumePositionMs: 0,
    runtimeMs: 3_600_000,
    watchCount: 1,
} as WatchStateChange;

describe('jellyfinWatchSync.pushWatchState — watched items must clear the resume position', () => {
    beforeEach(() => {
        axiosPost.mockClear();
        axiosDelete.mockClear();
        axiosGet.mockClear();
    });

    it('POSTs PlaybackPositionTicks:0 to UserData when marking an item watched (removes it from Continue Watching)', async () => {
        const result = await jellyfinWatchSync.pushWatchState!(makeCtx(), [WATCHED]);

        if (!result) throw new Error('Missing push result');
        expect(result.succeeded).toBe(1);

        // Marks played.
        expect(axiosPost).toHaveBeenCalledWith(
            'http://jellyfin.local/Users/jf-user/PlayedItems/jf-item-1',
            undefined,
            expect.anything(),
        );

        // AND clears the stale resume position so Jellyfin drops it from the
        // Resume/Continue-Watching rail.
        const userDataCall = axiosPost.mock.calls.find(
            (c: unknown[]) =>
                typeof c[0] === 'string' &&
                c[0].endsWith('/UserItems/jf-item-1/UserData?userId=jf-user'),
        );
        expect(userDataCall, 'expected a UserData position-clear POST').toBeDefined();
        expect(userDataCall![1]).toMatchObject({ PlaybackPositionTicks: 0 });
    });
    it.each([404, 405])('falls back to the legacy setter only for HTTP %s', async (status) => {
        axiosPost.mockRejectedValueOnce(
            Object.assign(new Error('route unavailable'), { response: { status } }),
        );
        const result = await jellyfinWatchSync.pushResumePosition!(makeCtx(), [
            {
                providerId: 'jf-item-1',
                mediaId: 'internal-uuid',
                username: 'user-uuid',
                resumePositionMs: 12000,
            },
        ]);
        if (!result) throw new Error('Missing push result');
        expect(result.succeeded).toBe(1);
        expect(axiosPost.mock.calls.map((c) => c[0])).toEqual([
            'http://jellyfin.local/UserItems/jf-item-1/UserData?userId=jf-user',
            'http://jellyfin.local/Users/jf-user/Items/jf-item-1/UserData',
        ]);
    });
});
