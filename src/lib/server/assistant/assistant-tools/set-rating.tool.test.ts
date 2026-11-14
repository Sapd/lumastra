// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `set_rating` WRITE tool. `ratingManager` is mocked, so
 * these assert the routing decision (taste path, not the device path), the
 * arguments crossing the boundary, and what the model is allowed to learn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));
vi.mock('$lib/server/services/rating-manager.service.js', () => ({
    ratingManager: { recordRating: vi.fn(), clearRating: vi.fn() },
}));

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { ratingManager } from '$lib/server/services/rating-manager.service.js';
import {
    MediaAccessDeniedError,
    MediaNotResolvableError,
} from '$lib/server/utils/resolve-and-gate.js';
import { setRatingTool } from './set-rating.tool.js';
import { setRatingArgsSchema } from '../../../schemas/assistant-tools.js';
import { assistantTestUser } from './test-context.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');
const user = assistantTestUser();

function makeCtx(over: Partial<AssistantToolContext> = {}): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
        userIsAdmin: false,
        user,
        writesAllowed: true,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
        ...over,
    };
}

const dawn = {
    media_id: '55555555-5555-4555-8555-555555555555',
    primary_ext_id: '438631',
    title: 'Dawn',
    media_type: 'movie',
    release_date: '2021-01-01',
} as AssistantMovieRow;

const recordResult = {
    rating: {} as never,
    mediaId: dawn.media_id,
    ratingCount: 41,
    learningApplied: true,
    profileUpdated: true,
    recommendationsReady: true,
    milestoneReached: true,
    isEpisodeMedia: false,
    wasNewRating: true,
};

describe('setRatingTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('bounds the scale to 1-10 and rejects a model-supplied mediaId', () => {
        expect(setRatingArgsSchema.safeParse({ title: 'Dawn', rating: 95 }).success).toBe(false);
        expect(setRatingArgsSchema.safeParse({ title: 'Dawn', rating: 0 }).success).toBe(false);
        expect(setRatingArgsSchema.safeParse({ title: 'Dawn', rating: 8.5 }).success).toBe(false);
        // Omitting `rating` is not the same as clearing it — null must be explicit.
        expect(setRatingArgsSchema.safeParse({ title: 'Dawn' }).success).toBe(false);
        expect(setRatingArgsSchema.safeParse({ title: 'Dawn', rating: null }).success).toBe(true);
        expect(
            setRatingArgsSchema.safeParse({ title: 'Dawn', rating: 8, mediaId: 'x' }).success,
        ).toBe(false);
    });

    it('records through the AI taste path with only the internal UUID', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);
        vi.mocked(ratingManager.recordRating).mockResolvedValue(recordResult);

        const body = JSON.parse(
            (await setRatingTool.execute({ title: 'Dawn', rating: 8 }, makeCtx())).summaryForModel,
        );

        const params = vi.mocked(ratingManager.recordRating).mock.calls[0][0];
        expect(params.externalIds).toEqual({ internal: dawn.media_id });
        expect(params.rating).toBe(8);
        expect(params.mediaType).toBe('movie');
        expect(params.username).toBe('alice');
        expect(params.user).toBe(user);

        expect(body.ok).toBe(true);
        expect(body.action).toBe('rated');
        expect(body.rating).toBe(8);
        expect(body.totalRatings).toBe(41);
        expect(body.wasNewRating).toBe(true);
    });

    it('never tells the model about milestones or recommendation unlocks', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);
        vi.mocked(ratingManager.recordRating).mockResolvedValue(recordResult);
        const body = JSON.parse(
            (await setRatingTool.execute({ title: 'Dawn', rating: 8 }, makeCtx())).summaryForModel,
        );
        expect(body).not.toHaveProperty('milestoneReached');
        expect(body).not.toHaveProperty('recommendationsReady');
        expect(body).not.toHaveProperty('profileUpdated');
    });

    it('clears a rating when rating is null', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);
        vi.mocked(ratingManager.clearRating).mockResolvedValue({ cleared: true });

        const body = JSON.parse(
            (await setRatingTool.execute({ title: 'Dawn', rating: null }, makeCtx()))
                .summaryForModel,
        );
        expect(ratingManager.recordRating).not.toHaveBeenCalled();
        expect(vi.mocked(ratingManager.clearRating).mock.calls[0][0].externalIds).toEqual({
            internal: dawn.media_id,
        });
        expect(body.action).toBe('cleared');
        expect(body.hadRating).toBe(true);
    });

    it('says plainly when there was no rating to clear', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);
        vi.mocked(ratingManager.clearRating).mockResolvedValue({ cleared: false });
        const body = JSON.parse(
            (await setRatingTool.execute({ title: 'Dawn', rating: null }, makeCtx()))
                .summaryForModel,
        );
        expect(body.hadRating).toBe(false);
        expect(body.note).toContain('no rating to remove');
    });

    it('gives access-denied and not-resolvable the SAME payload', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);

        vi.mocked(ratingManager.recordRating).mockRejectedValueOnce(new MediaAccessDeniedError());
        const denied = (await setRatingTool.execute({ title: 'Dawn', rating: 8 }, makeCtx()))
            .summaryForModel;

        vi.mocked(ratingManager.recordRating).mockRejectedValueOnce(new MediaNotResolvableError());
        const missing = (await setRatingTool.execute({ title: 'Dawn', rating: 8 }, makeCtx()))
            .summaryForModel;

        expect(denied).toBe(missing);
        expect(JSON.parse(denied).reason).toBe('not_found');
        expect(JSON.parse(denied).note).toContain('The rating was not saved.');
    });

    it('turns an unexpected failure into a refusal that leaks nothing', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);
        vi.mocked(ratingManager.recordRating).mockRejectedValue(
            new Error('SQLSTATE 42P01: relation "user_ratings" does not exist'),
        );
        const res = await setRatingTool.execute({ title: 'Dawn', rating: 8 }, makeCtx());
        expect(JSON.parse(res.summaryForModel).reason).toBe('failed');
        expect(res.summaryForModel).not.toContain('SQLSTATE');
    });

    it('refuses for an age-restricted profile, mirroring POST /api/ai/rate', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([dawn]);
        const ctx = makeCtx({
            user: assistantTestUser({ isAgeRestricted: true, maxAgeRating: 12 }),
        });
        const body = JSON.parse(
            (await setRatingTool.execute({ title: 'Dawn', rating: 8 }, ctx)).summaryForModel,
        );
        expect(body.reason).toBe('not_allowed');
        expect(ratingManager.recordRating).not.toHaveBeenCalled();
    });

    it('refuses when this run may not write', async () => {
        const body = JSON.parse(
            (
                await setRatingTool.execute(
                    { title: 'Dawn', rating: 8 },
                    makeCtx({ writesAllowed: false }),
                )
            ).summaryForModel,
        );
        expect(body.reason).toBe('not_allowed');
        expect(ratingManager.recordRating).not.toHaveBeenCalled();
    });
});
