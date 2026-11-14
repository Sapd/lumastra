// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Route-level integration test for GET /j/Items/{itemId}/Ancestors.
//
// Bypasses withJellyfinAuth via vi.mock (middleware behavior is covered in
// middleware.test.ts) and points getDb at the test database, so the real
// handler runs its real queries and serializers end-to-end. Real Jellyfin
// returns [Season, Series, CollectionFolder, UserRootFolder] for an episode
// (verified against a live Jellyfin 10.x) — the shim emits the same chain
// minus the UserRootFolder, which it has no id for.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../../tests/integration/fixtures/index.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    // No-op wrapper so the route exports the inner handler directly.
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

interface AncestorDto {
    Name: string;
    Id: string;
    Type: string;
    CollectionType?: string;
    IsFolder: boolean;
}

type AncestorsTracing = RequestEvent<
    { itemId: string },
    '/(modules)/j/Items/[itemId]/Ancestors'
>['tracing'];

// A fully-typed no-op OpenTelemetry span. SvelteKit's RequestEvent.tracing now
// types `root`/`current` as `Span` (not `undefined`), so a proper no-op span is
// the honest stand-in in tests that never enable tracing.
const noopSpan: AncestorsTracing['root'] = {
    spanContext() {
        return { traceId: '', spanId: '', traceFlags: 0 };
    },
    setAttribute() {
        return this;
    },
    setAttributes() {
        return this;
    },
    addEvent() {
        return this;
    },
    addLink() {
        return this;
    },
    addLinks() {
        return this;
    },
    setStatus() {
        return this;
    },
    updateName() {
        return this;
    },
    end() {},
    isRecording() {
        return false;
    },
    recordException() {},
};

function buildEvent(
    itemId: string,
    userId: string,
): RequestEvent<{ itemId: string }, '/(modules)/j/Items/[itemId]/Ancestors'> {
    return {
        url: new URL(`http://localhost/j/Items/${itemId}/Ancestors`),
        request: new Request(`http://localhost/j/Items/${itemId}/Ancestors`),
        locals: {
            user: {
                username: 'denis',
                userId: toUserId(userId),
                groups: 'admins',
                userGroups: ['admins'],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: true,
                ownerIsAdmin: true,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: true,
                liveTvPriority: 'high',
            },
        },
        params: { itemId },
        route: { id: '/(modules)/j/Items/[itemId]/Ancestors' },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        isRemoteRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
        tracing: { enabled: false, root: noopSpan, current: noopSpan },
    } as RequestEvent<{ itemId: string }, '/(modules)/j/Items/[itemId]/Ancestors'>;
}

describe.runIf(RUN)('GET /j/Items/{itemId}/Ancestors', () => {
    let sql: postgres.Sql;
    const userId = randomUUID();

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_file_items',
            'media_files',
            'library_paths',
            'media_items',
            'external_ids',
        ]);
    });

    async function seedEpisodeInLibrary(): Promise<{
        seriesId: string;
        seasonId: string;
        episodeId: string;
        groupId: string;
    }> {
        const seriesId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'tv', title: 'Chain Series' }),
        );
        const seasonId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'season', title: 'Season 1', parent_id: seriesId }),
        );
        const episodeId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'episode', title: 'Pilot', parent_id: seasonId }),
        );

        const [groupRow] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('Serien') RETURNING id
        `;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupRow.id}::uuid, 'tv', '/data/Serien', true)
        `;
        const [fileRow] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES ('/data/Serien/chain/pilot.mkv', ${groupRow.id}::uuid)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileRow.id}::uuid, ${episodeId}::uuid)
        `;
        return { seriesId, seasonId, episodeId, groupId: groupRow.id };
    }

    it('returns [Season, Series, CollectionFolder] for an episode', async () => {
        const { seriesId, seasonId, episodeId, groupId } = await seedEpisodeInLibrary();

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(episodeId, userId));

        expect(res.status).toBe(200);
        const body = (await res.json()) as AncestorDto[];

        expect(body.map((i) => i.Id)).toEqual([seasonId, seriesId, groupId]);
        expect(body.map((i) => i.Type)).toEqual(['Season', 'Series', 'CollectionFolder']);
        expect(body.every((i) => i.IsFolder)).toBe(true);
        expect(body[2].Name).toBe('Serien');
        expect(body[2].CollectionType).toBe('tvshows');
    });

    it('returns just the CollectionFolder for a movie', async () => {
        const movieId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'movie', title: 'Standalone' }),
        );
        const [groupRow] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('Filme') RETURNING id
        `;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupRow.id}::uuid, 'movie', '/data/Filme', true)
        `;
        const [fileRow] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES ('/data/Filme/standalone.mkv', ${groupRow.id}::uuid)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileRow.id}::uuid, ${movieId}::uuid)
        `;

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(movieId, userId));

        expect(res.status).toBe(200);
        const body = (await res.json()) as AncestorDto[];
        expect(body.map((i) => i.Type)).toEqual(['CollectionFolder']);
        expect(body[0].Id).toBe(groupRow.id);
    });

    it('returns 404 for an unknown item id', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent(randomUUID(), userId));
        expect(res.status).toBe(404);
    });

    it('returns 404 for a non-uuid id', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent('not-a-uuid', userId));
        expect(res.status).toBe(404);
    });

    it('falls back to file-path matching when the file has no library_group_id', async () => {
        const movieId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'movie', title: 'Orphaned Group', has_files: true }),
        );
        const [groupRow] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('Filme') RETURNING id
        `;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupRow.id}::uuid, 'movie', '/data/Filme', true)
        `;
        // media_files.library_group_id left NULL — reproduces the real prod
        // gap: a playable file whose own denormalized library_group_id is
        // missing, even though its path clearly lives under a real library.
        const [fileRow] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES ('/data/Filme/orphaned.mkv')
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileRow.id}::uuid, ${movieId}::uuid)
        `;

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(movieId, userId));

        expect(res.status).toBe(200);
        const body = (await res.json()) as AncestorDto[];
        expect(body.map((i) => i.Type)).toEqual(['CollectionFolder']);
        expect(body[0].Id).toBe(groupRow.id);
    });

    it('omits the CollectionFolder for catalog-only items without files', async () => {
        const seriesId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'tv', title: 'Ghost Series' }),
        );
        const seasonId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'season', title: 'Season 1', parent_id: seriesId }),
        );
        const episodeId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'episode', title: 'Ghost Ep', parent_id: seasonId }),
        );

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(episodeId, userId));

        expect(res.status).toBe(200);
        const body = (await res.json()) as AncestorDto[];
        expect(body.map((i) => i.Type)).toEqual(['Season', 'Series']);
    });
});
