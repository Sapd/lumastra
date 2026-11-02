// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the container-aware library-access fix (C3, task 4).
 *
 * `tv`, `season`, `artist` and `album` rows never own `media_file_items` of
 * their own — only their leaf descendants (`episode`, `track`) do. Before this
 * fix, `buildLibraryAccessFilter` and `isMediaAccessible` treated "no own
 * files" as "visible to everyone", so a series/album whose every
 * episode/track lived in a library group a user is denied was still listed to
 * that user with full metadata, and `checkMediaAccess` passed for it.
 *
 * Each block below seeds a container (series or artist) whose only
 * file-owning descendant lives in a DENIED group, and proves:
 *   - the container disappears from every affected query consumer for a
 *     restricted (denied) user,
 *   - it still appears for an unrestricted user and for a user allowed the
 *     group,
 *   - `checkMediaAccess` denies the container (and, for tv, its season) for
 *     the restricted user.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { restrictedAccess, unrestrictedAccess } from './media-access-boundary.js';
import { buildLibraryAccessFilter } from './library-access.builder.js';
import {
    browseMediaItems,
    getLatestItems,
    getDistinctGenresForLibrary,
} from '../jellyfin-browse.queries.js';
import { getMediaAlphabetical } from '../browse.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '../library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import type { UserContext } from '$lib/server/types.js';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

/** Minimal restricted (library-axis only) user. isAgeRestricted:false keeps checkMediaAccess from also running the age gate. */
function userIn(...groups: string[]): UserContext {
    return {
        isAdmin: false,
        userGroups: groups,
        isAgeRestricted: false,
    } as unknown as UserContext;
}

describe.runIf(RUN)('container-aware library access (C3, task 4)', () => {
    let sql: postgres.Sql;
    const mediaIds: string[] = [];
    const fileIds: string[] = [];
    const groupIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1 FROM media_items LIMIT 0`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        if (mediaIds.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds}::uuid[])`;
            mediaIds.length = 0;
        }
        if (fileIds.length > 0) {
            await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
            fileIds.length = 0;
        }
        for (const groupId of groupIds) {
            await deleteLibraryGroupPermission(sql, groupId);
        }
        if (groupIds.length > 0) {
            await sql`DELETE FROM library_groups WHERE id = ANY(${groupIds}::uuid[])`;
            groupIds.length = 0;
        }
        // checkMediaAccess reads permissions through the L1 cache.
        invalidateLibraryGroupPermissionsCache();
    });

    async function insertGroup(name: string): Promise<string> {
        const id = randomUUID();
        groupIds.push(id);
        await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
        return id;
    }

    /**
     * Insert series -> season -> episode -> media_file_items -> media_files,
     * with the episode's file pinned to `libraryGroupId`. `has_files` is set on
     * all three rows, matching what `propagateHasFiles` does on a real ingest —
     * `getMediaAlphabetical`'s `availableOnly` branch reads it directly.
     */
    async function insertSeries(
        tag: string,
        libraryGroupId: string,
    ): Promise<{ seriesId: string; seasonId: string; episodeId: string }> {
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const episodeId = randomUUID();
        const fileId = randomUUID();
        mediaIds.push(seriesId, seasonId, episodeId);
        fileIds.push(fileId);

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${seasonId}::uuid, ${`${tag} Season 1`}, 'season', ${seriesId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${episodeId}::uuid, ${`${tag} Episode 1`}, 'episode', ${seasonId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${fileId}::uuid, ${`/test/${episodeId}.mkv`}, ${libraryGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${episodeId}::uuid)
        `;
        await sql`
            UPDATE media_items SET has_files = true
            WHERE id = ANY(${[seriesId, seasonId, episodeId]}::uuid[])
        `;
        return { seriesId, seasonId, episodeId };
    }

    /** Insert artist -> album -> track -> media_file_items -> media_files. */
    async function insertArtist(
        tag: string,
        libraryGroupId: string,
    ): Promise<{ artistId: string; albumId: string; trackId: string }> {
        const artistId = randomUUID();
        const albumId = randomUUID();
        const trackId = randomUUID();
        const fileId = randomUUID();
        mediaIds.push(artistId, albumId, trackId);
        fileIds.push(fileId);

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${artistId}::uuid, ${`${tag} Artist`}, 'artist', NULL, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${albumId}::uuid, ${`${tag} Album`}, 'album', ${artistId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${trackId}::uuid, ${`${tag} Track`}, 'track', ${albumId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${fileId}::uuid, ${`/test/${trackId}.mp3`}, ${libraryGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${trackId}::uuid)
        `;
        await sql`
            UPDATE media_items SET has_files = true
            WHERE id = ANY(${[artistId, albumId, trackId]}::uuid[])
        `;
        return { artistId, albumId, trackId };
    }

    /** Insert a bare `tv` row with no seasons/episodes at all — an empty container. */
    async function insertEmptySeries(tag: string): Promise<{ seriesId: string }> {
        const seriesId = randomUUID();
        mediaIds.push(seriesId);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active')
        `;
        return { seriesId };
    }

    /**
     * Insert series -> season -> two episodes: one episode's file in
     * `deniedGroupId`, the other's in `allowedGroupId` (or ungrouped when
     * omitted). Exercises the "has descendant files, not ALL denied" case.
     */
    async function insertSeriesWithMixedFiles(
        tag: string,
        deniedGroupId: string,
        allowedGroupId: string | null,
    ): Promise<{ seriesId: string; seasonId: string }> {
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const deniedEpisodeId = randomUUID();
        const allowedEpisodeId = randomUUID();
        const deniedFileId = randomUUID();
        const allowedFileId = randomUUID();
        mediaIds.push(seriesId, seasonId, deniedEpisodeId, allowedEpisodeId);
        fileIds.push(deniedFileId, allowedFileId);

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${seasonId}::uuid, ${`${tag} Season 1`}, 'season', ${seriesId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${deniedEpisodeId}::uuid, ${`${tag} Episode 1`}, 'episode', ${seasonId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${allowedEpisodeId}::uuid, ${`${tag} Episode 2`}, 'episode', ${seasonId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${deniedFileId}::uuid, ${`/test/${deniedEpisodeId}.mkv`}, ${deniedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${allowedFileId}::uuid, ${`/test/${allowedEpisodeId}.mkv`}, ${allowedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${deniedFileId}::uuid, ${deniedEpisodeId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${allowedFileId}::uuid, ${allowedEpisodeId}::uuid)
        `;
        await sql`
            UPDATE media_items SET has_files = true
            WHERE id = ANY(${[seriesId, seasonId, deniedEpisodeId, allowedEpisodeId]}::uuid[])
        `;
        return { seriesId, seasonId };
    }

    /** Insert a bare `artist` row with no albums/tracks at all — an empty container. */
    async function insertEmptyArtist(tag: string): Promise<{ artistId: string }> {
        const artistId = randomUUID();
        mediaIds.push(artistId);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${artistId}::uuid, ${`${tag} Artist`}, 'artist', NULL, 'active')
        `;
        return { artistId };
    }

    /**
     * Insert artist -> album -> two tracks: one track's file in
     * `deniedGroupId`, the other's in `allowedGroupId` (or ungrouped when
     * omitted).
     */
    async function insertArtistWithMixedFiles(
        tag: string,
        deniedGroupId: string,
        allowedGroupId: string | null,
    ): Promise<{ artistId: string; albumId: string }> {
        const artistId = randomUUID();
        const albumId = randomUUID();
        const deniedTrackId = randomUUID();
        const allowedTrackId = randomUUID();
        const deniedFileId = randomUUID();
        const allowedFileId = randomUUID();
        mediaIds.push(artistId, albumId, deniedTrackId, allowedTrackId);
        fileIds.push(deniedFileId, allowedFileId);

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${artistId}::uuid, ${`${tag} Artist`}, 'artist', NULL, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${albumId}::uuid, ${`${tag} Album`}, 'album', ${artistId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${deniedTrackId}::uuid, ${`${tag} Track 1`}, 'track', ${albumId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, status)
            VALUES (${allowedTrackId}::uuid, ${`${tag} Track 2`}, 'track', ${albumId}::uuid, 'active')
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${deniedFileId}::uuid, ${`/test/${deniedTrackId}.mp3`}, ${deniedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${allowedFileId}::uuid, ${`/test/${allowedTrackId}.mp3`}, ${allowedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${deniedFileId}::uuid, ${deniedTrackId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${allowedFileId}::uuid, ${allowedTrackId}::uuid)
        `;
        await sql`
            UPDATE media_items SET has_files = true
            WHERE id = ANY(${[artistId, albumId, deniedTrackId, allowedTrackId]}::uuid[])
        `;
        return { artistId, albumId };
    }

    async function insertGenre(mediaId: string, genreName: string): Promise<void> {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${mediaId}::uuid, 'tmdb', ${sql.json({ genres: [{ id: 1, name: genreName }] })})
        `;
    }

    /** Restrict `libraryGroupId` to `allowedGroup` and wire up the caller's cache. */
    async function restrictGroupTo(libraryGroupId: string, allowedGroup: string): Promise<void> {
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId,
            allowedGroups: [allowedGroup],
        });
        invalidateLibraryGroupPermissionsCache();
    }

    /**
     * Probe `buildLibraryAccessFilter` DIRECTLY against a minimal ad hoc
     * SELECT — the seam both the "own-column declared affiliation" and
     * "Shape B" describe blocks below use. Bypasses consumer-side
     * availability gates (e.g. `browseMediaItems`' PLAYABLE/`has_files`
     * requirement) that mask a file-less row regardless of the access
     * predicate — those gates would make a "still visible" assertion
     * trivially false and a "hidden" assertion trivially true either way,
     * proving nothing about either fix. Shared rather than redefined per
     * describe block so the two do not drift into subtly different seams.
     */
    async function isVisible(mediaId: string, deniedGroupIds: string[]): Promise<boolean> {
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id::text FROM media_items mi
            WHERE mi.id = ${mediaId}::uuid
            ${buildLibraryAccessFilter(
                sql,
                restrictedAccess({ deniedGroupIds, maxAgeRating: null, allowUnrated: true })
                    .library,
            )}
        `;
        return rows.length > 0;
    }

    // -------------------------------------------------------------------
    // tv / season
    // -------------------------------------------------------------------

    describe('tv series', () => {
        it('browseMediaItems(tv) excludes a series whose only episode file is in a denied group', async () => {
            const tag = `C3Tv${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { seriesId } = await insertSeries(tag, groupId);

            const open = await browseMediaItems(
                sql,
                browseOpts({ mediaTypes: ['tv'], searchTerm: tag }),
            );
            expect(open.rows.map((r) => r.id)).toContain(seriesId);
            expect(open.totalCount).toBeGreaterThanOrEqual(1);

            const restricted = await browseMediaItems(
                sql,
                browseOpts({
                    mediaTypes: ['tv'],
                    searchTerm: tag,
                    access: restrictedAccess({
                        deniedGroupIds: [groupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                }),
            );
            expect(restricted.rows.map((r) => r.id)).not.toContain(seriesId);
            expect(restricted.totalCount).toBe(0);

            // A user allowed the group still sees it (not a blanket deny).
            const allowed = await browseMediaItems(
                sql,
                browseOpts({
                    mediaTypes: ['tv'],
                    searchTerm: tag,
                    access: restrictedAccess({
                        deniedGroupIds: [randomUUID()],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                }),
            );
            expect(allowed.rows.map((r) => r.id)).toContain(seriesId);
        });

        it('getLatestItems excludes the series for a restricted user', async () => {
            const tag = `C3Latest${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { seriesId } = await insertSeries(tag, groupId);

            const open = await getLatestItems(sql, {
                limit: 500,
                parentId: null,
                groupItems: true,
                access: unrestrictedAccess(),
            });
            expect(open.map((r) => r.id)).toContain(seriesId);

            const restricted = await getLatestItems(sql, {
                limit: 500,
                parentId: null,
                groupItems: true,
                access: restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            });
            expect(restricted.map((r) => r.id)).not.toContain(seriesId);
        });

        it('getDistinctGenresForLibrary excludes a genre that only the denied series carries', async () => {
            const tag = `C3Genre${randomUUID().slice(0, 8)}`;
            const genreName = `${tag}Genre`;
            const groupId = await insertGroup(`${tag} Group`);
            const { seriesId } = await insertSeries(tag, groupId);
            await insertGenre(seriesId, genreName);

            const open = await getDistinctGenresForLibrary(sql, null, unrestrictedAccess());
            expect(open.map((g) => g.name)).toContain(genreName);

            const restricted = await getDistinctGenresForLibrary(
                sql,
                null,
                restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            expect(restricted.map((g) => g.name)).not.toContain(genreName);
        });

        it('browse.queries.ts getMediaAlphabetical (tv listing) excludes the series for a restricted user', async () => {
            const tag = `C3Az${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { seriesId } = await insertSeries(tag, groupId);

            const open = await getMediaAlphabetical(sql, {
                mediaType: 'tv',
                query: tag,
                limit: 500,
                access: unrestrictedAccess(),
            });
            expect(open.items.map((i) => i.internal_id)).toContain(seriesId);

            const restricted = await getMediaAlphabetical(sql, {
                mediaType: 'tv',
                query: tag,
                limit: 500,
                access: restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            });
            expect(restricted.items.map((i) => i.internal_id)).not.toContain(seriesId);
            expect(restricted.totalCount).toBe(0);
        });

        it('checkMediaAccess denies the series AND its season for a denied user, allows an allowed user', async () => {
            const tag = `C3Check${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { seriesId, seasonId } = await insertSeries(tag, groupId);
            await restrictGroupTo(groupId, 'adults');

            expect(await checkMediaAccess(sql, seriesId, userIn('kids'))).toBe(false);
            expect(await checkMediaAccess(sql, seasonId, userIn('kids'))).toBe(false);

            expect(await checkMediaAccess(sql, seriesId, userIn('adults'))).toBe(true);
            expect(await checkMediaAccess(sql, seasonId, userIn('adults'))).toBe(true);
        });

        describe('empty and mixed containers (fix round 1)', () => {
            it('a series with zero seasons/episodes stays visible to a restricted user', async () => {
                const tag = `C3Empty${randomUUID().slice(0, 8)}`;
                // An UNRELATED group restriction is active — the empty series has
                // nothing to do with it, but the old EXISTS-only predicate hid
                // every container the instant ANY restriction existed at all.
                const unrelatedGroupId = await insertGroup(`${tag} Unrelated Group`);
                await restrictGroupTo(unrelatedGroupId, 'adults');
                const { seriesId } = await insertEmptySeries(tag);

                // checkMediaAccess is the right probe for this: browseMediaItems
                // filters on PLAYABLE availability (buildFileBackedVideoItemFilter
                // requires an actual episode file to exist), which a zero-episode
                // stub can never satisfy regardless of library access — verified
                // below with an unrestricted boundary, where it's absent for the
                // same reason. isMediaAccessible/checkMediaAccess is what a
                // request/watchlist detail-view check goes through for a stub like
                // this, and is exactly what this fix round's finding was about.
                expect(await checkMediaAccess(sql, seriesId, userIn('kids'))).toBe(true);

                const unrestrictedListing = await browseMediaItems(
                    sql,
                    browseOpts({ mediaTypes: ['tv'], searchTerm: tag }),
                );
                expect(unrestrictedListing.rows.map((r) => r.id)).not.toContain(seriesId);
            });

            it('a series whose only episode file is in a denied group is hidden (control)', async () => {
                const tag = `C3AllDenied${randomUUID().slice(0, 8)}`;
                const groupId = await insertGroup(`${tag} Group`);
                const { seriesId } = await insertSeries(tag, groupId);
                await restrictGroupTo(groupId, 'adults');

                expect(await checkMediaAccess(sql, seriesId, userIn('kids'))).toBe(false);
            });

            it('a series with one denied and one allowed episode file stays visible to a restricted user', async () => {
                const tag = `C3Mixed${randomUUID().slice(0, 8)}`;
                const deniedGroupId = await insertGroup(`${tag} Denied Group`);
                const { seriesId } = await insertSeriesWithMixedFiles(tag, deniedGroupId, null);
                await restrictGroupTo(deniedGroupId, 'adults');

                expect(await checkMediaAccess(sql, seriesId, userIn('kids'))).toBe(true);

                const restricted = await browseMediaItems(
                    sql,
                    browseOpts({
                        mediaTypes: ['tv'],
                        searchTerm: tag,
                        access: restrictedAccess({
                            deniedGroupIds: [deniedGroupId],
                            maxAgeRating: null,
                            allowUnrated: true,
                        }),
                    }),
                );
                expect(restricted.rows.map((r) => r.id)).toContain(seriesId);
            });
        });
    });

    // -------------------------------------------------------------------
    // artist / album
    // -------------------------------------------------------------------

    describe('artist / album', () => {
        it('browseMediaItems(artist) excludes an artist whose only track file is in a denied group', async () => {
            const tag = `C3Artist${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { artistId } = await insertArtist(tag, groupId);

            const open = await browseMediaItems(
                sql,
                browseOpts({ mediaTypes: ['artist'], searchTerm: tag }),
            );
            expect(open.rows.map((r) => r.id)).toContain(artistId);

            const restricted = await browseMediaItems(
                sql,
                browseOpts({
                    mediaTypes: ['artist'],
                    searchTerm: tag,
                    access: restrictedAccess({
                        deniedGroupIds: [groupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                }),
            );
            expect(restricted.rows.map((r) => r.id)).not.toContain(artistId);
            expect(restricted.totalCount).toBe(0);
        });

        it('browseMediaItems(album) excludes an album whose only track file is in a denied group', async () => {
            const tag = `C3Album${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { albumId } = await insertArtist(tag, groupId);

            const open = await browseMediaItems(
                sql,
                browseOpts({ mediaTypes: ['album'], searchTerm: tag }),
            );
            expect(open.rows.map((r) => r.id)).toContain(albumId);

            const restricted = await browseMediaItems(
                sql,
                browseOpts({
                    mediaTypes: ['album'],
                    searchTerm: tag,
                    access: restrictedAccess({
                        deniedGroupIds: [groupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                }),
            );
            expect(restricted.rows.map((r) => r.id)).not.toContain(albumId);
        });

        it('checkMediaAccess denies the artist AND its album for a denied user, allows an allowed user', async () => {
            const tag = `C3ArtistCheck${randomUUID().slice(0, 8)}`;
            const groupId = await insertGroup(`${tag} Group`);
            const { artistId, albumId } = await insertArtist(tag, groupId);
            await restrictGroupTo(groupId, 'adults');

            expect(await checkMediaAccess(sql, artistId, userIn('kids'))).toBe(false);
            expect(await checkMediaAccess(sql, albumId, userIn('kids'))).toBe(false);

            expect(await checkMediaAccess(sql, artistId, userIn('adults'))).toBe(true);
            expect(await checkMediaAccess(sql, albumId, userIn('adults'))).toBe(true);
        });

        describe('empty and mixed containers (fix round 1)', () => {
            it('an artist with zero albums/tracks stays visible to a restricted user', async () => {
                const tag = `C3EmptyArtist${randomUUID().slice(0, 8)}`;
                const unrelatedGroupId = await insertGroup(`${tag} Unrelated Group`);
                await restrictGroupTo(unrelatedGroupId, 'adults');
                const { artistId } = await insertEmptyArtist(tag);

                // Same reasoning as the empty-series case above: browseMediaItems
                // requires has_files=true (never set for a zero-track artist),
                // independent of library access — checkMediaAccess is the right
                // probe for this fix.
                expect(await checkMediaAccess(sql, artistId, userIn('kids'))).toBe(true);

                const unrestrictedListing = await browseMediaItems(
                    sql,
                    browseOpts({ mediaTypes: ['artist'], searchTerm: tag }),
                );
                expect(unrestrictedListing.rows.map((r) => r.id)).not.toContain(artistId);
            });

            it('an artist whose only track file is in a denied group is hidden (control)', async () => {
                const tag = `C3AllDeniedArtist${randomUUID().slice(0, 8)}`;
                const groupId = await insertGroup(`${tag} Group`);
                const { artistId } = await insertArtist(tag, groupId);
                await restrictGroupTo(groupId, 'adults');

                expect(await checkMediaAccess(sql, artistId, userIn('kids'))).toBe(false);
            });

            it('an artist with one denied and one allowed track file stays visible to a restricted user', async () => {
                const tag = `C3MixedArtist${randomUUID().slice(0, 8)}`;
                const deniedGroupId = await insertGroup(`${tag} Denied Group`);
                const { artistId, albumId } = await insertArtistWithMixedFiles(
                    tag,
                    deniedGroupId,
                    null,
                );
                await restrictGroupTo(deniedGroupId, 'adults');

                expect(await checkMediaAccess(sql, artistId, userIn('kids'))).toBe(true);
                expect(await checkMediaAccess(sql, albumId, userIn('kids'))).toBe(true);

                const restricted = await browseMediaItems(
                    sql,
                    browseOpts({
                        mediaTypes: ['album'],
                        searchTerm: tag,
                        access: restrictedAccess({
                            deniedGroupIds: [deniedGroupId],
                            maxAgeRating: null,
                            allowUnrated: true,
                        }),
                    }),
                );
                expect(restricted.rows.map((r) => r.id)).toContain(albumId);
            });
        });
    });

    // -------------------------------------------------------------------
    // own-column declared affiliation (fix round 2 — deferred item 4
    // review, 2026-09-15)
    // -------------------------------------------------------------------

    describe('own-column declared affiliation (fix round 2, corrected in fix round 3)', () => {
        /**
         * Probe `buildLibraryAccessFilter` DIRECTLY against a minimal ad hoc
         * SELECT, bypassing consumer-side availability gates (e.g.
         * `browseMediaItems`' PLAYABLE/`has_files` requirement) that mask a
         * file-less container regardless of the access predicate — those
         * gates would make a "still visible" assertion trivially false and a
         * "hidden" assertion trivially true either way, proving nothing about
         * this fix. Only `tv` is exercised here: the own-column backstop is
         * ONE shared code path across the CASE dispatch (originally guarded
         * to the four container types by a `media_type NOT IN (...)` clause;
         * that guard was DELETED and the backstop generalised to every media
         * type by the Shape B fix — see `library-access.builder.ts`'s
         * "Generalised beyond the four container types" doc section), not
         * per-branch duplicated logic, so this is not undertested by
         * covering one type — `artist` gets its own dedicated coverage in
         * `artists-query.integration.test.ts` for the separate
         * `buildArtistLibraryAccessFilter` function.
         *
         * `isVisible()` itself is the outer-scope helper defined above —
         * shared with the "Shape B" describe block below rather than
         * redefined here.
         */

        it('a file-less tv stub with library_group_id IS NULL stays visible', async () => {
            const tag = `C3OwnCol${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const { seriesId } = await insertEmptySeries(tag);

            expect(await isVisible(seriesId, [deniedGroupId])).toBe(true);
        });

        it('a file-less tv stub naming a denied library_group_id is hidden', async () => {
            const tag = `C3OwnCol${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const seriesId = randomUUID();
            mediaIds.push(seriesId);
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status, library_group_id)
                VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active', ${deniedGroupId}::uuid)
            `;

            expect(await isVisible(seriesId, [deniedGroupId])).toBe(false);

            // Control: unrestricted access still sees it (not a blanket deny).
            expect(await isVisible(seriesId, [randomUUID()])).toBe(true);
        });

        it('a container with only denied-group descendant files is hidden regardless of its own (NULL) library_group_id', async () => {
            const tag = `C3OwnCol${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const { seriesId } = await insertSeries(tag, deniedGroupId);

            expect(await isVisible(seriesId, [deniedGroupId])).toBe(false);
        });

        it('a container with a non-denied descendant file is visible', async () => {
            const tag = `C3OwnCol${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const allowedGroupId = await insertGroup(`${tag} Allowed`);
            const { seriesId } = await insertSeries(tag, allowedGroupId);

            expect(await isVisible(seriesId, [deniedGroupId])).toBe(true);
        });

        // Fix round 3 (review response, 2026-09-15): the own-column check's
        // first cut hid a container "regardless of file state", which also
        // hid one whose descendant files are FULLY ACCESSIBLE — reachable in
        // a real library because `media_items.library_group_id` is STICKY
        // (set once at first scan, only ever backfilled when NULL). A series
        // first scanned into a group it later loses episodes from keeps that
        // stale own-row group forever.
        it('a container naming a denied group with a non-denied descendant file stays visible, consistent with its children (fix round 3 — sticky-column desync)', async () => {
            const tag = `C3OwnCol${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Denied`);
            const allowedGroupId = await insertGroup(`${tag} Allowed`);

            const seriesId = randomUUID();
            const seasonId = randomUUID();
            const episodeId = randomUUID();
            const fileId = randomUUID();
            mediaIds.push(seriesId, seasonId, episodeId);
            fileIds.push(fileId);

            // Series' own library_group_id names the DENIED group (as if
            // first scanned there), but its only episode file lives in the
            // ALLOWED group.
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status, library_group_id)
                VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active', ${deniedGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status)
                VALUES (${seasonId}::uuid, ${`${tag} Season 1`}, 'season', ${seriesId}::uuid, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status)
                VALUES (${episodeId}::uuid, ${`${tag} Episode 1`}, 'episode', ${seasonId}::uuid, 'active')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id)
                VALUES (${fileId}::uuid, ${`/test/${episodeId}.mkv`}, ${allowedGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${episodeId}::uuid)
            `;

            expect(await isVisible(seriesId, [deniedGroupId])).toBe(true);

            // Consistency: season (same guarded builder) and episode (the
            // unmodified ELSE own-file branch) must agree with the series —
            // this is exactly the desync review verified pre-fix (series
            // HIDDEN, season/episode still VISIBLE).
            expect(await isVisible(seasonId, [deniedGroupId])).toBe(true);
            expect(await isVisible(episodeId, [deniedGroupId])).toBe(true);
        });

        // C7 (2026-09-16 security review 3, task 4): `isMediaAccessible` /
        // `checkMediaAccess` never received this own-column disjunct — only
        // `buildLibraryAccessFilter` (probed above via `isVisible`) did. The
        // fix collapses `isMediaAccessible` onto this same builder, so these
        // two cases now probe the imperative primitive directly instead of
        // the builder, in both directions the standing ruling requires.
        it('checkMediaAccess denies a file-less tv stub naming a denied library_group_id (C7)', async () => {
            const tag = `C7Check${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const seriesId = randomUUID();
            mediaIds.push(seriesId);
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status, library_group_id)
                VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active', ${deniedGroupId}::uuid)
            `;
            await restrictGroupTo(deniedGroupId, 'adults');

            expect(await checkMediaAccess(sql, seriesId, userIn('kids'))).toBe(false);

            // Control: a user allowed the group still sees it (not a blanket deny).
            expect(await checkMediaAccess(sql, seriesId, userIn('adults'))).toBe(true);
        });

        it('checkMediaAccess still allows a container whose own denied library_group_id is stale but a descendant file is non-denied (C7, sticky-column desync)', async () => {
            const tag = `C7Sticky${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Denied`);
            const allowedGroupId = await insertGroup(`${tag} Allowed`);

            const seriesId = randomUUID();
            const seasonId = randomUUID();
            const episodeId = randomUUID();
            const fileId = randomUUID();
            mediaIds.push(seriesId, seasonId, episodeId);
            fileIds.push(fileId);

            // Series' own library_group_id names the DENIED group (as if
            // first scanned there), but its only episode file lives in the
            // ALLOWED group — the exact sticky-column state a real library
            // reaches (insertScannedMediaItem sets it once; backfill only
            // ever writes WHERE library_group_id IS NULL).
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status, library_group_id)
                VALUES (${seriesId}::uuid, ${`${tag} Series`}, 'tv', NULL, 'active', ${deniedGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status)
                VALUES (${seasonId}::uuid, ${`${tag} Season 1`}, 'season', ${seriesId}::uuid, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, status)
                VALUES (${episodeId}::uuid, ${`${tag} Episode 1`}, 'episode', ${seasonId}::uuid, 'active')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id)
                VALUES (${fileId}::uuid, ${`/test/${episodeId}.mkv`}, ${allowedGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${episodeId}::uuid)
            `;
            await restrictGroupTo(deniedGroupId, 'adults');

            // Consistent with the season/episode below it — a user denied
            // only the (stale) series-own group must not lose the series row
            // while its playable content stays visible.
            expect(await checkMediaAccess(sql, seriesId, userIn('kids'))).toBe(true);
            expect(await checkMediaAccess(sql, seasonId, userIn('kids'))).toBe(true);
            expect(await checkMediaAccess(sql, episodeId, userIn('kids'))).toBe(true);
        });
    });

    // -------------------------------------------------------------------
    // Shape B — the own-column backstop generalised beyond containers
    // (security fix-plan-4, task 4, 2026-09-18)
    //
    // Review 4 named the general rule the "own-column declared affiliation"
    // fix above only applied to `tv`/`season`/`artist`/`album`: EVERY other
    // media type's `ELSE` branch passes a file-less row UNCONDITIONALLY, and
    // the own-column backstop's `media_type NOT IN (...)` guard made sure it
    // never even reached the own-column check for those types. The fix
    // deletes that guard and replaces the backstop's `ELSE FALSE` rescue arm
    // with a positive EXISTS over the row's OWN files — the same test the
    // four container branches already run, applied to a leaf row.
    // -------------------------------------------------------------------

    describe('Shape B — own-column backstop generalised beyond containers', () => {
        // `isVisible()` is the outer-scope helper defined above, shared with
        // the "own-column declared affiliation" describe block — not
        // redefined here.

        it('a file-less audiobook row naming a denied library_group_id is hidden', async () => {
            const tag = `ShapeBAudiobook${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const audiobookId = randomUUID();
            mediaIds.push(audiobookId);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, library_group_id)
                VALUES (${audiobookId}::uuid, ${`${tag} Audiobook`}, 'audiobook', 'active', false, ${deniedGroupId}::uuid)
            `;

            expect(await isVisible(audiobookId, [deniedGroupId])).toBe(false);

            // Control: unrestricted access still sees it (not a blanket deny).
            expect(await isVisible(audiobookId, [randomUUID()])).toBe(true);
        });

        it('a file-less product row naming a denied library_group_id is hidden', async () => {
            const tag = `ShapeBProduct${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const productId = randomUUID();
            mediaIds.push(productId);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, library_group_id)
                VALUES (${productId}::uuid, ${`${tag} Product`}, 'product', 'active', false, ${deniedGroupId}::uuid)
            `;

            expect(await isVisible(productId, [deniedGroupId])).toBe(false);
            expect(await isVisible(productId, [randomUUID()])).toBe(true);
        });

        it('a movie that lost its files but still names a denied library_group_id is hidden', async () => {
            const tag = `ShapeBMovie${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const movieId = randomUUID();
            mediaIds.push(movieId);
            // has_files=false and zero media_file_items rows — the state a
            // scanned movie reaches after its last file is removed
            // (recomputeHasFilesBatch flips has_files; the row survives with
            // a stale own library_group_id).
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, library_group_id)
                VALUES (${movieId}::uuid, ${`${tag} Movie`}, 'movie', 'active', false, ${deniedGroupId}::uuid)
            `;

            expect(await isVisible(movieId, [deniedGroupId])).toBe(false);
            expect(await isVisible(movieId, [randomUUID()])).toBe(true);
        });

        it('regression guard: a multi-version movie whose own library_group_id is a stale DENIED group but whose current file is in an ALLOWED group stays visible', async () => {
            const tag = `ShapeBMultiVersion${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Denied`);
            const allowedGroupId = await insertGroup(`${tag} Allowed`);
            const movieId = randomUUID();
            const fileId = randomUUID();
            mediaIds.push(movieId);
            fileIds.push(fileId);

            // Movie's own library_group_id names the DENIED group (as if
            // first scanned there), but its current media_file_items row is
            // in the ALLOWED group — the exact multi-version desync
            // `a07d051b4` fixed for containers, reintroduced for leaves by a
            // one-line (guard-delete-only) generalisation. This is why the
            // fix also replaces `ELSE FALSE` with a positive EXISTS instead
            // of just deleting the `media_type NOT IN (...)` guard.
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, library_group_id)
                VALUES (${movieId}::uuid, ${`${tag} Movie`}, 'movie', 'active', true, ${deniedGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id)
                VALUES (${fileId}::uuid, ${`/test/${movieId}.mkv`}, ${allowedGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${movieId}::uuid)
            `;

            expect(await isVisible(movieId, [deniedGroupId])).toBe(true);
        });

        it('a file-less audiobook row with library_group_id IS NULL stays visible (not a blanket deny)', async () => {
            const tag = `ShapeBNull${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const audiobookId = randomUUID();
            mediaIds.push(audiobookId);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files)
                VALUES (${audiobookId}::uuid, ${`${tag} Audiobook`}, 'audiobook', 'active', false)
            `;

            expect(await isVisible(audiobookId, [deniedGroupId])).toBe(true);
        });

        // C6 is decoupled from this fix — see the ledger's Shape B ruling and
        // `library-access.builder.ts`'s "Generalised beyond the four
        // container types" doc section. A `tvchannel` row never carries a
        // `library_group_id` (no such column exists anywhere in the Live TV
        // data model), so the generalised backstop is a NO-OP for it: this
        // pins that fact so the next reader does not mistake this filter for
        // a channel gate. The only real control over a `tvchannel` row is
        // `hasLiveTvPermission`, enforced at the route layer and covered by
        // its own test in `j/Items/[itemId]/server.test.ts` (C6).
        it('a tvchannel row (library_group_id always NULL) is still visible through this filter — the library axis does not and cannot gate Live TV; hasLiveTvPermission is the only control', async () => {
            const tag = `ShapeBTvChannel${randomUUID().slice(0, 8)}`;
            const deniedGroupId = await insertGroup(`${tag} Group`);
            const channelId = randomUUID();
            mediaIds.push(channelId);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_poster_url)
                VALUES (${channelId}::uuid, ${`${tag} Channel`}, 'tvchannel', 'active', NULL)
            `;

            expect(await isVisible(channelId, [deniedGroupId])).toBe(true);
        });
    });
});

/** Fill in the required BrowseItemsOptions fields with harmless defaults. */
function browseOpts(
    overrides: Partial<Parameters<typeof browseMediaItems>[1]> &
        Pick<Parameters<typeof browseMediaItems>[1], 'mediaTypes'>,
): Parameters<typeof browseMediaItems>[1] {
    return {
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: false,
        userId: undefined,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 500,
        startIndex: 0,
        access: unrestrictedAccess(),
        ...overrides,
    };
}
