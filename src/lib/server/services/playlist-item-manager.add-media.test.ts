// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * addMediaItems: access filtering of expansion children and the candidate cap.
 * SQL is a statement-dispatching fake; checkMediaAccess is mocked per id.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';

const mocks = vi.hoisted(() => ({
    access: vi.fn(),
    insert: vi.fn(),
    touch: vi.fn(),
    items: vi.fn(),
    media: { current: null as unknown },
    candidates: { current: [] as unknown[] },
    candidateQueue: [] as unknown[][],
    existing: { current: new Set<string>() },
    inserted: [] as string[],
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: mocks.access }));
vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: async (sql: unknown, cb: (tx: unknown) => unknown) => cb(sql),
}));
vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    resolvePreferredToMediaId: vi.fn(),
    resolveEpisodeContext: vi.fn(async () => null),
    insertPlaylistItem: mocks.insert,
    touchPlaylist: mocks.touch,
    getPlaylistSummary: vi.fn(async () => ({ itemCount: 0, revision: 1, updatedAt: 'x' })),
    getPlaylistItems: mocks.items,
    getItemPosition: vi.fn(),
    deletePlaylistItem: vi.fn(),
    reorderItemsAfterDelete: vi.fn(),
}));
vi.mock('$lib/server/database/queries/playlist-items.queries.js', () => ({
    getSeriesEpisodesForPlaylist: vi.fn(),
    getAlbumTracks: vi.fn(),
}));
vi.mock('$lib/server/utils/playlist-transforms.js', () => ({
    transformInsertedItemRow: vi.fn(),
    transformPlaylistItemRow: (row: { id: number; media_id: string }) => ({
        id: row.id,
        mediaId: row.media_id,
    }),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
}));

const { playlistItemManager } = await import('./playlist-item-manager.service.js');

const SERIES = '00000000-0000-4000-8000-0000000000aa';
const user = { userId: 'u', username: 'alice' } as unknown as UserContext;
const child = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: `Episode ${n}`,
    media_type: 'episode',
});

/** Tagged-template fake dispatching on statement text. */
const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
    if (text.includes('FROM media_items m')) {
        const list = mocks.candidateQueue.shift() ?? mocks.candidates.current;
        return Promise.resolve(list.slice(0, Number(values.at(-1))));
    }
    if (text.includes('FROM media_items WHERE id')) return Promise.resolve([mocks.media.current]);
    if (text.includes('FROM playlist_items')) {
        const mediaId = String(values[1]);
        return Promise.resolve(mocks.existing.current.has(mediaId) ? [{ id: 999 }] : []);
    }
    throw new Error(`unexpected SQL: ${text}`);
}) as unknown as postgres.Sql;

function add(mediaIds = [SERIES]) {
    return playlistItemManager.addMediaItems({
        sql: tx,
        playlistId: 1,
        playlistType: 'general',
        mediaIds,
        user,
        surface: 'internal',
        access: {} as never,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.inserted.length = 0;
    mocks.candidateQueue.length = 0;
    mocks.existing.current = new Set();
    mocks.media.current = { id: SERIES, title: 'Invented Show', media_type: 'tv' };
    mocks.candidates.current = [child(1), child(2), child(3)];
    mocks.access.mockResolvedValue(true);
    let next = 100;
    mocks.insert.mockImplementation(async (_tx: unknown, row: { mediaId: string }) => {
        mocks.inserted.push(row.mediaId);
        return { id: next++ };
    });
    mocks.items.mockImplementation(
        async (_tx: unknown, _p: unknown, _u: unknown, _t: unknown, _a: unknown, _o: unknown, _s: unknown, ids: number[]) =>
            ids.map((id, i) => ({ id, media_id: mocks.inserted[i] ?? 'dup' })),
    );
});

describe('addMediaItems expansion access', () => {
    it('adds only the accessible children of an accessible series', async () => {
        const denied = child(2).id;
        mocks.access.mockImplementation(async (_tx: unknown, id: string) => id !== denied);

        const { results } = await add();

        expect(results[0]).toMatchObject({ status: 'added', expanded: true, reason: null });
        expect(results[0].entries).toHaveLength(2);
        expect(mocks.inserted).toEqual([child(1).id, child(3).id]);
        expect(mocks.inserted).not.toContain(denied);
        expect(mocks.touch).toHaveBeenCalledOnce();
    });

    it('rejects with no_accessible_entries when every child is denied', async () => {
        mocks.access.mockImplementation(async (_tx: unknown, id: string) => id === SERIES);

        const { results } = await add();

        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: 'no_accessible_entries',
            entries: [],
        });
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(mocks.touch).not.toHaveBeenCalled();
    });

    it('rejects a denied series before reading its children', async () => {
        mocks.access.mockResolvedValue(false);
        const { results } = await add();
        expect(results[0]).toMatchObject({ status: 'rejected', reason: 'not_found_or_no_access' });
        expect(mocks.access).toHaveBeenCalledTimes(1);
    });

    it('reports existing accessible children as duplicates without inserting', async () => {
        mocks.existing.current = new Set(mocks.candidates.current.map((c) => (c as { id: string }).id));
        const { results } = await add();
        expect(results[0].status).toBe('duplicate');
        expect(mocks.insert).not.toHaveBeenCalled();
    });
});

describe('addMediaItems candidate cap', () => {
    it('rejects an expansion beyond 2000 candidates with too_many_entries', async () => {
        mocks.candidates.current = Array.from({ length: 2001 }, (_, i) => child(i + 1));
        const { results } = await add();
        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: 'too_many_entries',
            entries: [],
        });
        expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('shares the budget across inputs: the remainder is rejected, earlier inputs stay added', async () => {
        const second = '00000000-0000-4000-8000-0000000000bb';
        // 1500 + 600 > 2000: the second expansion no longer fits the remaining 500.
        mocks.candidateQueue.push(
            Array.from({ length: 1500 }, (_, i) => child(i + 1)),
            Array.from({ length: 501 }, (_, i) => child(i + 5000)),
        );
        const { results } = await add([SERIES, second]);
        expect(results[0].status).toBe('added');
        expect(results[1]).toMatchObject({ status: 'rejected', reason: 'too_many_entries' });
        expect(mocks.inserted).toHaveLength(1500);
    });
});
