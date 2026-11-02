// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: package 19 (and 11 for POST /media/batch). A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, expectOk } from './client';

/**
 * Fresh-eyes step 8b: keep a local library in sync (docs/api/API.md section 13).
 * take a cursor -> change something -> poll -> hydrate -> assert exactly that change; a bad cursor is 410.
 * The change is the caller's own watch state, the one change a public client can make and undo.
 * (A catalog rename is not reachable through the public spec; the integration tests cover it.)
 */
type Change = {
    kind: string;
    id: string;
    op: string;
    version: string;
    watchState?: { progress: { finished: boolean } };
};

async function poll(
    cursor: string,
    done: (changes: Change[]) => boolean,
): Promise<{ cursor: string; changes: Change[] }> {
    const changes: Change[] = [];
    // The server only reports changes below the cluster-wide transaction horizon, so allow some seconds.
    const deadline = Date.now() + 30000;
    do {
        let more = true;
        while (more) {
            const page = expectOk(
                'GET',
                '/sync/changes',
                await client.GET('/api/v1/sync/changes', { params: { query: { cursor } } }),
            );
            cursor = page.page.nextCursor; // always store it, even when changes is empty
            more = page.page.hasMore;
            changes.push(...(page.items as unknown as Change[]));
        }
        if (done(changes)) return { cursor, changes };
        await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new Error('The change did not appear in GET /sync/changes within 30 s');
}

test('11 sync: cursor → change → poll → hydrate → exactly that change; bad cursor is 410', async (ctx) => {
    // 1. Start: a cursor first, and the links for the initial load.
    const start = expectOk('GET', '/sync/changes', await client.GET('/api/v1/sync/changes'));
    expect(start.items).toEqual([]);
    expect(start.page.hasMore).toBe(false);
    expect(typeof start.page.nextCursor).toBe('string');
    const kinds = (start.initialLoad ?? []).map((link) => link.kind);
    for (const kind of ['movie', 'episode', 'track', 'audiobook', 'watch_state', 'playlist']) {
        expect(kinds).toContain(kind);
    }

    // 2. Initial load: ids per kind (hydrated below), state inline.
    const library = expectOk(
        'GET',
        '/sync/library',
        await client.GET('/api/v1/sync/library', {
            params: { query: { kind: 'movie', limit: 5 } },
        }),
    );
    const id = library.items[0]?.id;
    expectOk(
        'GET',
        '/sync/user-state',
        await client.GET('/api/v1/sync/user-state', {
            params: { query: { kind: 'watch_state', limit: 5 } },
        }),
    );

    // 4. A bad cursor: well-formed but not ours -> 410, reload (a garbage string is a 422, see below).
    const forged =
        start.page.nextCursor.slice(0, -1) + (start.page.nextCursor.endsWith('A') ? 'B' : 'A');
    const gone = await client.GET('/api/v1/sync/changes', {
        params: { query: { cursor: forged } },
    });
    expect(gone.response.status).toBe(410);
    expect(gone.response.headers.get('content-type')).toContain('json');
    expect(JSON.stringify(gone.error)).toContain('invalid_cursor');
    const garbage = await client.GET('/api/v1/sync/changes', {
        params: { query: { cursor: 'not a cursor' } },
    });
    expect(garbage.response.status).toBe(422);

    if (!id) return ctx.skip('Instance has no movies in the library');

    // 3. Change something of my own and follow it through the feed.
    const before = expectOk(
        'GET',
        '/watch-state/{id}',
        await client.GET('/api/v1/watch-state/{id}', { params: { path: { id } } }),
    );
    const put = (watched: boolean) =>
        client.PATCH('/api/v1/watch-state/{id}', {
            params: { path: { id } },
            body: { watched },
        });
    try {
        expectOk('PUT', '/watch-state/{id}', await put(!before.watched));
        const seen = await poll(start.page.nextCursor, (changes) =>
            changes.some((c) => c.id === id && c.kind === 'watch_state'),
        );
        const entry = seen.changes.find((c) => c.id === id && c.kind === 'watch_state')!;
        expect(entry.op).toBe('upsert');
        expect(entry.watchState?.progress.finished).toBe(!before.watched);
        expect(entry.version).toMatch(/^\d{20}:\d{20}$/);
        // Exactly that change: every entry of MY state kinds is this one id and kind.
        const mine = seen.changes.filter((c) =>
            ['watch_state', 'listen_state', 'rating', 'watchlist', 'playlist'].includes(c.kind),
        );
        expect(mine.map((c) => `${c.kind}:${c.id}`)).toEqual([`watch_state:${id}`]);

        // 3b. Hydrate the changed id with POST /media/batch (package 11). An id the caller cannot
        // see, or that is gone, comes back in `missing` (a delete for the local cache).
        const unknown = '00000000-0000-4000-8000-000000000001';
        const batch = expectOk(
            'POST',
            '/media/batch',
            await client.POST('/api/v1/media/batch', { body: { ids: [id, unknown] } }),
        );
        expect(batch.items.map((entry) => (entry as { id: string }).id)).toEqual([id]);
        expect(batch.missing).toEqual([unknown]);
        expect(typeof (batch.items[0] as { title?: unknown }).title).toBe('string');

        // 5. The cursor from the poll is current: nothing more arrives for my own state.
        const quiet = expectOk(
            'GET',
            '/sync/changes',
            await client.GET('/api/v1/sync/changes', {
                params: { query: { cursor: seen.cursor } },
            }),
        );
        expect(quiet.items.some((c) => c.id === id && c.kind === 'watch_state')).toBe(false);
    } finally {
        await put(before.watched);
    }
});
