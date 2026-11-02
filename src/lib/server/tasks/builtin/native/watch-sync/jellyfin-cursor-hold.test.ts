// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pull cursor must NOT advance past a window we failed to read.
 *
 * Each per-user fetch (movies, episodes, resume) is caught independently and
 * execution continues, so a movies failure alongside an episodes success used to
 * move the cursor to the newest EPISODE date — putting the unread movie plays
 * permanently behind it. Re-import is idempotent, but only for items the next
 * pull still asks for, and it would never ask for those again: silent, permanent
 * watch-history loss.
 *
 * This was inert while the engine delivered a mis-keyed cursor map (`since` was
 * always null, every pull was full, nothing could fall behind). Fixing that key
 * space is precisely what arms this, which is why the guard ships alongside it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => ({ get: axiosGet, post: vi.fn(), delete: vi.fn() }),
        getBaseUrl: () => 'http://jellyfin.local',
        getApiToken: () => 'token-123',
    },
}));
vi.mock('$lib/server/config.js', () => ({ features: { jellyfinSync: true } }));
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

const USER = 'denis';
const SINCE = '2026-08-01T00:00:00.000Z';

function makeCtx(): PluginContext {
    return {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
}

/** One played episode, newer than the cursor — enough to move it if allowed. */
const EPISODE_PAGE = {
    data: {
        Items: [
            {
                Id: 'ep-1',
                Name: 'Ep',
                Type: 'Episode',
                ProviderIds: { Tmdb: '111' },
                UserData: {
                    Played: true,
                    LastPlayedDate: '2026-08-26T10:00:00.000Z',
                    PlayCount: 1,
                },
                RunTimeTicks: 6000000000,
            },
        ],
        TotalRecordCount: 1,
    },
};

describe('jellyfin pull — cursor is held when a fetch fails', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does not advance the cursor when the movies fetch fails', async () => {
        axiosGet.mockImplementation((url: string, cfg?: { params?: Record<string, unknown> }) => {
            // User enumeration must succeed or pullForUser never runs.
            if (/\/Users$/.test(url)) {
                return Promise.resolve({ data: [{ Id: 'jf-user', Name: USER }] });
            }
            const kinds = String(cfg?.params?.includeItemTypes ?? '');
            if (kinds.toLowerCase().includes('movie')) {
                return Promise.reject(new Error('ECONNRESET'));
            }
            if (kinds.toLowerCase().includes('episode')) {
                return Promise.resolve(EPISODE_PAGE);
            }
            // Sessions / resume / anything else: empty but successful.
            return Promise.resolve({ data: { Items: [], TotalRecordCount: 0 } });
        });

        const res = await jellyfinWatchSync.pullWatchState!(makeCtx(), {
            cursors: new Map([[USER, SINCE]]),
            knownUsernames: new Set([USER]),
        } as never);

        // An episode newer than the cursor WAS read, so without the guard the
        // cursor would advance to 2026-08-26 and skip the unread movie window.
        expect(res.errors.some((e) => /movies/i.test(e))).toBe(true);
        expect(res.newCursors?.get(USER)).toBeUndefined();
    });
});
