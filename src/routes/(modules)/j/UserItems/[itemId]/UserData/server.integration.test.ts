// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres round trip for the /j user-data writes: POST
 * /UserItems/{id}/UserData through the real watch-state rebuild and watchlist,
 * and the read-back that mark-played / favourite answers now carry (they used
 * to hard-code the other flag to false).
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../../tests/integration/helpers/users.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../../tests/integration/fixtures/index.js';

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/services/database.service', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/services/database.service')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return {
        ...mod,
        aiDbService: new Proxy(mod.aiDbService, {
            get(target, prop, receiver) {
                if (prop === 'getSql') return async () => getSql();
                return Reflect.get(target, prop, receiver) as unknown;
            },
        }),
    };
});

vi.mock('$lib/server/cache', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/cache')>();
    return {
        ...mod,
        cacheInvalidation: {
            ...mod.cacheInvalidation,
            onWatchlistChange: vi.fn().mockResolvedValue(undefined),
        },
    };
});

const userData = await import('./+server.js');
const played = await import('../../../UserPlayedItems/[itemId]/+server.js');
const favorite = await import('../../../Users/[userId]/FavoriteItems/[itemId]/+server.js');

interface Dto {
    PlaybackPositionTicks: number;
    Played: boolean;
    IsFavorite: boolean;
    ItemId?: string;
    UnplayedItemCount?: number;
    PlayedPercentage?: number;
}

function event(
    method: 'GET' | 'POST',
    itemId: string,
    user: { id: string; username: string },
    body?: unknown,
): RequestEvent {
    const url = new URL(`http://localhost/j/UserItems/${itemId}/UserData`);
    return {
        request: new Request(url, {
            method,
            ...(body !== undefined
                ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
                : {}),
        }),
        url,
        params: { itemId, userId: user.id },
        locals: {
            user: {
                userId: user.id,
                username: user.username,
                hasLiveTvPermission: false,
                ownerIsAdmin: true, // short-circuits the library-access check — not under test
                userGroups: [],
                isAgeRestricted: false,
                maxAgeRating: null,
            },
        },
    } as unknown as RequestEvent;
}

async function call(handler: unknown, ev: RequestEvent): Promise<Dto> {
    const res = await (handler as (e: RequestEvent) => Promise<Response>)(ev);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Dto;
}

describe('/j user data writes (real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    it('POST UserData applies IsFavorite + position, then Played; each answer is the re-read state', async () => {
        const user = await createTestUser(sql);
        const movieId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'movie', has_files: true }),
        );

        const first = await call(
            userData.POST,
            event('POST', movieId, user, { IsFavorite: true, PlaybackPositionTicks: 600_000_000 }),
        );
        expect(first).toMatchObject({
            IsFavorite: true,
            Played: false,
            PlaybackPositionTicks: 600_000_000,
            ItemId: movieId,
        });

        const read = await call(userData.GET, event('GET', movieId, user));
        expect(read).toEqual(first);

        const second = await call(userData.POST, event('POST', movieId, user, { Played: true }));
        expect(second).toMatchObject({ IsFavorite: true, Played: true, PlaybackPositionTicks: 0 });

        const cleared = await call(
            userData.POST,
            event('POST', movieId, user, { Played: false, IsFavorite: false }),
        );
        expect(cleared).toMatchObject({ IsFavorite: false, Played: false });
    });

    it('mark-played answers the real IsFavorite, favourite answers the real Played', async () => {
        const user = await createTestUser(sql);
        const movieId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'movie', has_files: true }),
        );

        const fav = await call(favorite.POST, event('POST', movieId, user));
        expect(fav).toMatchObject({ IsFavorite: true, Played: false });

        const watched = await call(played.POST, event('POST', movieId, user));
        expect(watched).toMatchObject({ Played: true, IsFavorite: true });

        const favAgain = await call(favorite.POST, event('POST', movieId, user));
        expect(favAgain).toMatchObject({ IsFavorite: true, Played: true });
    });

    it('a series answers with its episode-derived state, like the lists', async () => {
        const user = await createTestUser(sql);
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status) VALUES ('G2 Series', 'tv', 'active') RETURNING id`;
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number)
            VALUES ('Season 1', 'season', 'active', ${series.id}, 1) RETURNING id`;
        const eps: string[] = [];
        for (const n of [1, 2]) {
            const [ep] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number, has_files, runtime_seconds)
                VALUES (${`Ep ${n}`}, 'episode', 'active', ${season.id}, 1, ${n}, true, 1500) RETURNING id`;
            const [f] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES (${`/g2/userdata/${ep.id}.mkv`}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${f.id}, ${ep.id}, true)`;
            eps.push(ep.id);
        }

        await call(played.POST, event('POST', eps[0], user));
        const read = await call(userData.GET, event('GET', series.id, user));
        expect(read).toMatchObject({ UnplayedItemCount: 1, PlayedPercentage: 50, Played: false });

        const fav = await call(favorite.POST, event('POST', series.id, user));
        expect(fav).toMatchObject({ IsFavorite: true, UnplayedItemCount: 1, Played: false });

        const done = await call(played.POST, event('POST', eps[1], user));
        expect(done).toMatchObject({ Played: true });
        const after = await call(userData.GET, event('GET', series.id, user));
        expect(after).toMatchObject({ UnplayedItemCount: 0, PlayedPercentage: 100, Played: true });
    });
});
