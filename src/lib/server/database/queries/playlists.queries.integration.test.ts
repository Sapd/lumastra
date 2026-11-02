// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Playlists Query Module
 *
 * Tests playlist CRUD, items, watched status, membership, and progress.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    generateTestUserId,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { placeInLibraryGroup } from '../../../../../tests/integration/fixtures/index.js';
import { TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { toUserId } from '$lib/shared/user-id.js';

import {
    createPlaylist,
    getPlaylistById,
    getOwnedPlaylists,
    getSharedPlaylists,
    getPlaylistItems,
    insertPlaylistItem,
    deletePlaylistItemAndReorder,
    getPlaylistSummary,
    updatePlaylist,
    upsertWatchedStatus,
    getPlaylistMembers,
    inviteMember,
    acceptInvite,
    deleteMember,
    deleteInvite,
    updateMemberRole,
    getPlaylistInvite,
    getPlaylistWatchProgress,
    checkPlaylistMembership,
    getPlaylistItemIds,
    resolveEpisodeContext,
    getMemberPlaylistProgress,
    getPlaylistItemWatchers,
    getPublicPlaylists,
    touchPlaylist,
    type PlaylistRow,
} from './playlists.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

/**
 * Explicit unrestricted boundary for the many assertions in this file that are
 * not about access at all. `getOwnedPlaylists` and friends no longer accept an
 * omitted access argument, which is the point: an unfiltered query is now
 * greppable instead of invisible.
 */
const UNRESTRICTED = unrestrictedAccess();

describe('Playlists Queries', () => {
    let sql: postgres.Sql;
    const owner = generateTestUserId();
    const member = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Truncate media tables to prevent duplicate external_ids when
        // createAndInsertTestMovie randomly reuses the same sample tmdbId.
        await truncateTables(sql, TEST_TABLES.media);
        // Clean playlist-related tables for both test users
        await sql`DELETE FROM playlist_item_watched WHERE user_id IN (${owner}::uuid, ${member}::uuid)`;
        await sql`DELETE FROM playlist_members WHERE user_id IN (${owner}::uuid, ${member}::uuid)`;
        await sql`DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id IN (${owner}::uuid, ${member}::uuid))`;
        await sql`DELETE FROM playlists WHERE user_id IN (${owner}::uuid, ${member}::uuid)`;
        await ensureTestUser(sql, owner);
        await ensureTestUser(sql, member);
    });

    async function makePlaylist(name = 'Test Playlist') {
        return createPlaylist(sql, owner, name, null, 'private', 'general');
    }

    // ========================================================================
    // createPlaylist / getPlaylistById
    // ========================================================================

    describe('createPlaylist / getPlaylistById', () => {
        it('creates a playlist and retrieves it by id', async () => {
            const playlist = await makePlaylist('My Playlist');
            expect(playlist.name).toBe('My Playlist');
            expect(playlist.user_id).toBe(owner);

            const fetched = await getPlaylistById(sql, playlist.id);
            expect(fetched).not.toBeNull();
            expect(fetched!.id).toBe(playlist.id);
        });

        it('returns null for unknown playlist id', async () => {
            const result = await getPlaylistById(sql, 999999);
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // getOwnedPlaylists
    // ========================================================================

    describe('getOwnedPlaylists', () => {
        it('returns playlists owned by user', async () => {
            await makePlaylist('Owned A');
            await makePlaylist('Owned B');

            const list = await getOwnedPlaylists(sql, owner, undefined, UNRESTRICTED);
            expect(list.length).toBe(2);
            expect(list.every((p) => p.user_id === owner)).toBe(true);
        });

        it('filters by playlist type when provided', async () => {
            await createPlaylist(sql, owner, 'Music List', null, 'public', 'music');
            await createPlaylist(sql, owner, 'Video List', null, 'public', 'video');

            const musicLists = await getOwnedPlaylists(sql, owner, 'music', UNRESTRICTED);
            expect(musicLists.length).toBe(1);
            expect(musicLists[0].playlist_type).toBe('music');
        });
    });

    // ========================================================================
    // updatePlaylist
    // ========================================================================

    describe('updatePlaylist', () => {
        it('updates playlist name', async () => {
            const playlist = await makePlaylist('Old Name');
            const updated = await updatePlaylist(sql, playlist.id, {
                name: 'New Name',
            });
            expect(updated).not.toBeNull();
            expect(updated!.name).toBe('New Name');
        });

        it('returns null when no updates provided', async () => {
            const playlist = await makePlaylist('No Change');
            const updated = await updatePlaylist(sql, playlist.id, {});
            expect(updated).toBeNull();
        });
    });

    // ========================================================================
    // insertPlaylistItem / getPlaylistItems
    // ========================================================================

    describe('insertPlaylistItem / getPlaylistItems', () => {
        it('adds an item and retrieves it', async () => {
            const playlist = await makePlaylist();
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            const inserted = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Test Movie',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            expect(inserted).not.toBeNull();

            const items = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED);
            expect(items.length).toBe(1);
            expect(items[0].media_id).toBe(mediaId);
        });

        it('adds items with auto-computed positions', async () => {
            const playlist = await makePlaylist();
            const { id: mediaId1 } = await createAndInsertTestMovie(sql);
            const { id: mediaId2 } = await createAndInsertTestMovie(sql);

            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: mediaId1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Movie 1',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: mediaId2,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Movie 2',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const items = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED);
            expect(items[0].position).toBe(0);
            expect(items[1].position).toBe(1);
        });
    });

    // ========================================================================
    // deletePlaylistItemAndReorder
    // ========================================================================

    describe('deletePlaylistItemAndReorder', () => {
        it('deletes an item and reorders subsequent items', async () => {
            const playlist = await makePlaylist();
            const { id: m1 } = await createAndInsertTestMovie(sql);
            const { id: m2 } = await createAndInsertTestMovie(sql);
            const { id: m3 } = await createAndInsertTestMovie(sql);

            const i1 = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m2,
                seasonNumber: null,
                episodeNumber: null,
                title: 'B',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m3,
                seasonNumber: null,
                episodeNumber: null,
                title: 'C',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const deletedPos = await deletePlaylistItemAndReorder(sql, i1!.id, playlist.id);
            expect(deletedPos).toBe(0);

            const items = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED);
            expect(items.length).toBe(2);
            expect(items[0].position).toBe(0);
            expect(items[1].position).toBe(1);
        });
    });

    // ========================================================================
    // getPlaylistSummary
    // ========================================================================

    describe('getPlaylistSummary', () => {
        it('increments an integer revision with entry mutations, preserving it across metadata edits', async () => {
            const playlist = await makePlaylist();
            expect((await getPlaylistSummary(sql, playlist.id)).revision).toBe(0);
            await touchPlaylist(sql, playlist.id);
            await touchPlaylist(sql, playlist.id);
            await updatePlaylist(sql, playlist.id, { name: 'Renamed' });
            expect((await getPlaylistById(sql, playlist.id))?.revision).toBe(2);
            expect((await getPlaylistSummary(sql, playlist.id)).revision).toBe(2);
        });
        it('returns item count and updated_at', async () => {
            const playlist = await makePlaylist();
            const { id: m1 } = await createAndInsertTestMovie(sql);
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const summary = await getPlaylistSummary(sql, playlist.id);
            expect(summary.itemCount).toBe(1);
            expect(summary.revision).toBe(0);
            expect(typeof summary.updatedAt).toBe('string');
        });
    });

    // ========================================================================
    // upsertWatchedStatus
    // ========================================================================

    describe('upsertWatchedStatus', () => {
        it('marks an item as watched', async () => {
            const playlist = await makePlaylist();
            const { id: m1 } = await createAndInsertTestMovie(sql);
            const item = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const result = await upsertWatchedStatus(sql, playlist.id, item!.id, owner, true);
            expect(result.watched).toBe(true);
            expect(result.watched_at).not.toBeNull();
        });

        it('unmarks an item as watched', async () => {
            const playlist = await makePlaylist();
            const { id: m1 } = await createAndInsertTestMovie(sql);
            const item = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            await upsertWatchedStatus(sql, playlist.id, item!.id, owner, true);
            const result = await upsertWatchedStatus(sql, playlist.id, item!.id, owner, false);
            expect(result.watched).toBe(false);
            expect(result.watched_at).toBeNull();
        });
    });

    // ========================================================================
    // getPlaylistMembers / inviteMember / acceptInvite / deleteMember
    // ========================================================================

    describe('Playlist membership', () => {
        it('invites and lists a member', async () => {
            const playlist = await makePlaylist();
            const invited = await inviteMember(sql, playlist.id, member, 'readonly');
            // The returned row resolves the login name (not the bare UUID)
            expect(invited.username).toBe(derivedUsername(member));

            const members = await getPlaylistMembers(sql, playlist.id);
            const row = members.find((m) => m.user_id === member);
            expect(row).toBeDefined();
            // Regression: getPlaylistMembers must resolve username, never echo the UUID
            expect(row?.username).toBe(derivedUsername(member));
            expect(row?.username).not.toBe(member);
        });

        it('accepts an invite', async () => {
            const playlist = await makePlaylist();
            await inviteMember(sql, playlist.id, member, 'editor');
            await acceptInvite(sql, playlist.id, member);

            const members = await getPlaylistMembers(sql, playlist.id);
            const m = members.find((x) => x.user_id === member);
            expect(m?.status).toBe('accepted');
        });

        it('deletes a member', async () => {
            const playlist = await makePlaylist();
            await inviteMember(sql, playlist.id, member, 'readonly');
            await deleteMember(sql, playlist.id, member);

            const members = await getPlaylistMembers(sql, playlist.id);
            expect(members.some((m) => m.user_id === member)).toBe(false);
        });
    });

    // ========================================================================
    // checkPlaylistMembership
    // ========================================================================

    describe('checkPlaylistMembership', () => {
        it('returns rows when user is owner', async () => {
            const playlist = await makePlaylist();
            const rows = await checkPlaylistMembership(sql, playlist.id, owner);
            expect(rows.length).toBeGreaterThan(0);
        });

        it('returns rows when user is accepted member', async () => {
            const playlist = await makePlaylist();
            await inviteMember(sql, playlist.id, member, 'readonly');
            await acceptInvite(sql, playlist.id, member);

            const rows = await checkPlaylistMembership(sql, playlist.id, member);
            expect(rows.length).toBeGreaterThan(0);
        });

        it('returns no rows for non-member', async () => {
            const playlist = await makePlaylist();
            const rows = await checkPlaylistMembership(
                sql,
                playlist.id,
                toUserId('00000000-0000-0000-0000-000000000099'),
            );
            expect(rows.length).toBe(0);
        });
    });

    // ========================================================================
    // getPlaylistWatchProgress
    // ========================================================================

    describe('getPlaylistWatchProgress', () => {
        it('returns watched counts for a playlist', async () => {
            const playlist = await makePlaylist();
            const { id: m1 } = await createAndInsertTestMovie(sql);
            const item = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await upsertWatchedStatus(sql, playlist.id, item!.id, owner, true);

            const progress = await getPlaylistWatchProgress(sql, [playlist.id], owner);
            expect(progress.length).toBe(1);
            expect(progress[0].watched_items).toBe(1);
            expect(progress[0].total_items).toBe(1);
        });
    });

    // ========================================================================
    // getPlaylistItemIds
    // ========================================================================

    describe('getPlaylistItemIds', () => {
        it('returns the playlist item ids', async () => {
            const playlist = await makePlaylist();
            const { id: m1 } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-playlist-001',
            });
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: m1,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const rows = await getPlaylistItemIds(sql, playlist.id);
            expect(rows.length).toBe(1);
            expect(rows[0]).toEqual({ id: expect.any(Number) });
        });
    });

    // ========================================================================
    // getMemberPlaylistProgress
    // ========================================================================

    describe('getMemberPlaylistProgress', () => {
        it('returns progress for owner and members', async () => {
            const playlist = await makePlaylist();
            await inviteMember(sql, playlist.id, member, 'readonly');
            await acceptInvite(sql, playlist.id, member);

            const progress = await getMemberPlaylistProgress(sql, playlist.id);
            const ids = progress.map((p) => p.user_id);
            expect(ids).toContain(owner);
            expect(ids).toContain(member);
            // Regression: progress rows resolve the login name, not the UUID
            const memberRow = progress.find((p) => p.user_id === member);
            expect(memberRow?.username).toBe(derivedUsername(member));
        });
    });

    // ========================================================================
    // getSharedPlaylists
    // ========================================================================

    describe('getSharedPlaylists', () => {
        it('returns accepted shared playlists with role and resolved owner_username', async () => {
            const playlist = await makePlaylist('Shared A');
            await inviteMember(sql, playlist.id, member, 'editor');
            await acceptInvite(sql, playlist.id, member);

            const shared = await getSharedPlaylists(sql, member, undefined, UNRESTRICTED);
            const row = shared.find((p) => p.id === playlist.id);
            expect(row).toBeDefined();
            expect(row?.role).toBe('editor');
            // owner_username must be the owner's login name, not the UUID
            expect(row?.owner_username).toBe(derivedUsername(owner));
        });

        it('excludes playlists with a pending (not accepted) invite', async () => {
            const playlist = await makePlaylist('Pending Shared');
            await inviteMember(sql, playlist.id, member, 'readonly');
            // no acceptInvite

            const shared = await getSharedPlaylists(sql, member, undefined, UNRESTRICTED);
            expect(shared.some((p) => p.id === playlist.id)).toBe(false);
        });

        it('filters shared playlists by playlist type', async () => {
            const musicList = await createPlaylist(
                sql,
                owner,
                'Shared Music',
                null,
                'private',
                'music',
            );
            const videoList = await createPlaylist(
                sql,
                owner,
                'Shared Video',
                null,
                'private',
                'video',
            );
            for (const pl of [musicList, videoList]) {
                await inviteMember(sql, pl.id, member, 'readonly');
                await acceptInvite(sql, pl.id, member);
            }

            const musicShared = await getSharedPlaylists(sql, member, 'music', UNRESTRICTED);
            expect(musicShared.some((p) => p.id === musicList.id)).toBe(true);
            expect(musicShared.some((p) => p.id === videoList.id)).toBe(false);
        });
    });

    // ========================================================================
    // owner_username resolution (regression for the UUID-as-username bug)
    // ========================================================================

    describe('owner_username resolution', () => {
        it('getOwnedPlaylists resolves the owner login name', async () => {
            await makePlaylist('Owned With Owner');
            const owned = await getOwnedPlaylists(sql, owner, undefined, UNRESTRICTED);
            expect(owned.length).toBeGreaterThan(0);
            expect(owned[0].owner_username).toBe(derivedUsername(owner));
            expect(owned[0].owner_username).not.toBe(owner);
        });

        it('getPlaylistById resolves the owner login name', async () => {
            const playlist = await makePlaylist('By Id With Owner');
            const fetched = await getPlaylistById(sql, playlist.id);
            expect(fetched?.owner_username).toBe(derivedUsername(owner));
        });
    });

    // ========================================================================
    // getPlaylistItems — music vs video item-type filtering
    // ========================================================================

    describe('getPlaylistItems item-type filtering', () => {
        async function makeMixedPlaylist() {
            const playlist = await makePlaylist('Mixed');
            const { id: movieId } = await createAndInsertTestMovie(sql);
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });

            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: movieId,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A Movie',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: trackIds[0],
                seasonNumber: null,
                episodeNumber: null,
                title: 'A Track',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            return playlist;
        }

        it('returns only music items when itemType is "music"', async () => {
            const playlist = await makeMixedPlaylist();
            const items = await getPlaylistItems(sql, playlist.id, owner, 'music', UNRESTRICTED);
            expect(items.length).toBe(1);
            expect(items[0].media_type).toBe('track');
        });

        it('returns only video items when itemType is "video"', async () => {
            const playlist = await makeMixedPlaylist();
            const items = await getPlaylistItems(sql, playlist.id, owner, 'video', UNRESTRICTED);
            expect(items.length).toBe(1);
            expect(items[0].media_type).toBe('movie');
        });

        it('returns both video and music items when itemType is omitted', async () => {
            const playlist = await makeMixedPlaylist();
            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            const types = items.map((i) => i.media_type).sort();
            expect(types).toEqual(['movie', 'track']);
        });
    });

    // ========================================================================
    // getPlaylistItems — per-viewer playback state (user_media_state join)
    // ========================================================================

    describe('getPlaylistItems playback state', () => {
        async function makePlaylistWithMovie() {
            const playlist = await makePlaylist('Resume');
            const { id: movieId } = await createAndInsertTestMovie(sql);
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: movieId,
                seasonNumber: null,
                episodeNumber: null,
                title: 'A Movie',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            return { playlist, movieId };
        }

        async function setWatchState(
            userId: string,
            mediaId: string,
            state: {
                resumeMs: number;
                runtimeMs: number | null;
                isWatched: boolean;
                lastEventAt: string;
            },
        ) {
            await sql`
                INSERT INTO user_media_state
                    (user_id, media_id, is_watched, resume_position_ms, runtime_ms, last_event_at)
                VALUES (
                    ${userId}::uuid, ${mediaId}::uuid, ${state.isWatched},
                    ${state.resumeMs}, ${state.runtimeMs}, ${state.lastEventAt}
                )
                ON CONFLICT (user_id, media_id) DO UPDATE SET
                    is_watched = EXCLUDED.is_watched,
                    resume_position_ms = EXCLUDED.resume_position_ms,
                    runtime_ms = EXCLUDED.runtime_ms,
                    last_event_at = EXCLUDED.last_event_at
            `;
        }

        it('returns the viewer resume position, runtime and last activity', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await setWatchState(owner, movieId, {
                resumeMs: 1891000,
                runtimeMs: 3502000,
                isWatched: false,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items.length).toBe(1);
            expect(items[0].resume_position_ms).toBe(1891000);
            expect(items[0].runtime_ms).toBe(3502000);
            expect(items[0].playback_watched).toBe(false);
            expect(new Date(items[0].last_played_at!).toISOString()).toBe(
                '2026-07-18T12:50:24.190Z',
            );
        });

        it('leaves per-viewer playback state null when the item was never played', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = NULL WHERE id = ${movieId}::uuid`;
            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items[0].resume_position_ms).toBeNull();
            expect(items[0].runtime_ms).toBeNull();
            expect(items[0].playback_watched).toBeNull();
            expect(items[0].last_played_at).toBeNull();
        });

        // Runtime is item metadata, not watch state — a fresh playlist nobody has
        // played must still report durations so clients can total the runtime.
        it('emits the catalog runtime with no playback state at all', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 3502 WHERE id = ${movieId}::uuid`;

            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items[0].runtime_ms).toBe(3502000);
            expect(items[0].resume_position_ms).toBeNull();
            expect(items[0].playback_watched).toBeNull();
        });

        it('emits the catalog runtime on the anonymous branch too', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 3502 WHERE id = ${movieId}::uuid`;

            const items = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED);
            expect(items[0].runtime_ms).toBe(3502000);
            expect(items[0].resume_position_ms).toBeNull();
        });

        // LEAST() IGNORES nulls, so an unguarded clamp returns 2147483647 for an
        // item with no runtime from either source. Assert the actual value, not
        // just "falsy" — that is what makes this a regression test.
        it('returns null (never the int32 clamp) when no runtime is known', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = NULL WHERE id = ${movieId}::uuid`;

            for (const viewer of [owner, null]) {
                const items = await getPlaylistItems(
                    sql,
                    playlist.id,
                    viewer,
                    undefined,
                    UNRESTRICTED,
                );
                expect(items[0].runtime_ms).toBeNull();
                expect(items[0].runtime_ms).not.toBe(2147483647);
            }
        });

        // runtime_seconds is int4 with no CHECK constraint. int4 * 1000 RAISES
        // 'integer out of range' rather than wrapping, and it raises while
        // evaluating LEAST's own argument — so a single corrupt row used to 500
        // the whole playlist instead of just omitting its duration.
        it('survives a runtime_seconds large enough to overflow int4 * 1000', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 2147484 WHERE id = ${movieId}::uuid`;

            for (const viewer of [owner, null]) {
                const items = await getPlaylistItems(
                    sql,
                    playlist.id,
                    viewer,
                    undefined,
                    UNRESTRICTED,
                );
                expect(items).toHaveLength(1);
                expect(items[0].runtime_ms).toBe(2147483647); // clamped, not thrown
            }
        });

        it('treats a zero catalog runtime as unknown, not as a zero-length item', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 0 WHERE id = ${movieId}::uuid`;

            for (const viewer of [owner, null]) {
                const items = await getPlaylistItems(
                    sql,
                    playlist.id,
                    viewer,
                    undefined,
                    UNRESTRICTED,
                );
                expect(items[0].runtime_ms).toBeNull();
            }
        });

        // A corrupt negative session runtime must not win the COALESCE and
        // discard a perfectly usable catalog runtime.
        it('falls back to the catalog runtime when the session runtime is negative', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 3502 WHERE id = ${movieId}::uuid`;
            await setWatchState(owner, movieId, {
                resumeMs: 1000,
                runtimeMs: -500,
                isWatched: false,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items[0].runtime_ms).toBe(3502000);
        });

        it('prefers the recorded session runtime over the catalog runtime', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 3502 WHERE id = ${movieId}::uuid`;
            await setWatchState(owner, movieId, {
                resumeMs: 1000,
                runtimeMs: 4000000,
                isWatched: false,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items[0].runtime_ms).toBe(4000000);
        });

        it('scopes playback state to the viewer, not the playlist owner', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await setWatchState(owner, movieId, {
                resumeMs: 1891000,
                runtimeMs: 3502000,
                isWatched: false,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const asMember = await getPlaylistItems(
                sql,
                playlist.id,
                member,
                undefined,
                UNRESTRICTED,
            );
            expect(asMember[0].resume_position_ms).toBeNull();
            expect(asMember[0].playback_watched).toBeNull();
        });

        it('falls back to the catalog runtime when no session runtime was recorded', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await sql`UPDATE media_items SET runtime_seconds = 3502 WHERE id = ${movieId}::uuid`;
            await setWatchState(owner, movieId, {
                resumeMs: 1891000,
                runtimeMs: null,
                isWatched: false,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items[0].runtime_ms).toBe(3502000);
        });

        it('reports a completed item with a zeroed resume position', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await setWatchState(owner, movieId, {
                resumeMs: 0,
                runtimeMs: 3502000,
                isWatched: true,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const items = await getPlaylistItems(sql, playlist.id, owner, undefined, UNRESTRICTED);
            expect(items[0].resume_position_ms).toBe(0);
            expect(items[0].playback_watched).toBe(true);
        });

        it('returns null playback state on the anonymous branch', async () => {
            const { playlist, movieId } = await makePlaylistWithMovie();
            await setWatchState(owner, movieId, {
                resumeMs: 1891000,
                runtimeMs: 3502000,
                isWatched: false,
                lastEventAt: '2026-07-18T12:50:24.190Z',
            });

            const items = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED);
            expect(items[0].resume_position_ms).toBeNull();
            expect(items[0].runtime_ms).toBeNull();
            expect(items[0].playback_watched).toBeNull();
            expect(items[0].last_played_at).toBeNull();
        });
    });

    // ========================================================================
    // getPlaylistInvite / updateMemberRole / deleteInvite
    // ========================================================================

    describe('getPlaylistInvite', () => {
        it('returns the pending invite with role, status and resolved owner_username', async () => {
            const playlist = await makePlaylist('Invite Me');
            await inviteMember(sql, playlist.id, member, 'editor');

            const invite = await getPlaylistInvite(sql, playlist.id, member);
            expect(invite).not.toBeNull();
            expect(invite?.status).toBe('pending');
            expect(invite?.role).toBe('editor');
            expect(invite?.playlist_name).toBe('Invite Me');
            expect(invite?.user_id).toBe(owner);
            expect(invite?.owner_username).toBe(derivedUsername(owner));
        });

        it('returns null when the user has no membership row', async () => {
            const playlist = await makePlaylist('No Invite');
            // owner is the playlist owner, not a member row → no invite
            const invite = await getPlaylistInvite(sql, playlist.id, owner);
            expect(invite).toBeNull();
        });
    });

    describe('updateMemberRole', () => {
        it('updates the role and returns the resolved username', async () => {
            const playlist = await makePlaylist('Role Update');
            await inviteMember(sql, playlist.id, member, 'readonly');

            const updated = await updateMemberRole(sql, playlist.id, member, 'editor');
            expect(updated?.role).toBe('editor');
            expect(updated?.username).toBe(derivedUsername(member));
        });

        it('returns null for a user with no membership row', async () => {
            const playlist = await makePlaylist('Role Update Missing');
            const updated = await updateMemberRole(sql, playlist.id, member, 'editor');
            expect(updated).toBeNull();
        });
    });

    describe('deleteInvite', () => {
        it('removes the membership row', async () => {
            const playlist = await makePlaylist('Delete Invite');
            await inviteMember(sql, playlist.id, member, 'readonly');
            await deleteInvite(sql, playlist.id, member);

            const members = await getPlaylistMembers(sql, playlist.id);
            expect(members.some((m) => m.user_id === member)).toBe(false);
        });
    });

    // ========================================================================
    // getPlaylistItemWatchers
    // ========================================================================

    describe('getPlaylistItemWatchers', () => {
        it('returns (item_id, user_id) pairs for watched items only', async () => {
            const playlist = await makePlaylist('Watchers');
            const { id: movieId } = await createAndInsertTestMovie(sql);
            const item = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: movieId,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Watched Movie',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await upsertWatchedStatus(sql, playlist.id, item!.id, owner, true);

            const watchers = await getPlaylistItemWatchers(sql, playlist.id);
            expect(watchers).toHaveLength(1);
            expect(watchers[0].item_id).toBe(item!.id);
            expect(watchers[0].user_id).toBe(owner);
        });

        it('does not return items that were marked then unwatched', async () => {
            const playlist = await makePlaylist('Unwatched');
            const { id: movieId } = await createAndInsertTestMovie(sql);
            const item = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: movieId,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Toggled Movie',
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            await upsertWatchedStatus(sql, playlist.id, item!.id, owner, true);
            await upsertWatchedStatus(sql, playlist.id, item!.id, owner, false);

            const watchers = await getPlaylistItemWatchers(sql, playlist.id);
            expect(watchers).toHaveLength(0);
        });
    });

    // ========================================================================
    // cover-item primary_ext_id resolution (getOwnedPlaylists collage)
    // ========================================================================

    describe('cover item primary_ext_id', () => {
        it('resolves the primary external id for a movie cover item', async () => {
            const playlist = await makePlaylist('Movie Cover');
            const { id: movieId, tmdbId } = await createAndInsertTestMovie(sql);
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: movieId,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Cover Movie',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const owned = await getOwnedPlaylists(sql, owner, undefined, UNRESTRICTED);
            const row = owned.find((p) => p.id === playlist.id);
            const cover = row?.cover_items?.[0];
            expect(cover).toBeDefined();
            // ELSE branch of the media_type CASE: movie ext id stored under 'movie'
            expect(cover?.primary_ext_id).toBe(String(tmdbId));
        });

        it('resolves the primary external id for an episode cover item via the tv media_type', async () => {
            // An episode playlist item carries season+episode numbers; its TMDB id
            // lives in external_ids under media_type='tv' (episodes are part of the
            // series). The cover subquery must look up 'tv', not the row's own
            // media_type — regression guard for the episode CASE branch.
            const playlist = await makePlaylist('Episode Cover');
            const { id: tvId, tmdbId } = await createAndInsertTestTvShow(sql);
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: tvId,
                seasonNumber: 1,
                episodeNumber: 3,
                title: 'Cover Episode',
                seriesName: 'Cover Series',
                overview: null,
                posterPath: null,
            });

            const owned = await getOwnedPlaylists(sql, owner, undefined, UNRESTRICTED);
            const row = owned.find((p) => p.id === playlist.id);
            const cover = row?.cover_items?.[0];
            expect(cover).toBeDefined();
            expect(cover?.media_type).toBe('episode');
            expect(cover?.primary_ext_id).toBe(String(tmdbId));
        });
    });

    // ========================================================================
    // cover-collage diversification (de-dupe + pull from across the playlist)
    // ========================================================================

    describe('cover collage diversification', () => {
        it('collapses same-series episodes and pulls distinct series by position', async () => {
            const playlist = await makePlaylist('Diverse Anime');
            // Explicit, distinct tmdb ids — the fixture otherwise picks a random
            // sample id, which collides on external_ids' unique key across calls.
            const a = await createAndInsertTestTvShow(sql, { tmdbId: 990001 });
            const b = await createAndInsertTestTvShow(sql, { tmdbId: 990002 });
            const c = await createAndInsertTestTvShow(sql, { tmdbId: 990003 });
            const d = await createAndInsertTestTvShow(sql, { tmdbId: 990004 });

            // Series A leads with 3 episodes (would otherwise fill the collage
            // with 3 identical series-art tiles), then one episode each of B/C/D.
            const layout = [
                { tv: a, ep: 1 },
                { tv: a, ep: 2 },
                { tv: a, ep: 3 },
                { tv: b, ep: 1 },
                { tv: c, ep: 1 },
                { tv: d, ep: 1 },
            ];
            for (const { tv, ep } of layout) {
                await insertPlaylistItem(sql, {
                    playlistId: playlist.id,
                    mediaId: tv.id,
                    seasonNumber: 1,
                    episodeNumber: ep,
                    title: `Ep ${ep}`,
                    seriesName: 'S',
                    overview: null,
                    posterPath: null,
                });
            }

            const owned = await getOwnedPlaylists(sql, owner, undefined, UNRESTRICTED);
            const covers = owned.find((p) => p.id === playlist.id)?.cover_items ?? [];
            const ids = covers.map((cv) => cv.primary_ext_id);

            // One tile per series — four distinct shows, no repeats.
            expect(ids).toHaveLength(4);
            expect(new Set(ids).size).toBe(4);
            for (const show of [a, b, c, d]) {
                expect(ids).toContain(String(show.tmdbId));
            }
            // Series A appears exactly once despite leading with 3 episodes.
            expect(ids.filter((id) => id === String(a.tmdbId))).toHaveLength(1);
        });
    });

    describe('cover item access filtering', () => {
        it('drops cover items above the viewer age limit', async () => {
            const userId = toUserId(generateTestUserId());
            await ensureTestUser(sql, userId);

            const playlist = await createPlaylist(sql, userId, 'Age Test', null, 'public', 'video');

            const kidsMovie = await createAndInsertTestMovie(sql);
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${kidsMovie.id}`;
            const adultMovie = await createAndInsertTestMovie(sql);
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adultMovie.id}`;

            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${playlist.id}, ${kidsMovie.id}, 'Kids', 0),
                       (${playlist.id}, ${adultMovie.id}, 'Adult', 1)
            `;

            const unrestricted = await getOwnedPlaylists(sql, userId, undefined, UNRESTRICTED);
            expect(unrestricted[0].cover_items).toHaveLength(2);

            const restricted = await getOwnedPlaylists(
                sql,
                userId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );
            expect(restricted[0].cover_items).toHaveLength(1);
            expect(restricted[0].cover_items?.[0].internal_id).toBe(kidsMovie.id);
        });

        it('keeps item_count unfiltered while filtering cover items', async () => {
            const userId = toUserId(generateTestUserId());
            await ensureTestUser(sql, userId);

            const playlist = await createPlaylist(
                sql,
                userId,
                'Count Test',
                null,
                'public',
                'video',
            );
            const adultMovie = await createAndInsertTestMovie(sql);
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adultMovie.id}`;

            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${playlist.id}, ${adultMovie.id}, 'Adult', 0)
            `;

            const restricted = await getOwnedPlaylists(
                sql,
                userId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );

            // itemCount reflects the playlist's real size; only the collage is filtered.
            expect(Number(restricted[0].item_count)).toBe(1);
            expect(restricted[0].cover_items ?? []).toHaveLength(0);
        });

        it('returns the playlist row with an EMPTY collage under a denyAll boundary', async () => {
            // Replaces the old 'defaults to no filtering when access is omitted'
            // test: omission is now a compile error, so the behaviour it pinned
            // no longer exists. denyAll was previously INEXPRESSIBLE.
            //
            // Note the assertion is over cover_items, not over rows: this
            // boundary filters the collage only, never the playlist row itself.
            const userId = toUserId(generateTestUserId());
            // 2-arg form: ensureTestUser derives its own username and the
            // 3-arg calls elsewhere in this file are a pre-existing type error.
            await ensureTestUser(sql, userId);

            const playlist = await createPlaylist(sql, userId, 'DenyAll', null, 'public', 'video');
            const movie = await createAndInsertTestMovie(sql);

            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${playlist.id}, ${movie.id}, 'Movie', 0)
            `;

            const open = await getOwnedPlaylists(sql, userId, undefined, UNRESTRICTED);
            expect(open[0].cover_items).toHaveLength(1);

            const closed = await getOwnedPlaylists(sql, userId, undefined, denyAllAccess());
            expect(closed).toHaveLength(1);
            expect(closed[0].cover_items ?? []).toHaveLength(0);
            // item_count stays unfiltered even under denyAll — pinned behaviour.
            expect(Number(closed[0].item_count)).toBe(1);
        });
    });

    // ========================================================================
    // Differential access-boundary tests
    //
    // These exist to catch what neither the type checker nor the token-presence
    // lint rule can see: an access argument that ARRIVED but was never used, a
    // predicate applied to the WRONG alias, or a filter injected into the wrong
    // subquery scope. Each runs the same query twice over one fixture and
    // asserts the restricted result is a STRICT subset of the unrestricted one.
    //
    // For the playlist-LIST queries the subset must be taken over `cover_items`
    // keyed by internal_id — NOT over the returned rows. The boundary there sits
    // inside a correlated target-list expression and filters only the collage;
    // the playlist row itself is never hidden. An assertion written as
    // "denyAll => zero rows" would be asserting the wrong contract and would
    // fail against correct code.
    // ========================================================================
    describe('access boundary — differential', () => {
        async function insertLibraryGroup(name: string): Promise<string> {
            const rows = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES (${name}) RETURNING id
            `;
            return rows[0].id;
        }

        async function linkFileWithGroup(mediaItemId: string, groupId: string): Promise<void> {
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id)
                VALUES (${`/data/pl-${crypto.randomUUID()}.mkv`}, ${groupId})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${file.id}, ${mediaItemId})
            `;
        }

        /**
         * Seed one playlist holding three movies: one freely visible, one whose
         * only file sits in `deniedGroup` (library axis), one rated 18 (age
         * axis). Returns the ids so each axis can be asserted independently.
         */
        async function seedMixedPlaylist(
            ownerId: ReturnType<typeof toUserId>,
            visibility: 'private' | 'public',
        ): Promise<{
            playlistId: number;
            openId: string;
            groupRestrictedId: string;
            adultId: string;
            deniedGroup: string;
        }> {
            const deniedGroup = await insertLibraryGroup(`Denied ${crypto.randomUUID()}`);
            const open = await createAndInsertTestMovie(sql);
            const grouped = await createAndInsertTestMovie(sql);
            const adult = await createAndInsertTestMovie(sql);
            await linkFileWithGroup(grouped.id, deniedGroup);
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.id}`;

            const playlist = await createPlaylist(
                sql,
                ownerId,
                'Boundary Fixture',
                null,
                visibility,
                'video',
            );
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${playlist.id}, ${open.id}, 'Open', 0),
                       (${playlist.id}, ${grouped.id}, 'Grouped', 1),
                       (${playlist.id}, ${adult.id}, 'Adult', 2)
            `;
            return {
                playlistId: playlist.id,
                openId: open.id,
                groupRestrictedId: grouped.id,
                adultId: adult.id,
                deniedGroup,
            };
        }

        const collageIds = (rows: PlaylistRow[]): string[] =>
            (rows[0]?.cover_items ?? []).map((c) => String(c.internal_id));

        it('getOwnedPlaylists: restricted collage is a strict subset; denyAll is empty', async () => {
            const userId = toUserId(generateTestUserId());
            await ensureTestUser(sql, userId);
            const seed = await seedMixedPlaylist(userId, 'private');

            const open = await getOwnedPlaylists(sql, userId, undefined, UNRESTRICTED);
            const openIds = collageIds(open);
            expect(openIds).toHaveLength(3);

            // Library axis: denying the group drops exactly the grouped item.
            const libRestricted = await getOwnedPlaylists(
                sql,
                userId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [seed.deniedGroup],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            const libIds = collageIds(libRestricted);
            expect(libIds.every((id) => openIds.includes(id))).toBe(true);
            expect(libIds.length).toBeLessThan(openIds.length);
            expect(libIds).not.toContain(seed.groupRestrictedId);
            expect(libIds).toContain(seed.openId);

            // Age axis: the 18-rated item drops, the others survive.
            const ageRestricted = await getOwnedPlaylists(
                sql,
                userId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            );
            const ageIds = collageIds(ageRestricted);
            expect(ageIds.every((id) => openIds.includes(id))).toBe(true);
            expect(ageIds).not.toContain(seed.adultId);
            expect(ageIds).toContain(seed.openId);

            // denyAll closes the collage entirely but keeps the playlist row.
            const closed = await getOwnedPlaylists(sql, userId, undefined, denyAllAccess());
            expect(closed).toHaveLength(1);
            expect(collageIds(closed)).toHaveLength(0);
        });

        it('getSharedPlaylists: restricted collage is a strict subset; denyAll is empty', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);
            const seed = await seedMixedPlaylist(ownerId, 'private');
            await inviteMember(sql, seed.playlistId, viewerId, 'readonly');
            await acceptInvite(sql, seed.playlistId, viewerId);

            const open = await getSharedPlaylists(sql, viewerId, undefined, UNRESTRICTED);
            const openIds = collageIds(open);
            expect(openIds).toHaveLength(3);

            const restricted = await getSharedPlaylists(
                sql,
                viewerId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [seed.deniedGroup],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            );
            const ids = collageIds(restricted);
            expect(ids.every((id) => openIds.includes(id))).toBe(true);
            expect(ids.length).toBeLessThan(openIds.length);
            expect(ids).toEqual([seed.openId]);

            const closed = await getSharedPlaylists(sql, viewerId, undefined, denyAllAccess());
            expect(closed).toHaveLength(1);
            expect(collageIds(closed)).toHaveLength(0);
        });

        it('getPublicPlaylists: restricted collage is a strict subset; denyAll is empty', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);
            const seed = await seedMixedPlaylist(ownerId, 'public');

            const page = { mode: 'offset', offset: 0 } as const;
            const open = await getPublicPlaylists(sql, viewerId, undefined, 10, page, UNRESTRICTED);
            const openRow = open.filter((r) => r.id === seed.playlistId);
            const openIds = collageIds(openRow);
            expect(openIds).toHaveLength(3);

            const restricted = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                page,
                restrictedAccess({
                    deniedGroupIds: [seed.deniedGroup],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            );
            const ids = collageIds(restricted.filter((r) => r.id === seed.playlistId));
            expect(ids.every((id) => openIds.includes(id))).toBe(true);
            expect(ids.length).toBeLessThan(openIds.length);
            expect(ids).toEqual([seed.openId]);

            const closed = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                page,
                denyAllAccess(),
            );
            // The playlist is still discoverable; only its collage closes.
            expect(closed.filter((r) => r.id === seed.playlistId)).toHaveLength(1);
            expect(collageIds(closed.filter((r) => r.id === seed.playlistId))).toHaveLength(0);
        });

        it('getPlaylistItems: restricted ROWS are a strict subset; denyAll is empty', async () => {
            // Unlike the list queries, this boundary filters the returned rows.
            const userId = toUserId(generateTestUserId());
            await ensureTestUser(sql, userId);
            const seed = await seedMixedPlaylist(userId, 'private');

            const open = await getPlaylistItems(
                sql,
                seed.playlistId,
                userId,
                undefined,
                UNRESTRICTED,
            );
            const openIds = open.map((i) => i.media_id);
            expect(openIds).toHaveLength(3);

            const libRestricted = await getPlaylistItems(
                sql,
                seed.playlistId,
                userId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [seed.deniedGroup],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            const libIds = libRestricted.map((i) => i.media_id);
            expect(libIds.every((id) => openIds.includes(id))).toBe(true);
            expect(libIds.length).toBeLessThan(openIds.length);
            expect(libIds).not.toContain(seed.groupRestrictedId);

            const ageRestricted = await getPlaylistItems(
                sql,
                seed.playlistId,
                userId,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            );
            const ageIds = ageRestricted.map((i) => i.media_id);
            expect(ageIds.every((id) => openIds.includes(id))).toBe(true);
            expect(ageIds).not.toContain(seed.adultId);

            const closed = await getPlaylistItems(
                sql,
                seed.playlistId,
                userId,
                undefined,
                denyAllAccess(),
            );
            expect(closed).toHaveLength(0);
        });

        it('treats a zero-length denyGroups list as unrestricted, not deny-everything', async () => {
            // Regression guard: buildLibraryAccessFilter collapsed null and []
            // to the same empty fragment. Under the new union, an empty
            // denyGroups list must keep emitting nothing — if it emitted
            // `AND false`, every restricted-but-denied-nothing user goes dark.
            const userId = toUserId(generateTestUserId());
            await ensureTestUser(sql, userId);
            const seed = await seedMixedPlaylist(userId, 'private');

            const rows = await getOwnedPlaylists(sql, userId, undefined, {
                library: { kind: 'denyGroups', ids: [] },
                age: { kind: 'any' },
            });
            expect(collageIds(rows)).toHaveLength(3);

            const items = await getPlaylistItems(sql, seed.playlistId, userId, undefined, {
                library: { kind: 'denyGroups', ids: [] },
                age: { kind: 'any' },
            });
            expect(items).toHaveLength(3);
        });
    });

    describe('owner fields and member count', () => {
        it('returns owner display name when set', async () => {
            const userId = toUserId(generateTestUserId());
            const uniqueUsername = `displayname-owner-${userId}`;
            await ensureTestUser(sql, userId);
            // ensureTestUser derives its own username and ignores this third
            // argument, so pin the username explicitly (unique per userId, to
            // stay collision-safe across repeated runs against the persistent
            // test database) for a deterministic assertion.
            await sql`UPDATE users SET username = ${uniqueUsername} WHERE id = ${userId}::uuid`;
            await sql`UPDATE users SET display_name = 'Denis A.' WHERE id = ${userId}::uuid`;

            await createPlaylist(sql, userId, 'Named', null, 'private', 'video');

            const rows = await getOwnedPlaylists(sql, userId, undefined, UNRESTRICTED);
            expect(rows[0].owner_username).toBe(uniqueUsername);
            expect(rows[0].owner_display_name).toBe('Denis A.');
        });

        it('returns null display name when unset', async () => {
            const userId = toUserId(generateTestUserId());
            await ensureTestUser(sql, userId);

            await createPlaylist(sql, userId, 'Unnamed', null, 'private', 'video');

            const rows = await getOwnedPlaylists(sql, userId, undefined, UNRESTRICTED);
            expect(rows[0].owner_display_name).toBeNull();
        });

        it('counts accepted members only, excluding owner and pending invites', async () => {
            const ownerId = toUserId(generateTestUserId());
            const acceptedId = toUserId(generateTestUserId());
            const pendingId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, acceptedId);
            await ensureTestUser(sql, pendingId);

            const playlist = await createPlaylist(sql, ownerId, 'Members', null, 'public', 'video');

            await inviteMember(sql, playlist.id, acceptedId, 'readonly');
            await acceptInvite(sql, playlist.id, acceptedId);
            await inviteMember(sql, playlist.id, pendingId, 'readonly');

            const rows = await getOwnedPlaylists(sql, ownerId, undefined, UNRESTRICTED);
            // 1 accepted member. Owner has no playlist_members row; pending excluded.
            expect(Number(rows[0].member_count)).toBe(1);
        });
    });

    // ========================================================================
    // getPublicPlaylists
    // ========================================================================

    describe('getPublicPlaylists', () => {
        it('returns public playlists owned by others, newest first', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const older = await createPlaylist(sql, ownerId, 'Older', null, 'public', 'video');
            const newer = await createPlaylist(sql, ownerId, 'Newer', null, 'public', 'video');

            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${older.id}, ${movie.id}, 'M', 0), (${newer.id}, ${movie.id}, 'M', 0)
            `;
            await sql`UPDATE playlists SET updated_at = now() - interval '1 day' WHERE id = ${older.id}`;

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );

            expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
            expect(rows.every((r) => r.role === 'readonly')).toBe(true);
        });

        it('excludes playlists the viewer owns', async () => {
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const own = await createPlaylist(sql, viewerId, 'Mine', null, 'public', 'video');
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${own.id}, ${movie.id}, 'M', 0)
            `;

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            expect(rows.map((r) => r.id)).not.toContain(own.id);
        });

        it('excludes playlists the viewer is an accepted member of', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const shared = await createPlaylist(sql, ownerId, 'Shared', null, 'public', 'video');
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${shared.id}, ${movie.id}, 'M', 0)
            `;
            await inviteMember(sql, shared.id, viewerId, 'readonly');
            await acceptInvite(sql, shared.id, viewerId);

            // Would otherwise appear in BOTH the shared list and the discover feed,
            // rendering the same card twice in clients that call them separately.
            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            expect(rows.map((r) => r.id)).not.toContain(shared.id);
        });

        it('still returns playlists with only a pending invite for the viewer', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const p = await createPlaylist(sql, ownerId, 'Pending', null, 'public', 'video');
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${p.id}, ${movie.id}, 'M', 0)
            `;
            await inviteMember(sql, p.id, viewerId, 'readonly');

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            expect(rows.map((r) => r.id)).toContain(p.id);
        });

        it('excludes private playlists and empty playlists', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const priv = await createPlaylist(sql, ownerId, 'Private', null, 'private', 'video');
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${priv.id}, ${movie.id}, 'M', 0)
            `;
            const empty = await createPlaylist(sql, ownerId, 'Empty', null, 'public', 'video');

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(priv.id);
            expect(ids).not.toContain(empty.id);
        });

        it('excludes playlists owned by a soft-deleted user', async () => {
            const deletedOwnerId = toUserId(generateTestUserId());
            const normalOwnerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, deletedOwnerId);
            await ensureTestUser(sql, normalOwnerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const deletedOwnerPlaylist = await createPlaylist(
                sql,
                deletedOwnerId,
                'Deleted Owner',
                null,
                'public',
                'video',
            );
            const normalPlaylist = await createPlaylist(
                sql,
                normalOwnerId,
                'Normal Owner',
                null,
                'public',
                'video',
            );
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${deletedOwnerPlaylist.id}, ${movie.id}, 'M', 0),
                       (${normalPlaylist.id}, ${movie.id}, 'M', 0)
            `;
            await sql`UPDATE users SET deleted_at = now() WHERE id = ${deletedOwnerId}::uuid`;

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(deletedOwnerPlaylist.id);
            expect(ids).toContain(normalPlaylist.id);
        });

        it('excludes playlists owned by a disabled user', async () => {
            const disabledOwnerId = toUserId(generateTestUserId());
            const normalOwnerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, disabledOwnerId);
            await ensureTestUser(sql, normalOwnerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const disabledOwnerPlaylist = await createPlaylist(
                sql,
                disabledOwnerId,
                'Disabled Owner',
                null,
                'public',
                'video',
            );
            const normalPlaylist = await createPlaylist(
                sql,
                normalOwnerId,
                'Normal Owner',
                null,
                'public',
                'video',
            );
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${disabledOwnerPlaylist.id}, ${movie.id}, 'M', 0),
                       (${normalPlaylist.id}, ${movie.id}, 'M', 0)
            `;
            await sql`UPDATE users SET disabled_at = now() WHERE id = ${disabledOwnerId}::uuid`;

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(disabledOwnerPlaylist.id);
            expect(ids).toContain(normalPlaylist.id);
        });

        it('filters by playlist type', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const video = await createPlaylist(sql, ownerId, 'Video', null, 'public', 'video');
            const music = await createPlaylist(sql, ownerId, 'Music', null, 'public', 'music');
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${video.id}, ${movie.id}, 'M', 0), (${music.id}, ${movie.id}, 'M', 0)
            `;

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                'video',
                10,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(video.id);
            expect(ids).not.toContain(music.id);
        });

        it('returns limit + 1 rows so the caller can compute hasMore', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            for (let i = 0; i < 3; i++) {
                const p = await createPlaylist(sql, ownerId, `P${i}`, null, 'public', 'video');
                await sql`
                    INSERT INTO playlist_items (playlist_id, media_id, title, position)
                    VALUES (${p.id}, ${movie.id}, 'M', 0)
                `;
            }

            // 3 exist, ask for 2 → 3 returned (limit + 1) → caller sees hasMore
            const page1 = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                2,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            expect(page1).toHaveLength(3);

            // offset past the end → fewer than limit → no more
            const page2 = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                2,
                {
                    mode: 'offset',
                    offset: 2,
                },
                UNRESTRICTED,
            );
            expect(page2).toHaveLength(1);
        });

        it('applies cover item access filtering', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const p = await createPlaylist(sql, ownerId, 'Mixed', null, 'public', 'video');
            const kids = await createAndInsertTestMovie(sql);
            const adult = await createAndInsertTestMovie(sql);
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${kids.id}`;
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.id}`;
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${p.id}, ${kids.id}, 'K', 0), (${p.id}, ${adult.id}, 'A', 1)
            `;

            const rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                10,
                { mode: 'offset', offset: 0 },
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );

            const row = rows.find((r) => r.id === p.id);
            expect(row?.cover_items).toHaveLength(1);
            expect(row?.cover_items?.[0].internal_id).toBe(kids.id);
        });
    });

    // ========================================================================
    // getPublicPlaylists — cursor (keyset) paging
    // ========================================================================

    describe('getPublicPlaylists — cursor paging', () => {
        function toIso(value: string | Date): string {
            return value instanceof Date ? value.toISOString() : value;
        }

        it('walks the same complete set as offset paging over a static dataset, with no duplicates', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const playlists = [];
            for (let i = 0; i < 7; i++) {
                const p = await createPlaylist(
                    sql,
                    ownerId,
                    `Static ${i}`,
                    null,
                    'public',
                    'video',
                );
                await sql`
                    INSERT INTO playlist_items (playlist_id, media_id, title, position)
                    VALUES (${p.id}, ${movie.id}, 'M', 0)
                `;
                // Stagger updated_at so ordering is deterministic and stable —
                // this dataset is never mutated again in this test.
                await sql`UPDATE playlists SET updated_at = now() - (${i} * interval '1 second') WHERE id = ${p.id}`;
                playlists.push(p);
            }

            const limit = 3;

            const offsetIds: number[] = [];
            for (let offset = 0; ; offset += limit) {
                const rows = await getPublicPlaylists(
                    sql,
                    viewerId,
                    undefined,
                    limit,
                    {
                        mode: 'offset',
                        offset,
                    },
                    UNRESTRICTED,
                );
                const hasMore = rows.length > limit;
                offsetIds.push(...rows.slice(0, limit).map((r) => r.id));
                if (!hasMore) break;
            }

            const cursorIds: number[] = [];
            let cursor: { updatedAt: string; id: string } | undefined;
            for (;;) {
                const rows = await getPublicPlaylists(
                    sql,
                    viewerId,
                    undefined,
                    limit,
                    cursor ? { mode: 'cursor', cursor } : { mode: 'offset', offset: 0 },
                    UNRESTRICTED,
                );
                const hasMore = rows.length > limit;
                const page = rows.slice(0, limit);
                cursorIds.push(...page.map((r) => r.id));
                if (!hasMore) break;
                const last = page[page.length - 1];
                cursor = { updatedAt: toIso(last.updated_at), id: String(last.id) };
            }

            expect(new Set(cursorIds).size).toBe(cursorIds.length);
            expect(new Set(cursorIds)).toEqual(new Set(offsetIds));
            for (const p of playlists) {
                expect(cursorIds).toContain(p.id);
            }
        });

        it('is immune to a mid-pagination updated_at jump that makes offset paging duplicate a row', async () => {
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const limit = 3;
            const playlists = [];
            // p0 (newest) .. p5 (oldest) — deterministic descending order.
            for (let i = 0; i < 6; i++) {
                const p = await createPlaylist(sql, ownerId, `Drift ${i}`, null, 'public', 'video');
                await sql`
                    INSERT INTO playlist_items (playlist_id, media_id, title, position)
                    VALUES (${p.id}, ${movie.id}, 'M', 0)
                `;
                await sql`UPDATE playlists SET updated_at = now() - (${i} * interval '1 second') WHERE id = ${p.id}`;
                playlists.push(p);
            }

            // Page 1, before any mutation — the newest three: p0, p1, p2.
            const page1Rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                limit,
                {
                    mode: 'offset',
                    offset: 0,
                },
                UNRESTRICTED,
            );
            const page1 = page1Rows.slice(0, limit);
            expect(page1.map((r) => r.id)).toEqual([
                playlists[0].id,
                playlists[1].id,
                playlists[2].id,
            ]);
            const page1Ids = page1.map((r) => r.id);
            const cursorFromPage1 = {
                updatedAt: toIso(page1[page1.length - 1].updated_at),
                id: String(page1[page1.length - 1].id),
            };

            // p3 was ranked just past page 1 (rank 4). A member marking an item
            // watched touches the playlist mid-pagination and it jumps to the top.
            await touchPlaylist(sql, playlists[3].id);

            // Cursor path: no row already shown on page 1 reappears, and the
            // untouched remaining rows (p4, p5) are still found.
            const cursorPage2Rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                limit,
                {
                    mode: 'cursor',
                    cursor: cursorFromPage1,
                },
                UNRESTRICTED,
            );
            const cursorPage2Ids = cursorPage2Rows.slice(0, limit).map((r) => r.id);
            expect(cursorPage2Ids.some((id) => page1Ids.includes(id))).toBe(false);
            expect(cursorPage2Ids).toEqual(
                expect.arrayContaining([playlists[4].id, playlists[5].id]),
            );

            // Offset path: DOES exhibit the duplicate under the identical mutation —
            // the row that shifted into the offset window was already shown on page 1.
            const offsetPage2Rows = await getPublicPlaylists(
                sql,
                viewerId,
                undefined,
                limit,
                {
                    mode: 'offset',
                    offset: limit,
                },
                UNRESTRICTED,
            );
            const offsetPage2Ids = offsetPage2Rows.slice(0, limit).map((r) => r.id);
            expect(offsetPage2Ids.some((id) => page1Ids.includes(id))).toBe(true);
        });

        it('never skips a row whose updated_at differs from the cursor boundary by only microseconds', async () => {
            // Whole-second staggering (as used above) can never expose millisecond
            // truncation of the cursor. Here two playlists are touched within the
            // SAME millisecond — boundary (page 1's last row) at .123456,
            // straddle (must survive onto page 2) at .123200 — so a cursor that
            // round-trips through a JS Date (toISOString() truncates to
            // milliseconds) would encode boundary's timestamp as .123Z, which
            // excludes straddle too even though straddle ranks strictly after
            // boundary.
            const ownerId = toUserId(generateTestUserId());
            const viewerId = toUserId(generateTestUserId());
            await ensureTestUser(sql, ownerId);
            await ensureTestUser(sql, viewerId);

            const movie = await createAndInsertTestMovie(sql);
            const limit = 1;

            // Anchor on the DB's own current time (truncated to whole seconds)
            // rather than a hardcoded literal — a fixed literal would collide
            // with identical timestamps left behind by a prior run of this same
            // test against the persistent test database.
            const [{ nowText }] = await sql<{ nowText: string }[]>`
                SELECT clock_timestamp()::text AS "nowText"
            `;
            const base = nowText.split('.')[0]; // 'YYYY-MM-DD HH:MI:SS', whole seconds only

            // Newest first: head (rank 1, clearly newest) > boundary (rank 2,
            // page 1's boundary row) > straddle (rank 3, must appear on page 2)
            // > tail (rank 4).
            const head = await createPlaylist(sql, ownerId, 'Micro Head', null, 'public', 'video');
            const boundary = await createPlaylist(
                sql,
                ownerId,
                'Micro Boundary',
                null,
                'public',
                'video',
            );
            const straddle = await createPlaylist(
                sql,
                ownerId,
                'Micro Straddle',
                null,
                'public',
                'video',
            );
            const tail = await createPlaylist(sql, ownerId, 'Micro Tail', null, 'public', 'video');
            for (const p of [head, boundary, straddle, tail]) {
                await sql`
                    INSERT INTO playlist_items (playlist_id, media_id, title, position)
                    VALUES (${p.id}, ${movie.id}, 'M', 0)
                `;
            }

            // Exact microsecond precision, all values bound as parameters (never
            // sql.unsafe()). `boundary` and `straddle` sit in the SAME
            // millisecond (.123456 vs .123200) but are still ordered relative
            // to one another at full precision.
            //
            // sql.typed(..., 25) pins the parameter's wire OID to TEXT: left as a
            // bare `${...}::timestamptz` bind, postgres.js infers the OID from
            // Postgres's ParameterDescription (1184/timestamptz, from the cast)
            // and serializes the value via `new Date(x).toISOString()` —
            // silently truncating these literals to millisecond precision
            // before they ever reach the database, which would collapse
            // `boundary` and `straddle` onto the identical stored value and
            // defeat this fixture entirely.
            await sql`UPDATE playlists SET updated_at = ${sql.typed(`${base}.999999+00`, 25)}::timestamptz WHERE id = ${head.id}`;
            await sql`UPDATE playlists SET updated_at = ${sql.typed(`${base}.123456+00`, 25)}::timestamptz WHERE id = ${boundary.id}`;
            await sql`UPDATE playlists SET updated_at = ${sql.typed(`${base}.123200+00`, 25)}::timestamptz WHERE id = ${straddle.id}`;
            await sql`UPDATE playlists SET updated_at = ${sql.typed(`${base}.000001+00`, 25)}::timestamptz WHERE id = ${tail.id}`;

            try {
                // Walk limit=1 cursor pages from the start. `boundary`'s cursor is
                // built from its own row (whatever the code under test derives it
                // from — the fix vs. the bug); `straddle` ranks immediately after
                // `boundary` and must survive onto the next page regardless.
                const seen: number[] = [];
                let cursor: { updatedAt: string; id: string } | undefined;
                for (let i = 0; i < 10; i++) {
                    const rows = await getPublicPlaylists(
                        sql,
                        viewerId,
                        undefined,
                        limit,
                        cursor ? { mode: 'cursor', cursor } : { mode: 'offset', offset: 0 },
                        UNRESTRICTED,
                    );
                    const hasMore = rows.length > limit;
                    const page = rows.slice(0, limit);
                    seen.push(...page.map((r) => r.id));
                    if (!hasMore) break;
                    const last = page[page.length - 1] as {
                        updated_at_cursor?: string;
                        updated_at: string | Date;
                        id: number;
                    };
                    cursor = {
                        updatedAt: last.updated_at_cursor ?? toIso(last.updated_at),
                        id: String(last.id),
                    };
                }

                expect(new Set(seen).size).toBe(seen.length);
                expect(seen).toContain(straddle.id);
                expect(seen).toEqual([head.id, boundary.id, straddle.id, tail.id]);
            } finally {
                await sql`DELETE FROM playlist_items WHERE playlist_id IN (${head.id}, ${boundary.id}, ${straddle.id}, ${tail.id})`;
                await sql`DELETE FROM playlists WHERE id IN (${head.id}, ${boundary.id}, ${straddle.id}, ${tail.id})`;
            }
        });
    });

    describe('resolveEpisodeContext', () => {
        /** Insert an episode row directly — fixtures don't cover season/episode numbers. */
        async function insertEpisode(
            parentId: string,
            seasonNumber: number,
            episodeNumber: number,
            title: string,
        ): Promise<string> {
            const rows = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                VALUES (${title}, 'episode', ${parentId}, ${seasonNumber}, ${episodeNumber})
                RETURNING id::text AS id
            `;
            return rows[0].id;
        }

        it('resolves a nested episode (episode -> season -> series)', async () => {
            const series = await createAndInsertTestTvShow(sql, { title: 'Nested Show' });
            const season = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('Season 2', 'season', ${series.id}, 2)
                RETURNING id::text AS id
            `;
            const episodeId = await insertEpisode(season[0].id, 2, 5, 'The One With The Test');

            const ctx = await resolveEpisodeContext(sql, episodeId);

            expect(ctx).not.toBeNull();
            expect(ctx?.seriesMediaId).toBe(series.id);
            expect(ctx?.seriesName).toBe('Nested Show');
            expect(ctx?.seasonNumber).toBe(2);
            expect(ctx?.episodeNumber).toBe(5);
        });

        it('resolves a flat episode whose parent is the series directly', async () => {
            const series = await createAndInsertTestTvShow(sql, { title: 'Flat Show' });
            const episodeId = await insertEpisode(series.id, 1, 3, 'Flat Episode');

            const ctx = await resolveEpisodeContext(sql, episodeId);

            expect(ctx?.seriesMediaId).toBe(series.id);
            expect(ctx?.seriesName).toBe('Flat Show');
            expect(ctx?.seasonNumber).toBe(1);
            expect(ctx?.episodeNumber).toBe(3);
        });

        it('returns null for a movie, a series, and an unknown id', async () => {
            const movie = await createAndInsertTestMovie(sql);
            const series = await createAndInsertTestTvShow(sql);

            expect(await resolveEpisodeContext(sql, movie.id)).toBeNull();
            expect(await resolveEpisodeContext(sql, series.id)).toBeNull();
            expect(await resolveEpisodeContext(sql, crypto.randomUUID())).toBeNull();
        });

        it('returns the episode even when the parent chain has no series row', async () => {
            const orphanSeason = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, season_number)
                VALUES ('Orphan Season', 'season', 1)
                RETURNING id::text AS id
            `;
            const episodeId = await insertEpisode(orphanSeason[0].id, 1, 1, 'Orphan Episode');

            const ctx = await resolveEpisodeContext(sql, episodeId);

            // Season/episode still resolve; the series is simply absent.
            expect(ctx).not.toBeNull();
            expect(ctx?.seriesMediaId).toBeNull();
            expect(ctx?.seasonNumber).toBe(1);
            expect(ctx?.episodeNumber).toBe(1);
        });
    });

    // ========================================================================
    // getPlaylistItems keyset cursor — (position ASC, id ASC)
    // ========================================================================

    describe('getPlaylistItems keyset cursor', () => {
        async function seedItems(playlistId: number, n: number): Promise<void> {
            for (let i = 0; i < n; i++) {
                const { id: mediaId } = await createAndInsertTestMovie(sql);
                await insertPlaylistItem(sql, {
                    playlistId,
                    mediaId,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: `Item ${i}`,
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                });
            }
        }

        it('cursor walk reproduces the offset order exactly (parity over a static set)', async () => {
            const playlist = await makePlaylist('Keyset Items');
            await seedItems(playlist.id, 5);

            const offsetAll = await getPlaylistItems(
                sql,
                playlist.id,
                null,
                undefined,
                UNRESTRICTED,
            );
            expect(offsetAll).toHaveLength(5);

            // (-1, 0) precedes every real row (position >= 0, id > 0).
            let cursor = { position: '-1', id: '0' };
            const walked: number[] = [];
            const LIMIT = 2;
            for (let guard = 0; guard < 20; guard++) {
                const rows = await getPlaylistItems(
                    sql,
                    playlist.id,
                    null,
                    undefined,
                    UNRESTRICTED,
                    {
                        mode: 'cursor',
                        cursor,
                        limit: LIMIT,
                    },
                );
                const take = rows.slice(0, LIMIT);
                for (const r of take) walked.push(r.id);
                if (rows.length <= LIMIT) break;
                const last = take[take.length - 1];
                cursor = { position: String(last.position), id: String(last.id) };
            }
            expect(walked).toEqual(offsetAll.map((r) => r.id));
        });

        it('n+1 lookahead does not skip or re-emit the page boundary row', async () => {
            const playlist = await makePlaylist('Keyset Items Boundary');
            await seedItems(playlist.id, 3); // positions 0,1,2
            const all = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED);

            const page1 = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED, {
                mode: 'cursor',
                cursor: { position: '-1', id: '0' },
                limit: 2,
            });
            expect(page1).toHaveLength(3); // 2 + 1 lookahead
            const last = page1[1];

            const page2 = await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED, {
                mode: 'cursor',
                cursor: { position: String(last.position), id: String(last.id) },
                limit: 2,
            });
            // Exactly the third row — the boundary row (id=page1[1].id) is neither
            // dropped nor repeated.
            expect(page2.map((r) => r.id)).toEqual([all[2].id]);
        });
    });

    // ========================================================================
    // getPlaylistMembers keyset cursor — (status ASC, invited_at DESC NULLS
    // FIRST, user_id DESC)
    // ========================================================================

    describe('getPlaylistMembers keyset cursor', () => {
        async function seedMember(
            playlistId: number,
            status: 'accepted' | 'pending',
            invitedAt: string | null,
        ): Promise<string> {
            const uid = generateTestUserId();
            await ensureTestUser(sql, uid);
            await inviteMember(sql, playlistId, toUserId(uid), 'readonly');
            // `${invitedAt}::timestamptz` binds the JS string as a Date param, which
            // postgres.js truncates to millisecond precision — collapsing the µs-distinct
            // values these keyset tests rely on. Cast through ::text first so the full
            // microsecond string reaches the timestamptz column intact (the same reason
            // the cursor path binds via pgTextTimestamp). NULL flows through unchanged.
            await sql`
                UPDATE playlist_members
                SET status = ${status}, invited_at = ${invitedAt}::text::timestamptz
                WHERE playlist_id = ${playlistId} AND user_id = ${uid}::uuid
            `;
            return uid;
        }

        it('cursor walk reproduces the offset order exactly (parity + D2b NULL carry)', async () => {
            const playlist = await makePlaylist('Keyset Members');
            // accepted group: NULL-invited sorts FIRST (DESC NULLS FIRST), then dated DESC.
            const uNull = await seedMember(playlist.id, 'accepted', null);
            const uA1 = await seedMember(playlist.id, 'accepted', '2026-07-20T00:00:00.000200Z');
            const uA2 = await seedMember(playlist.id, 'accepted', '2026-07-20T00:00:00.000100Z');
            // pending group: dated DESC.
            const uP1 = await seedMember(playlist.id, 'pending', '2026-07-19T00:00:00.000000Z');
            const uP2 = await seedMember(playlist.id, 'pending', '2026-07-18T00:00:00.000000Z');

            const offsetAll = await getPlaylistMembers(sql, playlist.id);
            expect(offsetAll.map((r) => r.user_id)).toEqual([uNull, uA1, uA2, uP1, uP2]);

            // Walk from the FIRST (NULL-invited) row's cursor → must reproduce
            // offsetAll[1..]. Starting inside the NULL group exercises the D2b
            // carry: the NULL-group cursor must carry the non-null accepted tail
            // and the whole pending group.
            const first = offsetAll[0];
            let cursor: {
                status: 'accepted' | 'pending';
                invitedAt: string | null;
                userId: string;
            } = {
                status: first.status,
                invitedAt: first.invited_at_cursor ?? null,
                userId: first.user_id,
            };
            const walked: string[] = [];
            for (let guard = 0; guard < 20; guard++) {
                const rows = await getPlaylistMembers(sql, playlist.id, {
                    mode: 'cursor',
                    cursor,
                    limit: 1,
                });
                if (rows.length === 0) break;
                const r = rows[0];
                walked.push(r.user_id);
                if (rows.length <= 1) break;
                cursor = {
                    status: r.status,
                    invitedAt: r.invited_at_cursor ?? null,
                    userId: r.user_id,
                };
            }
            expect(walked).toEqual([uA1, uA2, uP1, uP2]);
        });

        it('does not skip a boundary row sharing the same millisecond (micro precision)', async () => {
            const playlist = await makePlaylist('Keyset Members Micro');
            const uHi = await seedMember(playlist.id, 'accepted', '2026-07-20T00:00:00.123457Z');
            const uLo = await seedMember(playlist.id, 'accepted', '2026-07-20T00:00:00.123456Z');

            const all = await getPlaylistMembers(sql, playlist.id);
            const hiRow = all.find((r) => r.user_id === uHi);
            expect(hiRow?.invited_at_cursor).toBeTruthy();

            // A cursor at uHi (.123457) must still return uLo (.123456) — same
            // millisecond. Round-tripping the cursor through a JS Date would
            // truncate to .123 and wrongly exclude uLo.
            const rows = await getPlaylistMembers(sql, playlist.id, {
                mode: 'cursor',
                cursor: { status: 'accepted', invitedAt: hiRow!.invited_at_cursor!, userId: uHi },
                limit: 10,
            });
            const ids = rows.map((r) => r.user_id);
            expect(ids).toContain(uLo);
            expect(ids).not.toContain(uHi);
        });
    });

    // =========================================================================
    // Library axis on CONTAINER playlist items.
    //
    // getPlaylistItems itself names the containers as first-class item types:
    // MUSIC_TYPES = ['track','album','artist'], VIDEO_TYPES =
    // ['movie','tv','episode','season'], and the bulk-add endpoint accepts
    // isSeries(). None of tv/season/artist/album owns a media_file_items row
    // (0 of 19,836 on production, 2026-09-15), so the predicate correlated to
    // pi.media_id was satisfied by its `NOT EXISTS (own files)` arm for every
    // one of them and the library axis was a no-op.
    // =========================================================================
    describe('getPlaylistItems — library axis for container items', () => {
        async function addContainer(
            playlistId: number,
            mediaType: 'tv' | 'album',
            title: string,
            libraryGroupId: string,
        ): Promise<string> {
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files)
                VALUES (${mediaId}::uuid, ${title}, ${mediaType}, 'active', false)
            `;
            await placeInLibraryGroup(sql, { mediaItemId: mediaId, mediaType, libraryGroupId });
            await insertPlaylistItem(sql, {
                playlistId,
                mediaId,
                seasonNumber: null,
                episodeNumber: null,
                title,
                seriesName: null,
                overview: null,
                posterPath: null,
            });
            return mediaId;
        }

        for (const mediaType of ['tv', 'album'] as const) {
            it(`hides a ${mediaType} item whose only descendant file is in a denied group`, async () => {
                const playlist = await makePlaylist();
                const groupA = crypto.randomUUID();
                const groupB = crypto.randomUUID();
                await sql`
                    INSERT INTO library_groups (id, name)
                    VALUES (${groupA}::uuid, 'PL A'), (${groupB}::uuid, 'PL B')
                `;

                const denied = await addContainer(
                    playlist.id,
                    mediaType,
                    `Denied ${mediaType}`,
                    groupA,
                );
                const allowed = await addContainer(
                    playlist.id,
                    mediaType,
                    `Allowed ${mediaType}`,
                    groupB,
                );

                // POSITIVE CONTROL.
                const open = (
                    await getPlaylistItems(sql, playlist.id, null, undefined, UNRESTRICTED)
                ).map((r) => r.media_id);
                expect(open).toContain(denied);
                expect(open).toContain(allowed);

                const narrowed = (
                    await getPlaylistItems(
                        sql,
                        playlist.id,
                        null,
                        undefined,
                        restrictedAccess({
                            deniedGroupIds: [groupA],
                            maxAgeRating: null,
                            allowUnrated: true,
                        }),
                    )
                ).map((r) => r.media_id);
                for (const id of narrowed) expect(open).toContain(id);
                expect(narrowed.length).toBeLessThan(open.length);
                expect(narrowed).not.toContain(denied);
                expect(narrowed).toContain(allowed);

                expect(
                    await getPlaylistItems(sql, playlist.id, null, undefined, denyAllAccess()),
                ).toEqual([]);
            });
        }

        it('keeps an empty container item visible (stub fail-open)', async () => {
            const playlist = await makePlaylist();
            const groupA = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'PL Unrelated')`;

            const stub = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files)
                VALUES (${stub}::uuid, 'Empty Series Stub', 'tv', 'active', false)
            `;
            await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: stub,
                seasonNumber: null,
                episodeNumber: null,
                title: 'Empty Series Stub',
                seriesName: null,
                overview: null,
                posterPath: null,
            });

            const narrowed = await getPlaylistItems(
                sql,
                playlist.id,
                null,
                undefined,
                restrictedAccess({
                    deniedGroupIds: [groupA],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            expect(narrowed.map((r) => r.media_id)).toContain(stub);
        });
    });
});
