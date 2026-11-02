// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { buildWatchPlanTool } from './build-watch-plan.tool.js';
import type { AssistantToolContext } from './types.js';
vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    findMediaByConstraints: vi.fn(),
}));
import { findMediaByConstraints } from '../../database/queries/assistant-rag.queries.js';
import { assistantTestUser } from './test-context.js';

const ctx: AssistantToolContext = {
    sql: {} as never,
    userId: toUserId('00000000-0000-0000-0000-000000000001'),
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
    embedQuery: async () => '[0]',
};
describe('buildWatchPlanTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('only selects unwatched candidates that fit the time budget', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'A', runtime_minutes: 100, media_type: 'movie' },
            { title: 'B', runtime_minutes: 90, media_type: 'movie' },
            { title: 'C', runtime_minutes: 80, media_type: 'movie' },
        ] as never);
        const result = await buildWatchPlanTool.execute({ targetMinutes: 190, itemCount: 3 }, ctx);
        expect(result.media?.map((item) => item.title)).toEqual(['A', 'B']);
        expect(JSON.parse(result.summaryForModel)).toMatchObject({
            totalMinutes: 190,
            remainingMinutes: 0,
            exactFit: true,
        });
        expect(vi.mocked(findMediaByConstraints).mock.calls[0][1]).toMatchObject({
            watched: false,
            limit: 20,
        });
    });

    // The tool exists to budget time; the shared media summary carries no
    // runtime, so without this the model could not state how long a pick was.
    it('reports each pick’s own runtime to the model', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'A', runtime_minutes: 100, media_type: 'movie' },
        ] as never);
        const result = await buildWatchPlanTool.execute({ targetMinutes: 200 }, ctx);
        const summary = JSON.parse(result.summaryForModel);
        expect(summary.items).toEqual([expect.objectContaining({ runtimeMinutes: 100 })]);
        expect(summary.remainingMinutes).toBe(100);
    });

    // `diverse` compared JSON.stringify(genres), so a reordered or merely
    // overlapping genre list counted as different and the mode did nothing.
    it('diverse mode rejects a candidate sharing any genre with a pick', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'A', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Comedy'] },
            { title: 'B', runtime_minutes: 60, media_type: 'movie', genres: ['Comedy', 'Action'] },
            { title: 'C', runtime_minutes: 60, media_type: 'movie', genres: [{ name: 'Horror' }] },
        ] as never);
        const result = await buildWatchPlanTool.execute(
            { targetMinutes: 300, itemCount: 3, selectionMode: 'diverse' },
            ctx,
        );
        expect(result.media?.map((item) => item.title)).toEqual(['A', 'C']);
    });

    // Every candidate carries the requested genre by construction, so counting
    // it made the first pick disqualify all the rest: a "diverse" 5-hour action
    // marathon came back as one film.
    it('does not let the genre the caller asked for block every later pick', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'A', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Comedy'] },
            { title: 'B', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Horror'] },
            { title: 'C', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Drama'] },
        ] as never);
        const result = await buildWatchPlanTool.execute(
            {
                targetMinutes: 300,
                itemCount: 3,
                selectionMode: 'diverse',
                genres: ['Action'],
            },
            ctx,
        );
        expect(result.media?.map((item) => item.title)).toEqual(['A', 'B', 'C']);
    });

    // ...but the genres it did NOT ask for still have to separate the picks.
    it('still rejects an overlap on a genre the caller did not request', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'A', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Comedy'] },
            { title: 'B', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Comedy'] },
            { title: 'C', runtime_minutes: 60, media_type: 'movie', genres: ['Action', 'Horror'] },
        ] as never);
        const result = await buildWatchPlanTool.execute(
            {
                targetMinutes: 300,
                itemCount: 3,
                selectionMode: 'diverse',
                genres: ['Action'],
            },
            ctx,
        );
        expect(result.media?.map((item) => item.title)).toEqual(['A', 'C']);
    });
});
