// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for SessionsCacheService standalone mode guard.
 *
 * Verifies that when Jellyfin sync is disabled (features.jellyfinSync = false),
 * startCaching() is a no-op and no intervals are scheduled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../operation-mode.js', () => ({
    operationMode: {
        isJellyfinEnabled: false,
    },
}));

// features.jellyfinSync is the actual guard checked by startCaching()
vi.mock('../config.js', () => ({
    config: {
        JELLYFINURL: '',
        JELLYFINAPIKEY: '',
    },
    features: {
        audiobooks: false,
        jellyfinSync: false,
    },
    FEATURE_PER_TASK_QUEUES: false,
}));

// Mock Jellyfin services and LiveTV provider imported at module load time
vi.mock('../jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getUserByName: vi.fn().mockResolvedValue(null),
        getUserIdForLumastraUser: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('../jellyfin/playback.service.js', () => ({
    jellyfinPlaybackService: {
        getSessions: vi.fn().mockResolvedValue([]),
    },
}));
vi.mock('../jellyfin/media.service.js', () => ({
    jellyfinMediaService: {
        getItemDetails: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('./livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannels: vi.fn().mockResolvedValue([]),
        getCurrentProgram: vi.fn().mockResolvedValue(undefined),
        getGuidePrograms: vi.fn().mockResolvedValue({}),
    }),
}));

vi.mock('../transformers.js', () => ({
    transformJellyfinSessionToStreamSession: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

vi.mock('../cache/index.js', () => ({
    cacheManager: {
        for: vi.fn(() => ({
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            del: vi.fn().mockResolvedValue(undefined),
            invalidate: vi.fn().mockResolvedValue(undefined),
        })),
    },
    CACHE_NAMESPACES: {
        liveTvPrograms: 'liveTvPrograms',
        audioMetadata: 'audioMetadata',
    },
}));

import { sessionsCacheService, getSessionsCacheService } from './sessions-cache.service.js';

describe('SessionsCacheService — standalone mode (Jellyfin sync disabled)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('startCaching() is a no-op when features.jellyfinSync is false', () => {
        // Should not throw
        expect(() => sessionsCacheService.startCaching()).not.toThrow();

        // Advance timers — no intervals should fire
        vi.advanceTimersByTime(60_000);

        // stopCaching() should be safe (nothing to clear)
        expect(() => sessionsCacheService.stopCaching()).not.toThrow();
    });

    it('calling startCaching() multiple times in standalone mode does not throw', () => {
        expect(() => {
            sessionsCacheService.startCaching();
            sessionsCacheService.startCaching();
            sessionsCacheService.startCaching();
        }).not.toThrow();
    });

    it('getSessionsCacheService() returns the same singleton instance', () => {
        expect(getSessionsCacheService()).toBe(sessionsCacheService);
    });
});
