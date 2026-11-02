// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Jellyfin pull skips accounts with no Lumastra match before fetching their
 * history. Those accounts must be reported back (by name) so the engine can
 * count them and the admin can be told which Jellyfin users to link.
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

function makeCtx() {
    return {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
}

beforeEach(() => {
    axiosGet.mockReset();
    axiosGet.mockImplementation(async (url: string) => {
        if (url.endsWith('/Users')) {
            return {
                data: [
                    { Id: 'u1', Name: 'alice' },
                    { Id: 'u2', Name: 'Bob' },
                    { Id: 'u3', Name: 'carol' },
                ],
            };
        }
        if (url.endsWith('/Sessions')) return { data: [] };
        return { data: { Items: [] } };
    });
});

describe('jellyfinWatchSync.pullWatchState — accounts with no Lumastra match', () => {
    it('rejects a failed user-list fetch instead of reporting an empty pull', async () => {
        axiosGet.mockRejectedValueOnce(new Error('Jellyfin /Users unavailable'));

        await expect(
            jellyfinWatchSync.pullWatchState!(makeCtx(), { knownUsernames: new Set(['alice']) }),
        ).rejects.toThrow('Jellyfin /Users unavailable');
        expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed user list instead of treating it as no users', async () => {
        axiosGet.mockResolvedValueOnce({ data: { error: 'unavailable' } });

        await expect(jellyfinWatchSync.pullWatchState!(makeCtx(), {})).rejects.toThrow(
            'Invalid Jellyfin users response',
        );
    });

    it('accepts a successfully fetched empty user list', async () => {
        axiosGet.mockResolvedValueOnce({ data: [] });

        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {});

        expect(result.errors).toEqual([]);
        expect(result.skippedUsernames).toEqual([]);
    });

    it('reports the skipped Jellyfin user names and fetches only the matched user', async () => {
        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {
            knownUsernames: new Set(['alice', 'carol']),
        });

        expect(result.skippedUsernames).toEqual(['Bob']);
        const fetchedUserPaths = axiosGet.mock.calls
            .map(([url]) => String(url))
            .filter((url) => url.includes('/Users/u2/'));
        expect(fetchedUserPaths).toEqual([]);
    });

    it('reports nothing skipped when every Jellyfin user has a Lumastra match', async () => {
        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {
            knownUsernames: new Set(['alice', 'bob', 'carol']),
        });

        expect(result.skippedUsernames ?? []).toEqual([]);
    });

    it('reports nothing skipped when the known-user set is unavailable', async () => {
        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {});

        expect(result.skippedUsernames ?? []).toEqual([]);
    });

    it('does not report a blank or missing Jellyfin user name as skipped', async () => {
        axiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith('/Users')) {
                return {
                    data: [
                        { Id: 'u1', Name: 'alice' },
                        { Id: 'u4', Name: '' },
                        { Id: 'u5', Name: '   ' },
                        { Id: 'u6' },
                    ],
                };
            }
            if (url.endsWith('/Sessions')) return { data: [] };
            return { data: { Items: [] } };
        });

        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {
            knownUsernames: new Set(['alice']),
        });

        expect(result.skippedUsernames).toEqual([]);
    });
});
