// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext } from '../recommender.js';

const { getRandomPickItems } = vi.hoisted(() => ({
    getRandomPickItems: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    restrictedAccess: () => ({ age: {}, library: {} }),
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({ getRandomPickItems }));
// hydrateRailMetadata (item-mapper.ts) issues a real getMediaRailMetadataBatch
// round trip after mapBatch; this suite's `getDb` returns a bare `{}`, which
// isn't callable as a tagged-template `sql` — mock the query itself out so the
// hydration no-ops instead of throwing and collapsing the result to empty.
vi.mock('$lib/server/database/queries/media-rail-metadata.queries.js', () => ({
    getMediaRailMetadataBatch: vi.fn().mockResolvedValue(new Map()),
}));

import { RandomPicksStrategy } from './random-picks.strategy.js';

const ctx: AccessContext = {
    userId: 'usr_00000000-0000-0000-0000-000000000001' as UserId,
    username: 'alice',
    deniedGroupIds: null,
    maxAgeRating: null,
    allowUnrated: true,
    showUnavailableMedia: true,
    isAgeRestricted: false,
};

describe('RandomPicksStrategy media filtering', () => {
    beforeEach(() => vi.clearAllMocks());

    it('pushes the public allow-list into one randomized query and leaves offset as a no-op', async () => {
        getRandomPickItems.mockResolvedValue([
            { id: '00000000-0000-0000-0000-000000000001', title: 'Movie', media_type: 'movie' },
        ]);

        const result = await new RandomPicksStrategy().fetch(ctx, {
            surface: 'internal',
            limit: 2,
            offset: 50,
            mediaTypes: new Set(['movie']),
        });

        expect(getRandomPickItems).toHaveBeenCalledOnce();
        expect(getRandomPickItems).toHaveBeenCalledWith(expect.anything(), 3, expect.anything(), [
            'movie',
        ]);
        expect(result.items.map((item) => item.media.type)).toEqual(['movie']);
    });

    it('returns empty without querying when the allow-list has no supported video type', async () => {
        const result = await new RandomPicksStrategy().fetch(ctx, {
            surface: 'internal',
            limit: 2,
            mediaTypes: new Set(['audiobook']),
        });

        expect(result).toEqual({ items: [], hasMore: false, total: 0 });
        expect(getRandomPickItems).not.toHaveBeenCalled();
    });
});
