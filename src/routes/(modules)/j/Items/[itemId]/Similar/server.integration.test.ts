// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Route-level integration test for GET /j/Items/{itemId}/Similar.
//
// Bypasses withJellyfinAuth via vi.mock and points getDb at the test database,
// so the real handler runs its hydration and fallback queries. The embedding
// neighbour search is mocked: what is under test is that a neighbour without
// local files never reaches the client and that the vote-ordered fallback
// takes over when no neighbour is playable.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import type { SimilarMediaDualRow } from '$lib/server/database/queries/suggestion-search.queries';
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

const searchMocks = vi.hoisted(() => ({
    findSimilarMediaDual: vi.fn(),
    parseEmbedding: vi.fn(),
}));

vi.mock('$lib/server/database/queries/suggestion-search.queries', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/suggestion-search.queries')
    >()),
    findSimilarMediaDual: searchMocks.findSimilarMediaDual,
}));

vi.mock('$lib/server/utils/embedding-utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/embedding-utils')>()),
    parseEmbedding: searchMocks.parseEmbedding,
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

type SimilarEvent = RequestEvent<{ itemId: string }, '/(modules)/j/Items/[itemId]/Similar'>;

const noopSpan: SimilarEvent['tracing']['root'] = {
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

function buildEvent(itemId: string, userId: string): SimilarEvent {
    return {
        url: new URL(`http://localhost/j/Items/${itemId}/Similar?Limit=12`),
        request: new Request(`http://localhost/j/Items/${itemId}/Similar?Limit=12`),
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
        route: { id: '/(modules)/j/Items/[itemId]/Similar' },
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
    } as SimilarEvent;
}

function neighbours(...ids: string[]): SimilarMediaDualRow[] {
    return ids.map((id) => ({ media_uuid: id }) as unknown as SimilarMediaDualRow);
}

describe.runIf(RUN)('GET /j/Items/{itemId}/Similar', () => {
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
        searchMocks.findSimilarMediaDual.mockReset();
        searchMocks.parseEmbedding.mockReset().mockReturnValue([0.1, 0.2, 0.3]);
    });

    /** A movie row; `file` links a media file whatever `has_files` says. */
    async function movie(
        title: string,
        opts: { hasFiles: boolean; file: boolean },
    ): Promise<string> {
        const id = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'movie', title, has_files: opts.hasFiles }),
        );
        if (opts.file) {
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES (${`/data/Filme/${id}.mkv`}) RETURNING id
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileRow.id}::uuid, ${id}::uuid)`;
        }
        return id;
    }

    async function similarIds(itemId: string): Promise<string[]> {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent(itemId, userId));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
        expect(body.TotalRecordCount).toBe(body.Items.length);
        return body.Items.map((i) => i.Id);
    }

    it('never returns file-less neighbours and falls back to a playable item', async () => {
        const source = await movie('Source', { hasFiles: true, file: true });
        // A stale file link without has_files proves the hydration filter, not
        // just the MediaSources drop, keeps it out.
        const staleLink = await movie('Luma With Link', { hasFiles: false, file: true });
        const catalogOnly = await movie('Catalog Only', { hasFiles: false, file: false });
        const fallback = await movie('Fallback', { hasFiles: true, file: true });
        searchMocks.findSimilarMediaDual.mockResolvedValue(neighbours(staleLink, catalogOnly));

        const ids = await similarIds(source);

        expect(searchMocks.findSimilarMediaDual).toHaveBeenCalledOnce();
        expect(ids).toEqual([fallback]);
    });

    it('keeps playable neighbours in similarity order without falling back', async () => {
        const source = await movie('Source', { hasFiles: true, file: true });
        const staleLink = await movie('Luma With Link', { hasFiles: false, file: true });
        const first = await movie('First', { hasFiles: true, file: true });
        const second = await movie('Second', { hasFiles: true, file: true });
        searchMocks.findSimilarMediaDual.mockResolvedValue(
            neighbours(second, staleLink, source, first),
        );

        expect(await similarIds(source)).toEqual([second, first]);
    });

    it('uses the fallback when the item has no embedding, still without file-less items', async () => {
        searchMocks.parseEmbedding.mockReturnValue(null);
        const source = await movie('Source', { hasFiles: true, file: true });
        await movie('Luma With Link', { hasFiles: false, file: true });
        const fallback = await movie('Fallback', { hasFiles: true, file: true });

        expect(await similarIds(source)).toEqual([fallback]);
        expect(searchMocks.findSimilarMediaDual).not.toHaveBeenCalled();
    });
});
