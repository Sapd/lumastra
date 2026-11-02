// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_music_picks` assistant tool.
 * Mocks the backing quick-picks service — no real DB.
 *
 * Covers the cold-start honesty annotation: when the user has no recorded
 * listening history, `summaryForModel` must carry an explicit note so the
 * model does not present random/cold-start picks as personalized or
 * mood-matched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { getMusicPicksTool } from './get-music-picks.tool.js';
import type { AssistantToolContext } from './types.js';
import type { TaggedTrack } from '../../services/music/quick-picks.service.js';

vi.mock('../../services/music/quick-picks.service.js', () => ({
    getQuickPicks: vi.fn(),
    hasMusicListeningHistory: vi.fn(),
}));

import {
    getQuickPicks,
    hasMusicListeningHistory,
} from '../../services/music/quick-picks.service.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: toUserId(randomUUID()),
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

const pick = {
    id: 't1',
    title: 'Deep Cut',
    artist_title: 'Some Band',
    album_title: 'Some Album',
    bucket: 'deep-cuts',
} as unknown as TaggedTrack;

describe('getMusicPicksTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('adds the cold-start note when the user has no listening history', async () => {
        vi.mocked(getQuickPicks).mockResolvedValue([pick]);
        vi.mocked(hasMusicListeningHistory).mockResolvedValue(false);

        const result = await getMusicPicksTool.execute({}, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.note).toMatch(/no listening history/i);
        expect(summary.note).toMatch(/NOT personalized/);
        expect(summary.note).toMatch(/NOT mood-filtered/);
    });

    // Previously asserted that the caveat was OMITTED for a user with history.
    // That is what let "Musik zum Kochen" come back as taste picks with nothing
    // saying they were not mood-filtered — these picks are never mood, genre or
    // era aware, for anyone, so the caveat has to hold for everyone. The
    // cold-start wording still differs (see the test above).
    it('still says the picks are not mood-filtered when the user HAS history', async () => {
        vi.mocked(getQuickPicks).mockResolvedValue([pick]);
        vi.mocked(hasMusicListeningHistory).mockResolvedValue(true);

        const result = await getMusicPicksTool.execute({}, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.note).toMatch(/TASTE-based/);
        expect(summary.note).toMatch(/NOT filtered by mood/);
        expect(summary.note).not.toMatch(/no listening history/);
    });

    it('threads access scope and limit into getQuickPicks', async () => {
        vi.mocked(getQuickPicks).mockResolvedValue([]);
        vi.mocked(hasMusicListeningHistory).mockResolvedValue(true);

        await getMusicPicksTool.execute({ limit: 5 }, makeCtx());

        const call = vi.mocked(getQuickPicks).mock.calls[0];
        expect(call[2]).toBe(5);
        expect(call[4]).toMatchObject({ deniedGroupIds: ['g1'], ageRating: null });
    });

    it('returns music cards built from the returned tracks', async () => {
        vi.mocked(getQuickPicks).mockResolvedValue([pick]);
        vi.mocked(hasMusicListeningHistory).mockResolvedValue(true);

        const result = await getMusicPicksTool.execute({}, makeCtx());

        expect(result.music).toHaveLength(1);
        expect(result.music?.[0]).toMatchObject({
            id: 't1',
            title: 'Deep Cut',
            mediaType: 'track',
            bucket: 'deep-cuts',
        });
    });
});
