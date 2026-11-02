// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the proactive chat opener.
 *
 * The opener runs on every chat open, so it is deliberately NOT an LLM call: it
 * picks one hook from data the user already has. These tests pin the priority
 * order and, more importantly, that it never invents a hook — an empty library
 * must yield no suggestion rather than a generic one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('../database/queries/audiobook-browse.queries.js', () => ({
    getAudiobooksInProgress: vi.fn(),
}));
vi.mock('../database/queries/assistant-rag.queries.js', () => ({
    findMediaByConstraints: vi.fn(),
}));
vi.mock('../database/queries/watchlist-media.queries.js', () => ({
    getUserWatchlistMedia: vi.fn(),
}));

import { getAudiobooksInProgress } from '../database/queries/audiobook-browse.queries.js';
import { findMediaByConstraints } from '../database/queries/assistant-rag.queries.js';
import { getUserWatchlistMedia } from '../database/queries/watchlist-media.queries.js';
import { buildAssistantOpener } from './assistant-opener.service.js';

const userId = toUserId('00000000-0000-0000-0000-000000000001');
const accessCtx = {
    username: 'denis',
    deniedGroupIds: ['g1'],
    ageRating: null,
    liveTvAllowed: true,
    showUnavailableMedia: true,
};

function args() {
    return { sql: {} as never, userId, accessCtx } as never;
}

/** Nothing anywhere — the shape every test starts from. */
function seedEmpty(): void {
    vi.mocked(getAudiobooksInProgress).mockResolvedValue([]);
    vi.mocked(getUserWatchlistMedia).mockResolvedValue([] as never);
    vi.mocked(findMediaByConstraints).mockResolvedValue([]);
}

describe('buildAssistantOpener', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedEmpty();
    });

    it('returns no hook when the user has nothing at all', async () => {
        expect((await buildAssistantOpener(args())).hook).toBeNull();
    });

    it('prefers an in-progress audiobook over everything else', async () => {
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([
            { title: 'Dawn', positionMs: 3_600_000, durationMs: 7_200_000 },
        ] as never);
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([{ title: 'Haze' }] as never);
        vi.mocked(findMediaByConstraints).mockResolvedValue([{ title: 'Aralyn' }] as never);

        const { hook } = await buildAssistantOpener(args());

        expect(hook).toMatchObject({ kind: 'resume_audiobook', title: 'Dawn' });
    });

    it('states the remaining time when there is a useful amount of it', async () => {
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([
            { title: 'Dawn', positionMs: 3_600_000, durationMs: 7_200_000 },
        ] as never);

        expect((await buildAssistantOpener(args())).hook).toMatchObject({
            remainingMinutes: 60,
        });
    });

    it('omits the remaining time rather than saying "0 min"', async () => {
        // Anything under a minute rounded to 0, and the opener read
        // "dir fehlen noch 0 min bei Dawn". The client already has wording for
        // an absent amount.
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([
            { title: 'Dawn', positionMs: 7_199_000, durationMs: 7_200_000 },
        ] as never);

        const { hook } = await buildAssistantOpener(args());
        expect(hook).toMatchObject({ kind: 'resume_audiobook', title: 'Dawn' });
        expect(hook?.remainingMinutes).toBeUndefined();
    });

    it('reads only a page of the watchlist, not all of it', async () => {
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([{ title: 'Haze' }] as never);

        await buildAssistantOpener(args());

        expect(vi.mocked(getUserWatchlistMedia).mock.calls[0][3]).toMatchObject({
            limit: expect.any(Number),
            offset: 0,
        });
    });

    it('falls to a recent arrival when no audiobook is in progress', async () => {
        vi.mocked(findMediaByConstraints).mockResolvedValueOnce([{ title: 'Aralyn' }] as never);

        expect((await buildAssistantOpener(args())).hook).toMatchObject({
            kind: 'new_arrival',
            title: 'Aralyn',
        });
    });

    it('falls to the watchlist when nothing is new', async () => {
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([{ title: 'Haze' }] as never);

        expect((await buildAssistantOpener(args())).hook).toMatchObject({
            kind: 'watchlist',
            title: 'Haze',
        });
    });

    it('falls last to a well-reviewed unwatched title', async () => {
        // First call (new arrivals) empty, second (top rated) has a row.
        vi.mocked(findMediaByConstraints)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ title: 'Haze' }] as never);

        expect((await buildAssistantOpener(args())).hook).toMatchObject({
            kind: 'top_rated',
            title: 'Haze',
        });
    });

    // The opener is a read the user did not ask for; it must never widen access.
    it('threads the caller access boundary into every source', async () => {
        await buildAssistantOpener(args());

        const boundary = {
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        };
        expect(vi.mocked(getAudiobooksInProgress).mock.calls[0][1]).toMatchObject({
            access: boundary,
        });
        expect(vi.mocked(findMediaByConstraints).mock.calls[0][1]).toMatchObject({
            access: boundary,
        });
    });

    // A failing source must not take the chat page down with it.
    it('degrades to no hook when a source throws', async () => {
        vi.mocked(getAudiobooksInProgress).mockRejectedValue(new Error('db down'));

        await expect(buildAssistantOpener(args())).resolves.toMatchObject({ hook: null });
    });
});
