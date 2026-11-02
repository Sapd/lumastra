// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `?jellyfinId=` (legacy alias of `?itemId=`) and `?itemId=<Jellyfin item id>`
 * from older clients: the id is mapped to the internal id through the
 * `external_ids` rows Jellyfin sync keeps, and the right position is returned.
 * An unmapped id is a 404.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../../../tests/integration/helpers/users.js';
import { createAndInsertTestMovie } from '../../../../../../../tests/integration/fixtures/index.js';
import { createPlaylist } from '$lib/server/database/queries/playlists.queries.js';
import { toUserId } from '$lib/shared/user-id';
import type postgres from 'postgres';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return { ...mod, getValkeyClient: () => null };
});

const { def: playbackContextDef } = await import('./playback-context.js');

const ctx: ApiContext = { surface: 'internal' };

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000000'),
        username: 'playback-context-legacy-id-test',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

function buildEvent(playlistId: number, user: UserContext, url: URL): RequestEvent {
    return {
        params: { id: String(playlistId) },
        locals: { user },
        url,
        request: new Request(url, { method: 'GET' }),
        route: { id: null },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('GET /playlists/{id}/playback-context — legacy Jellyfin item ids', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    function hexId(): string {
        return crypto.randomUUID().replace(/-/g, '');
    }

    async function setup() {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const user = fullUser({ userId, username: owner.username });
        const playlist = await createPlaylist(sql, userId, 'Legacy ids', null, 'private');
        const first = await createAndInsertTestMovie(sql, {
            withFileItem: true,
            jellyfinId: hexId(),
        });
        const secondJellyfinId = hexId();
        const second = await createAndInsertTestMovie(sql, {
            withFileItem: true,
            jellyfinId: secondJellyfinId,
        });
        for (const [position, mediaId] of [first.id, second.id].entries()) {
            await sql`INSERT INTO playlist_items (playlist_id, media_id, title, position) VALUES (${playlist.id}, ${mediaId}::uuid, ${`Entry ${position}`}, ${position})`;
        }
        const read = (query: string) => {
            const url = new URL(
                `http://localhost/api/playlists/${playlist.id}/playback-context?${query}`,
            );
            return playbackContextDef.handlers.GET!(buildEvent(playlist.id, user, url), ctx);
        };
        return { first, second, secondJellyfinId, read };
    }

    it('rejects the retired jellyfinId selector', async () => {
        const { secondJellyfinId, read } = await setup();
        expect((await read(`jellyfinId=${secondJellyfinId}`)).status).toBe(422);
    });
    it('rejects the retired itemId selector even when it names a catalog UUID', async () => {
        const { second, read } = await setup();
        expect((await read(`itemId=${second.id}`)).status).toBe(422);
    });
    it('selects a catalog mediaId and returns only current and neighbours', async () => {
        const { first, second, read } = await setup();
        const response = await read(`mediaId=${second.id}`);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.current).toMatchObject({ mediaId: second.id, position: 1 });
        expect(body.previous).toMatchObject({ mediaId: first.id, position: 0 });
        expect(body.next).toBeNull();
        expect(body).not.toHaveProperty('items');
    });
    it('selects the same entry by entryId and stored position', async () => {
        const { second, read } = await setup();
        const selected = await (await read(`mediaId=${second.id}`)).json();
        for (const query of [
            `entryId=${selected.current.id}`,
            `position=${selected.current.position}`,
        ]) {
            const response = await read(query);
            expect(response.status).toBe(200);
            expect((await response.json()).current.id).toBe(selected.current.id);
        }
    });

    it('rejects missing and ambiguous selectors', async () => {
        const { second, read } = await setup();
        expect((await read('')).status).toBe(422);
        expect((await read(`mediaId=${second.id}&position=1`)).status).toBe(422);
        expect((await read(`mediaId=${crypto.randomUUID()}`)).status).toBe(404);
    });
});
