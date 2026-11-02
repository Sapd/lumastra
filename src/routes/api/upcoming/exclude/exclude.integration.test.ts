// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/upcoming/exclude handlers against a real database: which key a mute
 * writes, that it never reveals an item the user cannot see, and that a row is
 * only removable by its owner.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { loadSeriesExclusionsForUser } from '$lib/server/services/series-interest.service.js';
import { isCalendarRowExcluded } from '$lib/server/utils/excluded-series-match.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => getTestDb(),
    getTaskDb: () => getTestDb(),
}));

import { def } from '$lib/server/api/defs/recommendations/upcoming-exclude.js';

const PREFIX = 'Excl Route Test';

interface TestUser {
    id: string;
    userId: string;
    username: string;
    isAdmin: boolean;
    isAgeRestricted: boolean;
    maxAgeRating: number | null;
}

type Handler = (event: unknown, ctx: unknown) => Promise<Response>;

function call(method: 'POST' | 'DELETE', user: TestUser, body: unknown): Promise<Response> {
    const url = new URL('http://localhost/api/upcoming/exclude');
    const event = {
        url,
        request: new Request(url, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: { user },
        params: {},
        route: { id: '/api/upcoming/exclude' },
    };
    const handler = (def.handlers as Record<string, Handler>)[method];
    return handler(event, { surface: 'internal' });
}

describe('/api/upcoming/exclude', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM user_media_flags WHERE user_id IN (
            SELECT id FROM users WHERE username LIKE 'excl-route-%')`;
        await sql`DELETE FROM media_files WHERE id IN (
            SELECT mfi.file_id FROM media_file_items mfi
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mi.title LIKE 'Access fixture %')`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Access fixture %'`;
        await sql`DELETE FROM media_items WHERE title LIKE ${PREFIX + '%'}`;
        await sql`DELETE FROM users WHERE username LIKE 'excl-route-%'`;
        await sql`DELETE FROM library_group_permissions WHERE library_group_id IN (
            SELECT id FROM library_groups WHERE name LIKE ${PREFIX + '%'})`;
        await sql`DELETE FROM library_groups WHERE name LIKE ${PREFIX + '%'}`;
        invalidateLibraryGroupPermissionsCache();
    });

    async function insertUser(maxAgeRating: number | null = null): Promise<TestUser> {
        const id = crypto.randomUUID();
        const username = `excl-route-${id.slice(0, 8)}`;
        await sql`
            INSERT INTO users (id, username, is_admin, max_age_rating)
            VALUES (${id}::uuid, ${username}, false, ${maxAgeRating})
        `;
        return {
            id,
            userId: id,
            username,
            isAdmin: false,
            isAgeRestricted: maxAgeRating !== null,
            maxAgeRating,
        };
    }

    async function insertItem(
        title: string,
        mediaType: 'tv' | 'movie' | 'episode',
        ageRating: number | null = null,
    ): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, media_type, title, status, has_files, age_rating)
            VALUES (${id}::uuid, ${mediaType}, ${title}, 'active', true, ${ageRating})
        `;
        return id;
    }

    async function flags(
        userId: string,
    ): Promise<Array<{ target_type: string; target_id: string }>> {
        return sql`
            SELECT target_type, target_id FROM user_media_flags
            WHERE user_id = ${userId}::uuid AND flag_type = 'series_excluded'
            ORDER BY target_id
        `;
    }

    it('mutes a catalog series by its id', async () => {
        const user = await insertUser();
        const seriesId = await insertItem(`${PREFIX} Lantern Ward`, 'tv');

        const res = await call('POST', user, { seriesName: 'Lantern Ward', mediaId: seriesId });

        expect(res.status).toBe(200);
        expect(await flags(user.id)).toEqual([{ target_type: 'series', target_id: seriesId }]);
    });

    it('answers a denied item like a missing one and writes nothing', async () => {
        const user = await insertUser(12);
        const adultId = await insertItem(`${PREFIX} Night Ledger`, 'tv', 18);

        const res = await call('POST', user, { seriesName: 'Night Ledger', mediaId: adultId });

        expect(res.status).toBe(404);
        expect(await flags(user.id)).toEqual([]);
    });

    it('refuses an episode id: a mute only matches series and movies', async () => {
        const user = await insertUser();
        const episodeId = await insertItem(`${PREFIX} Episode`, 'episode');

        const res = await call('POST', user, { seriesName: 'x', mediaId: episodeId });

        expect(res.status).toBe(404);
        expect(await flags(user.id)).toEqual([]);
    });

    it('rejects a name-only mute with a validation error and writes nothing', async () => {
        const user = await insertUser();
        await insertItem(`${PREFIX} Quillmoor`, 'tv');

        const res = await call('POST', user, { seriesName: `${PREFIX} Quillmoor` });

        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain('mediaId or tmdbId is required');
        expect(await flags(user.id)).toEqual([]);
    });

    it('rejects an unmute without an id, also the old seriesName form', async () => {
        const user = await insertUser();
        const seriesId = await insertItem(`${PREFIX} Lantern Ward`, 'tv');
        await call('POST', user, { seriesName: 'Lantern Ward', mediaId: seriesId });

        expect((await call('DELETE', user, {})).status).toBe(422);
        expect((await call('DELETE', user, { seriesName: 'Lantern Ward' })).status).toBe(422);
        expect(await flags(user.id)).toHaveLength(1);
    });

    it('does not mute a Sonarr row without a TMDB id by a title equal to a muted series', async () => {
        const user = await insertUser();
        const title = `${PREFIX} Quillmoor`;
        const seriesId = await insertItem(title, 'tv');
        expect((await call('POST', user, { seriesName: title, mediaId: seriesId })).status).toBe(
            200,
        );

        const exclusions = await loadSeriesExclusionsForUser(sql, user.id);
        const sonarrRow = {
            id: null,
            title: 'Pilot',
            media_type: 'episode',
            series_name: title,
            series_id: null,
            tmdb_id: null,
        };
        expect(isCalendarRowExcluded(exclusions, sonarrRow)).toBe(false);
    });

    it('stores a TMDB key with its media type', async () => {
        const user = await insertUser();

        const res = await call('POST', user, {
            seriesName: 'Arr Only Movie',
            tmdbId: 4242,
            mediaType: 'movie',
        });

        expect(res.status).toBe(200);
        expect(await flags(user.id)).toEqual([
            { target_type: 'tmdb_movie', target_id: 'movie:4242' },
        ]);
    });

    it('refuses a TMDB key for a restricted user', async () => {
        const user = await insertUser(12);

        const res = await call('POST', user, { seriesName: 'Arr Only', tmdbId: 4242 });

        expect(res.status).toBe(404);
        expect(await flags(user.id)).toEqual([]);
    });

    it("cannot remove another user's mute by id", async () => {
        const owner = await insertUser();
        const other = await insertUser();
        const seriesId = await insertItem(`${PREFIX} Lantern Ward`, 'tv');
        const created = await call('POST', owner, { seriesName: 'x', mediaId: seriesId });
        const { id } = (await created.json()) as { id: string };

        const res = await call('DELETE', other, { id });

        expect(res.status).toBe(404);
        expect(await flags(owner.id)).toHaveLength(1);

        const own = await call('DELETE', owner, { id });
        expect(own.status).toBe(200);
        expect(await flags(owner.id)).toEqual([]);
    });
});
