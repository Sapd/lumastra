// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it, vi } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { findMediaTool } from './find-media.tool.js';
import type { AssistantToolContext } from './types.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    findMediaByConstraints: vi.fn(),
}));
import { findMediaByConstraints } from '../../database/queries/assistant-rag.queries.js';
import { assistantTestUser } from './test-context.js';

const userId = toUserId('00000000-0000-0000-0000-000000000001');
const ctx: AssistantToolContext = {
    sql: {} as never,
    userId,
    userIsAdmin: false,
    user: assistantTestUser(),
    writesAllowed: false,
    accessCtx: {
        username: 'alice',
        deniedGroupIds: ['group-1'],
        ageRating: null,
        liveTvAllowed: true,
        showUnavailableMedia: true,
    },
    embedQuery: async () => '[0]',
};

describe('findMediaTool', () => {
    it('passes typed hard filters with the caller access boundary', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([]);
        await findMediaTool.execute(
            {
                mediaType: 'movie',
                minYear: 2000,
                maxYear: 2009,
                maxRuntimeMinutes: 100,
                watched: false,
            },
            ctx,
        );
        expect(findMediaByConstraints).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                userId,
                mediaType: 'movie',
                minYear: 2000,
                maxYear: 2009,
                maxRuntimeMinutes: 100,
                watched: false,
                // limit + 1: the tool over-fetches by one to distinguish a full
                // page from a truncated one, then trims before returning.
                limit: 11,
                access: { library: { kind: 'denyGroups', ids: ['group-1'] }, age: { kind: 'any' } },
            }),
        );
    });

    // The reported failure: a user asked for "very good rotten tomatoes rating",
    // the tool had no RT filter, and the model invented three RT percentages.
    //
    // Asserted through the tool's OWN argsSchema, not through the mocked query:
    // execute() spreads args straight through, so a mock-level assertion passes
    // whether or not the capability exists. The schema is the contract the model
    // is shown and the gate dispatch validates against — that is what has to
    // change for the model to be ABLE to ask for this.
    it('accepts Rotten Tomatoes critic and audience floors', () => {
        const parsed = findMediaTool.argsSchema.parse({
            minRtRating: 75,
            minRtAudienceScore: 80,
        });
        expect(parsed).toMatchObject({ minRtRating: 75, minRtAudienceScore: 80 });
    });

    it('rejects Rotten Tomatoes scores outside the 0-100 percentage scale', () => {
        expect(() => findMediaTool.argsSchema.parse({ minRtRating: 9.5 })).toThrow();
        expect(() => findMediaTool.argsSchema.parse({ minRtAudienceScore: 101 })).toThrow();
    });

    it('can sort by Rotten Tomatoes critic and audience score', () => {
        for (const sortBy of ['rt_rating', 'rt_audience_score'] as const) {
            expect(findMediaTool.argsSchema.parse({ sortBy })).toMatchObject({ sortBy });
        }
    });

    // The second half of the bug: the model KNEW it lacked RT data (it said so
    // in its reasoning) and quoted numbers anyway. An empty or rating-less
    // result must carry an explicit statement the model can repeat, not a bare
    // empty list it will paper over.
    it('states plainly when a rating filter matched nothing', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([]);

        const result = await findMediaTool.execute({ minRtRating: 90 }, ctx);
        const summary = JSON.parse(result.summaryForModel);

        // `count` became `returnedCount` (see result-counts.ts): a bare count
        // beside a list kept being relayed as a library total.
        expect(summary.returnedCount).toBe(0);
        expect(summary.ratingDataNote).toMatch(/rotten tomatoes/i);
        expect(summary.ratingDataNote).toMatch(/do not (invent|state)|never invent/i);
    });

    it('reports how many returned titles actually carry each rating', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'A', media_type: 'movie', rt_rating: 96, rt_audience_score: 89 },
            { title: 'B', media_type: 'movie', rt_rating: null, rt_audience_score: null },
        ] as never);

        const result = await findMediaTool.execute({ minRtRating: 50 }, ctx);
        const summary = JSON.parse(result.summaryForModel);

        // Per-title truth so the model can cite A's score and say it lacks B's.
        expect(summary.results[0]).toMatchObject({ rtRating: 96, rtAudienceScore: 89 });
        expect(summary.results[1]).toMatchObject({ rtRating: null, rtAudienceScore: null });
        // `total` read as a library total too — it is the number of ROWS RETURNED.
        expect(summary.ratingCoverage).toMatchObject({
            rtRating: 1,
            rtAudienceScore: 1,
            ofReturned: 2,
        });
    });

    it('does not pass a peer watch-state predicate without the shared-history capability', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([]);

        await findMediaTool.execute({ unwatchedByUsername: 'Alex' }, ctx);

        expect(vi.mocked(findMediaByConstraints).mock.calls.at(-1)?.[1]).toMatchObject({
            unwatchedByUsername: undefined,
        });
    });

    // "Was ist neu dazugekommen?" had no lever at all: sortBy offered only
    // oldest_added, and minYear is RELEASE year, so a 1994 film added yesterday
    // was invisible while a 2026 film added two years ago counted as new.
    it('can ask for recently added titles by ingest date, not release year', () => {
        expect(findMediaTool.argsSchema.parse({ sortBy: 'newest_added' })).toMatchObject({
            sortBy: 'newest_added',
        });
        expect(findMediaTool.argsSchema.parse({ addedWithinDays: 30 })).toMatchObject({
            addedWithinDays: 30,
        });
    });

    // "irgendwas, aber bitte kein Horror" had no exclusion anywhere, so it
    // became a mood string for vector search, which cannot represent negation —
    // horror came back and was presented as fitting.
    // "Kinderserien" was answered with Elfen Lied and Death Note: those rows
    // carry no genres, so a Kids/Family/Animation filter degrades to "any
    // animation". Age rating is the signal that actually exists.
    it('can filter by age suitability', () => {
        expect(findMediaTool.argsSchema.parse({ maxAgeRating: 12 })).toMatchObject({
            maxAgeRating: 12,
        });
    });

    it('can exclude genres', () => {
        expect(findMediaTool.argsSchema.parse({ excludeGenres: ['Horror'] })).toMatchObject({
            excludeGenres: ['Horror'],
        });
    });

    it('trims the over-fetched row and flags that more exist', async () => {
        // 11 rows come back for a limit of 10 → the 11th is the probe.
        vi.mocked(findMediaByConstraints).mockResolvedValue(
            Array.from({ length: 11 }, (_, i) => ({
                title: `T${i}`,
                media_type: 'movie',
            })) as never,
        );

        const result = await findMediaTool.execute({}, ctx);
        const summary = JSON.parse(result.summaryForModel);

        expect(result.media).toHaveLength(10);
        // `hasMore`/`truncationNote` folded into the shared `maybeMore`/
        // `countNote` pair every tool now emits — one vocabulary, always
        // present, so a MISSING marker can no longer read as "this is all".
        expect(summary.maybeMore).toBe(true);
        expect(summary.countNote).toMatch(/PAGE|not a total/i);
    });

    it('does not claim more results exist when the page is not full', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([
            { title: 'Only', media_type: 'movie' },
        ] as never);

        const summary = JSON.parse((await findMediaTool.execute({}, ctx)).summaryForModel);

        expect(summary.maybeMore).toBe(false);
        // The marker is unconditional now, so assert on what it SAYS.
        expect(summary.countNote).toMatch(/nothing was cut off/i);
    });

    it('says the peer filter was dropped instead of implying it was applied', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([]);

        const result = await findMediaTool.execute({ unwatchedByUsername: 'Alex' }, ctx);
        const summary = JSON.parse(result.summaryForModel);

        expect(summary.peerFilterApplied).toBe(false);
        expect(summary.peerFilterNote).toContain('Alex');
        expect(summary.peerFilterNote).toMatch(/not.*checked|only/i);
    });

    it('reports the peer filter as applied when the capability is present', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([]);

        const result = await findMediaTool.execute(
            { unwatchedByUsername: 'Alex' },
            { ...ctx, socialWatchHistoryViewable: true },
        );
        const summary = JSON.parse(result.summaryForModel);

        expect(summary.peerFilterApplied).toBe(true);
        expect(summary.peerFilterNote).toBeUndefined();
    });

    it('passes the peer watch-state predicate only with the shared-history capability', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValue([]);

        await findMediaTool.execute(
            { unwatchedByUsername: 'Alex' },
            { ...ctx, socialWatchHistoryViewable: true },
        );

        expect(vi.mocked(findMediaByConstraints).mock.calls.at(-1)?.[1]).toMatchObject({
            unwatchedByUsername: 'Alex',
        });
    });
});
