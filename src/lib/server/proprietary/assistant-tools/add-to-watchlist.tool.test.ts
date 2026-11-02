// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `add_to_watchlist` WRITE tool.
 *
 * Mocks the watchlist service and the access-scoped title query — so these
 * assert WHICH arguments cross the boundary and WHAT the model is told, and
 * nothing about the SQL underneath. The invariants that matter here are the
 * ones a later edit could quietly break: no model-supplied id ever reaches
 * resolution, and a denied title is indistinguishable from a missing one.
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
import {
    MediaAccessDeniedError,
    MediaNotResolvableError,
} from '$lib/server/utils/resolve-and-gate.js';
import { addToWatchlistTool } from './add-to-watchlist.tool.js';
import { addToWatchlistArgsSchema } from '../../../schemas/assistant-tools.js';
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

const bladeRunner = {
    media_id: '11111111-1111-4111-8111-111111111111',
    primary_ext_id: '335984',
    title: 'Cloud Runner 2049',
    media_type: 'movie',
    release_date: '2017-01-01',
    is_available: true,
    can_request: false,
} as AssistantMovieRow;

describe('addToWatchlistTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects a model-supplied mediaId — the UUID may only come from our own query', () => {
        const parsed = addToWatchlistArgsSchema.safeParse({
            title: 'Cloud Runner 2049',
            mediaId: '11111111-1111-4111-8111-111111111111',
        });
        expect(parsed.success).toBe(false);
    });

    it('saves the title and reports it as newly added', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        vi.mocked(watchlistManager.addItem).mockResolvedValue({
            saved: true,
            alreadyPresent: false,
            mediaId: bladeRunner.media_id,
        });

        const res = await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx());
        const body = JSON.parse(res.summaryForModel);

        expect(body.ok).toBe(true);
        expect(body.action).toBe('added');
        expect(body.alreadyOnWatchlist).toBe(false);
        expect(body.title).toBe('Cloud Runner 2049');
        expect(body.ref).toBe('335984:movie');
    });

    it('passes ONLY the internal UUID downstream, never a provider id', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        vi.mocked(watchlistManager.addItem).mockResolvedValue({
            saved: true,
            alreadyPresent: false,
            mediaId: bladeRunner.media_id,
        });

        await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx());

        const params = vi.mocked(watchlistManager.addItem).mock.calls[0][0];
        // Exactly `{ internal }` — a `tmdb` key here would fall through to
        // resolveOrCreateMediaId and CREATE a stub media_items row.
        expect(params.externalIds).toEqual({ internal: bladeRunner.media_id });
        expect(params.userId).toBe(ALICE);
        expect(params.mediaType).toBe('movie');
        expect(params.user).toBe(user);
    });

    it('emits the DB media type, not the public one, to the service', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            { ...bladeRunner, media_type: 'tv', primary_ext_id: '1396' } as AssistantMovieRow,
        ]);
        vi.mocked(watchlistManager.addItem).mockResolvedValue({
            saved: true,
            alreadyPresent: false,
            mediaId: bladeRunner.media_id,
        });

        const res = await addToWatchlistTool.execute(
            { title: 'Cloud Runner 2049', mediaType: 'tv' },
            makeCtx(),
        );

        expect(vi.mocked(watchlistManager.addItem).mock.calls[0][0].mediaType).toBe('tv');
        // …but the model-facing ref uses the PUBLIC vocabulary or it is a dead link.
        expect(JSON.parse(res.summaryForModel).ref).toBe('1396:series');
    });

    it('reports an already-saved title as a no-op, not as a fresh save', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        vi.mocked(watchlistManager.addItem).mockResolvedValue({
            saved: true,
            alreadyPresent: true,
            mediaId: bladeRunner.media_id,
        });

        const body = JSON.parse(
            (await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx()))
                .summaryForModel,
        );
        expect(body.ok).toBe(true);
        expect(body.action).toBe('noop');
        expect(body.alreadyOnWatchlist).toBe(true);
    });

    it('refuses when nothing accessible matches, and says nothing was saved', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const body = JSON.parse(
            (await addToWatchlistTool.execute({ title: 'Ghost Film' }, makeCtx())).summaryForModel,
        );
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('not_found');
        expect(body.note).toContain('Nothing was saved.');
        expect(watchlistManager.addItem).not.toHaveBeenCalled();
    });

    it('refuses to guess between two same-named titles', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            { ...bladeRunner, media_id: 'a', title: 'Fenwick', media_type: 'movie' },
            {
                ...bladeRunner,
                media_id: 'b',
                title: 'Fenwick',
                media_type: 'tv',
                release_date: '2014-01-01',
            },
        ] as AssistantMovieRow[]);

        const body = JSON.parse(
            (await addToWatchlistTool.execute({ title: 'Fenwick' }, makeCtx())).summaryForModel,
        );
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('ambiguous');
        expect(body.candidates).toHaveLength(2);
        expect(body.note).toContain('Nothing was saved.');
        expect(watchlistManager.addItem).not.toHaveBeenCalled();
    });

    it('gives access-denied and not-resolvable the SAME payload (no existence leak)', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);

        vi.mocked(watchlistManager.addItem).mockRejectedValueOnce(new MediaAccessDeniedError());
        const denied = (await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx()))
            .summaryForModel;

        vi.mocked(watchlistManager.addItem).mockRejectedValueOnce(new MediaNotResolvableError());
        const missing = (
            await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx())
        ).summaryForModel;

        expect(denied).toBe(missing);
        expect(JSON.parse(denied).reason).toBe('not_found');
    });

    it('maps the service swallowing an unresolvable id to the same not_found payload', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        // addItem catches MediaNotResolvableError itself and returns this shape.
        vi.mocked(watchlistManager.addItem).mockResolvedValue({ saved: false, mediaId: null });

        const body = JSON.parse(
            (await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx()))
                .summaryForModel,
        );
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('not_found');
    });

    it('turns an unexpected service failure into a refusal, never a throw', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        vi.mocked(watchlistManager.addItem).mockRejectedValue(
            new Error('SQLSTATE 42P01: relation "playlist_items" does not exist'),
        );

        const res = await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx());
        const body = JSON.parse(res.summaryForModel);
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('failed');
        expect(body.note).toContain('Nothing was saved.');
        // The dispatch loop's generic error text would have destroyed that detail,
        // and err.message must never reach the model.
        expect(res.summaryForModel).not.toContain('SQLSTATE');
    });

    it('refuses outright when this run may not write (plugin bridge)', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        const body = JSON.parse(
            (await addToWatchlistTool.execute({ title: 'X' }, makeCtx({ writesAllowed: false })))
                .summaryForModel,
        );
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('not_allowed');
        expect(watchlistManager.addItem).not.toHaveBeenCalled();
        expect(searchMediaByTitle).not.toHaveBeenCalled();
    });

    it('does not put the written title into the recommendation rail', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([bladeRunner]);
        vi.mocked(watchlistManager.addItem).mockResolvedValue({
            saved: true,
            alreadyPresent: false,
            mediaId: bladeRunner.media_id,
        });
        const res = await addToWatchlistTool.execute({ title: 'Cloud Runner 2049' }, makeCtx());
        expect(res.media).toBeUndefined();
    });
});
