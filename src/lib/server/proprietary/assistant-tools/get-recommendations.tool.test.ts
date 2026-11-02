// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_recommendations` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getRecommendationsTool } from './get-recommendations.tool.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieSimilarityRow } from '../../database/queries/assistant-rag.queries.js';
import type { UserRatingFullRow } from '../../database/queries/user-ratings.queries.js';

const TEST_USER_ID = toUserId('aaaaaaaa-0000-0000-0000-000000000001');

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    findRelevantMediaByVector: vi.fn(),
}));
vi.mock('../../database/queries/user-ratings.queries.js', () => ({
    getUserRatingsFullMetadata: { all: vi.fn() },
}));

import { findRelevantMediaByVector } from '../../database/queries/assistant-rag.queries.js';
import { getUserRatingsFullMetadata } from '../../database/queries/user-ratings.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(embedSpy?: (t: string) => Promise<string>): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_USER_ID,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: embedSpy ?? (async () => '[0]'),
    };
}

const liked = [
    { primary_ext_id: '1', media_type: 'movie', title: 'Haze', rating: 9 },
] as unknown as UserRatingFullRow[];

const candidates = [
    // already rated -> must be excluded
    {
        primary_ext_id: '1',
        media_type: 'movie',
        title: 'Haze',
        similarity: 0.05,
    },
    {
        primary_ext_id: '2',
        media_type: 'movie',
        title: 'Collateral',
        similarity: 0.1,
    },
] as unknown as AssistantMovieSimilarityRow[];

describe('getRecommendationsTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('seeds the search from the user taste and excludes already-rated titles', async () => {
        const embed = vi.fn(async (_t: string) => '[0,0]');
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue(liked);
        vi.mocked(findRelevantMediaByVector).mockResolvedValue(candidates);

        const result = await getRecommendationsTool.execute({}, makeCtx(embed));

        // Seed mentions the liked title.
        expect(embed.mock.calls[0][0]).toContain('Haze');
        // "Haze" (already rated) excluded; "Collateral" kept.
        const titles = result.media?.map((m) => m.title);
        expect(titles).toEqual(['Collateral']);
    });

    it('uses the mood when provided', async () => {
        const embed = vi.fn(async (_t: string) => '[0,0]');
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue([]);
        vi.mocked(findRelevantMediaByVector).mockResolvedValue([candidates[1]]);

        await getRecommendationsTool.execute({ mood: 'cozy' }, makeCtx(embed));
        expect(embed.mock.calls[0][0]).toContain('cozy');
    });

    it('cold-start (no ratings) still returns recommendations', async () => {
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue([]);
        vi.mocked(findRelevantMediaByVector).mockResolvedValue([candidates[1]]);
        const result = await getRecommendationsTool.execute({}, makeCtx());
        expect(result.media).toHaveLength(1);
        expect(result.media?.[0].title).toBe('Collateral');
    });

    it('passes the media-type scope through to the vector search', async () => {
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue([]);
        vi.mocked(findRelevantMediaByVector).mockResolvedValue([]);
        await getRecommendationsTool.execute({ mediaType: 'tv' }, makeCtx());
        expect(vi.mocked(findRelevantMediaByVector).mock.calls[0][1].mediaTypes).toEqual(['tv']);
    });

    it('excludes watched titles by default', async () => {
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue([]);
        vi.mocked(findRelevantMediaByVector).mockResolvedValue([]);
        await getRecommendationsTool.execute({}, makeCtx());
        expect(vi.mocked(findRelevantMediaByVector).mock.calls[0][1].excludeWatched).toBe(true);
    });

    it('includes watched titles when includeWatched is true', async () => {
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue([]);
        vi.mocked(findRelevantMediaByVector).mockResolvedValue([]);
        await getRecommendationsTool.execute({ includeWatched: true }, makeCtx());
        expect(vi.mocked(findRelevantMediaByVector).mock.calls[0][1].excludeWatched).toBe(false);
    });
});
