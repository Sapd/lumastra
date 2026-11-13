// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `mark_watched` WRITE tool. The shared watched-state ops
 * are mocked, so these cover which UUID is handed over, the denied→not_found
 * collapse, and that a series fan-out is reported as such.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));
vi.mock('$lib/server/services/watched-state-ops.js', () => ({
    markWatchedOp: vi.fn(),
    markUnwatchedOp: vi.fn(),
}));

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { markWatchedOp, markUnwatchedOp } from '$lib/server/services/watched-state-ops.js';
import { markWatchedTool } from './mark-watched.tool.js';
import { markWatchedArgsSchema } from '../../../schemas/assistant-tools.js';
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

const heat = {
    media_id: '33333333-3333-4333-8333-333333333333',
    primary_ext_id: '949',
    title: 'Haze',
    media_type: 'movie',
    release_date: '1995-01-01',
} as AssistantMovieRow;

const breakingBad = {
    media_id: '44444444-4444-4444-8444-444444444444',
    primary_ext_id: '1396',
    title: 'Drifting Clouds',
    media_type: 'tv',
    release_date: '2008-01-01',
} as AssistantMovieRow;

describe('markWatchedTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('requires an explicit direction and rejects a model-supplied mediaId', () => {
        expect(markWatchedArgsSchema.safeParse({ title: 'Haze' }).success).toBe(false);
        expect(
            markWatchedArgsSchema.safeParse({ title: 'Haze', watched: true, mediaId: 'x' }).success,
        ).toBe(false);
    });

    it('marks a movie watched with the resolved internal UUID and the caller principal', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([heat]);
        vi.mocked(markWatchedOp).mockResolvedValue({ kind: 'ok', watched: true });

        const body = JSON.parse(
            (await markWatchedTool.execute({ title: 'Haze', watched: true }, makeCtx()))
                .summaryForModel,
        );

        expect(markWatchedOp).toHaveBeenCalledWith(ALICE, heat.media_id, user);
        expect(markUnwatchedOp).not.toHaveBeenCalled();
        expect(body.ok).toBe(true);
        expect(body.action).toBe('marked_watched');
        expect(body.fannedOutToWholeSeries).toBe(false);
        expect(body.ref).toBe('949:movie');
    });

    it('routes watched:false to the unwatched op', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([heat]);
        vi.mocked(markUnwatchedOp).mockResolvedValue({ kind: 'ok', watched: false });

        const body = JSON.parse(
            (await markWatchedTool.execute({ title: 'Haze', watched: false }, makeCtx()))
                .summaryForModel,
        );
        expect(markUnwatchedOp).toHaveBeenCalledWith(ALICE, heat.media_id, user);
        expect(markWatchedOp).not.toHaveBeenCalled();
        expect(body.action).toBe('marked_unwatched');
    });

    it('tells the model a series marking hit the WHOLE show', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([breakingBad]);
        vi.mocked(markWatchedOp).mockResolvedValue({ kind: 'ok', watched: true });

        const body = JSON.parse(
            (
                await markWatchedTool.execute(
                    { title: 'Drifting Clouds', mediaType: 'tv', watched: true },
                    makeCtx(),
                )
            ).summaryForModel,
        );
        expect(body.fannedOutToWholeSeries).toBe(true);
        expect(body.mediaType).toBe('series');
        expect(body.ref).toBe('1396:series');
        expect(body.note).toContain('every season and episode');
    });

    it('reports a denied item exactly like a missing one', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([heat]);
        vi.mocked(markWatchedOp).mockResolvedValue({ kind: 'denied' });
        const denied = (await markWatchedTool.execute({ title: 'Haze', watched: true }, makeCtx()))
            .summaryForModel;

        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const missing = (await markWatchedTool.execute({ title: 'Haze', watched: true }, makeCtx()))
            .summaryForModel;

        expect(denied).toBe(missing);
        expect(JSON.parse(denied).reason).toBe('not_found');
        expect(JSON.parse(denied).note).toContain('Nothing was marked.');
    });

    it('refuses when this run may not write', async () => {
        const body = JSON.parse(
            (
                await markWatchedTool.execute(
                    { title: 'Haze', watched: true },
                    makeCtx({ writesAllowed: false }),
                )
            ).summaryForModel,
        );
        expect(body.reason).toBe('not_allowed');
        expect(markWatchedOp).not.toHaveBeenCalled();
    });
});
