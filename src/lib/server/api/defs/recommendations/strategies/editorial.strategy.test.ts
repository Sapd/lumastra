// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EditorialStrategy(holiday): the rail must apply the same gates as
 * /api/recommendations/holiday — age-restricted profiles get nothing, and the
 * plugin runs inside the caller's library/age boundary (it scopes library
 * discovery, availability and the `internal` ids it emits).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccessContext, RecommenderOptions } from '../recommender.js';
import type { UserId } from '$lib/shared/user-id.js';

const mockGetHolidayRecommendations = vi.fn();

vi.mock('$lib/server/plugins/holidays/plugin.js', () => ({
    getHolidayRecommendations: (...args: unknown[]) => mockGetHolidayRecommendations(...args),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));

const { EditorialStrategy } = await import('./editorial.strategy.js');
const { features } = await import('$lib/server/config.js');

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

const opts: RecommenderOptions = { surface: 'internal', limit: 10 };

beforeEach(() => {
    // Off by default (DISABLE_HOLIDAY_RECOMMENDATIONS); most cases test ON.
    vi.spyOn(features, 'holidays', 'get').mockReturnValue(true);
    mockGetHolidayRecommendations.mockReset().mockResolvedValue({
        active: true,
        holiday: { id: 'halloween', name: 'Halloween' },
        cached: false,
        items: [
            {
                externalIds: { tmdb: '4232', internal: '11111111-1111-4111-8111-111111111111' },
                mediaType: 'movie',
                title: 'Shimmer',
                rating: 7.4,
                isAvailable: true,
                canRequest: false,
            },
        ],
    });
});

describe('EditorialStrategy(holiday)', () => {
    it('returns no holiday rail when the feature is off, without calling the plugin', async () => {
        vi.spyOn(features, 'holidays', 'get').mockReturnValue(false);
        const result = await new EditorialStrategy().fetch(makeCtx(), opts);

        expect(result).toEqual({ items: [], hasMore: false });
        expect(mockGetHolidayRecommendations).not.toHaveBeenCalled();
    });

    it('returns the holiday rail when the feature is on', async () => {
        const result = await new EditorialStrategy().fetch(makeCtx(), opts);
        expect(result.items).toHaveLength(1);
    });

    it('returns nothing for an age-restricted profile without calling the plugin', async () => {
        const result = await new EditorialStrategy().fetch(
            makeCtx({ isAgeRestricted: true }),
            opts,
        );

        expect(result).toEqual({ items: [], hasMore: false });
        expect(mockGetHolidayRecommendations).not.toHaveBeenCalled();
    });

    it("passes the caller's library and age boundary to the plugin", async () => {
        await new EditorialStrategy().fetch(
            makeCtx({
                deniedGroupIds: ['g-1'],
                maxAgeRating: 12,
                allowUnrated: false,
                showUnavailableMedia: false,
            }),
            opts,
        );

        expect(mockGetHolidayRecommendations).toHaveBeenCalledWith('alice', {
            limit: 11,
            refresh: undefined,
            access: {
                username: 'alice',
                deniedGroupIds: ['g-1'],
                ageRating: { maxAgeRating: 12, allowUnrated: false },
                liveTvAllowed: false,
                showUnavailableMedia: false,
            },
        });
    });

    it('uses the internal id the plugin emits as the media reference', async () => {
        const result = await new EditorialStrategy().fetch(makeCtx(), opts);

        expect(result.items).toHaveLength(1);
        expect(result.items[0].media.id).toBe('11111111-1111-4111-8111-111111111111');
        expect(result.items[0].isAvailable).toBe(true);
    });
});
