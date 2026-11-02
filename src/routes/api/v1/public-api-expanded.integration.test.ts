// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API Expanded Integration Contract Tests
 *
 * Integration contract tests for /api/v1 playlist endpoints:
 * - GET /api/v1/playlists/[id]
 * - PATCH /api/v1/playlists/[id]
 * - DELETE /api/v1/playlists/[id]
 *
 * Focus: shape + status + access scoping against lumastra_tests DB.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import type { RequestEvent } from '@sveltejs/kit';

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

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => getTestDb(),
    getTaskDb: () => getTestDb(),
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('Public API expanded contract tests', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM playlists LIMIT 0`;
        } catch {
            throw new Error('playlists table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM playlist_items WHERE playlist_id IN (
            SELECT id FROM playlists WHERE name LIKE 'Expanded Contract%'
        )`;
        await sql`DELETE FROM playlist_members WHERE playlist_id IN (
            SELECT id FROM playlists WHERE name LIKE 'Expanded Contract%'
        )`;
        await sql`DELETE FROM collaborative_chat_messages WHERE context_type = 'playlist' AND context_id IN (
            SELECT id FROM playlists WHERE name LIKE 'Expanded Contract%'
        )`;
        await sql`DELETE FROM playlists WHERE name LIKE 'Expanded Contract%'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Expanded Contract%'`;
        await sql`DELETE FROM users WHERE username LIKE 'expanded-%'`;
        vi.clearAllMocks();
    });

    async function insertUser(opts: { username?: string } = {}) {
        const id = crypto.randomUUID();
        const username = opts.username ?? `expanded-${id.slice(0, 8)}`;
        await sql`
            INSERT INTO users (id, username, is_admin, max_age_rating)
            VALUES (${id}::uuid, ${username}, false, null)
        `;
        return { id, username };
    }

    async function insertMediaItem(opts: { title?: string } = {}) {
        const id = crypto.randomUUID();
        const title = opts.title ?? 'Expanded Contract Media';
        await sql`
            INSERT INTO media_items (
                id, media_type, title, overview, status,
                has_files, created_at
            ) VALUES (
                ${id}::uuid, ${'movie'},
                ${title},
                ${'Test overview'},
                ${'active'},
                true,
                NOW()
            )
        `;
        return id;
    }

    async function insertPlaylist(opts: {
        userId: string;
        name?: string;
        visibility?: 'private' | 'public';
        playlistType?: 'general' | 'music' | 'video';
    }) {
        const name = opts.name ?? 'Expanded Contract Playlist';
        const visibility = opts.visibility ?? 'private';
        const playlistType = opts.playlistType ?? 'music';
        const rows = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${opts.userId}::uuid, ${name}, ${visibility}, ${playlistType})
            RETURNING id
        `;
        return rows[0].id;
    }

    async function insertPlaylistItem(playlistId: number, mediaId: string) {
        await sql`
            INSERT INTO playlist_items (
                playlist_id, media_id, season_number, episode_number,
                title, series_name, overview, poster_path, position
            ) VALUES (
                ${playlistId}, ${mediaId}::uuid,
                null, null,
                'Expanded Contract Item', null, null, null, 0
            )
        `;
    }

    async function insertPlaylistMember(
        playlistId: number,
        userId: string,
        role: 'editor' | 'readonly',
    ) {
        await sql`
            INSERT INTO playlist_members (playlist_id, user_id, role, status)
            VALUES (${playlistId}, ${userId}::uuid, ${role}, 'accepted')
        `;
    }

    function fakeEvent(opts: {
        url: URL;
        method?: string;
        params?: Record<string, string>;
        user?: Record<string, unknown>;
        body?: unknown;
    }) {
        const method = opts.method ?? 'GET';
        const headers = new Headers();
        if (opts.body !== undefined) {
            headers.set('Content-Type', 'application/json');
        }
        return {
            url: opts.url,
            request: new Request(opts.url, {
                method,
                headers,
                body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            }),
            locals: {
                user: opts.user ?? null,
                resolvedIds: undefined,
            },
            params: opts.params ?? {},
            route: { id: null },
            cookies: {} as never,
            fetch,
            getClientAddress: () => '127.0.0.1',
            platform: undefined,
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: () => undefined,
            depends: () => undefined,
            untrack: (fn: () => unknown) => fn(),
        } as unknown as RequestEvent;
    }

    describe('GET /api/playlists/[id]', () => {
        it('returns 200 with playlist shape for owner', async () => {
            const owner = await insertUser();
            const mediaId = await insertMediaItem();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract Owner Playlist',
            });
            await insertPlaylistItem(playlistId, mediaId);

            const { GET } = (await import('../../api/playlists/[id]/+server.js'))!;
            const res = await GET!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    params: { id: String(playlistId) },
                    user: { username: owner.username },
                }) as Parameters<NonNullable<typeof GET>>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            // Metadata only: the playlist is the body, entries come from /items.
            expect(body.playlist).toBeUndefined();
            expect(body.items).toBeUndefined();
            expect(body.id).toBe(playlistId);
            expect(body.name).toBe('Expanded Contract Owner Playlist');
            expect((body.owner as { userId: string }).userId).toBe(owner.id);
            expect(body.itemCount).toBe(1);
        });

        it('returns 200 for a public playlist viewed by non-owner', async () => {
            const owner = await insertUser();
            const viewer = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract Public Playlist',
                visibility: 'public',
            });

            const { GET } = (await import('../../api/playlists/[id]/+server.js'))!;
            const res = await GET!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    params: { id: String(playlistId) },
                    user: { username: viewer.username },
                }) as Parameters<NonNullable<typeof GET>>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.id).toBe(playlistId);
        });

        it('returns 404 for private playlist viewed by non-member', async () => {
            const owner = await insertUser();
            const stranger = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract Private Playlist',
                visibility: 'private',
            });

            const { GET } = (await import('../../api/playlists/[id]/+server.js'))!;
            const res = await GET!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    params: { id: String(playlistId) },
                    user: { username: stranger.username },
                }) as Parameters<NonNullable<typeof GET>>[0],
            );

            expect(res.status).toBe(404);
        });

        it('returns 404 for non-existent playlist ID', async () => {
            const user = await insertUser();
            const fakeId = '999999';

            const { GET } = await import('../../api/playlists/[id]/+server.js');
            const res = await GET!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${fakeId}`),
                    params: { id: fakeId },
                    user: { username: user.username },
                }) as Parameters<NonNullable<typeof GET>>[0],
            );

            expect(res.status).toBe(404);
        });
    });

    describe('PATCH /api/playlists/[id]', () => {
        it('owner can update name and description', async () => {
            const owner = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract Update Playlist',
            });

            const { PATCH } = await import('../../api/playlists/[id]/+server.js');
            const res = await PATCH!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    method: 'PATCH',
                    params: { id: String(playlistId) },
                    user: { username: owner.username },
                    body: {
                        name: 'Updated Name',
                        description: 'Updated desc',
                    },
                }) as Parameters<NonNullable<typeof PATCH>>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.name).toBe('Updated Name');
            expect(body.description).toBe('Updated desc');
        });

        it('non-owner gets 403', async () => {
            const owner = await insertUser();
            const stranger = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract NonOwner PATCH',
                visibility: 'public',
            });

            const { PATCH } = await import('../../api/playlists/[id]/+server.js');
            const res = await PATCH!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    method: 'PATCH',
                    params: { id: String(playlistId) },
                    user: { username: stranger.username },
                    body: { name: 'Hacked Name' },
                }) as Parameters<NonNullable<typeof PATCH>>[0],
            );

            expect(res.status).toBe(403);
        });

        it('readonly member gets 403', async () => {
            const owner = await insertUser();
            const member = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract Readonly PATCH',
            });
            await insertPlaylistMember(playlistId, member.id, 'readonly');

            const { PATCH } = await import('../../api/playlists/[id]/+server.js');
            const res = await PATCH!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    method: 'PATCH',
                    params: { id: String(playlistId) },
                    user: { username: member.username },
                    body: { name: 'Hacked Name' },
                }) as Parameters<NonNullable<typeof PATCH>>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    describe('DELETE /api/playlists/[id]', () => {
        it('owner can delete', async () => {
            const owner = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract Delete Playlist',
            });

            const { DELETE } = await import('../../api/playlists/[id]/+server.js');
            const res = await DELETE!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    method: 'DELETE',
                    params: { id: String(playlistId) },
                    user: { username: owner.username },
                }) as Parameters<NonNullable<typeof DELETE>>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.message).toBe('Playlist deleted');

            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int as count FROM playlists WHERE id = ${playlistId}
            `;
            expect(rows[0].count).toBe(0);
        });

        it('non-owner gets 403', async () => {
            const owner = await insertUser();
            const stranger = await insertUser();
            const playlistId = await insertPlaylist({
                userId: owner.id,
                name: 'Expanded Contract NonOwner DELETE',
                visibility: 'public',
            });

            const { DELETE } = await import('../../api/playlists/[id]/+server.js');
            const res = await DELETE!(
                fakeEvent({
                    url: new URL(`http://localhost/api/playlists/${playlistId}`),
                    method: 'DELETE',
                    params: { id: String(playlistId) },
                    user: { username: stranger.username },
                }) as Parameters<NonNullable<typeof DELETE>>[0],
            );

            expect(res.status).toBe(403);
        });
    });
});
