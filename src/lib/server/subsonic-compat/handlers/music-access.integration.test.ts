// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test: the Subsonic artist / album handlers apply the caller's
 * real access boundary to what they COUNT, not just to what they list.
 *
 * getArtist, getMusicDirectory and getStarred* loaded the artist with
 * `unrestrictedAccess()` and filtered only the album list afterwards, so the
 * artist's albumCount/songCount and each album's songCount/duration still
 * counted albums and tracks the caller cannot play. getAlbum and the starred
 * album list did the same for a partly hidden album. getStarred* also skipped
 * its artist filter for a caller with no denied library group, so an
 * age-limited user kept a starred artist whose music is all over their limit.
 *
 * Every case also runs as an admin and asserts the hidden albums/tracks ARE
 * counted there, so "the count is lower for the restricted user" cannot pass
 * because the fixture simply has fewer rows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import * as quickPicks from '$lib/server/database/queries/music-quick-picks.queries.js';
import { createLibraryGroup } from '$lib/server/database/queries/library-groups.queries.js';
import { upsertLibraryGroupPermission } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { upsertUserRating } from '$lib/server/database/queries/user-ratings.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import {
    handleGetAlbum,
    handleGetAlbumList2,
    handleGetArtist,
    handleGetMusicDirectory,
} from '$lib/server/subsonic-compat/handlers/browse.js';
import {
    handleGetArtistInfo2,
    handleGetAlbumInfo,
    handleGetAlbumInfo2,
} from '$lib/server/subsonic-compat/handlers/info.js';
import { handleGetStarred2 } from '$lib/server/subsonic-compat/handlers/ratings.js';
import {
    handleGetTopSongs,
    handleSearch2,
    handleSearch3,
    handleGetRandomSongs,
    handleGetSongsByGenre,
} from '$lib/server/subsonic-compat/handlers/search.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const TEST_USER: UserId = toUserId(randomUUID());

function auth(overrides: Partial<SubsonicAuthContext>): SubsonicAuthContext {
    return {
        userId: TEST_USER,
        username: TEST_USER,
        ownerIsAdmin: false,
        displayName: null,
        clientName: 'integration-test',
        format: 'json',
        userGroups: [],
        maxAgeRating: null,
        isAgeRestricted: false,
        ...overrides,
    };
}

const admin = () => auth({ ownerIsAdmin: true, userGroups: ['adults'] });
// Not in 'adults', so denied the restricted library group.
const groupDenied = () => auth({ userGroups: ['kids'] });
// In 'adults' (no library restriction) but age-limited to 12.
const ageLimited = () => auth({ userGroups: ['adults'], maxAgeRating: 12, isAgeRestricted: true });

type Body = Record<string, unknown>;
type Album = { id: string; songCount: number; duration: number; song?: { duration: number }[] };
type Artist = { id: string; albumCount: number; songCount: number; album?: Album[] };

async function call(
    handler: SubsonicHandler,
    caller: SubsonicAuthContext,
    sql: postgres.Sql,
    params: Record<string, string>,
): Promise<Body> {
    const url = new URL('http://localhost/rest/x');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const event = {
        url,
        request: new Request(url),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        getClientAddress: () => '127.0.0.1',
    } as unknown as RequestEvent;
    const res = await handler(event, caller, sql);
    expect(res.status).toBe(200);
    return ((await res.json()) as { 'subsonic-response': Body })['subsonic-response'];
}

describe('Subsonic artist/album handlers count only what the caller can play (Integration)', () => {
    let sql: postgres.Sql;
    // "Mixed Artist" owns three albums: `open` (3 tracks, one of them in the
    // denied group), `grouped` (2 tracks, all in the denied group) and `adult`
    // (2 tracks, rated 18). `adultOnly` is a second artist whose only album is
    // rated 18 while the artist row itself is rated 6.
    const libraryGroupIds: string[] = [];
    let mixedArtistId: string;
    let open: { albumId: string; trackIds: string[] };
    let grouped: { albumId: string; trackIds: string[] };
    let adult: { albumId: string; trackIds: string[] };
    let adultOnly: { artistId: string; albumId: string };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ANY(${libraryGroupIds}::uuid[])`;
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        await sql`TRUNCATE TABLE library_group_permissions CASCADE`;
        invalidateLibraryGroupPermissionsCache();
        await ensureTestUser(sql, TEST_USER);

        const mixed = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: `Mixed Artist ${randomUUID()}`,
            trackCount: 3,
        });
        mixedArtistId = mixed.artistId;
        open = mixed;
        grouped = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        adult = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        await sql`UPDATE media_items SET parent_id = ${mixedArtistId}
                  WHERE id = ANY(${[grouped.albumId, adult.albumId]}::uuid[])`;
        const only = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: `Adult Only ${randomUUID()}`,
            trackCount: 2,
        });
        adultOnly = only;

        // The scanner propagates playable leaves to their containers; the
        // low-level music factory only attaches the track files.
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[mixedArtistId, open.albumId, grouped.albumId, adult.albumId, only.artistId, only.albumId]}::uuid[])`;

        // Unrated items are hidden under an age limit by default
        // (UNRATED_CONTENT_VISIBLE=false), so rate everything explicitly.
        await sql`UPDATE media_items SET age_rating = 6
                  WHERE id = ANY(${[mixedArtistId, open.albumId, ...open.trackIds, grouped.albumId, ...grouped.trackIds, only.artistId]}::uuid[])`;
        await sql`UPDATE media_items SET age_rating = 18
                  WHERE id = ANY(${[adult.albumId, ...adult.trackIds, only.albumId, ...only.trackIds]}::uuid[])`;

        const group = await createLibraryGroup(sql, { name: `Restricted ${randomUUID()}` });
        libraryGroupIds.push(group.id);
        await sql`UPDATE media_files SET library_group_id = ${group.id}
                  WHERE id IN (SELECT file_id FROM media_file_items
                               WHERE media_item_id = ANY(${[open.trackIds[0], ...grouped.trackIds]}::uuid[]))`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: group.id,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();

        for (const mediaId of [mixedArtistId, open.albumId, only.artistId]) {
            await upsertUserRating.execute(sql, { userId: TEST_USER, mediaId, rating: 10 });
        }
    });

    function counts(artist: Artist): { albums: string[]; albumCount: number; songCount: number } {
        return {
            albums: (artist.album ?? []).map((a) => a.id).sort(),
            albumCount: artist.albumCount,
            songCount: artist.songCount,
        };
    }

    const sorted = (...ids: string[]) => [...ids].sort();

    it('getAlbumInfo and getAlbumInfo2 gate zero-track albums by library group and age', async () => {
        const zeroTrack = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
        const group = await createLibraryGroup(sql, { name: `Empty restricted ${randomUUID()}` });
        libraryGroupIds.push(group.id);
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: group.id,
            allowedGroups: ['adults'],
        });
        await sql`UPDATE media_items
                  SET library_group_id = ${group.id}, age_rating = 18, overview = 'Private album notes'
                  WHERE id = ${zeroTrack.albumId}`;
        invalidateLibraryGroupPermissionsCache();

        for (const [handler, key] of [
            [handleGetAlbumInfo, 'albumInfo'],
            [handleGetAlbumInfo2, 'albumInfo2'],
        ] as const) {
            const visible = await call(handler, admin(), sql, { id: zeroTrack.albumId });
            expect(visible.status).toBe('ok');
            expect(visible[key]).toMatchObject({ notes: 'Private album notes' });
            for (const caller of [groupDenied(), ageLimited()]) {
                const denied = await call(handler, caller, sql, { id: zeroTrack.albumId });
                expect(denied.status).toBe('failed');
                expect(denied.error).toMatchObject({ code: 70 });
                expect(denied).not.toHaveProperty(key);
            }
        }
    });

    it('getArtist counts only the albums and tracks the caller can play', async () => {
        const get = async (caller: SubsonicAuthContext) =>
            (await call(handleGetArtist, caller, sql, { id: mixedArtistId })).artist as Artist;

        const all = await get(admin());
        expect(counts(all)).toEqual({
            albums: sorted(open.albumId, grouped.albumId, adult.albumId),
            albumCount: 3,
            songCount: 7,
        });
        expect(all.album!.find((a) => a.id === open.albumId)!.songCount).toBe(3);

        const byGroup = await get(groupDenied());
        expect(counts(byGroup)).toEqual({
            albums: sorted(open.albumId, adult.albumId),
            albumCount: 2,
            songCount: 4,
        });
        expect(byGroup.album!.find((a) => a.id === open.albumId)!.songCount).toBe(2);

        // In 'adults', so the grouped album is theirs; only the adult one is hidden.
        const byAge = await get(ageLimited());
        expect(counts(byAge)).toEqual({
            albums: sorted(open.albumId, grouped.albumId),
            albumCount: 2,
            songCount: 5,
        });
    });

    it('getArtist and getArtistInfo2 answer "not found" when none of the albums is visible', async () => {
        for (const handler of [handleGetArtist, handleGetArtistInfo2]) {
            const asAdmin = await call(handler, admin(), sql, { id: adultOnly.artistId });
            expect(asAdmin.status).toBe('ok');

            const restricted = await call(handler, ageLimited(), sql, { id: adultOnly.artistId });
            expect(restricted.status).toBe('failed');
            expect((restricted.error as { code: number }).code).toBe(70);
        }
    });

    it('getMusicDirectory (artist) counts each album over the visible tracks only', async () => {
        const children = async (caller: SubsonicAuthContext) =>
            (
                (await call(handleGetMusicDirectory, caller, sql, { id: mixedArtistId }))
                    .directory as { child: Album[] }
            ).child;

        const all = await children(admin());
        expect(all.map((c) => c.id).sort()).toEqual(
            sorted(open.albumId, grouped.albumId, adult.albumId),
        );
        expect(all.find((c) => c.id === open.albumId)!.songCount).toBe(3);

        const byGroup = await children(groupDenied());
        expect(byGroup.map((c) => c.id).sort()).toEqual(sorted(open.albumId, adult.albumId));
        expect(byGroup.find((c) => c.id === open.albumId)!.songCount).toBe(2);

        const byAge = await children(ageLimited());
        expect(byAge.map((c) => c.id).sort()).toEqual(sorted(open.albumId, grouped.albumId));
    });

    it('getAlbum counts and times a partly hidden album over the visible songs', async () => {
        const get = async (caller: SubsonicAuthContext) =>
            (await call(handleGetAlbum, caller, sql, { id: open.albumId })).album as Album;
        const total = (a: Album) => a.song!.reduce((sum, s) => sum + s.duration, 0);

        const all = await get(admin());
        expect(all.song).toHaveLength(3);
        expect(all.songCount).toBe(3);
        expect(all.duration).toBe(total(all));

        const byGroup = await get(groupDenied());
        expect(byGroup.song).toHaveLength(2);
        expect(byGroup.songCount).toBe(2);
        expect(byGroup.duration).toBe(total(byGroup));
        expect(byGroup.duration).toBeLessThan(all.duration);
    });

    it('getAlbumList2 type=starred counts a partly hidden album over the visible tracks', async () => {
        const starred = async (caller: SubsonicAuthContext) =>
            (
                (await call(handleGetAlbumList2, caller, sql, { type: 'starred' })).albumList2 as {
                    album: Album[];
                }
            ).album;

        expect((await starred(admin())).find((a) => a.id === open.albumId)!.songCount).toBe(3);
        expect((await starred(groupDenied())).find((a) => a.id === open.albumId)!.songCount).toBe(
            2,
        );
    });

    it('getAlbumList2 type=frequent counts a partly hidden album over the visible tracks', async () => {
        for (const trackId of open.trackIds) {
            await sql`INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at)
                      VALUES (${TEST_USER}, ${trackId}, 3, now())`;
        }
        const frequent = async (caller: SubsonicAuthContext) =>
            (
                (await call(handleGetAlbumList2, caller, sql, { type: 'frequent' })).albumList2 as {
                    album: Album[];
                }
            ).album.find((a) => a.id === open.albumId)!.songCount;

        expect(await frequent(admin())).toBe(3);
        expect(await frequent(groupDenied())).toBe(2);
    });

    it('getAlbum recounts an album with one over-age track for an age-limited caller', async () => {
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${open.trackIds[1]}`;
        const get = async (caller: SubsonicAuthContext) =>
            (await call(handleGetAlbum, caller, sql, { id: open.albumId })).album as Album;

        expect((await get(admin())).songCount).toBe(3);
        const byAge = await get(ageLimited());
        expect(byAge.song!.map((s) => (s as unknown as { id: string }).id)).not.toContain(
            open.trackIds[1],
        );
        expect(byAge.songCount).toBe(2);
    });

    it('getStarred2 hides an over-age starred artist and counts only visible music', async () => {
        const starred = async (caller: SubsonicAuthContext) =>
            (await call(handleGetStarred2, caller, sql, {})).starred2 as {
                artist: Artist[];
                album: Album[];
            };

        const all = await starred(admin());
        expect(all.artist.map((a) => a.id).sort()).toEqual(
            sorted(mixedArtistId, adultOnly.artistId),
        );
        expect(all.artist.find((a) => a.id === mixedArtistId)).toMatchObject({
            albumCount: 3,
            songCount: 7,
        });
        expect(all.album.find((a) => a.id === open.albumId)!.songCount).toBe(3);

        const byGroup = await starred(groupDenied());
        expect(byGroup.artist.find((a) => a.id === mixedArtistId)).toMatchObject({
            albumCount: 2,
            songCount: 4,
        });
        expect(byGroup.album.find((a) => a.id === open.albumId)!.songCount).toBe(2);

        // No denied library group, only an age limit: this artist used to be
        // returned unfiltered.
        const byAge = await starred(ageLimited());
        expect(byAge.artist.map((a) => a.id)).toEqual([mixedArtistId]);
        expect(byAge.artist[0]).toMatchObject({ albumCount: 2, songCount: 5 });
    });

    it.each([
        [handleSearch2, 'searchResult2'],
        [handleSearch3, 'searchResult3'],
        [handleGetSongsByGenre, 'songsByGenre'],
    ] as const)(
        '%s uses the authenticated principal after IdP admin demotion',
        async (handler, key) => {
            // The stale local flag is deliberately inconsistent with the canonical
            // auth context. Before the fix this resurrected the admin library bypass.
            await sql`UPDATE users SET username = ${TEST_USER}, is_admin = true, groups = ARRAY['kids'] WHERE id = ${TEST_USER}`;
            await sql`INSERT INTO subsonic_client_passwords (user_id, token)
                  VALUES (${TEST_USER}, ${'a'.repeat(40)})
                  ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token`;
            const genre = `demotion-${randomUUID()}`;
            await sql`UPDATE media_items SET custom_metadata = custom_metadata || ${sql.json({ genre })}
                  WHERE id = ANY(${[...open.trackIds, ...grouped.trackIds, ...adult.trackIds]}::uuid[])`;
            const params = { query: '', size: '500', count: '500', songCount: '500', genre };
            const songs = async (caller: SubsonicAuthContext): Promise<string[]> => {
                const body = await call(handler, caller, sql, params);
                return ((body[key] as { song?: { id: string }[] }).song ?? []).map(
                    (song) => song.id,
                );
            };
            const hidden = [open.trackIds[0], ...grouped.trackIds];
            const all = await songs(admin());
            for (const id of hidden) expect(all).toContain(id);
            const restricted = await songs(groupDenied());
            for (const id of hidden) expect(restricted).not.toContain(id);
            expect(restricted).toContain(open.trackIds[1]);
        },
    );

    it('getRandomSongs passes the demoted principal library deny-list to its sampled query', async () => {
        await sql`UPDATE users SET username = ${TEST_USER}, is_admin = true, groups = ARRAY['kids'] WHERE id = ${TEST_USER}`;
        await sql`INSERT INTO subsonic_client_passwords (user_id, token)
                  VALUES (${TEST_USER}, ${'a'.repeat(40)})
                  ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token`;
        // TABLESAMPLE can legitimately return no tracks from a tiny fixture.
        // Observe the boundary passed to that query rather than asserting a
        // random draw; group permissions still resolve against real Postgres.
        const random = vi.spyOn(quickPicks, 'getRandomTracks').mockResolvedValue([]);
        try {
            await call(handleGetRandomSongs, admin(), sql, {});
            expect(random.mock.calls[0][3]).toBeNull();
            await call(handleGetRandomSongs, groupDenied(), sql, {});
            expect(random.mock.calls[1][3]).toEqual(expect.arrayContaining([expect.any(String)]));
        } finally {
            random.mockRestore();
        }
    });

    it('getTopSongs answers a hidden artist like an unknown one', async () => {
        const [{ title }] = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${adultOnly.artistId}`;
        const top = async (caller: SubsonicAuthContext, artist: string) =>
            (await call(handleGetTopSongs, caller, sql, { artist })).topSongs as {
                song?: unknown[];
            };

        expect((await top(admin(), title)).song).toHaveLength(2);
        expect(await top(ageLimited(), title)).toEqual(
            await top(ageLimited(), `No Such Artist ${randomUUID()}`),
        );
    });
});
