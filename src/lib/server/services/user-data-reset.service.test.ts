// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const clearAllMusicState = vi.fn().mockResolvedValue({ musicState: 5, listenEvents: 9 });
const clearAllTrackRatings = vi.fn().mockResolvedValue(2);
const clearAllWatchHistory = vi.fn().mockResolvedValue({
    events: 4,
    state: 4,
    watchHistory: 3,
    playSessions: 1,
    playlistItemWatched: 0,
});
const clearAllTasteDampers = vi.fn().mockResolvedValue(2);
const clearWatchProgress = vi.fn().mockResolvedValue(undefined);
const emit = vi.fn();
const invalidateContinueWatchingCache = vi.fn().mockResolvedValue(undefined);
const deleteUserCache = vi.fn().mockResolvedValue(undefined);
const begin = vi.fn(async (cb: (tx: unknown) => unknown) => cb({}));

vi.mock('$lib/server/database/queries/music-tracking.queries.js', () => ({ clearAllMusicState }));
vi.mock('$lib/server/database/queries/music-interactions.queries.js', () => ({
    clearAllTrackRatings,
}));
vi.mock('$lib/server/database/queries/user-data-reset.queries.js', () => ({
    clearAllWatchHistory,
    clearAllTasteDampers,
}));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: { clearWatchProgress },
}));
vi.mock('$lib/server/services/watch-state-events.service.js', () => ({
    watchStateEvents: { emit },
}));
vi.mock('$lib/server/services/watched-cache.service.js', () => ({
    invalidateContinueWatchingCache,
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => Object.assign(() => [], { begin }),
}));
vi.mock('$lib/server/cache', () => ({
    CACHE_NAMESPACES: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
    cacheManager: { for: () => ({ deleteUserCache }) },
}));

const USER = '00000000-0000-0000-0000-0000000000a5';

describe('UserDataResetManager', () => {
    beforeEach(() => vi.clearAllMocks());

    it('music-history clears state + flushes caches', async () => {
        const { userDataResetManager } = await import('./user-data-reset.service.js');
        const cleared = await userDataResetManager.run(USER as never, 'music-history');
        expect(clearAllMusicState).toHaveBeenCalledWith(expect.anything(), USER);
        expect(cleared).toMatchObject({ musicState: 5, listenEvents: 9 });
        expect(deleteUserCache).toHaveBeenCalled();
    });

    it('vod-history runs in a transaction and emits watch_state_set_changed', async () => {
        const { userDataResetManager } = await import('./user-data-reset.service.js');
        await userDataResetManager.run(USER as never, 'vod-history');
        expect(begin).toHaveBeenCalled();
        expect(clearAllWatchHistory).toHaveBeenCalled();
        expect(invalidateContinueWatchingCache).toHaveBeenCalledWith(USER);
        expect(emit).toHaveBeenCalledWith(
            USER,
            expect.objectContaining({ type: 'watch_state_set_changed' }),
        );
    });

    it('vod-recs clears dampers', async () => {
        const { userDataResetManager } = await import('./user-data-reset.service.js');
        const cleared = await userDataResetManager.run(USER as never, 'vod-recs');
        expect(clearAllTasteDampers).toHaveBeenCalledWith(expect.anything(), USER);
        expect(cleared).toMatchObject({ dampers: 2 });
    });

    it('vod-resume delegates to watchManager', async () => {
        const { userDataResetManager } = await import('./user-data-reset.service.js');
        await userDataResetManager.run(USER as never, 'vod-resume');
        expect(clearWatchProgress).toHaveBeenCalledWith({ userId: USER });
    });
});
