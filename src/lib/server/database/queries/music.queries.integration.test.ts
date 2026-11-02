// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Music Query Module
 *
 * Tests the music hierarchy (artist → album → track) queries against
 * a real PostgreSQL test database.
 *
 * Requires a running test DB with all migrations applied (including 6.0.0).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { toUserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestMusicHierarchy,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    musicFixtureEmbeddingLiteral,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    getArtists,
    getArtistWithAlbums,
    getArtistTracks,
    getArtistSummary,
    getAlbumSummary,
    getAlbumSummaries,
    getArtistSummaries,
    getAlbums,
    getAlbumWithTracks,
    getTracksForAlbums,
    getTrackDetail,
    getTrackStreamSource,
    getRecentlyPlayed,
    getMusicByGenre,
    getRecentlyPlayedVariants,
    getSmartQueueCandidates,
    getTracksByGenre,
    hasMusicLibraryOrContent,
    hasPlayableMusic,
    getMostPlayedArtists,
    getTopArtistsByAlbumCount,
    getTracksPaged,
    countTracksPaged,
    countArtists,
    countAlbums,
    getAlphaIndex,
} from './music.queries.js';
import { trackFilePathJoin } from './fragments/music-file-path.fragments.js';
import type { RecentTrackRow } from './music.queries.js';
import { getMediaBrowserStats } from './admin-media.queries.js';
import { createLibraryGroup } from './library-groups.queries.js';
import { createLibraryPath } from './library-paths.queries.js';
import {
    unrestrictedAccess,
    restrictedAccess,
    denyAllAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

/**
 * Asserts every row carries a valid `hours_since_played` projection:
 * either `null` (LEFT JOIN miss) or a finite JS number — never a string,
 * never `undefined`.
 */
function expectHoursSincePlayedShape(rows: RecentTrackRow[]): void {
    for (const row of rows) {
        expect(row).toHaveProperty('hours_since_played');
        if (row.hours_since_played !== null) {
            expect(typeof row.hours_since_played).toBe('number');
            expect(Number.isFinite(row.hours_since_played)).toBe(true);
        }
    }
}

describe('Music Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE',
        );
    });

    describe('playable music availability', () => {
        it('batches summaries without counting nine denied tracks or their duration', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 10,
            });
            const deniedGroup = await createLibraryGroup(sql, { name: 'Summary denied' });
            await sql`UPDATE media_items SET runtime_seconds = 60 WHERE id = ANY(${trackIds}::uuid[])`;
            await sql`UPDATE media_files SET library_group_id = ${deniedGroup.id}
                WHERE id IN (SELECT file_id FROM media_file_items
                             WHERE media_item_id = ANY(${trackIds.slice(1)}::uuid[]))`;
            const hiddenAlbum = createTestAlbum(artistId, { title: 'Denied release' });
            await insertTestAlbum(sql, hiddenAlbum);
            const hiddenTrack = createTestTrack(hiddenAlbum.id, 1);
            await insertTestTrack(sql, hiddenTrack);
            await sql`UPDATE media_files SET library_group_id = ${deniedGroup.id}
                WHERE id IN (SELECT file_id FROM media_file_items
                             WHERE media_item_id = ${hiddenTrack.id})`;
            const access = restrictedAccess({
                deniedGroupIds: [deniedGroup.id],
                maxAgeRating: null,
                allowUnrated: true,
            });
            expect(await getArtistSummaries(sql, [artistId], unrestrictedAccess())).toEqual([
                expect.objectContaining({ album_count: 2, track_count: 11 }),
            ]);
            expect(await getAlbumSummaries(sql, [albumId], access)).toEqual([
                expect.objectContaining({
                    id: albumId,
                    artist_id: artistId,
                    track_count: 1,
                    total_duration: 60,
                }),
            ]);
            expect(await getArtistSummaries(sql, [artistId], access)).toEqual([
                expect.objectContaining({ id: artistId, album_count: 1, track_count: 1 }),
            ]);
            expect(await getAlbumSummaries(sql, [albumId], unrestrictedAccess())).toEqual([
                expect.objectContaining({ track_count: 10, total_duration: 600 }),
            ]);
            expect(await getAlbumSummaries(sql, [albumId], denyAllAccess())).toEqual([]);
            expect(await getArtistSummaries(sql, [artistId], denyAllAccess())).toEqual([]);
        });

        it('hides empty releases and counts only available tracks without multiplying file links', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 5,
            });
            const guest = createTestArtist({ title: 'Playable Guest' });
            await insertTestArtist(sql, guest);
            await sql`UPDATE media_items SET custom_metadata = ${sql.json({ additional_artist_ids: [guest.id] })}, runtime_seconds = 123, has_files = false WHERE id = ${trackIds[0]}`;
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${trackIds[1]}`;
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${trackIds[2]}`;
            await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${trackIds[3]}`;
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[4]})`;
            const noTracks = createTestAlbum(artistId, { title: 'No child rows' });
            await insertTestAlbum(sql, noTracks);
            const empty = createTestAlbum(artistId, { title: 'Removed pack' });
            await insertTestAlbum(sql, empty);
            const unavailable = createTestTrack(empty.id, 1, {
                custom_metadata: { additional_artist_ids: [guest.id] },
            });
            await insertTestTrack(sql, unavailable);
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${unavailable.id})`;
            const duplicateFile = randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${duplicateFile}, '/test/alternate.FLAC')`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${duplicateFile}, ${trackIds[0]}, false)`;

            for (const access of [
                unrestrictedAccess(),
                restrictedAccess({
                    deniedGroupIds: [randomUUID()],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            ]) {
                const albums = await getAlbums(sql, { access });
                expect(albums.map((a) => a.id)).toEqual([albumId]);
                expect(albums[0]).toMatchObject({ track_count: 1, total_duration: 123 });
                expect(await countAlbums(sql, { access })).toBe(1);
                expect(await getAlbums(sql, { access, limit: 1, offset: 1 })).toEqual([]);
                const artists = await getArtists(sql, { access });
                expect(artists.find((a) => a.id === artistId)).toMatchObject({
                    album_count: 1,
                    track_count: 1,
                });
                expect(artists.find((a) => a.id === guest.id)).toMatchObject({
                    album_count: 1,
                    track_count: 1,
                });
            }
            for (const id of [artistId, guest.id]) {
                const result = await getArtistWithAlbums(sql, id, unrestrictedAccess());
                expect(result?.albums.map((a) => a.id)).toEqual([albumId]);
                expect(result?.artist).toMatchObject({ album_count: 1, track_count: 1 });
                expect(await getArtistSummary(sql, id)).toMatchObject({
                    album_count: 1,
                    track_count: 1,
                });
                expect(
                    (
                        await getArtistTracks(sql, id, toUserId(randomUUID()), unrestrictedAccess())
                    ).map((t) => t.id),
                ).toEqual([trackIds[0]]);
            }
            const batch = await getTracksForAlbums(sql, [albumId, empty.id, noTracks.id]);
            expect([...batch.keys()]).toEqual([albumId]);
            expect(batch.get(albumId)?.map((t) => t.id)).toEqual([trackIds[0]]);
            expect(await getAlbumSummary(sql, empty.id)).toBeNull();
            expect(await getAlbumSummary(sql, noTracks.id)).toBeNull();
            expect(await getAlbumSummary(sql, albumId)).toMatchObject({
                track_count: 1,
                total_duration: 123,
            });
            // Retained albums still resolve for history links, listing only playable tracks.
            expect(await getAlbumWithTracks(sql, empty.id)).toMatchObject({
                album: { id: empty.id, track_count: 0 },
                tracks: [],
            });
            expect(await getAlbumWithTracks(sql, noTracks.id)).toMatchObject({
                album: { id: noTracks.id, track_count: 0 },
                tracks: [],
            });
            expect(await sql`SELECT id FROM media_items WHERE id = ${noTracks.id}`).toHaveLength(1);
            expect((await getAlbumWithTracks(sql, albumId))?.album).toMatchObject({
                track_count: 1,
                total_duration: 123,
            });
            expect(await sql`SELECT id FROM media_items WHERE id = ${empty.id}`).toHaveLength(1);
        });

        it('hides artists without playable tracks from unrestricted browse and its count', async () => {
            const { artistId: playable } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Still Playable',
                trackCount: 1,
            });
            const { artistId: gone, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Files Gone',
                trackCount: 2,
            });
            await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${trackIds}::uuid[])`;
            const access = unrestrictedAccess();
            const ids = (await getArtists(sql, { access, limit: 100 })).map((a) => a.id);
            expect(ids).toContain(playable);
            expect(ids).not.toContain(gone);
            expect(await countArtists(sql, { access })).toBe(ids.length);
        });

        it('uses an available alternate with explicit access when the default file is missing', async () => {
            const { albumId, artistId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            const alternate = randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${alternate}, '/test/surviving.flac')`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${alternate}, ${trackIds[0]}, false)`;
            expect((await getAlbumWithTracks(sql, albumId))?.tracks[0]?.file_path).toBe(
                `/test/music/${trackIds[0]}.mp3`,
            );
            expect(
                (
                    await getArtistTracks(
                        sql,
                        artistId,
                        toUserId(randomUUID()),
                        unrestrictedAccess(),
                    )
                )[0]?.file_path,
            ).toBe('/test/surviving.flac');
        });

        it('preserves an unscoped missing default instead of exposing a denied alternate', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            const deniedGroup = await createLibraryGroup(sql, {
                name: `Denied alternate ${randomUUID()}`,
            });
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            const alternate = randomUUID();
            await sql`INSERT INTO media_files (id, file_path, library_group_id) VALUES (${alternate}, '/test/denied-alternate.flac', ${deniedGroup.id})`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${alternate}, ${trackIds[0]}, false)`;
            expect((await getAlbumWithTracks(sql, albumId))?.tracks[0]?.file_path).toBe(
                `/test/music/${trackIds[0]}.mp3`,
            );
            const unscoped =
                await sql`SELECT mf.file_path FROM media_items t ${trackFilePathJoin(sql, 't')} WHERE t.id = ${trackIds[0]}`;
            expect(unscoped).toEqual([{ file_path: `/test/music/${trackIds[0]}.mp3` }]);
            const access = restrictedAccess({
                deniedGroupIds: [deniedGroup.id],
                maxAgeRating: null,
                allowUnrated: true,
            });
            expect(await getArtistTracks(sql, artistId, toUserId(randomUUID()), access)).toEqual(
                [],
            );
            expect((await getArtistWithAlbums(sql, artistId, access))?.albums).toEqual([]);
        });

        it('restores availability with the same album and track identities when a file returns', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            expect(await getAlbums(sql, { access: unrestrictedAccess() })).toEqual([]);
            expect(await getAlbumSummary(sql, albumId)).toBeNull();
            expect(await getTracksForAlbums(sql, [albumId])).toEqual(new Map());
            await sql`UPDATE media_files SET is_missing = false WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            expect(
                (await getAlbums(sql, { access: unrestrictedAccess() })).map((a) => a.id),
            ).toEqual([albumId]);
            expect(
                (
                    await getArtistTracks(
                        sql,
                        artistId,
                        toUserId(randomUUID()),
                        unrestrictedAccess(),
                    )
                ).map((t) => t.id),
            ).toEqual(trackIds);
            expect(
                (await getTracksForAlbums(sql, [albumId])).get(albumId)?.map((t) => t.id),
            ).toEqual(trackIds);
        });

        it('resolves an allowed alternate and excludes unavailable genre/credit matches', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
                genre: 'Rock',
            });
            const deniedGroup = await createLibraryGroup(sql, {
                name: `Denied ${randomUUID()}`,
            });
            const allowedGroup = await createLibraryGroup(sql, {
                name: `Allowed ${randomUUID()}`,
            });
            await sql`UPDATE media_files SET library_group_id = ${deniedGroup.id} WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            const alternate = randomUUID();
            await sql`INSERT INTO media_files (id, file_path, library_group_id) VALUES (${alternate}, '/test/allowed-alternate.mp3', ${allowedGroup.id})`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${alternate}, ${trackIds[0]}, false)`;
            const guest = createTestArtist({ title: 'Unavailable Credit' });
            await insertTestArtist(sql, guest);
            await sql`UPDATE media_items SET is_dismissed = true, custom_metadata = ${sql.json({ genre: 'Jazz', additional_artist_ids: [guest.id] })} WHERE id = ${trackIds[1]}`;
            const access = restrictedAccess({
                deniedGroupIds: [deniedGroup.id],
                maxAgeRating: null,
                allowUnrated: true,
            });
            const tracks = await getArtistTracks(sql, artistId, toUserId(randomUUID()), access);
            expect(tracks).toHaveLength(1);
            expect(tracks[0]?.file_path).toBe('/test/allowed-alternate.mp3');
            expect((await getArtistWithAlbums(sql, artistId, access))?.artist).toMatchObject({
                album_count: 1,
                track_count: 1,
            });
            expect(await getAlbums(sql, { access, artistId: guest.id })).toEqual([]);
            expect(await getAlbums(sql, { access, genre: 'Jazz' })).toEqual([]);
            expect(await getMusicByGenre(sql, 'Jazz', access)).toEqual([]);
            expect((await getMusicByGenre(sql, 'Rock', access)).map((a) => a.id)).toEqual([
                albumId,
            ]);
        });

        it('honors denyAll on either boundary axis in lists, counts and file resolution', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const boundaries: MediaAccessBoundary[] = [
                { library: { kind: 'denyAll' }, age: { kind: 'any' } },
                { library: { kind: 'all' }, age: { kind: 'denyAll' } },
            ];
            for (const access of boundaries) {
                expect(await getAlbums(sql, { access })).toEqual([]);
                expect(await countAlbums(sql, { access })).toBe(0);
                expect(
                    await getArtistTracks(sql, artistId, toUserId(randomUUID()), access),
                ).toEqual([]);
                expect((await getArtistWithAlbums(sql, artistId, access))?.artist).toMatchObject({
                    album_count: 0,
                    track_count: 0,
                });
                const paths =
                    await sql`SELECT mf.file_path FROM media_items t ${trackFilePathJoin(sql, 't', access)} WHERE t.media_type = 'track'`;
                expect(paths).toEqual([{ file_path: null }]);
            }
        });

        it('applies the age cap to both album and track, including unrated parents', async () => {
            const parentDenied = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const trackDenied = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const unratedParent = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${parentDenied.albumId}`;
            await sql`UPDATE media_items SET age_rating = 0 WHERE id = ${parentDenied.trackIds[0]}`;
            await sql`UPDATE media_items SET age_rating = 0 WHERE id = ${trackDenied.albumId}`;
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${trackDenied.trackIds[0]}`;
            await sql`UPDATE media_items SET age_rating = NULL WHERE id = ${unratedParent.albumId}`;
            await sql`UPDATE media_items SET age_rating = 0 WHERE id = ${unratedParent.trackIds[0]}`;
            for (const allowUnrated of [true, false]) {
                const access = restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated,
                });
                const expected = allowUnrated ? [unratedParent.albumId] : [];
                expect((await getAlbums(sql, { access })).map((a) => a.id)).toEqual(expected);
                expect(await countAlbums(sql, { access })).toBe(expected.length);
                for (const hierarchy of [parentDenied, trackDenied, unratedParent]) {
                    const count = hierarchy === unratedParent && allowUnrated ? 1 : 0;
                    expect(
                        (await getArtistWithAlbums(sql, hierarchy.artistId, access))?.artist,
                    ).toMatchObject({ album_count: count, track_count: count });
                    expect(
                        await getArtistTracks(
                            sql,
                            hierarchy.artistId,
                            toUserId(randomUUID()),
                            access,
                        ),
                    ).toHaveLength(count);
                }
            }
        });

        it('does not grant access from an allowed sidecar when its audio is denied', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            const deniedGroup = await createLibraryGroup(sql, {
                name: `Denied audio ${randomUUID()}`,
            });
            await sql`UPDATE media_files SET library_group_id = ${deniedGroup.id} WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            const sidecar = randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${sidecar}, '/test/allowed-cover.jpg')`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${sidecar}, ${trackIds[0]}, false)`;
            const access = restrictedAccess({
                deniedGroupIds: [deniedGroup.id],
                maxAgeRating: null,
                allowUnrated: true,
            });
            expect(await getAlbums(sql, { access })).toEqual([]);
            expect(await countAlbums(sql, { access })).toBe(0);
            expect((await getArtistWithAlbums(sql, artistId, access))?.albums).toEqual([]);
            expect(await getArtistTracks(sql, artistId, toUserId(randomUUID()), access)).toEqual(
                [],
            );
            expect(
                (await getAlbums(sql, { access: unrestrictedAccess() })).map((a) => a.id),
            ).toEqual([albumId]);
            await sql`DELETE FROM media_file_items WHERE file_id = ${sidecar}`;
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackIds[0]})`;
            expect(await getAlbumSummary(sql, albumId)).toBeNull();
        });

        it.each(['deleted', 'dismissed'])(
            'does not resurrect an unavailable %s parent through track credits',
            async (state) => {
                const { albumId, artistId, trackIds } = await createAndInsertTestMusicHierarchy(
                    sql,
                    { trackCount: 1 },
                );
                const guest = createTestArtist({ title: 'Hidden Parent Guest' });
                await insertTestArtist(sql, guest);
                await sql`UPDATE media_items SET custom_metadata = ${sql.json({ additional_artist_ids: [guest.id] })} WHERE id = ${trackIds[0]}`;
                if (state === 'deleted')
                    await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${albumId}`;
                else await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${albumId}`;
                expect(await getAlbums(sql, { access: unrestrictedAccess() })).toEqual([]);
                expect(await countAlbums(sql, { access: unrestrictedAccess() })).toBe(0);
                expect(await getTracksForAlbums(sql, [albumId])).toEqual(new Map());
                expect(await getAlbumWithTracks(sql, albumId)).toBeNull();
                expect(await getAlbumSummary(sql, albumId)).toBeNull();
                for (const id of [artistId, guest.id]) {
                    const result = await getArtistWithAlbums(sql, id, unrestrictedAccess());
                    expect(result?.albums).toEqual([]);
                    expect(result?.artist).toMatchObject({ album_count: 0, track_count: 0 });
                    expect(
                        await getArtistTracks(
                            sql,
                            id,
                            toUserId(randomUUID()),
                            unrestrictedAccess(),
                        ),
                    ).toEqual([]);
                }
            },
        );
    });

    // =========================================================================
    // getArtists
    // =========================================================================

    describe('getArtists', () => {
        it('returns artists with album counts', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Test Artist Alpha',
                trackCount: 2,
            });

            const artists = await getArtists(sql, { access: unrestrictedAccess() });
            const found = artists.find((a) => a.id === artistId);

            expect(found).toBeDefined();
            expect(found!.title).toBe('Test Artist Alpha');
            expect(found!.album_count).toBe(1);
        });

        // Regression: a credit-only artist reported album_count/track_count 0
        // while their own detail response listed tracks (reported from the iOS
        // client 2026-08-19: 171 of 200 artists came back 0/0; on the prod
        // library it was 2,481 of 2,822). The counts walked the album→artist
        // hierarchy only, so an artist who appears solely via a "feat." credit
        // on someone else's album owned nothing. getArtistTracks — which is
        // what the detail page actually lists — has always resolved the
        // hierarchy UNION additional_artist_ids.
        it('counts credited (feat.) tracks, so a credit-only artist is never 0/0', async () => {
            const { artistId: albumArtistId, albumId } = await createAndInsertTestMusicHierarchy(
                sql,
                { artistTitle: 'Album Artist', trackCount: 1 },
            );
            const guest = createTestArtist({ title: `Guest ${randomUUID().slice(0, 8)}` });
            await insertTestArtist(sql, guest);

            // Guest owns NOTHING in the hierarchy — reachable only by credit.
            await insertTestTrack(
                sql,
                createTestTrack(albumId, 2, {
                    title: 'Feature Track',
                    custom_metadata: { additional_artist_ids: [guest.id] },
                }),
            );

            const artists = await getArtists(sql, { access: unrestrictedAccess(), limit: 100 });

            const found = artists.find((a) => a.id === guest.id);
            expect(found).toBeDefined();
            expect(found!.track_count).toBe(1);
            expect(found!.album_count).toBe(1);

            // The album artist still counts its own tracks — including the
            // guest-credited one, which sits on its album. UNION de-dupes, so a
            // track that is both owned and credited is counted once.
            const albumArtist = artists.find((a) => a.id === albumArtistId);
            expect(albumArtist!.track_count).toBe(2);
            expect(albumArtist!.album_count).toBe(1);
        });

        it('supports pagination with limit and offset', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Artist A',
            });
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Artist B',
            });
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Artist C',
            });

            const page1 = await getArtists(sql, {
                access: unrestrictedAccess(),
                limit: 2,
                offset: 0,
            });
            expect(page1).toHaveLength(2);

            const page2 = await getArtists(sql, {
                access: unrestrictedAccess(),
                limit: 2,
                offset: 2,
            });
            expect(page2).toHaveLength(1);
        });

        it('sorts alphabetically when sort=alpha', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Zeta',
            });
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Alpha',
            });

            const artists = await getArtists(sql, { access: unrestrictedAccess(), sort: 'alpha' });
            expect(artists[0].title).toBe('Alpha');
            expect(artists[1].title).toBe('Zeta');
        });

        it('does not return albums or tracks as artists', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 3 });

            const artists = await getArtists(sql, { access: unrestrictedAccess() });
            // Only the top-level artist (parent_id IS NULL)
            expect(artists).toHaveLength(1);
        });

        it('excludeVariousArtists filters the flagged row only when opted in', async () => {
            const { artistId: va } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Various Artists',
            });
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va}`;
            const { artistId: ordinaryId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: `Darius ${randomUUID().slice(0, 8)}`,
            });
            const ordinary = { id: ordinaryId };

            const withVa = await getArtists(sql, { access: unrestrictedAccess(), limit: 100 });
            expect(withVa.some((a) => a.title === 'Various Artists')).toBe(true); // default keeps VA (compat)
            expect(withVa.some((a) => a.id === ordinary.id)).toBe(true);

            const withoutVa = await getArtists(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                excludeVariousArtists: true,
            });
            expect(withoutVa.some((a) => a.title === 'Various Artists')).toBe(false);
            expect(withoutVa.some((a) => a.id === ordinary.id)).toBe(true);
        });
    });

    // =========================================================================
    // getArtists — access boundary is honoured (differential)
    // =========================================================================
    //
    // Mirrors the contract in search-access-boundary.integration.test.ts:
    // getArtists takes a REQUIRED MediaAccessBoundary and gates each artist on
    // an EXISTS over its tracks' files. Types guarantee the argument arrives;
    // they cannot guarantee it is applied. So each run is checked three ways
    // against one fixture:
    //   1. unrestrictedAccess() — POSITIVE CONTROL, must be non-empty.
    //   2. a restricted boundary — must be a STRICT SUBSET of (1).
    //   3. denyAllAccess() — must be EMPTY.

    describe('getArtists — access boundary (differential)', () => {
        /** Boundary denying exactly the given library groups; age unrestricted. */
        function denyGroups(...ids: string[]): MediaAccessBoundary {
            return restrictedAccess({
                deniedGroupIds: ids,
                maxAgeRating: null,
                allowUnrated: true,
            });
        }

        /** Point a track's fixture-created media_files row at a library group. */
        async function moveTrackFileToGroup(
            trackId: string,
            libraryGroupId: string,
        ): Promise<void> {
            await sql`
                UPDATE media_files mf
                SET library_group_id = ${libraryGroupId}::uuid
                FROM media_file_items mfi
                WHERE mfi.file_id = mf.id
                  AND mfi.media_item_id = ${trackId}::uuid
            `;
        }

        it('restricted boundary is a strict subset; denyAll returns empty', async () => {
            const groupA = await createLibraryGroup(sql, { name: 'Artist Access Group A' });
            const groupB = await createLibraryGroup(sql, { name: 'Artist Access Group B' });

            // Artist A — sole track's file lives in group A.
            const artistA = createTestArtist({ title: 'Access Artist Alpha' });
            await insertTestArtist(sql, artistA);
            const albumA = createTestAlbum(artistA.id, { title: 'Album Alpha' });
            await insertTestAlbum(sql, albumA);
            const trackA = createTestTrack(albumA.id, 1, { title: 'Track Alpha' });
            await insertTestTrack(sql, trackA);
            await moveTrackFileToGroup(trackA.id, groupA.id);

            // Artist B — sole track's file lives in group B.
            const artistB = createTestArtist({ title: 'Access Artist Beta' });
            await insertTestArtist(sql, artistB);
            const albumB = createTestAlbum(artistB.id, { title: 'Album Beta' });
            await insertTestAlbum(sql, albumB);
            const trackB = createTestTrack(albumB.id, 1, { title: 'Track Beta' });
            await insertTestTrack(sql, trackB);
            await moveTrackFileToGroup(trackB.id, groupB.id);

            // (1) POSITIVE CONTROL — unrestricted sees both artists. A swallowed
            // error or a broken fixture would surface here as an empty set.
            const open = (await getArtists(sql, { access: unrestrictedAccess(), limit: 100 })).map(
                (a) => a.id,
            );
            const openSet = new Set(open);
            expect(openSet.has(artistA.id)).toBe(true);
            expect(openSet.has(artistB.id)).toBe(true);

            // (2) STRICT SUBSET — denying group A hides artist A, keeps artist B,
            // and introduces nothing new.
            const narrowed = (
                await getArtists(sql, { access: denyGroups(groupA.id), limit: 100 })
            ).map((a) => a.id);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(artistA.id);
            expect(narrowed).toContain(artistB.id);

            // (3) EMPTY — denyAll closes the boundary entirely.
            const denied = await getArtists(sql, { access: denyAllAccess(), limit: 100 });
            expect(denied).toEqual([]);
        });
    });

    // =========================================================================
    // Flat track browse — backs GET /music/tracks ("Songs" index row)
    // =========================================================================

    describe('getTracksPaged / countTracksPaged', () => {
        const USER = toUserId(randomUUID());

        it('lists tracks library-wide, alpha by default', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Browse Artist',
                trackCount: 3,
            });

            const rows = await getTracksPaged(sql, USER, 50, 0, unrestrictedAccess());
            expect(rows.length).toBe(3);
            const titles = rows.map((r) => r.title);
            expect([...titles].sort()).toEqual(titles);
        });

        it('pages without dropping or repeating a row', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 5 });

            const page1 = await getTracksPaged(sql, USER, 2, 0, unrestrictedAccess());
            const page2 = await getTracksPaged(sql, USER, 2, 2, unrestrictedAccess());
            const page3 = await getTracksPaged(sql, USER, 2, 4, unrestrictedAccess());

            const ids = [...page1, ...page2, ...page3].map((r) => r.id);
            expect(ids).toHaveLength(5);
            expect(new Set(ids).size).toBe(5);
        });

        it('sorts by display artist and album order with stable artist pagination', async () => {
            const artist = createTestArtist({ title: 'Bravo' });
            await insertTestArtist(sql, artist);
            const older = createTestAlbum(artist.id, { title: 'Zulu', year: 2000 });
            const newer = createTestAlbum(artist.id, { title: 'Alpha', year: 2020 });
            const sameYear = createTestAlbum(artist.id, { title: 'Beta', year: 2020 });
            for (const album of [newer, sameYear, older]) {
                await insertTestAlbum(sql, album);
            }

            const unknown = createTestTrack(older.id, 1, {
                title: 'Unknown performer',
                custom_metadata: {},
            });
            const tagged = createTestTrack(newer.id, 1, {
                title: 'Tagged performer',
                custom_metadata: { artist: 'Alpha' },
            });
            const first = createTestTrack(older.id, 1, {
                title: 'Zulu opening',
                custom_metadata: {},
            });
            const tied = [0, 1, 2].map(() =>
                createTestTrack(older.id, 2, {
                    title: 'Alpha tie',
                    custom_metadata: { artist: '' },
                }),
            );
            const laterTitle = createTestTrack(older.id, 2, {
                title: 'Zulu tie',
                custom_metadata: {},
            });
            const laterAlbum = createTestTrack(newer.id, 1, { custom_metadata: {} });
            const lastAlbum = createTestTrack(sameYear.id, 1, { custom_metadata: {} });
            const expected = [
                unknown,
                tagged,
                first,
                ...tied.sort((a, b) => a.id.localeCompare(b.id)),
                laterTitle,
                laterAlbum,
                lastAlbum,
            ];
            // Insert opposite to the expected order, including all-key ties.
            for (const track of [...expected].reverse()) {
                await insertTestTrack(sql, track);
            }
            await sql`UPDATE media_items SET parent_id = NULL WHERE id = ${unknown.id}`;

            const rows = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess(), {
                sort: 'artist',
            });
            const expectedIds = expected.map((track) => track.id);
            expect(rows.map((row) => row.id)).toEqual(expectedIds);
            expect(rows.map((row) => row.artist_title)).toEqual([
                null,
                'Alpha',
                ...Array<string>(7).fill('Bravo'),
            ]);

            const pagedIds: string[] = [];
            for (let offset = 0; offset < expected.length; offset += 2) {
                const page = await getTracksPaged(sql, USER, 2, offset, unrestrictedAccess(), {
                    sort: 'artist',
                });
                expect(page.map((row) => row.id)).toEqual(expectedIds.slice(offset, offset + 2));
                pagedIds.push(...page.map((row) => row.id));
            }
            expect(pagedIds).toEqual(expectedIds);
            expect(new Set(pagedIds).size).toBe(expected.length);
            expect(
                await getTracksPaged(sql, USER, 2, expected.length, unrestrictedAccess(), {
                    sort: 'artist',
                }),
            ).toEqual([]);
        });

        it('later pages return the same rows as the first-page query, every sort', async () => {
            // Past the first page the ids are chosen first and the columns joined
            // afterwards; the first page is a single SELECT. Stitching pages of
            // two must reproduce the one-page listing column for column.
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Paging A',
                trackCount: 4,
            });
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Paging B',
                trackCount: 3,
            });
            const strip = (rows: Awaited<ReturnType<typeof getTracksPaged>>) =>
                rows.map(({ hours_since_played: _now, ...rest }) => rest);

            for (const sort of [undefined, 'recent', 'artist'] as const) {
                const all = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess(), { sort });
                expect(all.length).toBeGreaterThanOrEqual(7);
                const stitched: Awaited<ReturnType<typeof getTracksPaged>> = [];
                for (let offset = 0; offset < all.length; offset += 2) {
                    stitched.push(
                        ...(await getTracksPaged(sql, USER, 2, offset, unrestrictedAccess(), {
                            sort,
                        })),
                    );
                }
                expect(strip(stitched), `sort=${sort ?? 'title'}`).toEqual(strip(all));
            }
        });

        it('filters by genre against the track own tags', async () => {
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Electronic', trackCount: 2 });
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Jazz', trackCount: 3 });

            const jazz = await getTracksPaged(sql, USER, 50, 0, unrestrictedAccess(), {
                genre: 'Jazz',
            });
            expect(jazz).toHaveLength(3);
            // Case-insensitive, like every other genre filter in this module.
            const jazzLower = await getTracksPaged(sql, USER, 50, 0, unrestrictedAccess(), {
                genre: 'jazz',
            });
            expect(jazzLower).toHaveLength(3);
        });

        // The whole point of accepting a UUID: name matching cannot see an
        // artist who only ever appears as a credit, which is the majority of
        // the production library.
        it('artist filter by UUID is credit-aware', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Owner Artist',
                trackCount: 1,
            });
            const guest = createTestArtist({ title: `Guest ${randomUUID().slice(0, 8)}` });
            await insertTestArtist(sql, guest);
            await insertTestTrack(
                sql,
                createTestTrack(albumId, 2, {
                    title: 'Credited Track',
                    custom_metadata: { additional_artist_ids: [guest.id] },
                }),
            );

            const byId = await getTracksPaged(sql, USER, 50, 0, unrestrictedAccess(), {
                artist: guest.id,
            });
            expect(byId).toHaveLength(1);
            expect(byId[0].title).toBe('Credited Track');

            // The guest owns no album, so a name lookup finds nothing — the
            // exact gap the UUID form exists to close.
            const byName = await getTracksPaged(sql, USER, 50, 0, unrestrictedAccess(), {
                artist: guest.title,
            });
            expect(byName).toHaveLength(0);
        });

        it('countTracksPaged agrees with the rows the same filters return', async () => {
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Electronic', trackCount: 4 });
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Jazz', trackCount: 2 });

            const all = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess());
            expect(await countTracksPaged(sql, unrestrictedAccess())).toBe(all.length);

            const electronic = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess(), {
                genre: 'Electronic',
            });
            expect(await countTracksPaged(sql, unrestrictedAccess(), { genre: 'Electronic' })).toBe(
                electronic.length,
            );

            // A total must describe the whole set, not the page in front of it.
            const firstPage = await getTracksPaged(sql, USER, 2, 0, unrestrictedAccess());
            expect(firstPage).toHaveLength(2);
            expect(await countTracksPaged(sql, unrestrictedAccess())).toBe(6);
        });

        it('returns nothing and counts zero when the boundary denies everything', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 3 });

            expect(await getTracksPaged(sql, USER, 50, 0, denyAllAccess())).toHaveLength(0);
            expect(await countTracksPaged(sql, denyAllAccess())).toBe(0);
        });
    });

    // =========================================================================
    // getAlbums artist filters — name (hierarchy) vs artistId (credit-aware)
    // =========================================================================

    describe('getAlbums artist filtering', () => {
        /**
         * Builds the exact shape reported from the iOS client: an artist with
         * NO album of their own, credited on a track of someone else's album.
         * On prod this is "21 Savage" credited on Katie Vale's "143".
         */
        async function creditedGuest(): Promise<{ guestId: string; guestTitle: string }> {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Owner Artist',
                albumTitle: 'Owner Album',
                trackCount: 1,
            });
            const guest = createTestArtist({ title: `Guest ${randomUUID().slice(0, 8)}` });
            await insertTestArtist(sql, guest);
            await insertTestTrack(
                sql,
                createTestTrack(albumId, 2, {
                    title: 'Featured Track',
                    custom_metadata: { additional_artist_ids: [guest.id] },
                }),
            );
            return { guestId: guest.id, guestTitle: guest.title };
        }

        // The reported bug: /music/artists says album_count 1, but
        // /music/albums?artist=<name> returns []. artistId closes the gap.
        it('artistId finds the album an artist is only credited on; artist name does not', async () => {
            const { guestId, guestTitle } = await creditedGuest();

            const byId = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                artistId: guestId,
            });
            expect(byId).toHaveLength(1);
            expect(byId[0].title).toBe('Owner Album');

            // Name matching still resolves only the hierarchy parent. That is
            // the documented contract, not a second bug — but it is exactly why
            // the client saw an empty grid.
            const byName = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                artist: guestTitle,
            });
            expect(byName).toHaveLength(0);
        });

        // The count and the filter must now agree — that agreement is the whole
        // point of the fix, and is what the client asserts against.
        it('artistId returns as many albums as MusicArtistRow.album_count reports', async () => {
            const { guestId } = await creditedGuest();

            const artists = await getArtists(sql, { access: unrestrictedAccess(), limit: 100 });
            const guestRow = artists.find((a) => a.id === guestId);
            const albums = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                artistId: guestId,
            });

            expect(guestRow!.album_count).toBe(albums.length);
        });

        it('artistId still finds albums the artist owns outright', async () => {
            const { artistId, albumId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Sole Owner',
                trackCount: 2,
            });

            const albums = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                artistId,
            });
            expect(albums.map((a) => a.id)).toEqual([albumId]);
        });

        it('does not bleed other artists albums into the result', async () => {
            const { guestId } = await creditedGuest();
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Unrelated',
                trackCount: 1,
            });

            const albums = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                artistId: guestId,
            });
            expect(albums).toHaveLength(1);
            expect(albums[0].title).toBe('Owner Album');
        });

        it('counts the same albums it lists', async () => {
            const { guestId } = await creditedGuest();
            const albums = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                artistId: guestId,
            });
            expect(
                await countAlbums(sql, { access: unrestrictedAccess(), artistId: guestId }),
            ).toBe(albums.length);
        });
    });

    // =========================================================================
    // getAlphaIndex — offsets must address the sort=alpha listing exactly
    // =========================================================================

    describe('getAlphaIndex', () => {
        const USER = toUserId(randomUUID());

        async function trackNamed(albumId: string, title: string): Promise<void> {
            await sql`
                INSERT INTO media_items (title, media_type, parent_id, has_files)
                VALUES (${title}, 'track', ${albumId}, true)
            `;
        }

        it('offsets point at the row the alpha listing actually has there', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            for (const t of ['Apple', 'Avocado', 'Banana', 'Cherry', '9 Lives']) {
                await trackNamed(albumId, t);
            }

            const buckets = await getAlphaIndex(sql, 'tracks', unrestrictedAccess());
            const listing = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess(), {
                sort: 'alpha',
            });

            expect(buckets.length).toBeGreaterThan(0);
            // The contract the rail depends on: seeking to a bucket's offset
            // lands on a row whose initial belongs to that bucket. Computing
            // offsets from cumulative counts instead of ROW_NUMBER() breaks
            // exactly here once collation reorders anything.
            for (const b of buckets) {
                const row = listing[b.offset];
                expect(row, `offset ${b.offset} for bucket ${b.key}`).toBeDefined();
                const initial = row.title.slice(0, 1).toUpperCase();
                const expected = /^[A-Z]$/.test(initial) ? initial : '#';
                expect(expected).toBe(b.key);
            }
        });

        it('bucket counts sum to the total listing size', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            for (const t of ['Alpha', 'Able', 'Bravo', '1st', 'Zulu']) {
                await trackNamed(albumId, t);
            }

            const buckets = await getAlphaIndex(sql, 'tracks', unrestrictedAccess());
            const total = await countTracksPaged(sql, unrestrictedAccess());
            expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(total);
        });

        /**
         * Attach file rows to `trackId`, the first one marked `is_default`.
         *
         * `media_file_items` is many-to-one onto a track (an album pressed on
         * two compilation CDs, or the same path scanned twice), and the browse
         * used to LEFT JOIN it straight — which duplicated the track in the
         * listing while the alpha-index, which has no such join, counted it
         * once. A schema trigger enforces exactly one `is_default` row per
         * item that has any, so the first path here has to claim it.
         */
        async function giveTrackFiles(trackId: string, paths: string[]): Promise<void> {
            for (const [i, path] of paths.entries()) {
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path) VALUES (${path}) RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                    VALUES (${file.id}, ${trackId}, ${i === 0}, ${i})
                `;
            }
        }

        async function trackIdNamed(title: string): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE title = ${title} AND media_type = 'track'
            `;
            return row.id;
        }

        // The tracks-specific half of the drift, and the one the artists-only
        // check missed: a track carrying two file rows appeared twice in the
        // browse but once in the index, so every offset after it was short by
        // one. On prod that was 358 tracks — the Songs rail landed most of a
        // letter early (bucket S → "Rock That City").
        it('offsets still address the listing when a track has two file rows', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            for (const t of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
                await trackNamed(albumId, t);
            }
            await giveTrackFiles(await trackIdNamed('Alpha'), [
                '/music/disc1/alpha.mp3',
                '/music/disc2/alpha.mp3',
            ]);

            const buckets = await getAlphaIndex(sql, 'tracks', unrestrictedAccess());
            const listing = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess(), {
                sort: 'alpha',
            });

            // One row per track, not one row per file.
            expect(listing.map((r) => r.title)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
            for (const b of buckets) {
                expect(listing[b.offset]?.title.slice(0, 1).toUpperCase()).toBe(b.key);
            }
        });

        it('total matches the listing when a track has two file rows', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            for (const t of ['Alpha', 'Bravo']) await trackNamed(albumId, t);
            await giveTrackFiles(await trackIdNamed('Alpha'), [
                '/music/disc1/alpha.mp3',
                '/music/disc2/alpha.mp3',
            ]);

            // countTracksPaged never had the file join, so it was already
            // right — it was the page that walked too many rows.
            const listing = await getTracksPaged(sql, USER, 100, 0, unrestrictedAccess(), {
                sort: 'alpha',
            });
            expect(listing).toHaveLength(await countTracksPaged(sql, unrestrictedAccess()));
        });

        it('reports the is_default file, not whichever row sorts first', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            await trackNamed(albumId, 'Alpha');
            // The non-default path sorts BEFORE the default one, so a
            // file_path-ordered pick would choose it and hand the Subsonic
            // stream handler the wrong file.
            await giveTrackFiles(await trackIdNamed('Alpha'), [
                '/music/disc1/alpha.mp3',
                '/music/aaa-alternate.flac',
            ]);

            const [row] = await getTracksPaged(sql, USER, 10, 0, unrestrictedAccess(), {
                sort: 'alpha',
            });
            expect(row.file_path).toBe('/music/disc1/alpha.mp3');
        });

        // The invariant the previous implementation broke. Summing counts to
        // the listing total could never catch it — COUNT(*) over every bucket
        // always sums to the total, whatever it counts. What has to hold is
        // the PER-bucket relation: the segment starting at one bucket's offset
        // must end exactly where the next one begins.
        it('each bucket count spans exactly to the next bucket offset', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            for (const t of [
                '9 Lives',
                'Atmozfears',
                'ÄTNA', // collates INSIDE the A run, not after Z
                'Atomic Kitten',
                'Banana',
                '[theatre]', // punctuation is variable-weight: sorts under T
                'Tundra',
            ]) {
                await trackNamed(albumId, t);
            }

            const buckets = await getAlphaIndex(sql, 'tracks', unrestrictedAccess());
            const total = await countTracksPaged(sql, unrestrictedAccess());

            for (let i = 0; i < buckets.length - 1; i++) {
                expect(
                    buckets[i].offset + buckets[i].count,
                    `bucket ${buckets[i].key} must end where ${buckets[i + 1].key} begins`,
                ).toBe(buckets[i + 1].offset);
            }
            const last = buckets[buckets.length - 1];
            expect(last.offset + last.count).toBe(total);
        });

        it('folds an accented initial into its base letter instead of minting a bucket', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            for (const t of ['Atmozfears', 'ÄTNA', 'Atomic Kitten', 'Banana']) {
                await trackNamed(albumId, t);
            }

            const buckets = await getAlphaIndex(sql, 'tracks', unrestrictedAccess());

            // `BETWEEN 'A' AND 'Z'` is collation-aware and lets 'Ä' through,
            // which used to split A's run around a key no A–Z rail can render.
            expect(buckets.map((b) => b.key)).toEqual(['A', 'B']);
            expect(buckets[0].count).toBe(3);
        });

        it("folds non-alphabetic initials into '#'", async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 0 });
            await trackNamed(albumId, '99 Red Balloons');
            await trackNamed(albumId, '!Attention');

            const buckets = await getAlphaIndex(sql, 'tracks', unrestrictedAccess());
            const hash = buckets.find((b) => b.key === '#');
            expect(hash).toBeDefined();
            expect(hash!.count).toBe(2);
        });

        it('honours the same filters as the browse call', async () => {
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Jazz', trackCount: 3 });
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Electronic', trackCount: 2 });

            const jazz = await getAlphaIndex(sql, 'tracks', unrestrictedAccess(), {
                genre: 'Jazz',
            });
            const jazzTotal = await countTracksPaged(sql, unrestrictedAccess(), { genre: 'Jazz' });
            expect(jazz.reduce((n, b) => n + b.count, 0)).toBe(jazzTotal);
        });

        it('indexes albums and artists too', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Zebra',
                albumTitle: 'Zoo',
                trackCount: 1,
            });
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Aardvark',
                albumTitle: 'Anthology',
                trackCount: 1,
            });

            const artists = await getAlphaIndex(sql, 'artists', unrestrictedAccess());
            expect(artists.map((b) => b.key)).toEqual(['A', 'Z']);
            expect(artists[0].offset).toBe(0);

            const albums = await getAlphaIndex(sql, 'albums', unrestrictedAccess());
            expect(albums.map((b) => b.key)).toEqual(['A', 'Z']);
        });

        it('returns nothing when the boundary denies everything', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 3 });
            expect(await getAlphaIndex(sql, 'tracks', denyAllAccess())).toHaveLength(0);
        });
    });

    // =========================================================================
    // countArtists / countAlbums — back page.total on the browse collections
    // =========================================================================

    describe('countArtists / countAlbums', () => {
        it('count the same set their paged counterparts return', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Count A',
                genre: 'Electronic',
            });
            await createAndInsertTestMusicHierarchy(sql, { artistTitle: 'Count B', genre: 'Jazz' });
            await createAndInsertTestMusicHierarchy(sql, { artistTitle: 'Count C', genre: 'Jazz' });

            const artists = await getArtists(sql, { access: unrestrictedAccess(), limit: 100 });
            expect(await countArtists(sql, { access: unrestrictedAccess() })).toBe(artists.length);

            const albums = await getAlbums(sql, { access: unrestrictedAccess(), limit: 100 });
            expect(await countAlbums(sql, { access: unrestrictedAccess() })).toBe(albums.length);

            // Filters must be honoured identically on both sides, or `total`
            // would describe a different set than the rows beside it.
            const jazzAlbums = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                genre: 'Jazz',
            });
            expect(await countAlbums(sql, { access: unrestrictedAccess(), genre: 'Jazz' })).toBe(
                jazzAlbums.length,
            );

            const jazzArtists = await getArtists(sql, {
                access: unrestrictedAccess(),
                limit: 100,
                genre: 'Jazz',
            });
            expect(await countArtists(sql, { access: unrestrictedAccess(), genre: 'Jazz' })).toBe(
                jazzArtists.length,
            );
        });

        it('countArtists honours excludeVariousArtists', async () => {
            const { artistId: va } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Various Artists',
            });
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va}`;
            await createAndInsertTestMusicHierarchy(sql, { artistTitle: 'Ordinary' });

            const withVa = await countArtists(sql, { access: unrestrictedAccess() });
            const withoutVa = await countArtists(sql, {
                access: unrestrictedAccess(),
                excludeVariousArtists: true,
            });
            expect(withVa - withoutVa).toBe(1);
        });

        it('count zero when the boundary denies everything', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
            expect(await countArtists(sql, { access: denyAllAccess() })).toBe(0);
            expect(await countAlbums(sql, { access: denyAllAccess() })).toBe(0);
        });
    });

    // =========================================================================
    // getArtistWithAlbums
    // =========================================================================

    describe('getArtistWithAlbums', () => {
        it('returns artist with their albums', async () => {
            const { artistId, albumId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Test Band',
                albumTitle: 'Debut Album',
            });

            const result = await getArtistWithAlbums(sql, artistId, unrestrictedAccess());
            expect(result).not.toBeNull();
            expect(result!.artist.title).toBe('Test Band');
            expect(result!.albums).toHaveLength(1);
            expect(result!.albums[0].id).toBe(albumId);
            expect(result!.albums[0].title).toBe('Debut Album');
        });

        it('returns null for non-existent artist', async () => {
            const result = await getArtistWithAlbums(
                sql,
                '00000000-0000-0000-0000-000000000000',
                unrestrictedAccess(),
            );
            expect(result).toBeNull();
        });

        // Regression (same root cause as the getArtists case above): the detail
        // response's own artist.album_count / artist.track_count were counted
        // from the hierarchy, so they read 0/0 for a credit-only artist even
        // though the `tracks` array in the SAME response was non-empty. The
        // header must never contradict the list underneath it.
        it('counts credited tracks so the header agrees with the tracks list', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Album Artist',
                trackCount: 1,
            });
            const guest = createTestArtist({ title: `Guest ${randomUUID().slice(0, 8)}` });
            await insertTestArtist(sql, guest);
            await insertTestTrack(
                sql,
                createTestTrack(albumId, 2, {
                    title: 'Feature Track',
                    custom_metadata: { additional_artist_ids: [guest.id] },
                }),
            );

            const result = await getArtistWithAlbums(sql, guest.id, unrestrictedAccess());
            expect(result).not.toBeNull();
            // Owns no album in the hierarchy, but IS credited on one via
            // additional_artist_ids — and `albums[]` is credit-aware for
            // exactly this reason (893e2b3a0): the Subsonic getArtist response
            // (subsonic-compat/handlers/browse.ts) serializes this same row's
            // `album_count` as `albumCount` right beside this same `albums[]`
            // array in one payload, so a real client rendered "1 release"
            // over a literally empty album list before that fix. The header
            // count and the list it sits above must describe the same set.
            expect(result!.albums).toHaveLength(1);
            expect(result!.albums[0]?.id).toBe(albumId);
            // …and the counts still describe that same track/album set.
            expect(result!.artist.track_count).toBe(1);
            expect(result!.artist.album_count).toBe(1);
        });

        it('sorts albums by year ascending', async () => {
            const artist = createTestArtist({ title: 'Multi-Album Artist' });
            await insertTestArtist(sql, artist);

            const album1 = createTestAlbum(artist.id, {
                title: 'Early Work',
                year: 2020,
            });
            const album2 = createTestAlbum(artist.id, {
                title: 'Later Work',
                year: 2024,
            });
            await insertTestAlbum(sql, album1);
            await insertTestAlbum(sql, album2);
            await insertTestTrack(sql, createTestTrack(album1.id, 1));
            await insertTestTrack(sql, createTestTrack(album2.id, 1));

            const result = await getArtistWithAlbums(sql, artist.id, unrestrictedAccess());
            expect(result!.albums[0].title).toBe('Early Work');
            expect(result!.albums[1].title).toBe('Later Work');
        });

        it('surfaces is_various_artists=true on the artist row when flagged, with albums intact', async () => {
            const [vaRow] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, is_various_artists)
                VALUES ('Various Artists', 'artist', true)
                RETURNING id
            `;
            const album = createTestAlbum(vaRow.id, { title: 'Compilation One', year: 2022 });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, { title: 'Various Track' });
            await insertTestTrack(sql, track);

            const result = await getArtistWithAlbums(sql, vaRow.id, unrestrictedAccess());
            expect(result).not.toBeNull();
            expect(result!.artist.is_various_artists).toBe(true);
            expect(result!.albums).toHaveLength(1);
            expect(result!.albums[0].title).toBe('Compilation One');
        });

        it('surfaces is_various_artists=false on an ordinary artist row', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Ordinary Artist',
            });

            const result = await getArtistWithAlbums(sql, artistId, unrestrictedAccess());
            expect(result!.artist.is_various_artists).toBe(false);
        });
    });

    // =========================================================================
    // getAlbums
    // =========================================================================

    describe('getAlbums', () => {
        it('returns albums with artist info and track counts', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Cool Band',
                albumTitle: 'Great Album',
                trackCount: 4,
            });

            const albums = await getAlbums(sql, { access: unrestrictedAccess() });
            const found = albums.find((a) => a.id === albumId);

            expect(found).toBeDefined();
            expect(found!.title).toBe('Great Album');
            expect(found!.artist_title).toBe('Cool Band');
            expect(found!.track_count).toBe(4);
        });

        it('supports genre filter', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                genre: 'Electronic',
            });
            await createAndInsertTestMusicHierarchy(sql, { genre: 'Jazz' });

            const electronic = await getAlbums(sql, {
                access: unrestrictedAccess(),
                genre: 'Electronic',
            });
            const jazz = await getAlbums(sql, { access: unrestrictedAccess(), genre: 'Jazz' });

            expect(electronic).toHaveLength(1);
            expect(jazz).toHaveLength(1);
        });

        it('supports pagination', async () => {
            for (let i = 0; i < 5; i++) {
                await createAndInsertTestMusicHierarchy(sql);
            }

            const page = await getAlbums(sql, {
                access: unrestrictedAccess(),
                limit: 3,
                offset: 0,
            });
            expect(page).toHaveLength(3);
        });
    });

    // =========================================================================
    // getAlbums — access boundary is honoured (differential)
    // =========================================================================
    //
    // Mirrors the contract in search-access-boundary.integration.test.ts:
    // getAlbums takes a REQUIRED MediaAccessBoundary and gates each album on an
    // EXISTS over its tracks' audio files. Types guarantee the argument arrives;
    // they cannot guarantee it is applied. So each run is checked three ways
    // against one fixture:
    //   1. unrestrictedAccess() — POSITIVE CONTROL, must be non-empty.
    //   2. a restricted boundary — must be a STRICT SUBSET of (1).
    //   3. denyAllAccess() — must be EMPTY.

    describe('getAlbums — access boundary (differential)', () => {
        /** Boundary denying exactly the given library groups; age unrestricted. */
        function denyGroups(...ids: string[]): MediaAccessBoundary {
            return restrictedAccess({
                deniedGroupIds: ids,
                maxAgeRating: null,
                allowUnrated: true,
            });
        }

        /** Point a track's fixture-created media_files row at a library group. */
        async function moveTrackFileToGroup(
            trackId: string,
            libraryGroupId: string,
        ): Promise<void> {
            await sql`
                UPDATE media_files mf
                SET library_group_id = ${libraryGroupId}::uuid
                FROM media_file_items mfi
                WHERE mfi.file_id = mf.id
                  AND mfi.media_item_id = ${trackId}::uuid
            `;
        }

        it('restricted boundary is a strict subset; denyAll returns empty', async () => {
            const groupA = await createLibraryGroup(sql, { name: 'Album Access Group A' });
            const groupB = await createLibraryGroup(sql, { name: 'Album Access Group B' });

            // Album A — sole track's audio file lives in group A.
            const artistA = createTestArtist({ title: 'Album Access Artist Alpha' });
            await insertTestArtist(sql, artistA);
            const albumA = createTestAlbum(artistA.id, { title: 'Access Album Alpha' });
            await insertTestAlbum(sql, albumA);
            const trackA = createTestTrack(albumA.id, 1, { title: 'Album Track Alpha' });
            await insertTestTrack(sql, trackA);
            await moveTrackFileToGroup(trackA.id, groupA.id);

            // Album B — sole track's audio file lives in group B.
            const artistB = createTestArtist({ title: 'Album Access Artist Beta' });
            await insertTestArtist(sql, artistB);
            const albumB = createTestAlbum(artistB.id, { title: 'Access Album Beta' });
            await insertTestAlbum(sql, albumB);
            const trackB = createTestTrack(albumB.id, 1, { title: 'Album Track Beta' });
            await insertTestTrack(sql, trackB);
            await moveTrackFileToGroup(trackB.id, groupB.id);

            // (1) POSITIVE CONTROL — unrestricted sees both albums. A swallowed
            // error or a broken fixture would surface here as an empty set.
            const open = (await getAlbums(sql, { access: unrestrictedAccess(), limit: 100 })).map(
                (a) => a.id,
            );
            const openSet = new Set(open);
            expect(openSet.has(albumA.id)).toBe(true);
            expect(openSet.has(albumB.id)).toBe(true);

            // (2) STRICT SUBSET — denying group A hides album A, keeps album B,
            // and introduces nothing new.
            const narrowed = (
                await getAlbums(sql, { access: denyGroups(groupA.id), limit: 100 })
            ).map((a) => a.id);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(albumA.id);
            expect(narrowed).toContain(albumB.id);

            // (3) EMPTY — denyAll closes the boundary entirely.
            const denied = await getAlbums(sql, { access: denyAllAccess(), limit: 100 });
            expect(denied).toEqual([]);
        });
    });

    // =========================================================================
    // getAlbumWithTracks
    // =========================================================================

    describe('getAlbumWithTracks', () => {
        it('returns album with ordered tracks', async () => {
            const { albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 3,
            });

            const result = await getAlbumWithTracks(sql, albumId);
            expect(result).not.toBeNull();
            expect(result!.tracks).toHaveLength(3);
            expect(result!.tracks[0].id).toBe(trackIds[0]);
            expect(result!.tracks[0].sort_order).toBe(1);
            expect(result!.tracks[2].sort_order).toBe(3);
        });

        it('returns null for non-existent album', async () => {
            const result = await getAlbumWithTracks(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('tracks are ordered by sort_order', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);

            // Insert tracks in reverse order
            const track3 = createTestTrack(album.id, 3, {
                title: 'Track C',
            });
            const track1 = createTestTrack(album.id, 1, {
                title: 'Track A',
            });
            const track2 = createTestTrack(album.id, 2, {
                title: 'Track B',
            });
            await insertTestTrack(sql, track3);
            await insertTestTrack(sql, track1);
            await insertTestTrack(sql, track2);

            const result = await getAlbumWithTracks(sql, album.id);
            expect(result!.tracks[0].title).toBe('Track A');
            expect(result!.tracks[1].title).toBe('Track B');
            expect(result!.tracks[2].title).toBe('Track C');
        });

        // A non-numeric `disc_number` is not hypothetical: `custom_metadata` is a
        // freeform jsonb column and `PUT /api/admin/media/bulk-metadata` merges an
        // arbitrary admin-supplied object into it verbatim (up to 100 keys, no
        // per-key schema, by design). An admin pasting the raw ID3 combined form
        // "1/2" is enough. Before the `jsonb_typeof(...) = 'number'` guard, the bare
        // `(custom_metadata->>'disc_number')::int` in this ORDER BY raised
        // `invalid input syntax for type integer` for the WHOLE statement, so one
        // such row 500s the entire album page rather than sorting oddly on its own.
        it('survives a non-numeric disc_number instead of failing the whole album', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);

            // Disc 1 tagged as a proper JSON number, disc 2 likewise, plus one
            // track an admin poisoned with the raw combined tag.
            const d1t1 = createTestTrack(album.id, 1, {
                title: 'Disc One Track One',
                custom_metadata: { disc_number: 1 },
            });
            const d2t1 = createTestTrack(album.id, 1, {
                title: 'Disc Two Track One',
                custom_metadata: { disc_number: 2 },
            });
            const poisoned = createTestTrack(album.id, 2, {
                title: 'Poisoned Disc Tag',
                custom_metadata: { disc_number: '1/2' },
            });
            const untagged = createTestTrack(album.id, 3, {
                title: 'Untagged Disc',
                custom_metadata: {},
            });
            await insertTestTrack(sql, d2t1);
            await insertTestTrack(sql, poisoned);
            await insertTestTrack(sql, d1t1);
            await insertTestTrack(sql, untagged);

            const result = await getAlbumWithTracks(sql, album.id);

            expect(result).not.toBeNull();
            expect(result!.tracks).toHaveLength(4);

            // Sane order, not merely "did not throw": the guard yields NULL for the
            // string, and the enclosing COALESCE(..., 1) sorts it WITH disc 1 rather
            // than exiling it past the last disc — same as an untagged track. Disc 1
            // (sort_order 1, 2, 3) therefore precedes disc 2 (sort_order 1).
            expect(result!.tracks.map((t) => t.title)).toEqual([
                'Disc One Track One',
                'Poisoned Disc Tag',
                'Untagged Disc',
                'Disc Two Track One',
            ]);
        });

        it('includes track custom_metadata with audio features', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });

            const result = await getAlbumWithTracks(sql, albumId);
            const track = result!.tracks[0];
            const meta =
                typeof track.custom_metadata === 'string'
                    ? (JSON.parse(track.custom_metadata) as Record<string, unknown>)
                    : track.custom_metadata;

            expect(meta).toHaveProperty('essentia');
            expect(meta.essentia).toHaveProperty('bpm');
            expect(meta.essentia).toHaveProperty('key');
            expect(meta.essentia).toHaveProperty('energy');
        });
    });

    // =========================================================================
    // getTracksForAlbums
    // =========================================================================

    describe('getTracksForAlbums', () => {
        // Second of the two disc_number ORDER BY sites in this module. Same
        // hazard, same guard — see the getAlbumWithTracks case above for why a
        // string can reach this key at all.
        it('survives a non-numeric disc_number instead of failing every album', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);

            const d1t1 = createTestTrack(album.id, 1, {
                title: 'Disc One Track One',
                custom_metadata: { disc_number: 1 },
            });
            const d2t1 = createTestTrack(album.id, 1, {
                title: 'Disc Two Track One',
                custom_metadata: { disc_number: 2 },
            });
            const poisoned = createTestTrack(album.id, 2, {
                title: 'Poisoned Disc Tag',
                custom_metadata: { disc_number: '1/2' },
            });
            await insertTestTrack(sql, d2t1);
            await insertTestTrack(sql, poisoned);
            await insertTestTrack(sql, d1t1);

            const byAlbum = await getTracksForAlbums(sql, [album.id]);

            const tracks = byAlbum.get(album.id);
            expect(tracks).toBeDefined();
            expect(tracks!.map((t) => t.title)).toEqual([
                'Disc One Track One',
                'Poisoned Disc Tag',
                'Disc Two Track One',
            ]);
        });
    });

    // =========================================================================
    // getTrackDetail
    // =========================================================================

    describe('getTrackDetail', () => {
        it('returns full track detail with album and artist info', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                artistTitle: 'Detail Artist',
                albumTitle: 'Detail Album',
                trackCount: 1,
            });

            const detail = await getTrackDetail(sql, trackIds[0]);
            expect(detail).not.toBeNull();
            expect(detail!.album_id).toBe(albumId);
            expect(detail!.album_title).toBe('Detail Album');
            expect(detail!.artist_id).toBe(artistId);
            expect(detail!.artist_title).toBe('Detail Artist');
        });

        it('returns null for non-existent track', async () => {
            const result = await getTrackDetail(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('includes custom_metadata with audio features', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });

            const detail = await getTrackDetail(sql, trackIds[0]);
            const meta =
                typeof detail!.custom_metadata === 'string'
                    ? (JSON.parse(detail!.custom_metadata) as Record<string, unknown>)
                    : detail!.custom_metadata;
            expect(meta).toHaveProperty('essentia');
            expect(meta.essentia).toHaveProperty('bpm');
            expect(meta.essentia).toHaveProperty('key');
        });
    });

    // =========================================================================
    // getTrackStreamSource
    // =========================================================================

    describe('getTrackStreamSource', () => {
        it('returns the selected file path and its duration', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });

            const detail = await getTrackDetail(sql, trackIds[0]);
            await sql`UPDATE media_files SET duration_seconds = 600.125
                      WHERE file_path = ${detail!.file_path}`;
            const source = await getTrackStreamSource(sql, trackIds[0]);

            expect(source).toEqual({
                id: trackIds[0],
                file_path: detail!.file_path,
                duration_seconds: 600.125,
            });
            expect(source!.file_path).toBeTruthy();
        });

        it('returns null for a non-existent id and for a non-track row', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });

            expect(
                await getTrackStreamSource(sql, '00000000-0000-0000-0000-000000000000'),
            ).toBeNull();
            expect(await getTrackStreamSource(sql, albumId)).toBeNull();
        });
    });

    // =========================================================================
    // getMusicByGenre
    // =========================================================================

    describe('getMusicByGenre', () => {
        it('returns albums matching genre', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                genre: 'Electronic',
            });
            await createAndInsertTestMusicHierarchy(sql, {
                genre: 'Jazz',
            });

            const results = await getMusicByGenre(sql, 'Electronic', unrestrictedAccess());
            expect(results).toHaveLength(1);

            const jazz = await getMusicByGenre(sql, 'Jazz', unrestrictedAccess());
            expect(jazz).toHaveLength(1);
        });

        it('is case-insensitive', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                genre: 'Electronic',
            });

            const results = await getMusicByGenre(sql, 'electronic', unrestrictedAccess());
            expect(results).toHaveLength(1);
        });

        it('returns empty array for non-matching genre', async () => {
            await createAndInsertTestMusicHierarchy(sql, {
                genre: 'Electronic',
            });

            const results = await getMusicByGenre(sql, 'Country', unrestrictedAccess());
            expect(results).toHaveLength(0);
        });
    });

    // =========================================================================
    // getTracksByGenre — access boundary is honoured (differential)
    // =========================================================================
    //
    // Mirrors the contract in search-access-boundary.integration.test.ts:
    // getTracksByGenre takes a REQUIRED MediaAccessBoundary and gates each track
    // on its file's library group (and, on the age axis, the track's age_rating).
    // Types guarantee the argument arrives; they cannot guarantee it is applied,
    // that it targets the right table alias, or that it lands in the outer WHERE.
    // So each run is checked three ways against one fixture:
    //   1. unrestrictedAccess() — POSITIVE CONTROL, must be non-empty.
    //   2. a restricted boundary — must be a STRICT SUBSET of (1).
    //   3. denyAllAccess() — must be EMPTY.

    describe('getTracksByGenre — access boundary (differential)', () => {
        // A genre string unique enough that no other fixture collides with it.
        const GENRE = 'Zylvorakcore';

        /** Boundary denying exactly the given library groups; age unrestricted. */
        function denyGroups(...ids: string[]): MediaAccessBoundary {
            return restrictedAccess({
                deniedGroupIds: ids,
                maxAgeRating: null,
                allowUnrated: true,
            });
        }

        /** Point a track's fixture-created media_files row at a library group. */
        async function moveTrackFileToGroup(
            trackId: string,
            libraryGroupId: string,
        ): Promise<void> {
            await sql`
                UPDATE media_files mf
                SET library_group_id = ${libraryGroupId}::uuid
                FROM media_file_items mfi
                WHERE mfi.file_id = mf.id
                  AND mfi.media_item_id = ${trackId}::uuid
            `;
        }

        it('restricted boundary is a strict subset; denyAll returns empty', async () => {
            const groupA = await createLibraryGroup(sql, { name: 'Genre Access Group A' });
            const groupB = await createLibraryGroup(sql, { name: 'Genre Access Group B' });

            const artist = createTestArtist({ title: 'Genre Access Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, { title: 'Genre Access Album' });
            await insertTestAlbum(sql, album);

            // Two tracks tagged with the SAME genre; their files sit in
            // different library groups so the library predicate can split them.
            const trackA = createTestTrack(album.id, 1, {
                title: 'Genre Track Alpha',
                custom_metadata: { genre: GENRE },
            });
            await insertTestTrack(sql, trackA);
            await moveTrackFileToGroup(trackA.id, groupA.id);

            const trackB = createTestTrack(album.id, 2, {
                title: 'Genre Track Beta',
                custom_metadata: { genre: GENRE },
            });
            await insertTestTrack(sql, trackB);
            await moveTrackFileToGroup(trackB.id, groupB.id);

            // (1) POSITIVE CONTROL — unrestricted sees both tracks. A swallowed
            // error or a broken fixture would surface here as an empty set.
            const open = (await getTracksByGenre(sql, GENRE, unrestrictedAccess())).map(
                (t) => t.id,
            );
            const openSet = new Set(open);
            expect(openSet.has(trackA.id)).toBe(true);
            expect(openSet.has(trackB.id)).toBe(true);

            // (2) STRICT SUBSET — denying group A hides track A, keeps track B,
            // and introduces nothing new.
            const narrowed = (await getTracksByGenre(sql, GENRE, denyGroups(groupA.id))).map(
                (t) => t.id,
            );
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(trackA.id);
            expect(narrowed).toContain(trackB.id);

            // (3) EMPTY — denyAll closes the boundary entirely.
            const denied = await getTracksByGenre(sql, GENRE, denyAllAccess());
            expect(denied).toEqual([]);
        });
    });

    // =========================================================================
    // Parent-child hierarchy integrity
    // =========================================================================

    describe('hierarchy integrity', () => {
        it('maintains artist → album → track chain', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });

            // Verify artist exists with no parent
            const artists = await getArtists(sql, { access: unrestrictedAccess() });
            const artist = artists.find((a) => a.id === artistId);
            expect(artist).toBeDefined();

            // Verify album has artist as parent
            const albumResult = await getAlbumWithTracks(sql, albumId);
            expect(albumResult!.album.artist_id).toBe(artistId);

            // Verify tracks have album as parent
            for (const trackId of trackIds) {
                const detail = await getTrackDetail(sql, trackId);
                expect(detail!.parent_id).toBe(albumId);
                expect(detail!.album_id).toBe(albumId);
                expect(detail!.artist_id).toBe(artistId);
            }
        });
    });

    // =========================================================================
    // getRecentlyPlayedVariants
    // =========================================================================

    describe('getRecentlyPlayedVariants', () => {
        const USER = toUserId(randomUUID());

        beforeEach(async () => {
            await sql`
                INSERT INTO users (id, username)
                VALUES (${USER}::uuid, ${derivedUsername(USER)})
                ON CONFLICT (id) DO NOTHING
            `;
            await sql`DELETE FROM user_music_state WHERE user_id = ${USER}::uuid`;
        });

        async function seedTrack(
            artistTitle: string,
            albumTitle: string,
            trackTitle: string,
        ): Promise<string> {
            const artist = createTestArtist({ title: artistTitle });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, { title: albumTitle });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, { title: trackTitle });
            await insertTestTrack(sql, track);
            return track.id;
        }

        it('returns normalised stems for tracks played inside the window', async () => {
            const hereIGo = await seedTrack(
                'Cool Artist',
                'Cool Album',
                'Here I Go (DJ Lht Remix Edit)',
            );
            const other = await seedTrack('Cool Artist 2', 'Cool Album 2', 'Some Other Song');

            // Played 1 hour ago (inside a 24h window)
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at)
                VALUES (${USER}::uuid, ${hereIGo}::uuid, 1, NOW() - INTERVAL '1 hour')
            `;
            // Played 48 hours ago (outside a 24h window)
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at)
                VALUES (${USER}::uuid, ${other}::uuid, 1, NOW() - INTERVAL '48 hours')
            `;

            const stems = await getRecentlyPlayedVariants(sql, USER, 24);

            expect(stems).toContain('here i go');
            expect(stems).not.toContain('some other song');
        });

        it('returns [] when cooldownHours is 0 without issuing a query', async () => {
            const stems = await getRecentlyPlayedVariants(sql, USER, 0);
            expect(stems).toEqual([]);
        });

        it('returns empty set for a user with no state rows', async () => {
            const stems = await getRecentlyPlayedVariants(sql, USER, 24);
            expect(stems).toEqual([]);
        });

        it('deduplicates equal stems from different variants', async () => {
            const t1 = await seedTrack(
                'Variant Artist',
                'Variant Album',
                'Here I Go (DJ Lht Remix Edit)',
            );
            const t2 = await seedTrack(
                'Variant Artist 2',
                'Variant Album 2',
                'Here I Go (Radio Edit)',
            );

            for (const id of [t1, t2]) {
                await sql`
                    INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at)
                    VALUES (${USER}::uuid, ${id}::uuid, 1, NOW() - INTERVAL '1 hour')
                `;
            }

            const stems = await getRecentlyPlayedVariants(sql, USER, 24);
            expect(stems).toEqual(['here i go']);
        });
    });

    // =========================================================================
    // getSmartQueueCandidates — skipped title matching
    // =========================================================================

    describe('getSmartQueueCandidates — skipped title matching', () => {
        const USER = toUserId(randomUUID());

        beforeEach(async () => {
            await sql`
                INSERT INTO users (id, username)
                VALUES (${USER}::uuid, ${derivedUsername(USER)})
                ON CONFLICT (id) DO NOTHING
            `;
        });

        it('uses the newest skipped IDs in title match when array exceeds 20', async () => {
            // Seed one current + 21 unrelated filler + the "Here I Go" played
            // variant (pushed to the END of the skipped array = "newest").
            // With oldest-first slice(0,20) it gets dropped. With slice(-20)
            // it's retained and therefore filters out any other "Here I Go"
            // variant from results via remix title matching.
            const artist = createTestArtist({ title: 'Skip Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, { title: 'Skip Album' });
            await insertTestAlbum(sql, album);

            const currentTrack = createTestTrack(album.id, 1, {
                title: 'Current Track',
            });
            await insertTestTrack(sql, currentTrack);

            // 21 unrelated skipped tracks — oldest first in the array
            const filler: string[] = [];
            for (let i = 0; i < 21; i++) {
                const t = createTestTrack(album.id, i + 2, {
                    title: `Filler ${i}`,
                });
                await insertTestTrack(sql, t);
                filler.push(t.id);
            }

            // The newest skip: "Here I Go (DJ Lht Remix Edit)"
            const hereIGoPlayed = createTestTrack(album.id, 23, {
                title: 'Here I Go (DJ Lht Remix Edit)',
            });
            await insertTestTrack(sql, hereIGoPlayed);

            // Candidate variant that should be filtered via remix matching
            const hereIGoVariant = createTestTrack(album.id, 24, {
                title: 'Here I Go (Radio Edit)',
            });
            await insertTestTrack(sql, hereIGoVariant);

            // Embeddings must exist for the candidate to surface
            // NOT an all-zero vector: cosine distance to zero is NaN and the
            // idx_me_music_hnsw index scan then returns none of these rows.
            // Every fixture shares this one vector, so all distances are 0.
            const vectorString = musicFixtureEmbeddingLiteral();
            for (const id of [currentTrack.id, hereIGoVariant.id]) {
                await sql`
                    INSERT INTO media_embeddings (media_id, source, embedding)
                    VALUES (${id}::uuid, 'music', ${vectorString}::vector)
                `;
            }

            const results = await getSmartQueueCandidates(sql, currentTrack.id, [], 50, {
                skippedTrackIds: [...filler, hereIGoPlayed.id],
                userId: USER,
            });

            const titles = results.map((r) => r.title);
            expect(titles).not.toContain('Here I Go (Radio Edit)');
        });
    });

    // =========================================================================
    // getRecentlyPlayed — hours_since_played projection
    // =========================================================================

    describe('getRecentlyPlayed', () => {
        const USER = toUserId(randomUUID());

        beforeEach(async () => {
            await sql`
                INSERT INTO users (id, username)
                VALUES (${USER}::uuid, ${derivedUsername(USER)})
                ON CONFLICT (id) DO NOTHING
            `;
            await sql`
                INSERT INTO user_profiles (user_id)
                VALUES (${USER}::uuid)
                ON CONFLICT (user_id) DO NOTHING
            `;
        });

        async function seedPlayedTrack(hoursAgo: number): Promise<string> {
            const artist = createTestArtist({ title: 'RP Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, { title: 'RP Album' });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, { title: 'RP Track' });
            await insertTestTrack(sql, track);

            // getRecentlyPlayed reads from user_music_state (the derived
            // music watch-state table), not watch_history. Seed both: the
            // watch_history row keeps any other observer happy, and the
            // user_music_state row is what the query actually returns.
            await sql`
                INSERT INTO watch_history (
                    user_id, media_type, source_service, title,
                    session_start_time, session_end_time,
                    actual_watch_time_seconds, media_id,
                    created_at
                ) VALUES (
                    ${USER}::uuid, 'track', 'lumastra', 'RP Track',
                    NOW() - make_interval(hours => ${hoursAgo}),
                    NOW() - make_interval(hours => ${hoursAgo}) + INTERVAL '3 minutes',
                    180,
                    ${track.id}::uuid,
                    NOW() - make_interval(hours => ${hoursAgo})
                )
            `;
            await sql`
                INSERT INTO user_music_state (
                    user_id, track_id, play_count, complete_count,
                    total_listen_ms, last_played_at, first_played_at
                ) VALUES (
                    ${USER}::uuid, ${track.id}::uuid, 1, 1, 180000,
                    NOW() - make_interval(hours => ${hoursAgo}),
                    NOW() - make_interval(hours => ${hoursAgo})
                )
                ON CONFLICT (user_id, track_id) DO UPDATE SET
                    last_played_at = EXCLUDED.last_played_at,
                    play_count = user_music_state.play_count + 1
            `;

            return track.id;
        }

        it('projects hours_since_played alongside last_played_at', async () => {
            await seedPlayedTrack(2);

            const rows = await getRecentlyPlayed(sql, USER, 10);
            expect(rows.length).toBeGreaterThan(0);
            expectHoursSincePlayedShape(rows);
        });

        it('returns hours_since_played ≈ 2 for a 2h-old play', async () => {
            await seedPlayedTrack(2);

            const rows = await getRecentlyPlayed(sql, USER, 10);
            expect(rows.length).toBeGreaterThan(0);
            const row = rows[0];
            expect(row.hours_since_played).not.toBeNull();
            expect(row.hours_since_played).toBeGreaterThan(1.95);
            expect(row.hours_since_played).toBeLessThan(2.05);
        });
    });

    // =========================================================================
    // getSmartQueueCandidates — persistentPlayedTitles
    // =========================================================================

    describe('getSmartQueueCandidates — persistentPlayedTitles', () => {
        const USER = toUserId(randomUUID());

        beforeEach(async () => {
            await sql`
                INSERT INTO users (id, username)
                VALUES (${USER}::uuid, ${derivedUsername(USER)})
                ON CONFLICT (id) DO NOTHING
            `;
        });

        it('excludes candidates whose title matches a persistent stem', async () => {
            const artist = createTestArtist({ title: 'Persist Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Persist Album',
            });
            await insertTestAlbum(sql, album);

            const current = createTestTrack(album.id, 1, {
                title: 'Current Track',
            });
            await insertTestTrack(sql, current);

            // A variant that the user heard yesterday but is NOT in this session
            const variant = createTestTrack(album.id, 2, {
                title: 'Here I Go (Radio Edit)',
            });
            await insertTestTrack(sql, variant);

            // NOT an all-zero vector: cosine distance to zero is NaN and the
            // idx_me_music_hnsw index scan then returns none of these rows.
            // Every fixture shares this one vector, so all distances are 0.
            const vectorString = musicFixtureEmbeddingLiteral();
            for (const id of [current.id, variant.id]) {
                await sql`
                    INSERT INTO media_embeddings (media_id, source, embedding)
                    VALUES (${id}::uuid, 'music', ${vectorString}::vector)
                `;
            }

            const results = await getSmartQueueCandidates(sql, current.id, [], 50, {
                userId: USER,
                persistentPlayedTitles: ['here i go'],
            });

            expect(results.map((r) => r.title)).not.toContain('Here I Go (Radio Edit)');
        });

        it('is a no-op when persistentPlayedTitles is empty', async () => {
            const artist = createTestArtist({ title: 'Passthrough Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Passthrough Album',
            });
            await insertTestAlbum(sql, album);

            const current = createTestTrack(album.id, 1, { title: 'Current' });
            await insertTestTrack(sql, current);
            const other = createTestTrack(album.id, 2, {
                title: 'Different Song',
            });
            await insertTestTrack(sql, other);

            // NOT an all-zero vector: cosine distance to zero is NaN and the
            // idx_me_music_hnsw index scan then returns none of these rows.
            // Every fixture shares this one vector, so all distances are 0.
            const vectorString = musicFixtureEmbeddingLiteral();
            for (const id of [current.id, other.id]) {
                await sql`
                    INSERT INTO media_embeddings (media_id, source, embedding)
                    VALUES (${id}::uuid, 'music', ${vectorString}::vector)
                `;
            }

            const results = await getSmartQueueCandidates(sql, current.id, [], 50, {
                userId: USER,
                persistentPlayedTitles: [],
            });

            expect(results.map((r) => r.title)).toContain('Different Song');
        });
    });

    // =========================================================================
    // getSmartQueueCandidates — mood seed (metadata path)
    // =========================================================================

    describe('getSmartQueueCandidates — mood seed', () => {
        const USER = toUserId(randomUUID());
        /** A 1024-d unit vector from axis weights. */
        const literal = (weights: Record<number, number>): string => {
            const v = new Array<number>(1024).fill(0);
            for (const [axis, w] of Object.entries(weights)) v[Number(axis)] = w;
            const n = Math.hypot(...v);
            return `[${v.map((x) => x / n).join(',')}]`;
        };

        beforeEach(async () => {
            await sql`
                INSERT INTO users (id, username)
                VALUES (${USER}::uuid, ${derivedUsername(USER)})
                ON CONFLICT (id) DO NOTHING
            `;
            await sql`DELETE FROM mood_vectors WHERE mood_key = 'music:chill' AND model_id = 'text'`;
        });

        afterEach(async () => {
            await sql`DELETE FROM mood_vectors WHERE mood_key = 'music:chill' AND model_id = 'text'`;
        });

        // The seed carries the bare key ("chill"); the text-space mood vectors are
        // stored as music:chill in the `vector` column. Reading a non-existent
        // `embedding` column made every mood radio that reached this path a 500.
        it('biases the candidates toward the mood vector', async () => {
            const artist = createTestArtist({ title: 'Mood Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, { title: 'Mood Album' });
            await insertTestAlbum(sql, album);
            const current = createTestTrack(album.id, 1, { title: 'Mood Current' });
            const nearSeed = createTestTrack(album.id, 2, { title: 'Sounds Like Current' });
            const nearMood = createTestTrack(album.id, 3, { title: 'Sounds Chill' });
            for (const t of [current, nearSeed, nearMood]) await insertTestTrack(sql, t);
            const vectors: [string, string][] = [
                [current.id, literal({ 0: 1 })],
                [nearSeed.id, literal({ 0: 0.95, 2: 0.31 })],
                [nearMood.id, literal({ 0: 0.6, 1: 0.8 })],
            ];
            for (const [id, v] of vectors) {
                await sql`
                    INSERT INTO media_embeddings (media_id, source, embedding)
                    VALUES (${id}::uuid, 'music', ${v}::vector)
                `;
            }
            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES ('music:chill', 'Chill', ${literal({ 1: 1 })}::vector, 'text')
            `;

            const plain = await getSmartQueueCandidates(sql, current.id, [], 10, { userId: USER });
            const withMood = await getSmartQueueCandidates(sql, current.id, [], 10, {
                userId: USER,
                seed: { type: 'mood', mood: 'chill' },
            });

            expect(plain[0]?.title).toBe('Sounds Like Current');
            expect(withMood[0]?.title).toBe('Sounds Chill');
        });
    });

    // =========================================================================
    // hasMusicLibraryOrContent
    // =========================================================================
    //
    // Gates music-scoped attention nudges (Last.fm / Discogs "not
    // configured") on a fresh install — see finding: "MUSIC-PROVIDER
    // NOTIFICATION NOISE". library_paths/library_groups aren't covered by the
    // per-test media_items TRUNCATE above, so clean up any rows this block
    // creates explicitly.

    describe('hasMusicLibraryOrContent', () => {
        afterEach(async () => {
            await sql`DELETE FROM library_paths WHERE path LIKE '/test-music-gate%'`;
            await sql`DELETE FROM library_groups WHERE name LIKE 'Music Gate Test%'`;
        });

        it('returns false on a fresh install with no music library and no music content', async () => {
            expect(await hasMusicLibraryOrContent(sql)).toBe(false);
        });

        it('returns false when only the canonical Various Artists placeholder exists', async () => {
            // Mirrors the migration-16.132.0-seeded placeholder: media_type='artist',
            // is_various_artists=true, no children. Must NOT count as "has music".
            const va = createTestArtist({ title: 'Various Artists' });
            await insertTestArtist(sql, va);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;

            expect(await hasMusicLibraryOrContent(sql)).toBe(false);
        });

        it('returns true when a real (non-VA) artist exists', async () => {
            const artist = createTestArtist({ title: 'Real Artist For Gate Test' });
            await insertTestArtist(sql, artist);

            expect(await hasMusicLibraryOrContent(sql)).toBe(true);
        });

        it('returns true when an enabled music library path is configured, even with zero content', async () => {
            const group = await createLibraryGroup(sql, { name: 'Music Gate Test Group' });
            await createLibraryPath(sql, {
                path: '/test-music-gate/music',
                media_type: 'music',
                library_group_id: group.id,
            });

            expect(await hasMusicLibraryOrContent(sql)).toBe(true);
        });

        it('ignores a dismissed (has_files=false) track', async () => {
            // seed a hierarchy with all dismissed, has_files=false, or status != 'active'
            const artist = createTestArtist({ title: 'Ghost Artist' });
            await insertTestArtist(sql, artist);

            const album = createTestAlbum(artist.id, { title: 'Ghost Album' });
            await insertTestAlbum(sql, album);

            const track = createTestTrack(album.id, 1, { title: 'Ghost Track' });
            await insertTestTrack(sql, track);

            // Mark all of them with has_files=false and status != 'active' so they don't count
            await sql`
                UPDATE media_items
                SET has_files = false, status = 'deleted'
                WHERE id IN (${artist.id}::uuid, ${album.id}::uuid, ${track.id}::uuid)
            `;

            expect(await hasMusicLibraryOrContent(sql)).toBe(false);
        });
    });

    // =========================================================================
    // hasPlayableMusic
    // =========================================================================
    //
    // Replaced music-quick-picks' `artists + albums + tracks === 0` check on
    // the full-scan getMediaBrowserStats — every case asserts parity with it.

    describe('hasPlayableMusic', () => {
        async function expectParity(expected: boolean): Promise<void> {
            const stats = await getMediaBrowserStats(sql);
            expect(stats.artists + stats.albums + stats.tracks > 0).toBe(expected);
            expect(await hasPlayableMusic(sql)).toBe(expected);
        }

        it('returns false with no music rows', async () => {
            await expectParity(false);
        });

        it('returns false when artist and album exist but nothing has files', async () => {
            const artist = createTestArtist({ title: 'Fileless Artist' });
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, createTestAlbum(artist.id, { title: 'Fileless Album' }));
            await sql`
                UPDATE media_items SET has_files = false
                 WHERE media_type IN ('artist', 'album', 'track')
            `;

            await expectParity(false);
        });

        it('returns true once a track has files', async () => {
            await createAndInsertTestMusicHierarchy(sql);

            await expectParity(true);
        });

        it('returns true for an artist row with has_files alone', async () => {
            const artist = createTestArtist({ title: 'Artist With Files' });
            await insertTestArtist(sql, artist);
            await sql`
                UPDATE media_items SET has_files = (id = ${artist.id}::uuid)
                 WHERE media_type IN ('artist', 'album', 'track')
            `;

            await expectParity(true);
        });

        it('ignores non-active rows even when they have files', async () => {
            await createAndInsertTestMusicHierarchy(sql);
            await sql`
                UPDATE media_items SET status = 'deleted'
                 WHERE media_type IN ('artist', 'album', 'track')
            `;

            await expectParity(false);
        });

        it('ignores playable non-music rows', async () => {
            await sql`
                UPDATE media_items SET has_files = false
                 WHERE media_type IN ('artist', 'album', 'track')
            `;
            const movie = await createAndInsertTestMovie(sql, { tmdbId: 990001 });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            await expectParity(false);
        });
    });

    // =========================================================================
    // getMostPlayedArtists
    // =========================================================================

    const DENIED_GROUP_ID = 'dddddddd-eeee-4fff-8000-222222222222';
    const USER = toUserId(randomUUID());

    async function createDeniedGroup(sql: postgres.Sql): Promise<void> {
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${DENIED_GROUP_ID}::uuid, 'Denied Top-Artists Group')
            ON CONFLICT (id) DO NOTHING
        `;
    }

    async function ensureTestUser(sql: postgres.Sql): Promise<void> {
        await sql`
            INSERT INTO users (id, username)
            VALUES (${USER}::uuid, ${derivedUsername(USER)})
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO user_profiles (user_id)
            VALUES (${USER}::uuid)
            ON CONFLICT (user_id) DO NOTHING
        `;
    }

    async function denyTrackLibrary(sql: postgres.Sql, trackId: string): Promise<void> {
        await sql`
            UPDATE media_files SET library_group_id = ${DENIED_GROUP_ID}::uuid
            WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackId}::uuid)
        `;
    }

    /** Seed an artist -> album -> track chain with a user_music_state play. */
    async function seedPlayedArtist(
        sql: postgres.Sql,
        opts: { artistTitle: string; playCount: number },
    ): Promise<{ artistId: string; trackId: string }> {
        const artist = createTestArtist({ title: opts.artistTitle });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id);
        await insertTestAlbum(sql, album);
        const track = createTestTrack(album.id, 1);
        await insertTestTrack(sql, track);
        await sql`
            INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at)
            VALUES (${USER}::uuid, ${track.id}::uuid, ${opts.playCount}, NOW())
        `;
        return { artistId: artist.id, trackId: track.id };
    }

    describe('getMostPlayedArtists access boundary (real DB)', () => {
        let sql: postgres.Sql;

        beforeAll(() => {
            sql = getTestDb();
        });

        afterAll(async () => {
            await closeTestDb();
        });

        beforeEach(async () => {
            await truncateTables(sql, ['user_music_state', ...TEST_TABLES.media]);
            await ensureTestUser(sql);
            await createDeniedGroup(sql);
        });

        it('excludes an artist whose only played track is in a denied library group', async () => {
            const allowed = await seedPlayedArtist(sql, {
                artistTitle: 'Allowed Artist',
                playCount: 5,
            });
            const denied = await seedPlayedArtist(sql, {
                artistTitle: 'Denied Artist',
                playCount: 5,
            });
            await denyTrackLibrary(sql, denied.trackId);

            const unrestricted = await getMostPlayedArtists(sql, USER, 10);
            const restricted = await getMostPlayedArtists(sql, USER, 10, [DENIED_GROUP_ID], null);

            expect(unrestricted.map((a) => a.id).sort()).toEqual(
                [allowed.artistId, denied.artistId].sort(),
            );
            expect(restricted.map((a) => a.id)).toEqual([allowed.artistId]);
        });

        it('excludes an artist whose only played track is above maxAgeRating', async () => {
            const allowed = await seedPlayedArtist(sql, {
                artistTitle: 'Kid Artist',
                playCount: 5,
            });
            const adult = await seedPlayedArtist(sql, {
                artistTitle: 'Adult Artist',
                playCount: 5,
            });
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.trackId}::uuid`;

            const restricted = await getMostPlayedArtists(sql, USER, 10, null, {
                maxAgeRating: 13,
                allowUnrated: true,
            });

            expect(restricted.map((a) => a.id)).toEqual([allowed.artistId]);
        });
    });

    describe('getTopArtistsByAlbumCount access boundary (real DB)', () => {
        let sql: postgres.Sql;

        beforeAll(() => {
            sql = getTestDb();
        });

        afterAll(async () => {
            await closeTestDb();
        });

        beforeEach(async () => {
            await truncateTables(sql, ['user_music_state', ...TEST_TABLES.media]);
            await createDeniedGroup(sql);
            await ensureTestUser(sql);
        });

        it('excludes an artist whose only album has a track in a denied library group', async () => {
            const allowedArtist = createTestArtist({ title: 'Allowed Catalog Artist' });
            await insertTestArtist(sql, allowedArtist);
            const allowedAlbum = createTestAlbum(allowedArtist.id);
            await insertTestAlbum(sql, allowedAlbum);
            const allowedTrack = createTestTrack(allowedAlbum.id, 1);
            await insertTestTrack(sql, allowedTrack);

            const deniedArtist = createTestArtist({ title: 'Denied Catalog Artist' });
            await insertTestArtist(sql, deniedArtist);
            const deniedAlbum = createTestAlbum(deniedArtist.id);
            await insertTestAlbum(sql, deniedAlbum);
            const deniedTrack = createTestTrack(deniedAlbum.id, 1);
            await insertTestTrack(sql, deniedTrack);
            await denyTrackLibrary(sql, deniedTrack.id);

            const unrestricted = await getTopArtistsByAlbumCount(sql, 10);
            const restricted = await getTopArtistsByAlbumCount(sql, 10, [DENIED_GROUP_ID], null);

            expect(unrestricted.map((a) => a.id).sort()).toEqual(
                [allowedArtist.id, deniedArtist.id].sort(),
            );
            expect(restricted.map((a) => a.id)).toEqual([allowedArtist.id]);
        });
    });
});
