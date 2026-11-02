// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for GET /api/music/artists/[id] — Various Artists guard.
 *
 * Key behavior verified:
 *   - A flagged Various Artists row (media_items.is_various_artists = true)
 *     returns tracks: [] while albums stay intact — the flat track list is
 *     meaningless for a synthetic compilation bucket, but its albums are not.
 *   - An ordinary artist keeps returning its full track list unaffected.
 *
 * NOTE: This file is named server.integration.test.ts (NOT +server.integration.test.ts)
 * — the `+` prefix is reserved by SvelteKit for route files and breaks vite build.
 */

import {
    describe,
    it,
    expect,
    vi,
    beforeAll,
    afterAll,
    beforeEach,
} from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    createAndInsertTestMusicHierarchy,
    createTestAlbum,
    createTestTrack,
    insertTestAlbum,
    insertTestTrack,
} from '../../../../../../tests/integration/fixtures/index.js';

// ── point ALL DB access at the test DB ──────────────────────────────────────

vi.hoisted(() => {
    const testUrl =
        process.env.TEST_DATABASE_URL ||
        process.env.DATABASE_URL?.replace(/\/[^/]*$/, '/lumastra_tests') ||
        'postgres://localhost:5432/lumastra_tests';
    process.env.TEST_DATABASE_URL = testUrl;
    process.env.DATABASE_URL = testUrl;
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => Promise.resolve(getTestDb()) },
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

// PARTIAL mock: only the DB-backed context build and the cache key are
// stubbed. `searchAccessBoundary` (and anything else this module exports) is
// inherited from the real implementation, so the route derives its
// MediaAccessBoundary through production code from the stubbed context. A
// full replacement here is what broke after 966de569a migrated these routes
// onto searchAccessBoundary: the mock had no such export and every test threw.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: vi.fn().mockResolvedValue({
            username: 'test-user',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: true,
        }),
        scopedCacheKey: vi.fn().mockReturnValue('test-key'),
    };
});

// ── skip when no test database is available ──────────────────────────────────

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('GET /api/music/artists/[id] — Various Artists guard integration', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
        } catch {
            throw new Error('media_items table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, media_items CASCADE',
        );
    });

    // ── helpers ──────────────────────────────────────────────────────────────

    function makeLocals(): App.Locals {
        return {
            user: {
                userId: '00000000-0000-0000-0000-0000000000aa',
                username: 'test-user',
                userGroups: [],
                isAdmin: false,
                hasLiveTvPermission: false,
                maxAgeRating: null,
                isAgeRestricted: false,
            },
        } as unknown as App.Locals;
    }

    function makeEvent(artistId: string): Record<string, unknown> {
        return { params: { id: artistId }, locals: makeLocals() };
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    it('returns tracks: [] with albums intact for a flagged Various Artists row', async () => {
        const [vaRow] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, is_various_artists)
            VALUES ('Various Artists', 'artist', true)
            RETURNING id
        `;
        const album = createTestAlbum(vaRow.id, { title: 'Compilation One', year: 2022 });
        await insertTestAlbum(sql, album);
        const track = createTestTrack(album.id, 1, { title: 'Various Track' });
        await insertTestTrack(sql, track);

        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent(vaRow.id) as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            isVariousArtists: boolean;
            albums: unknown[];
            tracks: unknown[];
        };
        expect(body.isVariousArtists).toBe(true);
        expect(body.albums).toHaveLength(1);
        expect(body.tracks).toEqual([]);
    });

    it('still returns the full track list for an ordinary (non-VA) artist', async () => {
        const { artistId } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ordinary Artist',
            trackCount: 2,
        });

        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent(artistId) as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            isVariousArtists: boolean;
            tracks: unknown[];
        };
        expect(body.isVariousArtists).toBe(false);
        expect(body.tracks).toHaveLength(2);
    });

    it('returns 404 when the artist does not exist', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET(
            makeEvent('00000000-0000-0000-0000-000000000000') as unknown as Parameters<
                typeof GET
            >[0],
        );
        expect(res.status).toBe(404);
    });
});
