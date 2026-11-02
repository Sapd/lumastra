// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Subsonic Browse Handlers
 *
 * Tests the browse endpoints against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';

// Import handlers
import {
    handleGetArtists,
    handleGetMusicDirectory,
    handleGetArtist,
    handleGetAlbum,
    handleGetSong,
    handleGetGenres,
    handleGetIndexes,
    handleGetAlbumList,
    handleGetAlbumList2,
} from '$lib/server/subsonic-compat/handlers/browse.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// users.id UUID (mig 16.46.0 — user_id columns are now uuid)
const TEST_USER: UserId = toUserId(randomUUID());

function buildMockEvent(params: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/rest/browse');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    return {
        url,
        request: new Request(url.toString()),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        route: { id: '/rest/browse' },
        cookies: {},
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

function buildAuth(overrides: Partial<SubsonicAuthContext> = {}): SubsonicAuthContext {
    return {
        // userId is the UUID (users.id). Tests set username = UUID so handlers
        // using auth.username for DB writes still resolve to the correct users row.
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

async function parseJson(resp: Response): Promise<Record<string, unknown>> {
    const data = (await resp.json()) as {
        'subsonic-response': Record<string, unknown>;
    };
    return data['subsonic-response'];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Subsonic browse handlers (Integration)', () => {
    let sql: postgres.Sql;
    let artistId: string;
    let albumId: string;
    let trackIds: string[];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        await ensureTestUser(sql, TEST_USER);

        const result = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'BrowseTestArtist',
            albumTitle: 'BrowseTestAlbum',
            trackCount: 3,
            genre: 'IntegrationGenre',
        });
        artistId = result.artistId;
        albumId = result.albumId;
        trackIds = result.trackIds;
    });

    // -----------------------------------------------------------------------
    // getArtists
    // -----------------------------------------------------------------------

    it('handleGetArtists returns artists grouped by index', async () => {
        const resp = await handleGetArtists(buildMockEvent(), buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.artists).toBeDefined();

        const artists = body.artists as Record<string, unknown>;
        expect(Array.isArray(artists.index)).toBe(true);

        const index = artists.index as Array<Record<string, unknown>>;
        expect(index.length).toBeGreaterThan(0);

        const allArtists = index.flatMap((idx) => idx.artist as Array<Record<string, unknown>>);
        const found = allArtists.find((a) => a.name === 'BrowseTestArtist');
        expect(found).toBeDefined();
        expect(found).toHaveProperty('id', artistId);
    });

    // -----------------------------------------------------------------------
    // getIndexes
    // -----------------------------------------------------------------------

    it('handleGetIndexes returns indexes with lastModified and ignoredArticles', async () => {
        const resp = await handleGetIndexes(buildMockEvent(), buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.indexes).toBeDefined();

        const indexes = body.indexes as Record<string, unknown>;
        expect(indexes.lastModified).toBe(0);
        expect(typeof indexes.ignoredArticles).toBe('string');
        expect(Array.isArray(indexes.index)).toBe(true);
        expect(Array.isArray(indexes.child)).toBe(true);

        const index = indexes.index as Array<Record<string, unknown>>;
        expect(index.length).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // getMusicDirectory — album
    // -----------------------------------------------------------------------

    it('handleGetMusicDirectory with album id returns directory with child tracks', async () => {
        const resp = await handleGetMusicDirectory(
            buildMockEvent({ id: albumId }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.directory).toBeDefined();

        const directory = body.directory as Record<string, unknown>;
        expect(directory.id).toBe(albumId);
        expect(Array.isArray(directory.child)).toBe(true);

        const children = directory.child as Array<Record<string, unknown>>;
        expect(children.length).toBe(3);
        expect(children.every((c) => c.isDir === false)).toBe(true);
        expect(children.some((c) => c.parent === albumId)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // getMusicDirectory — artist
    // -----------------------------------------------------------------------

    it('handleGetMusicDirectory with artist id returns directory with child albums', async () => {
        const resp = await handleGetMusicDirectory(
            buildMockEvent({ id: artistId }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.directory).toBeDefined();

        const directory = body.directory as Record<string, unknown>;
        expect(directory.id).toBe(artistId);
        expect(Array.isArray(directory.child)).toBe(true);

        const children = directory.child as Array<Record<string, unknown>>;
        expect(children.length).toBe(1);
        expect(children[0]?.isDir).toBe(true);
        expect(children[0]?.id).toBe(albumId);
    });

    // -----------------------------------------------------------------------
    // getMusicDirectory — unknown
    // -----------------------------------------------------------------------

    it('handleGetMusicDirectory with unknown id returns error 70', async () => {
        const resp = await handleGetMusicDirectory(
            buildMockEvent({ id: '00000000-0000-4000-a000-00000000dead' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.status).toBe('failed');
        expect((body.error as Record<string, unknown>)?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // getArtist
    // -----------------------------------------------------------------------

    it('handleGetArtist returns artist with album list', async () => {
        const resp = await handleGetArtist(buildMockEvent({ id: artistId }), buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.artist).toBeDefined();

        const artist = body.artist as Record<string, unknown>;
        expect(artist.id).toBe(artistId);
        expect(artist.name).toBe('BrowseTestArtist');
        expect(Array.isArray(artist.album)).toBe(true);

        const albums = artist.album as Array<Record<string, unknown>>;
        expect(albums.length).toBe(1);
        expect(albums[0]?.id).toBe(albumId);
    });

    it('handleGetArtist with unknown id returns error 70', async () => {
        const resp = await handleGetArtist(
            buildMockEvent({ id: '00000000-0000-4000-a000-00000000dead' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.status).toBe('failed');
        expect((body.error as Record<string, unknown>)?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // getAlbum
    // -----------------------------------------------------------------------

    it('handleGetAlbum returns album with song list', async () => {
        const resp = await handleGetAlbum(buildMockEvent({ id: albumId }), buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.album).toBeDefined();

        const album = body.album as Record<string, unknown>;
        expect(album.id).toBe(albumId);
        expect(album.name).toBe('BrowseTestAlbum');
        expect(Array.isArray(album.song)).toBe(true);

        const songs = album.song as Array<Record<string, unknown>>;
        expect(songs.length).toBe(3);
        expect(songs.every((s) => s.isDir === false)).toBe(true);
    });

    it('handleGetAlbum with unknown id returns error 70', async () => {
        const resp = await handleGetAlbum(
            buildMockEvent({ id: '00000000-0000-4000-a000-00000000dead' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.status).toBe('failed');
        expect((body.error as Record<string, unknown>)?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // getSong
    // -----------------------------------------------------------------------

    it('handleGetSong returns single song', async () => {
        const trackId = trackIds[0];
        const resp = await handleGetSong(buildMockEvent({ id: trackId }), buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.song).toBeDefined();

        const song = body.song as Record<string, unknown>;
        expect(song.id).toBe(trackId);
        expect(typeof song.title).toBe('string');
        expect(song.isDir).toBe(false);
    });

    it('handleGetSong with unknown id returns error 70', async () => {
        const resp = await handleGetSong(
            buildMockEvent({ id: '00000000-0000-4000-a000-00000000dead' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.status).toBe('failed');
        expect((body.error as Record<string, unknown>)?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // getGenres
    // -----------------------------------------------------------------------

    it('handleGetGenres returns genres array', async () => {
        const resp = await handleGetGenres(buildMockEvent(), buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.genres).toBeDefined();

        const genres = body.genres as Record<string, unknown>;
        expect(Array.isArray(genres.genre)).toBe(true);

        const genreList = genres.genre as Array<Record<string, unknown>>;
        expect(genreList.length).toBeGreaterThan(0);

        const found = genreList.find((g) => g.value === 'IntegrationGenre');
        expect(found).toBeDefined();
        expect(typeof found?.songCount).toBe('number');
        expect(typeof found?.albumCount).toBe('number');
    });

    // -----------------------------------------------------------------------
    // getAlbumList
    // -----------------------------------------------------------------------

    it('handleGetAlbumList with type=alphabeticalByName returns albums', async () => {
        const resp = await handleGetAlbumList(
            buildMockEvent({
                type: 'alphabeticalByName',
                size: '10',
                offset: '0',
            }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.albumList).toBeDefined();

        const albumList = body.albumList as Record<string, unknown>;
        expect(Array.isArray(albumList.album)).toBe(true);

        const albums = albumList.album as Array<Record<string, unknown>>;
        expect(albums.length).toBeGreaterThan(0);
        expect(albums.some((a) => a.id === albumId)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // getAlbumList2
    // -----------------------------------------------------------------------

    it('handleGetAlbumList2 with type=newest returns albums', async () => {
        const resp = await handleGetAlbumList2(
            buildMockEvent({ type: 'newest', size: '10', offset: '0' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const body = await parseJson(resp);
        expect(body.albumList2).toBeDefined();

        const albumList2 = body.albumList2 as Record<string, unknown>;
        expect(Array.isArray(albumList2.album)).toBe(true);

        const albums = albumList2.album as Array<Record<string, unknown>>;
        expect(albums.length).toBeGreaterThan(0);
        expect(albums.some((a) => a.id === albumId)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // C14 (2026-09-16 security review 3, task 4) — a zero-track album and a
    // file-less artist row were served to a restricted Subsonic caller
    // without ever calling an access primitive. Both cases are inert without
    // the C7 fix to isMediaAccessible (checkSubsonicMediaAccess -> checkMediaAccess
    // -> isMediaAccessible), which task 4 lands together with this one.
    // -----------------------------------------------------------------------

    describe('C14 — zero-track album / file-less artist access', () => {
        async function restrictGroupTo(
            libraryGroupId: string,
            allowedGroup: string,
        ): Promise<void> {
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId,
                allowedGroups: [allowedGroup],
            });
            invalidateLibraryGroupPermissionsCache();
        }

        async function withDeniedGroup<T>(fn: (deniedGroupId: string) => Promise<T>): Promise<T> {
            const deniedGroupId = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'C14 Denied Group')`;
            try {
                await restrictGroupTo(deniedGroupId, 'adults');
                return await fn(deniedGroupId);
            } finally {
                await deleteLibraryGroupPermission(sql, deniedGroupId);
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
                invalidateLibraryGroupPermissionsCache();
            }
        }

        it('handleGetArtist 404s a file-less artist naming a denied library_group_id', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                const bareArtistId = randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, library_group_id)
                    VALUES (${bareArtistId}::uuid, 'C14 Bare Artist', 'artist', 'active', ${deniedGroupId}::uuid)
                `;

                const resp = await handleGetArtist(
                    buildMockEvent({ id: bareArtistId }),
                    buildAuth({ userGroups: ['kids'] }),
                    sql,
                );
                expect(resp.status).toBe(200);
                const body = await parseJson(resp);
                expect(body.status).toBe('failed');
                expect((body.error as Record<string, unknown>)?.code).toBe(70);

                // Control: an unrestricted (admin) caller still sees it.
                const okResp = await handleGetArtist(
                    buildMockEvent({ id: bareArtistId }),
                    buildAuth({ ownerIsAdmin: true }),
                    sql,
                );
                const okBody = await parseJson(okResp);
                expect(okBody.artist).toBeDefined();
            });
        });

        it('handleGetMusicDirectory 404s a file-less artist naming a denied library_group_id', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                const bareArtistId = randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, library_group_id)
                    VALUES (${bareArtistId}::uuid, 'C14 Bare Artist 2', 'artist', 'active', ${deniedGroupId}::uuid)
                `;

                const resp = await handleGetMusicDirectory(
                    buildMockEvent({ id: bareArtistId }),
                    buildAuth({ userGroups: ['kids'] }),
                    sql,
                );
                expect(resp.status).toBe(200);
                const body = await parseJson(resp);
                expect(body.status).toBe('failed');
                expect((body.error as Record<string, unknown>)?.code).toBe(70);
            });
        });

        it('handleGetArtist excludes a zero-track album naming a denied library_group_id', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                const zeroTrackAlbumId = randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, parent_id, status, library_group_id)
                    VALUES (${zeroTrackAlbumId}::uuid, 'C14 Zero Track Album', 'album', ${artistId}::uuid, 'active', ${deniedGroupId}::uuid)
                `;

                const resp = await handleGetArtist(
                    buildMockEvent({ id: artistId }),
                    buildAuth({ userGroups: ['kids'] }),
                    sql,
                );
                expect(resp.status).toBe(200);
                const body = await parseJson(resp);
                const artist = body.artist as Record<string, unknown>;
                const albums = artist.album as Array<Record<string, unknown>>;
                expect(albums.map((a) => a.id)).not.toContain(zeroTrackAlbumId);
                // The normal (visible) album from the beforeEach fixture stays.
                expect(albums.map((a) => a.id)).toContain(albumId);
            });
        });

        // -------------------------------------------------------------------
        // C14 (follow-up, 2026-09-16) — the two id-keyed ALBUM entry points
        // were not named in the finding but carry the identical shape: the
        // `tracks.length > 0 && accessibleTracks.length === 0` guard is
        // VACUOUSLY FALSE for a zero-track album, so the album row's own
        // library_group_id was never gated and its metadata was served.
        // -------------------------------------------------------------------

        async function insertZeroTrackAlbum(deniedGroupId: string): Promise<string> {
            const zeroTrackAlbumId = randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status, library_group_id)
                VALUES (${zeroTrackAlbumId}::uuid, 'C14 Zero Track Album Direct', 'album', ${artistId}::uuid, 'active', ${deniedGroupId}::uuid)
            `;
            return zeroTrackAlbumId;
        }

        it('handleGetAlbum 404s a zero-track album naming a denied library_group_id', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                const zeroTrackAlbumId = await insertZeroTrackAlbum(deniedGroupId);

                const resp = await handleGetAlbum(
                    buildMockEvent({ id: zeroTrackAlbumId }),
                    buildAuth({ userGroups: ['kids'] }),
                    sql,
                );
                expect(resp.status).toBe(200);
                const body = await parseJson(resp);
                expect(body.status).toBe('failed');
                expect((body.error as Record<string, unknown>)?.code).toBe(70);
                expect(body.album).toBeUndefined();

                // Control: an unrestricted (admin) caller still sees it.
                const okBody = await parseJson(
                    await handleGetAlbum(
                        buildMockEvent({ id: zeroTrackAlbumId }),
                        buildAuth({ ownerIsAdmin: true }),
                        sql,
                    ),
                );
                expect(okBody.album).toBeDefined();
            });
        });

        it('handleGetMusicDirectory 404s a zero-track album naming a denied library_group_id', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                const zeroTrackAlbumId = await insertZeroTrackAlbum(deniedGroupId);

                const resp = await handleGetMusicDirectory(
                    buildMockEvent({ id: zeroTrackAlbumId }),
                    buildAuth({ userGroups: ['kids'] }),
                    sql,
                );
                expect(resp.status).toBe(200);
                const body = await parseJson(resp);
                expect(body.status).toBe('failed');
                expect((body.error as Record<string, unknown>)?.code).toBe(70);
                expect(body.directory).toBeUndefined();
            });
        });

        // Control for the new album gate: checkMediaAccess on an album-type row
        // is accessible when ANY descendant track file is non-denied, so an
        // album with a MIX of denied and allowed tracks must still be served —
        // only the individual denied tracks drop out, exactly as before.
        it('handleGetAlbum still serves a partially-accessible album, minus the denied tracks', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                // Move ONE of the fixture album's three track files into the
                // denied group; the other two stay unrestricted (NULL group).
                await sql`
                    UPDATE media_files SET library_group_id = ${deniedGroupId}::uuid
                    WHERE id IN (
                        SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]}::uuid
                    )
                `;

                const body = await parseJson(
                    await handleGetAlbum(
                        buildMockEvent({ id: albumId }),
                        buildAuth({ userGroups: ['kids'] }),
                        sql,
                    ),
                );
                expect(body.status).not.toBe('failed');
                const album = body.album as Record<string, unknown>;
                expect(album).toBeDefined();
                expect(album.id).toBe(albumId);
                const songs = album.song as Array<Record<string, unknown>>;
                expect(songs.map((s) => s.id)).not.toContain(trackIds[0]);
                expect(songs.map((s) => s.id)).toEqual(
                    expect.arrayContaining([trackIds[1], trackIds[2]]),
                );
            });
        });

        it('handleGetMusicDirectory still serves a partially-accessible album, minus the denied tracks', async () => {
            await withDeniedGroup(async (deniedGroupId) => {
                await sql`
                    UPDATE media_files SET library_group_id = ${deniedGroupId}::uuid
                    WHERE id IN (
                        SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]}::uuid
                    )
                `;

                const body = await parseJson(
                    await handleGetMusicDirectory(
                        buildMockEvent({ id: albumId }),
                        buildAuth({ userGroups: ['kids'] }),
                        sql,
                    ),
                );
                expect(body.status).not.toBe('failed');
                const directory = body.directory as Record<string, unknown>;
                expect(directory).toBeDefined();
                expect(directory.id).toBe(albumId);
                const children = directory.child as Array<Record<string, unknown>>;
                expect(children.map((c) => c.id)).not.toContain(trackIds[0]);
                expect(children.map((c) => c.id)).toEqual(
                    expect.arrayContaining([trackIds[1], trackIds[2]]),
                );
            });
        });
    });
});
