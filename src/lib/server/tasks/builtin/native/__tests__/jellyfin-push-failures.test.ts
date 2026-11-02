// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin push-side per-item failure reporting.
 *
 * `pushWatchState`'s transient catch-all (network error / 5xx / parse error)
 * used to only increment `failed` and push a flat string into `errors` —
 * nothing attributed the failure to a specific (username, mediaId) pair.
 * The new `failedItems` channel (`WatchSyncPushFailure[]`, added in a prior
 * task) lets the engine surface a per-connection sync activity feed. This
 * locks in that the transient branch now populates `failedItems` with
 * `terminal: false` (item stays queued, retried next cycle) — as opposed to
 * the 404 / no-Jellyfin-user branches a few lines above, which drain
 * terminally via `drainedAsSkipped` and must NOT populate `failedItems`.
 *
 * Mock shape mirrors the proven pattern in the colocated
 * `../watch-sync/jellyfin-resolve-errors.test.ts` (same file under test,
 * same dependency surface).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, WatchStateChange } from '@sapd/lumastra-plugin-sdk';

const axiosPost = vi.hoisted(() => vi.fn());
const axiosDelete = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => ({ get: vi.fn(), post: axiosPost, delete: axiosDelete }),
        getBaseUrl: () => 'http://jellyfin.local',
        getApiToken: () => 'token-123',
    },
}));

vi.mock('$lib/server/config.js', () => ({
    features: { jellyfinSync: true },
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
    resolveJellyfinUserIdByUserId: vi.fn().mockResolvedValue('jf-user-1'),
}));
vi.mock('$lib/shared/user-id.js', () => ({ toUserId: (u: string) => u }));
// jellyfin.ts imports this from '../../index.js' (native/ -> builtin/index.js);
// same relative depth from this __tests__/ dir.
vi.mock('../../index.js', () => ({ registerWatchSyncWithAutoTasks: vi.fn() }));

// Import under test AFTER mocks.
import { jellyfinWatchSync } from '../watch-sync/jellyfin.js';

function makeCtx(): PluginContext {
    return {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
}

describe('jellyfinWatchSync.pushWatchState — transient failures populate failedItems', () => {
    beforeEach(() => {
        axiosPost.mockReset();
        axiosDelete.mockReset();
    });

    it('records a transient (terminal=false) failedItems entry on a 5xx', async () => {
        axiosPost.mockRejectedValue(
            Object.assign(new Error('boom'), { response: { status: 500 } }),
        );

        const item: WatchStateChange = {
            providerId: 'jf-1',
            mediaId: 'media-uuid-1',
            username: 'user-uuid-1',
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 0,
            watchCount: 1,
        };

        const res = await jellyfinWatchSync.pushWatchState(makeCtx(), [item]);

        expect(res.failed).toBe(1);
        expect(res.skipped).toBe(0);
        expect(res.drainedAsSkipped).toEqual([]);
        expect(res.failedItems).toEqual([
            {
                username: 'user-uuid-1',
                mediaId: 'media-uuid-1',
                error: expect.stringContaining('boom'),
                terminal: false,
            },
        ]);
    });
});
