// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `get_audiobook_progress`.
 *
 * "Wo bin ich in meinem Hörbuch stehen geblieben?" had NO tool at all — the
 * audiobook surface was search-only and analyze_viewing_history reads
 * watch_history (video). Nothing forced the model to admit that, so a resume
 * position is exactly the kind of specific, checkable number it would supply
 * from nowhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getAudiobookProgressTool } from './get-audiobook-progress.tool.js';
import type { AssistantToolContext } from './types.js';

vi.mock('../../database/queries/audiobook-browse.queries.js', () => ({
    getAudiobooksInProgress: vi.fn(),
}));
import { getAudiobooksInProgress } from '../../database/queries/audiobook-browse.queries.js';
import { assistantTestUser } from './test-context.js';

const userId = toUserId('00000000-0000-0000-0000-000000000001');
function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: ['g1'],
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

describe('getAudiobookProgressTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('reports the resume position as a real elapsed/remaining time', async () => {
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([
            {
                media_id: 'b1',
                title: 'Dawn',
                seriesName: null,
                authors: ['Frank Herbert'],
                positionMs: 3_600_000, // 1h in
                durationMs: 7_200_000, // 2h long
                lastEventAt: new Date('2026-08-19T20:00:00Z'),
            },
        ] as never);

        const result = await getAudiobookProgressTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(1);
        expect(summary.books[0]).toMatchObject({
            title: 'Dawn',
            positionHuman: '1h 0m',
            remainingHuman: '1h 0m',
            percentComplete: 50,
        });
    });

    it('threads the caller access boundary', async () => {
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([]);

        await getAudiobookProgressTool.execute({}, makeCtx());

        expect(vi.mocked(getAudiobooksInProgress).mock.calls[0][1]).toMatchObject({
            userId,
            access: { library: { kind: 'denyGroups', ids: ['g1'] }, age: { kind: 'any' } },
        });
    });

    // Progress is mirrored from AudiobookShelf; an empty rail can mean "nothing
    // started" OR "the sync has not written yet". The model must not turn that
    // ambiguity into a confident "you haven't started any books".
    it('says an empty result is ambiguous rather than "nothing started"', async () => {
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([]);

        const result = await getAudiobookProgressTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        expect(summary.returnedCount).toBe(0);
        expect(summary.note).toMatch(/sync/i);
        expect(summary.note).toMatch(/do not|don't/i);
    });

    // A duration of 0/null must not become a division-by-zero percentage.
    it('omits the percentage when the duration is unknown', async () => {
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([
            {
                media_id: 'b2',
                title: 'Unknown Length',
                seriesName: null,
                authors: [],
                positionMs: 60_000,
                durationMs: null,
                lastEventAt: null,
            },
        ] as never);

        const result = await getAudiobookProgressTool.execute({}, makeCtx());
        const book = JSON.parse(result.summaryForModel).books[0];

        expect(book.percentComplete).toBeNull();
        expect(book.remainingHuman).toBeNull();
        expect(book.positionHuman).toBe('1m');
    });
});
