// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for Jellyfin watch-sync ID resolution.
 *
 * Two bugs, one file:
 *
 * 1. The ORIGINAL "false-success" bug: the resolvers bare-caught every axios
 *    error into `null`, so a Jellyfin 500 / timeout was indistinguishable from
 *    "item genuinely absent" (404). The push engine then terminally drained the
 *    unresolved item, silently dropping the change forever. Fix: resolvers return
 *    `null` only for a real 404, and re-throw any other error.
 *
 * 2. The FOLLOW-UP regression this file now locks in: the first fix made
 *    `resolveIds` THROW on the first rejection, which discarded already-resolved
 *    items AND aborted the whole page. Combined with the circuit breaker
 *    excluding 4xx, a deterministic 401/403 (revoked key) re-threw every cycle
 *    forever, head-of-line-blocking ALL items. New contract:
 *      - Circuit breaker OPEN (provider-wide outage) → resolveIds REJECTS so the
 *        engine aborts the page WITHOUT draining the backlog; it backs off.
 *      - Circuit breaker CLOSED (isolated per-item failure) → resolveIds returns
 *        the items that DID resolve; the failed one is omitted (engine drains it)
 *        so one bad item can't block the rest of the page.
 *      - A real 404 still → null (benign, omitted), never a throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, WatchSyncResolveItem } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Hoisted mocks — the test swaps `.get` per case and toggles breaker state.
// ---------------------------------------------------------------------------
const axiosGet = vi.hoisted(() => vi.fn());
const breaker = vi.hoisted(() => ({ open: false }));

vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => ({ get: axiosGet, post: vi.fn(), delete: vi.fn() }),
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
        getState: () => ({
            isOpen: breaker.open,
            failureCount: breaker.open ? 5 : 0,
            timeSinceOpenMs: breaker.open ? 0 : null,
        }),
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
    return {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
}

function axiosError(status: number): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response: { status },
    });
}

const MOVIE: WatchSyncResolveItem = {
    mediaId: 'internal-uuid',
    mediaType: 'movie',
    tmdbId: '27205',
} as WatchSyncResolveItem;

const MOVIE_2: WatchSyncResolveItem = {
    mediaId: 'internal-uuid-2',
    mediaType: 'movie',
    tmdbId: '155',
} as WatchSyncResolveItem;

describe('jellyfinWatchSync.resolveIds — outage aborts, isolated failure skips', () => {
    beforeEach(() => {
        axiosGet.mockReset();
        breaker.open = false;
    });

    it('REJECTS on a genuine error when the breaker is OPEN (provider-wide outage → abort page, no drain)', async () => {
        breaker.open = true;
        axiosGet.mockRejectedValue(axiosError(401)); // revoked key
        await expect(jellyfinWatchSync.resolveIds!(makeCtx(), [MOVIE])).rejects.toThrow();
    });

    it('ISOLATES an isolated failure when the breaker is CLOSED — resolves the good item, omits the bad one', async () => {
        breaker.open = false;
        // First item errors (poison), second resolves fine. One bad item must not
        // block the other — resolveIds returns only the resolved item, no throw.
        axiosGet.mockImplementation(
            (_url: string, config?: { params?: { AnyProviderIdEquals?: string } }) => {
                const q = config?.params?.AnyProviderIdEquals ?? '';
                if (q === 'tmdb.27205') return Promise.reject(axiosError(500));
                return Promise.resolve({
                    data: { Items: [{ Id: 'jf-item-2', ProviderIds: { Tmdb: '155' } }] },
                });
            },
        );

        const resolved = await jellyfinWatchSync.resolveIds!(makeCtx(), [MOVIE, MOVIE_2]);
        expect(resolved).toEqual([{ mediaId: 'internal-uuid-2', providerId: 'jf-item-2' }]);
    });

    it('resolves (item omitted) when Jellyfin returns a 404 (genuinely absent) — no throw', async () => {
        axiosGet.mockRejectedValue(axiosError(404));
        const resolved = await jellyfinWatchSync.resolveIds!(makeCtx(), [MOVIE]);
        // 404 → resolver returns null → item not in the resolved set, and NO throw.
        expect(resolved).toEqual([]);
    });

    it('does not accept an unfiltered or ambiguous provider-id response', async () => {
        axiosGet.mockResolvedValue({ data: { Items: [{ Id: 'wrong', ProviderIds: {} }] } });
        expect(await jellyfinWatchSync.resolveIds(makeCtx(), [MOVIE])).toEqual([]);
        axiosGet.mockResolvedValue({
            data: {
                Items: [
                    { Id: 'a', ProviderIds: { Tmdb: '27205' } },
                    { Id: 'b', ProviderIds: { Tmdb: '27205' } },
                ],
            },
        });
        expect(await jellyfinWatchSync.resolveIds(makeCtx(), [MOVIE])).toEqual([]);
    });

    it('resolves the provider id on a normal hit (success path unchanged)', async () => {
        axiosGet.mockResolvedValue({
            data: { Items: [{ Id: 'jf-item-1', ProviderIds: { Tmdb: '27205' } }] },
        });
        const resolved = await jellyfinWatchSync.resolveIds!(makeCtx(), [MOVIE]);
        expect(resolved).toEqual([{ mediaId: 'internal-uuid', providerId: 'jf-item-1' }]);
    });
});

describe('jellyfinWatchSync.pullWatchState — all-series-fail surfaces as a pull error', () => {
    beforeEach(() => {
        axiosGet.mockReset();
        breaker.open = false;
    });

    it('every series TMDB lookup failing (non-404) surfaces in result.errors (was silently "success")', async () => {
        // Drive the REAL pull: one user, one played episode whose series TMDB
        // lookup deterministically 500s. buildSeriesTmdbMap must throw when EVERY
        // series lookup fails; the per-user catch converts it to a pull error, so
        // the pull task's `success = allErrors.length === 0` correctly flips false.
        // Before the fix, buildSeriesTmdbMap only logged and the pull "succeeded"
        // with zero episodes resolved.
        axiosGet.mockImplementation(
            (url: string, config?: { params?: { includeItemTypes?: string } }) => {
                if (url.endsWith('/Users')) {
                    return Promise.resolve({ data: [{ Id: 'u1', Name: 'alice' }] });
                }
                if (url.endsWith('/Sessions')) return Promise.resolve({ data: [] });
                if (url.endsWith('/Items/Resume')) return Promise.resolve({ data: { Items: [] } });
                if (url.endsWith('/Items/s1')) {
                    // Series TMDB lookup → genuine transport error (not a 404).
                    return Promise.reject(axiosError(500));
                }
                if (url.endsWith('/Users/u1/Items')) {
                    if (config?.params?.includeItemTypes === 'Episode') {
                        return Promise.resolve({
                            data: {
                                Items: [
                                    {
                                        Id: 'e1',
                                        Type: 'Episode',
                                        SeriesId: 's1',
                                        IndexNumber: 1,
                                        ParentIndexNumber: 1,
                                        UserData: { Played: true },
                                    },
                                ],
                                TotalRecordCount: 1,
                            },
                        });
                    }
                    return Promise.resolve({ data: { Items: [], TotalRecordCount: 0 } });
                }
                return Promise.resolve({ data: { Items: [] } });
            },
        );

        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {});
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join(' ')).toContain('every series TMDB lookup failed');
    });
});

// Mirrors the private TICKS_PER_MS constant in jellyfin.ts (not exported) —
// keep in sync if that changes. Only the ratio matters for the fraction
// math below, so this just needs to convert an arbitrary "ms" unit to ticks.
const TICKS_PER_MS_TEST = 10_000;

describe('jellyfinWatchSync.pullWatchState — active-session merge guard (paused-near-end)', () => {
    beforeEach(() => {
        axiosGet.mockReset();
        breaker.open = false;
    });

    /**
     * Drives a real pull for one user with one already-`Played: true` movie
     * and one active session for that same movie, parameterized by
     * `IsPaused`/position fraction. Returns the merged `WatchStatePullItem`
     * Lumastra would persist for the movie.
     */
    async function pullWithSession(session: {
        isPaused: boolean;
        positionTicks: number;
        runTimeTicks: number;
    }) {
        axiosGet.mockImplementation(
            (url: string, config?: { params?: Record<string, unknown> }) => {
                if (url.endsWith('/Users')) {
                    return Promise.resolve({ data: [{ Id: 'u1', Name: 'alice' }] });
                }
                if (url.endsWith('/Sessions')) {
                    return Promise.resolve({
                        data: [
                            {
                                Id: 'sess-1',
                                UserId: 'u1',
                                UserName: 'alice',
                                PlayState: {
                                    IsPaused: session.isPaused,
                                    PositionTicks: session.positionTicks,
                                    PlayMethod: 'DirectPlay',
                                },
                                NowPlayingItem: {
                                    Id: 'movie-1',
                                    Type: 'Movie',
                                    Name: 'The Rewatchable',
                                    RunTimeTicks: session.runTimeTicks,
                                    ProviderIds: {},
                                },
                            },
                        ],
                    });
                }
                if (url.endsWith('/Items/Resume')) return Promise.resolve({ data: { Items: [] } });
                if (url.endsWith('/Users/u1/Items')) {
                    if (config?.params?.includeItemTypes === 'Movie') {
                        return Promise.resolve({
                            data: {
                                Items: [
                                    {
                                        Id: 'movie-1',
                                        Type: 'Movie',
                                        Name: 'The Rewatchable',
                                        RunTimeTicks: session.runTimeTicks,
                                        ProviderIds: {},
                                        UserData: { Played: true, PlayCount: 1 },
                                    },
                                ],
                                TotalRecordCount: 1,
                            },
                        });
                    }
                    return Promise.resolve({ data: { Items: [], TotalRecordCount: 0 } });
                }
                return Promise.resolve({ data: { Items: [] } });
            },
        );

        const result = await jellyfinWatchSync.pullWatchState!(makeCtx(), {});
        expect(result.errors).toEqual([]);
        const item = result.items.find((i) => i.providerId === 'movie-1');
        if (!item) throw new Error('expected merged item for movie-1');
        return item;
    }

    it('does NOT revert isWatched when the session is PAUSED at >= 90% runtime (the false-positive shape)', async () => {
        // Left open after natural completion: paused at 95% of runtime.
        const item = await pullWithSession({
            isPaused: true,
            positionTicks: 9_500 * TICKS_PER_MS_TEST,
            runTimeTicks: 10_000 * TICKS_PER_MS_TEST,
        });
        expect(item.isWatched).toBe(true);
    });

    it('DOES revert isWatched when the session is actively PLAYING below 70% runtime (genuine rewatch)', async () => {
        const item = await pullWithSession({
            isPaused: false,
            positionTicks: 3_000 * TICKS_PER_MS_TEST,
            runTimeTicks: 10_000 * TICKS_PER_MS_TEST,
        });
        expect(item.isWatched).toBe(false);
    });

    it('DOES revert isWatched when the session is PAUSED below 90% runtime (rewatch paused partway through)', async () => {
        const item = await pullWithSession({
            isPaused: true,
            positionTicks: 5_000 * TICKS_PER_MS_TEST,
            runTimeTicks: 10_000 * TICKS_PER_MS_TEST,
        });
        expect(item.isWatched).toBe(false);
    });
});
