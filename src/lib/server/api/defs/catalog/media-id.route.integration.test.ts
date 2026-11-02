// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for GET /media/{id} on types that have no
 * MediaNodeSchema arm. A music album used to answer 200 with `type: 'album'`,
 * which breaks the declared contract (mount()'s test-mode gate throws
 * ResponseContractViolation) and Swift's generated oneOf decoder.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function buildEvent(
    userId: string,
    mediaId: string,
    path: string,
    routeId: string,
): RequestEvent<{ id: string }, never> {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url),
        locals: {
            user: {
                username: `mi-${randomUUID().slice(0, 8)}`,
                userId: toUserId(userId),
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
            },
        },
        params: { id: mediaId },
        route: { id: routeId },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent<{ id: string }, never>;
}

describe.runIf(RUN)('GET /media/{id} for types without a MediaNode arm (route-level)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function seedAlbumWithTrack(): Promise<{
        albumId: string;
        cleanup: () => Promise<void>;
    }> {
        const artistId = randomUUID();
        const albumId = randomUUID();
        const trackId = randomUUID();
        const ids = [artistId, albumId, trackId];
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${artistId}::uuid, 'Route Artist', 'artist', NULL, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${albumId}::uuid, 'Route Album', 'album', ${artistId}::uuid, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${trackId}::uuid, 'Route Track', 'track', ${albumId}::uuid, 'active')`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds, created_at, updated_at)
            VALUES (${`/test/route-album/${albumId}/01.flac`}, 200, NOW(), NOW()) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}::uuid, ${trackId}::uuid)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${ids}::uuid[])`;
        return {
            albumId,
            cleanup: async () => {
                await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
                await sql`DELETE FROM media_files WHERE id = ${file.id}::uuid`;
            },
        };
    }

    it('a music album answers 404 with the music hint, not a non-conforming 200', async () => {
        const user = await createTestUser(sql);
        const { albumId, cleanup } = await seedAlbumWithTrack();
        try {
            const { GET } = await import('../../../../../routes/api/v1/media/[id]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                buildEvent(user.id, albumId, `/api/v1/media/${albumId}`, '/api/v1/media/[id]'),
            );
            expect(res.status).toBe(404);
            // The access gate answers a bare "Media item not found"; this text
            // proves the 404 came from the unserved-type path.
            const body = (await res.json()) as { code?: string };
            expect(body.code).toBe('not_found');
            expect(JSON.stringify(body)).toContain('music endpoints');
        } finally {
            await cleanup();
        }
    });

    it('context ?include=details leaves the details section out for a music album', async () => {
        const user = await createTestUser(sql);
        const { albumId, cleanup } = await seedAlbumWithTrack();
        try {
            const { GET } =
                await import('../../../../../routes/api/v1/media/[id]/context/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                buildEvent(
                    user.id,
                    albumId,
                    `/api/v1/media/${albumId}/context?include=details`,
                    '/api/v1/media/[id]/context',
                ),
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as { details?: unknown };
            expect(body.details).toBeUndefined();
        } finally {
            await cleanup();
        }
    });

    it('a movie still answers 200 with a conforming body', async () => {
        const user = await createTestUser(sql);
        const movieId = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${movieId}::uuid, 'Route Movie', 'movie', 'active')`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds, created_at, updated_at)
            VALUES (${`/test/route-movie/${movieId}.mkv`}, 5400, NOW(), NOW()) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}::uuid, ${movieId}::uuid)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${movieId}::uuid`;
        try {
            const { GET } = await import('../../../../../routes/api/v1/media/[id]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                buildEvent(user.id, movieId, `/api/v1/media/${movieId}`, '/api/v1/media/[id]'),
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as { type: string; id: string };
            expect(body.type).toBe('movie');
            expect(body.id).toBe(movieId);
        } finally {
            await sql`DELETE FROM media_items WHERE id = ${movieId}::uuid`;
            await sql`DELETE FROM media_files WHERE id = ${file.id}::uuid`;
        }
    });
});
