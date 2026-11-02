// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for File Rematch Query Module (bug #3)
 *
 * Verifies the rename-by-hash reclaim primitives:
 *   - `findReclaimableByHash` honors the 24h window and is_dismissed flag.
 *   - `undismissMediaItem` clears both is_dismissed and dismissed_at.
 *
 * Higher-level integration coverage (full reclaim flow with user state
 * preservation) is exercised in the rename-reconnect end-to-end test that
 * runs against the actual video/audio processors.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    findReclaimableByHash,
    deferHashReclaim,
    findActiveItemByLiveHeadHash,
    undismissMediaItem,
} from './file-rematch.queries.js';
import {
    softDeleteOrphanMusicItems,
    findHardDeletableMediaIds,
} from './database-cleanup.queries.js';
import { insertTestExternalIds } from '../../../../../tests/integration/fixtures/index.js';
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import { derivedUsername } from '../../../../../tests/integration/fixtures/user.fixtures.js';

const HASH_RENAMED = 'a'.repeat(64); // sha-256 hex shape
const HASH_OTHER = 'b'.repeat(64);

interface FixtureRow {
    mediaItemId: string;
    fileId: string;
    filePath: string;
}

async function insertDismissedItemWithFile(
    sql: postgres.Sql,
    options: {
        contentHash: string;
        dismissedAt: Date | null;
        isDismissed?: boolean;
        mediaType?: string;
        filePath?: string;
    },
): Promise<FixtureRow> {
    const mediaItemId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const filePath = options.filePath ?? `/test/library/track-${mediaItemId.slice(0, 8)}.mkv`;

    // dismissed_content_hash mirrors what deleteStaleMediaFile snapshots onto
    // the media_items row before cascading the file row away — it is the
    // surviving reclaim-time fingerprint.
    await sql`
        INSERT INTO media_items (
            id, media_type, title, is_dismissed, dismissed_at, dismissed_content_hash
        )
        VALUES (
            ${mediaItemId}::uuid,
            ${options.mediaType ?? 'movie'},
            ${'Reclaim Fixture ' + mediaItemId.slice(0, 6)},
            ${options.isDismissed ?? true},
            ${options.dismissedAt},
            ${(options.isDismissed ?? true) ? options.contentHash : null}
        )
    `;
    await sql`
        INSERT INTO media_files (id, file_path, file_hash_head, created_at, updated_at)
        VALUES (${fileId}::uuid, ${filePath}, ${options.contentHash}, NOW(), NOW())
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
    `;

    return { mediaItemId, fileId, filePath };
}

describe('file-rematch.queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    describe('findReclaimableByHash', () => {
        it.each([
            { throughSeason: false, episodeSeason: 2 },
            { throughSeason: true, episodeSeason: 2 },
            { throughSeason: true, episodeSeason: null },
        ])(
            'returns episode numbers and series (season parent: $throughSeason, episode season: $episodeSeason)',
            async ({ throughSeason, episodeSeason }) => {
                const seriesId = crypto.randomUUID();
                const seasonId = crypto.randomUUID();
                await sql`INSERT INTO media_items (id, media_type, title)
                    VALUES (${seriesId}::uuid, 'tv', 'Reclaim series')`;
                if (throughSeason) {
                    await sql`INSERT INTO media_items (id, media_type, title, parent_id, season_number)
                        VALUES (${seasonId}::uuid, 'season', 'Season 9', ${seriesId}::uuid, 9)`;
                }
                const fx = await insertDismissedItemWithFile(sql, {
                    contentHash: HASH_RENAMED,
                    dismissedAt: new Date(),
                    mediaType: 'episode',
                });
                await sql`UPDATE media_items
                    SET parent_id = ${throughSeason ? seasonId : seriesId}::uuid,
                        season_number = ${episodeSeason}, episode_number = 10, sort_order = 99
                    WHERE id = ${fx.mediaItemId}::uuid`;

                expect(await findReclaimableByHash(sql, HASH_RENAMED)).toMatchObject({
                    media_item_id: fx.mediaItemId,
                    series_id: seriesId,
                    season_number: episodeSeason ?? 9,
                    episode_number: 10,
                });
            },
        );

        it('returns the candidate when a dismissed item has the same hash within the window', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
            });

            const found = await findReclaimableByHash(sql, HASH_RENAMED);

            expect(found).not.toBeNull();
            expect(found?.media_item_id).toBe(fx.mediaItemId);
            expect(found?.dismissed_content_hash).toBe(HASH_RENAMED);
        });

        it.each([false, true])(
            'returns provider IDs from the series for an episode (season: %s)',
            async (throughSeason) => {
                const seriesId = crypto.randomUUID();
                const seasonId = crypto.randomUUID();
                await sql`INSERT INTO media_items (id, media_type, title)
                VALUES (${seriesId}::uuid, 'tv', 'Reclaim series')`;
                if (throughSeason) {
                    await sql`INSERT INTO media_items (id, media_type, title, parent_id)
                    VALUES (${seasonId}::uuid, 'season', 'Season 1', ${seriesId}::uuid)`;
                }
                const fx = await insertDismissedItemWithFile(sql, {
                    contentHash: HASH_RENAMED,
                    dismissedAt: new Date(),
                    mediaType: 'episode',
                });
                await sql`UPDATE media_items SET parent_id = ${throughSeason ? seasonId : seriesId}::uuid
                WHERE id = ${fx.mediaItemId}::uuid`;
                await insertTestExternalIds(sql, [
                    {
                        media_id: seriesId,
                        provider: 'tmdb',
                        external_id: '111',
                        media_type: 'tv',
                        is_primary: true,
                    },
                    {
                        media_id: seriesId,
                        provider: 'imdb',
                        external_id: 'tt1111111',
                        media_type: 'tv',
                        is_primary: false,
                    },
                    {
                        media_id: fx.mediaItemId,
                        provider: 'tmdb',
                        external_id: '222',
                        media_type: 'episode',
                        is_primary: true,
                    },
                ]);

                const found = await findReclaimableByHash(sql, HASH_RENAMED);
                expect(found).toMatchObject({
                    media_item_id: fx.mediaItemId,
                    media_type: 'episode',
                });
                expect(found).toHaveProperty(
                    'external_ids',
                    expect.arrayContaining([
                        { provider: 'tmdb', external_id: '111' },
                        { provider: 'imdb', external_id: 'tt1111111' },
                    ]),
                );
                expect(found).toHaveProperty(
                    'external_ids',
                    expect.not.arrayContaining([{ provider: 'tmdb', external_id: '222' }]),
                );
            },
        );

        it('returns null when no dismissed item has the hash', async () => {
            await insertDismissedItemWithFile(sql, {
                contentHash: HASH_OTHER,
                dismissedAt: new Date(),
            });

            const found = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(found).toBeNull();
        });

        it('excludes items dismissed outside the window', async () => {
            const tooOld = new Date(Date.now() - 48 * 3600 * 1000); // 48h ago
            await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: tooOld,
            });

            const found = await findReclaimableByHash(sql, HASH_RENAMED, 24);
            expect(found).toBeNull();
        });

        it('excludes non-dismissed items even when the hash matches', async () => {
            await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
                isDismissed: false,
            });

            const found = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(found).toBeNull();
        });

        it('excludes legacy dismissed rows with NULL dismissed_at', async () => {
            await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: null,
                isDismissed: true,
            });

            const found = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(found).toBeNull();
        });

        it('pins only the deferred hash beyond 24 hours and clears the pin when reclaimed', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
            });
            await deferHashReclaim(sql, fx.mediaItemId, HASH_RENAMED);
            await sql`UPDATE media_items SET dismissed_at = NOW() - INTERVAL '31 days'
                WHERE id = ${fx.mediaItemId}`;
            expect((await findReclaimableByHash(sql, HASH_RENAMED))?.media_item_id).toBe(
                fx.mediaItemId,
            );
            await sql`UPDATE media_items SET dismissed_content_hash = ${HASH_OTHER} WHERE id = ${fx.mediaItemId}`;
            expect(await findReclaimableByHash(sql, HASH_OTHER)).toBeNull();
            await sql`UPDATE media_items SET dismissed_content_hash = ${HASH_RENAMED} WHERE id = ${fx.mediaItemId}`;
            await undismissMediaItem(sql, fx.mediaItemId);
            const [row] = await sql<{ pinned: boolean; dismissed_at: Date | null }[]>`
                SELECT processing_state ? 'hash-reclaim-deferred' AS pinned, dismissed_at
                FROM media_items WHERE id = ${fx.mediaItemId}
            `;
            expect(row).toEqual({ pinned: false, dismissed_at: null });
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).toBeNull();
        });

        it('bounds both new and legacy pins to three deferrals and clears exhausted pins', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
            });
            await sql`UPDATE media_items SET processing_state = jsonb_build_object(
                'hash-reclaim-deferred', dismissed_content_hash) WHERE id = ${fx.mediaItemId}`;
            for (let attempt = 1; attempt <= 3; attempt++) {
                expect(await deferHashReclaim(sql, fx.mediaItemId, HASH_RENAMED)).toBe(true);
            }
            await sql`UPDATE media_items SET dismissed_at = NOW() - INTERVAL '31 days'
                WHERE id = ${fx.mediaItemId}`;
            expect(await deferHashReclaim(sql, fx.mediaItemId, HASH_RENAMED)).toBe(false);
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).toBeNull();
            const [pin] = await sql<
                { pinned: boolean }[]
            >`SELECT processing_state ? 'hash-reclaim-deferred' AS pinned
                FROM media_items WHERE id = ${fx.mediaItemId}`;
            expect(pin.pinned).toBe(false);
            // Even inside the ordinary 24h window, a skipped normal match must
            // not restart the same dismissal's three-attempt budget.
            await sql`UPDATE media_items SET dismissed_at = NOW() WHERE id = ${fx.mediaItemId}`;
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).toBeNull();
            expect(await deferHashReclaim(sql, fx.mediaItemId, HASH_RENAMED)).toBe(false);
        });

        it('clears a stale pin on a new soft dismissal even for the same hash', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
            });
            await deferHashReclaim(sql, fx.mediaItemId, HASH_RENAMED);
            await sql`UPDATE media_items SET processing_state = processing_state ||
                jsonb_build_object('hash-reclaim-refused', dismissed_content_hash) WHERE id = ${fx.mediaItemId}`;
            await MediaDeletionService.softDismiss(sql, fx.mediaItemId);
            const [pin] = await sql<
                { pinned: boolean }[]
            >`SELECT processing_state ? 'hash-reclaim-deferred' AS pinned
                FROM media_items WHERE id = ${fx.mediaItemId}`;
            expect(pin.pinned).toBe(false);
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).not.toBeNull();
        });

        it('returns the most recently dismissed candidate when multiple match', async () => {
            const oldDismiss = new Date(Date.now() - 2 * 3600 * 1000);
            const recentDismiss = new Date();

            const oldFx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: oldDismiss,
                filePath: '/test/old.mkv',
            });
            const newFx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: recentDismiss,
                filePath: '/test/new.mkv',
            });

            const found = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(found?.media_item_id).toBe(newFx.mediaItemId);
            expect(found?.media_item_id).not.toBe(oldFx.mediaItemId);
        });

        it('respects the configurable withinHours window', async () => {
            const dismissedAt = new Date(Date.now() - 30 * 60 * 1000); // 30m ago
            await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt,
            });

            // 1-hour window: candidate still eligible.
            const inWindow = await findReclaimableByHash(sql, HASH_RENAMED, 1);
            expect(inWindow).not.toBeNull();

            // Window so small the row drops out (use fractional hours to push
            // the cutoff past the dismissed_at timestamp).
            const outOfWindow = await findReclaimableByHash(
                sql,
                HASH_RENAMED,
                1 / 3600, // 1 second window
            );
            expect(outOfWindow).toBeNull();
        });
    });

    describe('undismissMediaItem', () => {
        it('clears is_dismissed and dismissed_at on a dismissed row', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
            });

            await undismissMediaItem(sql, fx.mediaItemId);

            const [row] = await sql<{ is_dismissed: boolean; dismissed_at: Date | null }[]>`
                SELECT is_dismissed, dismissed_at
                  FROM media_items
                 WHERE id = ${fx.mediaItemId}::uuid
            `;
            expect(row.is_dismissed).toBe(false);
            expect(row.dismissed_at).toBeNull();
        });

        it('is a no-op for already-undismissed rows', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
                isDismissed: false,
            });

            await undismissMediaItem(sql, fx.mediaItemId);

            const [row] = await sql<{ is_dismissed: boolean; dismissed_at: Date | null }[]>`
                SELECT is_dismissed, dismissed_at
                  FROM media_items
                 WHERE id = ${fx.mediaItemId}::uuid
            `;
            // Row untouched — dismissed_at was non-null on insert and stays
            // that way because the WHERE clause filtered it out.
            expect(row.is_dismissed).toBe(false);
            expect(row.dismissed_at).not.toBeNull();
        });
    });

    describe('reclaim → un-dismiss flow', () => {
        it('after undismiss the row is no longer reclaimable', async () => {
            const fx = await insertDismissedItemWithFile(sql, {
                contentHash: HASH_RENAMED,
                dismissedAt: new Date(),
            });

            // Before undismiss: visible.
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).not.toBeNull();

            // After undismiss: gone.
            await undismissMediaItem(sql, fx.mediaItemId);
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).toBeNull();
        });
    });

    describe('full rename → unlink → reclaim flow preserves user state', () => {
        it('user ratings and watch history stay attached to the original UUID after a rename reconnect', async () => {
            const { deleteStaleMediaFile, attachFileToItem, upsertMediaFile } =
                await import('./media-files.queries.js');

            // 1. Seed: item + file linked, user ratings + watch history attached.
            const mediaItemId = crypto.randomUUID();
            const oldFileId = crypto.randomUUID();
            const oldPath = '/test/rename/Original Name.mkv';

            await sql`
                INSERT INTO media_items (id, media_type, title, runtime_seconds)
                VALUES (${mediaItemId}::uuid, 'movie',
                        ${'Rename Test ' + mediaItemId.slice(0, 6)}, 5400)
            `;
            await sql`
                INSERT INTO media_files (id, file_path, file_hash_head, created_at, updated_at)
                VALUES (${oldFileId}::uuid, ${oldPath}, ${HASH_RENAMED}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${oldFileId}::uuid, ${mediaItemId}::uuid, true)
            `;

            // User state — emulate a rating + a watch_history row.
            // user_profiles.user_id is uuid REFERENCES users(id) since mig 16.46.0.
            const userId = crypto.randomUUID();
            const userUsername = derivedUsername(userId);
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, ${userUsername})
                ON CONFLICT (id) DO NOTHING
            `;
            await sql`
                INSERT INTO user_profiles (user_id)
                VALUES (${userId}::uuid)
                ON CONFLICT (user_id) DO NOTHING
            `;
            await sql`
                INSERT INTO user_ratings (user_id, media_id, rating)
                VALUES (${userId}::uuid, ${mediaItemId}::uuid, 5)
            `;
            await sql`
                INSERT INTO watch_history (
                    user_id, media_type, source_service, title,
                    session_start_time, session_end_time,
                    actual_watch_time_seconds, media_id
                ) VALUES (
                    ${userId}::uuid, 'movie', 'lumastra', ${'Rename Test ' + mediaItemId.slice(0, 6)},
                    NOW(), NOW(), 5400, ${mediaItemId}::uuid
                )
            `;

            // Sanity: state is there.
            const [ratingBefore] = await sql<{ rating: number }[]>`
                SELECT rating FROM user_ratings WHERE media_id = ${mediaItemId}::uuid
            `;
            expect(ratingBefore.rating).toBe(5);
            const [historyBefore] = await sql<{ media_id: string }[]>`
                SELECT media_id FROM watch_history WHERE media_id = ${mediaItemId}::uuid
            `;
            expect(historyBefore.media_id).toBe(mediaItemId);

            // 2. unlink: native watcher fires deleteStaleMediaFile, which detects the
            //    orphaned item and soft-dismisses it.
            await deleteStaleMediaFile(sql, oldPath);
            const [afterUnlink] = await sql<{ is_dismissed: boolean; dismissed_at: Date | null }[]>`
                SELECT is_dismissed, dismissed_at
                  FROM media_items
                 WHERE id = ${mediaItemId}::uuid
            `;
            expect(afterUnlink.is_dismissed).toBe(true);
            expect(afterUnlink.dismissed_at).toBeInstanceOf(Date);

            // 3. add: the renamed file arrives. The reclaim primitives find
            //    the dismissed item by hash and reattach.
            const newPath = '/test/rename/Renamed Title.mkv';
            const reclaim = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(reclaim).not.toBeNull();
            expect(reclaim?.media_item_id).toBe(mediaItemId);

            const { id: newFileId } = await upsertMediaFile(sql, {
                filePath: newPath,
            });
            await attachFileToItem(sql, newFileId, mediaItemId);
            await undismissMediaItem(sql, mediaItemId);
            // Stamp the head hash on the new row (matches processor behavior).
            await sql`
                UPDATE media_files
                   SET file_hash_head = ${HASH_RENAMED}
                 WHERE id = ${newFileId}::uuid
            `;

            // 4. Assertions: original UUID preserved, user data attached.
            const [afterReclaim] = await sql<
                { is_dismissed: boolean; dismissed_at: Date | null }[]
            >`
                SELECT is_dismissed, dismissed_at
                  FROM media_items
                 WHERE id = ${mediaItemId}::uuid
            `;
            expect(afterReclaim.is_dismissed).toBe(false);
            expect(afterReclaim.dismissed_at).toBeNull();

            const [ratingAfter] = await sql<{ rating: number }[]>`
                SELECT rating FROM user_ratings WHERE media_id = ${mediaItemId}::uuid
            `;
            expect(ratingAfter.rating).toBe(5);
            const historyAfter = await sql<{ media_id: string }[]>`
                SELECT media_id FROM watch_history WHERE media_id = ${mediaItemId}::uuid
            `;
            expect(historyAfter).toHaveLength(1);

            // New file linked, old path absent.
            const linkedFiles = await sql<{ file_path: string }[]>`
                SELECT mf.file_path
                  FROM media_files mf
                  JOIN media_file_items mfi ON mfi.file_id = mf.id
                 WHERE mfi.media_item_id = ${mediaItemId}::uuid
            `;
            expect(linkedFiles.map((r) => r.file_path).sort()).toEqual([newPath]);
        });
    });

    describe('reclaim vs. the daily music sweep (Part C data-loss fix)', () => {
        it('undismiss resets status=active even after the daily sweep flipped it to deleted', async () => {
            const trackId = crypto.randomUUID();
            const oldTimestamp = new Date(Date.now() - 40 * 60 * 1000); // 40m ago

            // Seed an orphaned track (no media_files row) that the sweep is
            // still allowed to promote. Since the rename-race source guard
            // (fix #1), a row with is_dismissed=true is protected from the
            // sweep — so this fixture models the flag-cleared shape (the
            // reclaim snapshot columns survive with is_dismissed=false),
            // which the sweep may legitimately flip to 'deleted'.
            await sql`
                INSERT INTO media_items (
                    id, media_type, title, status, is_dismissed, dismissed_at,
                    dismissed_content_hash, created_at
                )
                VALUES (
                    ${trackId}::uuid, 'track', ${'Sweep Fixture ' + trackId.slice(0, 6)},
                    'active', false, ${oldTimestamp}, ${HASH_RENAMED}, ${oldTimestamp}
                )
            `;

            // The daily sweep runs and — since the row has no files, is not
            // dismissed, and is older than the grace window — flips status
            // to 'deleted'.
            await softDeleteOrphanMusicItems(sql);
            const [afterSweep] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(afterSweep.status).toBe('deleted');

            // Reclaim reattaches the renamed file and un-dismisses — this
            // must also reset status back to 'active', or the item stays
            // invisible despite is_dismissed being cleared.
            await undismissMediaItem(sql, trackId);

            const [row] = await sql<{ status: string; is_dismissed: boolean }[]>`
                SELECT status, is_dismissed FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.status).toBe('active');
            expect(row.is_dismissed).toBe(false);
        });

        it('findHardDeletableMediaIds never returns a file-backed row', async () => {
            const fileBackedDeletedId = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            const oldUpdatedAt = new Date(Date.now() - 60 * 24 * 3600 * 1000); // 60d ago

            // A row marked 'deleted' but that still has a media_file_items
            // link — this must never be hard-deleted (would drop a real file
            // reference / orphan the on-disk file's DB record).
            await sql`
                INSERT INTO media_items (id, media_type, title, status, updated_at)
                VALUES (
                    ${fileBackedDeletedId}::uuid, 'movie',
                    ${'FileBacked Deleted ' + fileBackedDeletedId.slice(0, 6)},
                    'deleted', ${oldUpdatedAt}
                )
            `;
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/hard-delete/' + fileBackedDeletedId.slice(0, 6) + '.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${fileBackedDeletedId}::uuid)
            `;

            const ids = await findHardDeletableMediaIds(sql, new Date(Date.now() + 1000));
            expect(ids).not.toContain(fileBackedDeletedId);
        });

        it('findReclaimableByHash finds a post-sweep status=deleted row', async () => {
            const trackId = crypto.randomUUID();

            // Post-sweep state: status flipped to 'deleted' by
            // softDeleteOrphanMusicItems, but the reclaim snapshot
            // (dismissed_at / dismissed_content_hash) is still intact.
            await sql`
                INSERT INTO media_items (
                    id, media_type, title, status, is_dismissed, dismissed_at,
                    dismissed_content_hash
                )
                VALUES (
                    ${trackId}::uuid, 'track', ${'Post-Sweep Fixture ' + trackId.slice(0, 6)},
                    'deleted', false, NOW(), ${HASH_RENAMED}
                )
            `;

            const c = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(c?.media_item_id).toBe(trackId);
        });
    });

    describe('findActiveItemByLiveHeadHash (order-independent reclaim, fix #4)', () => {
        /**
         * Seed an ACTIVE item with a live media_files row carrying the given
         * head hash — the add-before-unlink rename ordering, where the old
         * file row still exists when the renamed file is scanned.
         */
        async function insertActiveItemWithLiveFile(options: {
            contentHash: string;
            mediaType: string;
            status?: string;
            filePath?: string;
        }): Promise<FixtureRow> {
            const mediaItemId = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            const filePath =
                options.filePath ?? `/test/live/${options.mediaType}-${mediaItemId.slice(0, 8)}.x`;

            await sql`
                INSERT INTO media_items (id, media_type, title, status, is_dismissed)
                VALUES (
                    ${mediaItemId}::uuid,
                    ${options.mediaType},
                    ${'Live Fixture ' + mediaItemId.slice(0, 6)},
                    ${options.status ?? 'active'},
                    false
                )
            `;
            await sql`
                INSERT INTO media_files (id, file_path, file_hash_head, created_at, updated_at)
                VALUES (${fileId}::uuid, ${filePath}, ${options.contentHash}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${fileId}::uuid, ${mediaItemId}::uuid, true)
            `;
            return { mediaItemId, fileId, filePath };
        }

        it('finds an active non-provider track by live head hash', async () => {
            const fx = await insertActiveItemWithLiveFile({
                contentHash: HASH_RENAMED,
                mediaType: 'track',
            });

            const found = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['track']);
            expect(found?.media_item_id).toBe(fx.mediaItemId);
        });

        it('excludes items with an external_ids row (provider media is never hash-merged)', async () => {
            const fx = await insertActiveItemWithLiveFile({
                contentHash: HASH_RENAMED,
                mediaType: 'movie',
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${fx.mediaItemId}::uuid, 'tmdb', '550', 'movie', true)
            `;

            const found = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['movie']);
            expect(found).toBeNull();
        });

        it('excludes status=deleted rows (active-only)', async () => {
            await insertActiveItemWithLiveFile({
                contentHash: HASH_RENAMED,
                mediaType: 'track',
                status: 'deleted',
            });

            const found = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['track']);
            expect(found).toBeNull();
        });

        it('refuses (returns null) when two active items share the same head hash', async () => {
            // Two distinct active single-file tracks with an identical 64KB head
            // hash: there is no reliable signal for which one a renamed file
            // belongs to, so auto-reclaim must refuse rather than guess-merge
            // onto the wrong item (which would orphan the other's history).
            await insertActiveItemWithLiveFile({ contentHash: HASH_RENAMED, mediaType: 'track' });
            await insertActiveItemWithLiveFile({ contentHash: HASH_RENAMED, mediaType: 'track' });

            const found = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['track']);
            expect(found).toBeNull();
        });

        it('excludes media types outside the requested set', async () => {
            await insertActiveItemWithLiveFile({
                contentHash: HASH_RENAMED,
                mediaType: 'movie',
            });

            const found = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['track']);
            expect(found).toBeNull();
        });

        it('excludes items with more than one linked file (copies stay distinct)', async () => {
            const fx = await insertActiveItemWithLiveFile({
                contentHash: HASH_RENAMED,
                mediaType: 'track',
            });
            const secondFileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, file_hash_head, created_at, updated_at)
                VALUES (${secondFileId}::uuid, ${'/test/live/copy-' + fx.mediaItemId.slice(0, 6) + '.x'},
                        ${HASH_RENAMED}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${secondFileId}::uuid, ${fx.mediaItemId}::uuid, false)
            `;

            const found = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['track']);
            expect(found).toBeNull();
        });
    });

    describe('Window 1: add processed before unlink commits (order-independent reclaim)', () => {
        it('reattaches the renamed file to the still-active track; the late unlink cannot dismiss it', async () => {
            const { deleteStaleMediaFile, attachFileToItem, upsertMediaFile, touchLibraryAddedAt } =
                await import('./media-files.queries.js');

            // 1. Seed: an ACTIVE rated track whose old file (with head hash)
            //    is still linked — the unlink for the rename has NOT landed yet.
            const trackId = crypto.randomUUID();
            const oldFileId = crypto.randomUUID();
            const oldPath = '/test/window1/Old Track Name.flac';

            await sql`
                INSERT INTO media_items (id, media_type, title, status, is_dismissed)
                VALUES (${trackId}::uuid, 'track', ${'Window1 ' + trackId.slice(0, 6)}, 'active', false)
            `;
            await sql`
                INSERT INTO media_files (id, file_path, file_hash_head, created_at, updated_at)
                VALUES (${oldFileId}::uuid, ${oldPath}, ${HASH_RENAMED}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${oldFileId}::uuid, ${trackId}::uuid, true)
            `;

            const userId = crypto.randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, ${derivedUsername(userId)})
                ON CONFLICT (id) DO NOTHING
            `;
            await sql`
                INSERT INTO user_profiles (user_id)
                VALUES (${userId}::uuid)
                ON CONFLICT (user_id) DO NOTHING
            `;
            await sql`
                INSERT INTO user_ratings (user_id, media_id, rating)
                VALUES (${userId}::uuid, ${trackId}::uuid, 4)
            `;

            // 2. The `add` for the renamed path arrives FIRST. The dismissed-hash
            //    reclaim misses (nothing is dismissed yet)…
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).toBeNull();

            // …but the live-hash lookup finds the still-active track.
            const live = await findActiveItemByLiveHeadHash(sql, HASH_RENAMED, ['track']);
            expect(live?.media_item_id).toBe(trackId);

            // Reattach block (mirrors the processor tx): new file → same UUID.
            const newPath = '/test/window1/New Track Name.flac';
            const { id: newFileId } = await upsertMediaFile(sql, {
                filePath: newPath,
                fileHashHead: HASH_RENAMED,
            });
            await attachFileToItem(sql, newFileId, trackId);
            await touchLibraryAddedAt(sql, trackId, false);
            // undismissMediaItem is a no-op on an already-active row.
            await undismissMediaItem(sql, trackId);

            // 3. The unlink for the OLD path lands afterwards. The item still
            //    has the new file, so the orphan cleanup must not dismiss it.
            await deleteStaleMediaFile(sql, oldPath);

            const [item] = await sql<{ status: string; is_dismissed: boolean }[]>`
                SELECT status, is_dismissed FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(item.status).toBe('active');
            expect(item.is_dismissed).toBe(false);

            // Rating preserved on the original UUID; exactly one track row.
            const [rating] = await sql<{ rating: number }[]>`
                SELECT rating FROM user_ratings WHERE media_id = ${trackId}::uuid
            `;
            expect(rating.rating).toBe(4);
            const trackRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE media_type = 'track'
            `;
            expect(trackRows).toHaveLength(1);
            expect(trackRows[0].id).toBe(trackId);

            // Only the renamed file remains linked.
            const linked = await sql<{ file_path: string }[]>`
                SELECT mf.file_path
                  FROM media_files mf
                  JOIN media_file_items mfi ON mfi.file_id = mf.id
                 WHERE mfi.media_item_id = ${trackId}::uuid
            `;
            expect(linked.map((r) => r.file_path)).toEqual([newPath]);
        });
    });

    describe('deleteStaleMediaFile → softDismiss snapshots dismissed_content_hash', () => {
        it('stamps dismissed_content_hash on the media_items row before cascading the file away', async () => {
            const { deleteStaleMediaFile } = await import('./media-files.queries.js');

            const mediaItemId = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            const filePath = '/test/soft-' + mediaItemId.slice(0, 6) + '.mkv';
            await sql`
                INSERT INTO media_items (id, media_type, title)
                VALUES (${mediaItemId}::uuid, 'movie', ${'SoftDismiss ' + mediaItemId.slice(0, 6)})
            `;
            await sql`
                INSERT INTO media_files (id, file_path, file_hash_head, created_at, updated_at)
                VALUES (${fileId}::uuid, ${filePath}, ${HASH_RENAMED}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
            `;

            // Pre-condition: not yet dismissed → no reclaim match.
            expect(await findReclaimableByHash(sql, HASH_RENAMED)).toBeNull();

            // deleteStaleMediaFile runs softDismiss via cleanupOrphanedMediaItems
            // because the item ends up with zero files. It also snapshots the
            // file's file_hash_head onto dismissed_content_hash so the reclaim
            // query can still find the row after the cascade.
            await deleteStaleMediaFile(sql, filePath);

            // Post-condition: dismissed_at + dismissed_content_hash populated.
            const reclaim = await findReclaimableByHash(sql, HASH_RENAMED);
            expect(reclaim).not.toBeNull();
            expect(reclaim?.media_item_id).toBe(mediaItemId);
            expect(reclaim?.dismissed_at).toBeInstanceOf(Date);
            expect(reclaim?.dismissed_content_hash).toBe(HASH_RENAMED);
        });
    });
});
