// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `remove_from_watchlist` WRITE tool. Mocks the service and
 * the access-scoped title query — argument-passing and model-facing wording
 * only; nothing here proves the SQL works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));
vi.mock('$lib/server/services/watchlist-manager.service.js', () => ({
    watchlistManager: { addItem: vi.fn(), removeItem: vi.fn() },
}));

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { watchlistManager } from '$lib/server/services/watchlist-manager.service.js';
import { removeFromWatchlistTool } from './remove-from-watchlist.tool.js';
import { removeFromWatchlistArgsSchema } from '../../../schemas/assistant-tools.js';
import { assistantTestUser } from './test-context.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

function makeCtx(over: Partial<AssistantToolContext> = {}): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
        userIsAdmin: false,
        user: assistantTestUser(),
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

const matrix = {
    media_id: '22222222-2222-4222-8222-222222222222',
    primary_ext_id: '603',
    title: 'The Lantern',
    media_type: 'movie',
    release_date: '1999-01-01',
} as AssistantMovieRow;

describe('removeFromWatchlistTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects a model-supplied mediaId', () => {
        expect(
            removeFromWatchlistArgsSchema.safeParse({ title: 'The Lantern', mediaId: 'x' }).success,
        ).toBe(false);
    });

    it('removes the resolved title using only its internal UUID', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([matrix]);
        vi.mocked(watchlistManager.removeItem).mockResolvedValue({
            removed: true,
            mediaId: matrix.media_id,
        });

        const body = JSON.parse(
            (await removeFromWatchlistTool.execute({ title: 'The Lantern' }, makeCtx()))
                .summaryForModel,
        );

        expect(vi.mocked(watchlistManager.removeItem).mock.calls[0][0].externalIds).toEqual({
            internal: matrix.media_id,
        });
        expect(body.ok).toBe(true);
        expect(body.action).toBe('removed');
        expect(body.wasOnWatchlist).toBe(true);
        expect(body.ref).toBe('603:movie');
    });

    it('reports a second removal as a no-op, not a success', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([matrix]);
        vi.mocked(watchlistManager.removeItem).mockResolvedValue({
            removed: false,
            mediaId: matrix.media_id,
        });

        const body = JSON.parse(
            (await removeFromWatchlistTool.execute({ title: 'The Lantern' }, makeCtx()))
                .summaryForModel,
        );
        expect(body.action).toBe('noop');
        expect(body.wasOnWatchlist).toBe(false);
        expect(body.note).toContain('not on the watchlist');
    });

    it('refuses an unknown or inaccessible title with the same wording', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const body = JSON.parse(
            (await removeFromWatchlistTool.execute({ title: 'Ghost' }, makeCtx())).summaryForModel,
        );
        expect(body.reason).toBe('not_found');
        expect(body.note).toContain('Nothing was removed.');
        expect(watchlistManager.removeItem).not.toHaveBeenCalled();
    });

    it('turns a service failure into a refusal, never a throw', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([matrix]);
        vi.mocked(watchlistManager.removeItem).mockRejectedValue(new Error('boom'));
        const body = JSON.parse(
            (await removeFromWatchlistTool.execute({ title: 'The Lantern' }, makeCtx()))
                .summaryForModel,
        );
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('failed');
    });

    it('is absent-by-refusal when this run may not write', async () => {
        const body = JSON.parse(
            (
                await removeFromWatchlistTool.execute(
                    { title: 'The Lantern' },
                    makeCtx({ writesAllowed: false }),
                )
            ).summaryForModel,
        );
        expect(body.reason).toBe('not_allowed');
        expect(watchlistManager.removeItem).not.toHaveBeenCalled();
    });
});
