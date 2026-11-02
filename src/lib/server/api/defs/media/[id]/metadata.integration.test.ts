// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../../../tests/integration/setup/test-database.js';
import * as connection from '$lib/server/database/connection.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    getMediaItemById,
    listAdminMediaItems,
    countAdminMediaItems,
} from '$lib/server/database/queries/admin-media.queries.js';
import { GET, PATCH } from '../../../../../../routes/api/media/[id]/metadata/+server.js';
import {
    GET as v1GET,
    PATCH as v1PATCH,
} from '../../../../../../routes/api/v1/media/[id]/metadata/+server.js';

const itemId = randomUUID();
const albumId = randomUUID();
const fileId = randomUUID();
const userId = toUserId(randomUUID());
const admin = buildPrincipal({
    kind: 'pat',
    userId,
    username: 'reviewing-admin',
    userGroups: [],
    tokenScopes: ['admin'],
    ownerIsAdmin: true,
});
const opts = {
    types: ['track'],
    musicHygiene: 'music-title-from-filename' as const,
    limit: 100,
    offset: 0,
};
let sql: postgres.Sql;
let concurrentWriter: postgres.Sql;

async function patch(
    body: unknown,
    principal: Principal | null = admin,
    id: string = itemId,
    resolvedId: string | null = id,
): Promise<Response> {
    const url = new URL(`http://localhost/api/media/${id}/metadata`);
    const event = {
        url,
        params: { id },
        request: new Request(url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: {
            principal,
            ...(resolvedId ? { resolvedIds: { internalId: resolvedId } } : {}),
            user: { username: 'untrusted-fallback', isAdmin: true },
        },
        cookies: { get: () => undefined },
    } as unknown as RequestEvent;
    return PATCH!(event);
}

async function confirmation(handle: postgres.Sql = sql): Promise<Record<string, unknown>> {
    const row = await getMediaItemById(handle, itemId);
    return {
        confirmFilenameTitle: {
            title: row!.title,
            source: 'filename',
            locked: row!.metadata_locked,
            ...(row!.metadata_locked_by != null ? { lockedBy: row!.metadata_locked_by } : {}),
            ...(row!.lock_version != null ? { lockedAt: row!.lock_version } : {}),
        },
    };
}

async function snapshot(): Promise<unknown> {
    const [row] = await sql`SELECT to_jsonb(mi) AS item FROM media_items mi WHERE id = ${itemId}`;
    const links =
        await sql`SELECT to_jsonb(mfi) AS link FROM media_file_items mfi WHERE media_item_id = ${itemId} ORDER BY file_id`;
    const files = await sql`SELECT to_jsonb(mf) AS file FROM media_files mf WHERE id = ${fileId}`;
    const credits =
        await sql`SELECT to_jsonb(mc) AS credit FROM media_credits mc WHERE media_id = ${itemId}`;
    const segments =
        await sql`SELECT to_jsonb(ms) AS segment FROM media_segments ms WHERE media_id = ${itemId}`;
    const watch =
        await sql`SELECT to_jsonb(ums) AS watch FROM user_media_state ums WHERE media_id = ${itemId}`;
    return {
        row,
        links: [...links],
        files: [...files],
        credits: [...credits],
        segments: [...segments],
        watch: [...watch],
    };
}

beforeAll(async () => {
    sql = getTestDb();
    concurrentWriter = postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    vi.spyOn(connection, 'getDb').mockReturnValue(sql);
    vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
    await sql`INSERT INTO users (id, username) VALUES (${userId}, 'confirm-title-user')`;
    await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${albumId}, 'Parent Album', 'album', 'active')`;
    await sql`INSERT INTO media_files (id, file_path, file_size_bytes) VALUES (${fileId}, '/fixture/confirm-title.mp3', 12345)`;
});
beforeEach(async () => {
    await sql`DELETE FROM media_items WHERE id = ${itemId}`;
    await sql`INSERT INTO media_items (id, title, media_type, status, title_source, has_files, parent_id, overview, year, custom_metadata, custom_poster_url)
        VALUES (${itemId}, ' Glass Harbour ', 'track', 'active', 'filename', true, ${albumId}, 'Keep overview', 2011,
            '{"nested":{"a":[1,"two"],"title_source":"nested source","metadata_locked":false,"metadata_locked_by":"nested actor","metadata_locked_at":"nested date","updated_at":"nested update"},"artist":"Source Artist","title_source_verified":true}', 'https://example.com/poster.jpg')`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, start_offset_ms, end_offset_ms, offset_source) VALUES (${fileId}, ${itemId}, 1000, 5000, 'chapter')`;
    await sql`INSERT INTO media_credits (media_id, source, role, name) VALUES (${itemId}, 'local', 'producer', 'Keep Credit')`;
    await sql`INSERT INTO media_segments (media_id, type, start_time, end_time, source) VALUES (${itemId}, 'Intro', 1, 2, 'manual')`;
    await sql`INSERT INTO user_media_state (user_id, media_id, resume_position_ms, is_watched) VALUES (${userId}, ${itemId}, 1234, true)`;
    vi.mocked(connection.getDb).mockReturnValue(sql);
});
afterAll(async () => {
    await sql`DELETE FROM media_items WHERE id IN (${itemId}, ${albumId})`;
    await sql`DELETE FROM media_files WHERE id = ${fileId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    vi.restoreAllMocks();
    await concurrentWriter.end();
    await closeTestDb();
});

describe('mounted filename title confirmation against PostgreSQL', () => {
    it('preserves NULL overview on a title-only metadata patch and fresh database read', async () => {
        await sql`UPDATE media_items SET overview = NULL WHERE id = ${itemId}`;

        expect((await patch({ title: 'Saved without overview' })).status).toBe(200);

        const reloaded = await getMediaItemById(sql, itemId);
        expect(reloaded?.title).toBe('Saved without overview');
        expect(reloaded?.overview).toBeNull();
    });

    it('keeps a filename title with recoverable protection and removes it from the optional list', async () => {
        expect((await listAdminMediaItems(sql, opts)).some((r) => r.id === itemId)).toBe(true);
        const count = await countAdminMediaItems(sql, opts);
        const before = await snapshot();
        const expected = await confirmation();
        expect((await patch(expected)).status).toBe(200);
        const after = await snapshot();
        expect(after).toEqual(
            expect.objectContaining({
                ...(before as Record<string, unknown>),
                row: {
                    item: expect.objectContaining({
                        title: ' Glass Harbour ',
                        title_source: null,
                        metadata_locked: true,
                        metadata_locked_by: 'reviewing-admin',
                    }),
                },
            }),
        );
        // Compare the full row, omitting only the intentional protection and trigger timestamp writes.
        const clean = (value: unknown): unknown => {
            const state = value as { row: { item: Record<string, unknown> } };
            const item = { ...state.row.item };
            for (const key of [
                'title_source',
                'metadata_locked',
                'metadata_locked_by',
                'metadata_locked_at',
                'updated_at',
            ])
                delete item[key];
            return { ...state, row: { ...state.row, item } };
        };
        expect(clean(after)).toEqual(clean(before));
        expect((await listAdminMediaItems(sql, opts)).some((r) => r.id === itemId)).toBe(false);
        expect(await countAdminMediaItems(sql, opts)).toBe(count - 1);
        const row = await getMediaItemById(sql, itemId);
        expect(row?.lock_version).toBeTruthy();
        expect((await patch(expected)).status).toBe(409);
    });

    it('offers durable Undo of Keep title and restores protection while retaining provenance', async () => {
        const before = await snapshot();
        expect((await patch(await confirmation())).status).toBe(200);
        const [receipt] = await sql<
            { id: string }[]
        >`SELECT id FROM music_edit_receipts WHERE target_id=${itemId} AND kind='title'`;
        expect(receipt).toBeTruthy();
        expect((await patch({ undoMusicEdit: receipt.id })).status).toBe(200);
        const row = await getMediaItemById(sql, itemId);
        expect(row?.title_source).toBe('filename');
        expect(row?.metadata_locked).toBe(false);
        expect(row?.metadata_locked_by).toBeNull();
        expect((await patch({ undoMusicEdit: receipt.id })).status).toBe(200);
        expect((before as { row: unknown }).row).toBeTruthy();
    });

    it.each(['title', 'source', 'lock', 'actor', 'version'] as const)(
        'rejects stale concurrent %s without another write',
        async (field) => {
            const body = await confirmation();
            if (field === 'title')
                await sql`UPDATE media_items SET title = 'Changed elsewhere' WHERE id = ${itemId}`;
            if (field === 'source')
                await sql`UPDATE media_items SET title_source = 'tag' WHERE id = ${itemId}`;
            if (field === 'lock')
                await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${itemId}`;
            if (field === 'actor')
                await sql`UPDATE media_items SET metadata_locked_by = 'another-admin' WHERE id = ${itemId}`;
            if (field === 'version')
                await sql`UPDATE media_items SET metadata_locked_at = NOW() WHERE id = ${itemId}`;
            const before = await snapshot();
            expect((await patch(body)).status).toBe(409);
            expect(await snapshot()).toEqual(before);
        },
    );

    it.each(['title', 'source', 'lock'] as const)(
        'waits for the canonical item lock and rejects a concurrent %s writer',
        async (field) => {
            const body = await confirmation();
            const writer = await concurrentWriter.reserve();
            let request: Promise<Response> | undefined;
            try {
                await writer`BEGIN`;
                await writer`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`;
                if (field === 'title')
                    await writer`UPDATE media_items SET title = 'Concurrent title' WHERE id = ${itemId}`;
                if (field === 'source')
                    await writer`UPDATE media_items SET title_source = 'tag' WHERE id = ${itemId}`;
                if (field === 'lock')
                    await writer`UPDATE media_items SET metadata_locked = true WHERE id = ${itemId}`;
                request = patch(body);
                await vi.waitFor(async () => {
                    const [lock] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (
                    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                    AND objid::bigint = (hashtext(${itemId})::bigint & 4294967295)
                ) AS waiting`;
                    expect(lock.waiting).toBe(true);
                });
                await writer`COMMIT`;
                const before = await snapshot();
                expect((await request).status).toBe(409);
                expect(await snapshot()).toEqual(before);
            } finally {
                await writer`ROLLBACK`;
                writer.release();
                await request;
            }
        },
    );

    it('uses one timezone-independent microsecond token across independently connected sessions', async () => {
        await sql`UPDATE media_items SET metadata_locked=true, metadata_locked_by='old', metadata_locked_at='2026-10-24T12:34:56.123456Z' WHERE id=${itemId}`;
        const viewer = await sql.reserve();
        const writer = await concurrentWriter.reserve();
        try {
            await viewer`SET TIME ZONE 'Europe/Vienna'`;
            await writer`SET TIME ZONE 'America/New_York'`;
            const body = await confirmation(viewer as unknown as postgres.Sql);
            vi.mocked(connection.getDb).mockReturnValue(writer as unknown as postgres.Sql);
            expect((await patch(body)).status).toBe(200);
            await writer`UPDATE media_items SET title_source='filename', metadata_locked_at='2026-10-24T12:34:56.123456Z' WHERE id=${itemId}`;
            const stale = await confirmation(viewer as unknown as postgres.Sql);
            await writer`UPDATE media_items SET metadata_locked_at=metadata_locked_at+interval '1 microsecond' WHERE id=${itemId}`;
            const before = await snapshot();
            expect((await patch(stale)).status).toBe(409);
            expect(await snapshot()).toEqual(before);
        } finally {
            vi.mocked(connection.getDb).mockReturnValue(sql);
            await viewer`RESET TIME ZONE`;
            await writer`RESET TIME ZONE`;
            viewer.release();
            writer.release();
        }
    });

    it('refuses a requested/resolved UUID mismatch despite a matching target snapshot', async () => {
        const before = await snapshot();
        expect((await patch(await confirmation(), admin, randomUUID(), itemId)).status).toBe(409);
        expect(await snapshot()).toEqual(before);
    });

    it('refuses actual canonical and external resolution redirects without mutating the matching target', async () => {
        const aliasId = randomUUID();
        const externalId = randomUUID().replaceAll('-', '');
        await sql`INSERT INTO media_items (id,title,media_type,status,canonical_id) VALUES (${aliasId},'Merged alias','track','merged',${itemId})`;
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${itemId},'jellyfin',${externalId},'track')`;
        try {
            const before = await snapshot();
            for (const requested of [aliasId, externalId]) {
                expect((await patch(await confirmation(), admin, requested, null)).status).toBe(
                    409,
                );
                expect(await snapshot()).toEqual(before);
            }
        } finally {
            await sql`DELETE FROM media_items WHERE id=${aliasId}`;
        }
    });

    it('accepts a reviewed already-protected filename title using the full precision protection version', async () => {
        await sql`UPDATE media_items SET metadata_locked = true, metadata_locked_by = 'previous-admin',
            metadata_locked_at = '2026-10-24 12:34:56.123456+00' WHERE id = ${itemId}`;
        const body = await confirmation();
        expect(JSON.stringify(body)).toContain('123456');
        expect((await patch(body)).status).toBe(200);
    });

    it.each(['movie', 'deleted', 'dismissed', 'tag', 'manual'] as const)(
        'refuses ineligible %s without side effects',
        async (kind) => {
            if (kind === 'movie')
                await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${itemId}`;
            if (kind === 'deleted')
                await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${itemId}`;
            if (kind === 'dismissed')
                await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${itemId}`;
            if (kind === 'tag')
                await sql`UPDATE media_items SET title_source = 'tag' WHERE id = ${itemId}`;
            if (kind === 'manual')
                await sql`UPDATE media_items SET title_source = NULL WHERE id = ${itemId}`;
            const before = await snapshot();
            expect((await patch(await confirmation())).status).toBe(
                kind === 'tag' || kind === 'manual' ? 409 : 422,
            );
            expect(await snapshot()).toEqual(before);
        },
    );

    it('preserves the legacy mounted GET ISO timestamp contract', async () => {
        await sql`UPDATE media_items SET metadata_locked=true, metadata_locked_by='reviewer', metadata_locked_at='2026-10-24T12:34:56.123456Z' WHERE id=${itemId}`;
        const url = new URL(`http://localhost/api/media/${itemId}/metadata`);
        const response = await GET!({
            url,
            params: { id: itemId },
            locals: { principal: admin },
            request: new Request(url),
            cookies: { get: () => undefined },
        } as unknown as RequestEvent);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            locked: true,
            lockedBy: 'reviewer',
            lockedAt: '2026-10-24T12:34:56.123Z',
        });
    });

    it('preserves the separate mounted v1 custom-metadata contract', async () => {
        const url = new URL(`http://localhost/api/v1/media/${itemId}/metadata`);
        const event = (method: string, body?: unknown): RequestEvent =>
            ({
                url,
                params: { id: itemId },
                locals: { principal: admin },
                request: new Request(url, {
                    method,
                    ...(body !== undefined
                        ? {
                              headers: { 'content-type': 'application/json' },
                              body: JSON.stringify(body),
                          }
                        : {}),
                }),
                cookies: { get: () => undefined },
            }) as unknown as RequestEvent;
        const response = await v1GET!(event('GET'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            custom_metadata: { nested: { a: [1, 'two'] } },
        });
        const before = await snapshot();
        expect((await v1PATCH!(event('PATCH', await confirmation()))).status).toBe(422);
        expect(await snapshot()).toEqual(before);
    });

    it('missing item is 404', async () => {
        expect((await patch(await confirmation(), admin, randomUUID())).status).toBe(404);
    });

    it('rejects a request without an authenticated principal despite a legacy user flag', async () => {
        const before = await snapshot();
        expect([401, 403]).toContain((await patch(await confirmation(), null)).status);
        expect(await snapshot()).toEqual(before);
    });

    it.each([
        buildPrincipal({
            kind: 'session',
            userId,
            username: 'viewer',
            userGroups: [],
            ownerIsAdmin: false,
        }),
        buildPrincipal({
            kind: 'pat',
            userId,
            username: 'admin-low-scope',
            userGroups: ['admins'],
            tokenScopes: ['read'],
            ownerIsAdmin: true,
        }),
        buildPrincipal({
            kind: 'pat',
            userId,
            username: 'demoted',
            userGroups: ['admins'],
            tokenScopes: ['admin'],
            ownerIsAdmin: false,
        }),
    ])('denies $username before changing any value', async (principal) => {
        const before = await snapshot();
        expect((await patch(await confirmation(), principal)).status).toBe(403);
        expect(await snapshot()).toEqual(before);
    });

    it.each([
        { confirmFilenameTitle: { title: ' Glass Harbour ', source: 'tag', locked: false } },
        { confirmFilenameTitle: { title: ' Glass Harbour ', source: 'filename' } },
        {
            confirmFilenameTitle: { title: ' Glass Harbour ', source: 'filename', locked: false },
            overview: 'stale overview',
        },
        {
            confirmFilenameTitle: {
                title: ' Glass Harbour ',
                source: 'filename',
                locked: false,
                lockedBy: 'invented actor',
            },
        },
    ])('rejects malformed or stale payload %# without mutation', async (body) => {
        const before = await snapshot();
        expect([409, 422]).toContain((await patch(body)).status);
        expect(await snapshot()).toEqual(before);
    });

    it('unrelated and unchanged normal edits retain filename provenance', async () => {
        expect((await patch({ title: ' Glass Harbour ', overview: 'New overview' })).status).toBe(
            200,
        );
        expect((await getMediaItemById(sql, itemId))?.title_source).toBe('filename');
        expect((await patch({ overview: 'Another overview' })).status).toBe(200);
        expect((await getMediaItemById(sql, itemId))?.title_source).toBe('filename');
    });

    it('database unavailable produces a truthful error and no mutation', async () => {
        const body = await confirmation();
        const before = await snapshot();
        vi.mocked(connection.getDb).mockReturnValue(null);
        expect((await patch(body)).status).toBe(503);
        expect(await snapshot()).toEqual(before);
    });

    it('rolls back the whole confirmation when the database rejects commit', async () => {
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || '{"reject_confirmation":true}'::jsonb WHERE id = ${itemId}`;
        await sql`CREATE FUNCTION reject_title_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.custom_metadata->>'reject_confirmation' = 'true' AND NEW.metadata_locked = true THEN
                    RAISE EXCEPTION 'injected confirmation failure';
                END IF;
                RETURN NEW;
            END;
        $$`;
        await sql`CREATE CONSTRAINT TRIGGER reject_title_confirmation AFTER UPDATE ON media_items
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_title_confirmation()`;
        try {
            const before = await snapshot();
            expect((await patch(await confirmation())).status).toBe(500);
            expect(await snapshot()).toEqual(before);
        } finally {
            await sql`DROP TRIGGER reject_title_confirmation ON media_items`;
            await sql`DROP FUNCTION reject_title_confirmation()`;
        }
    });
});
