// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MoodStrategy — SHOW_UNAVAILABLE_MEDIA gate coverage.
 *
 * `ctx.showUnavailableMedia` is the always-on server-config gate for
 * discovery-sourced (has_files=false) items. Mood results include
 * requestable items via `WHERE (is_available = true OR can_request = true)`
 * in SQL, so the strategy must filter `item.isAvailable` on the raw rows
 * before paging when the gate is off.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext, RecommenderOptions } from '../recommender.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: vi.fn().mockReturnValue(null),
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    toPublicMediaType: (t: string) => (t === 'tv' ? 'series' : t),
}));

const mockGetDb = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

// hydrateRailMetadata (item-mapper.ts) issues a real getMediaRailMetadataBatch
// round trip after building items; mock the query out so it no-ops instead of
// calling the fake `sql` this suite's mockGetDb returns.
vi.mock('$lib/server/database/queries/media-rail-metadata.queries.js', () => ({
    getMediaRailMetadataBatch: vi.fn().mockResolvedValue(new Map()),
}));

const mockGetMoodRecommendations = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/mood-recommendations.service.js', () => ({
    getMoodRecommendations: (...args: unknown[]) => mockGetMoodRecommendations(...args),
}));

const mockBuildSearchAccessContext = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
}));

const { moodStrategy } = await import('./mood.strategy.js');

function makeCtx(partial: Partial<AccessContext> = {}): AccessContext {
    return {
        userId: 'usr_00000000-0000-0000-0000-000000000001' as UserId,
        username: 'alice',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
        ...partial,
    };
}

function makeOpts(partial: Partial<RecommenderOptions> = {}): RecommenderOptions {
    return {
        surface: 'internal',
        limit: 10,
        offset: 0,
        mood: 'cozy',
        ...partial,
    };
}

const AVAILABLE_ITEM = {
    mediaType: 'movie' as const,
    title: 'Available Movie',
    year: 2020,
    similarity: 0.5,
    externalIds: { internal: 'media-available' },
    media_id: 'media-available',
    isAvailable: true,
    canRequest: false,
};

const UNAVAILABLE_ITEM = {
    ...AVAILABLE_ITEM,
    title: 'Unavailable Movie',
    externalIds: { internal: 'media-unavailable' },
    media_id: 'media-unavailable',
    isAvailable: false,
    canRequest: true,
};

describe('MoodStrategy — SHOW_UNAVAILABLE_MEDIA gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ showUnavailableMedia: true });
        mockGetMoodRecommendations.mockResolvedValue([AVAILABLE_ITEM, UNAVAILABLE_ITEM]);
    });

    it('excludes has_files=false items when the gate is off', async () => {
        const result = await moodStrategy.fetch(
            makeCtx({ showUnavailableMedia: false }),
            makeOpts(),
        );

        expect(result.items).toHaveLength(1);
        expect(result.items[0].media.id).toBe('media-available');
    });

    it('includes has_files=false items when the gate is on', async () => {
        const result = await moodStrategy.fetch(
            makeCtx({ showUnavailableMedia: true }),
            makeOpts(),
        );

        expect(result.items).toHaveLength(2);
        const ids = result.items.map((i) => i.media.id);
        expect(ids).toEqual(expect.arrayContaining(['media-available', 'media-unavailable']));
    });
});
