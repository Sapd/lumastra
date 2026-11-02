// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Media Files Query Module
 *
 * Tests the M:N file↔media_item mapping introduced in migration 11.22.0:
 * - upsertMediaFile / findMediaFileByPath
 * - attachFileToItem
 * - getFilesForMediaItem
 * - getLinkedMediaItemIds  (multi-episode file → mark all episodes watched)
 * - getEditionsForMediaItem (edition picker)
 *
 * Requires a running test DB with migrations 11.21.0 + 11.22.0 applied.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { hashFileHead } from '../../utils/file-hash.js';
import {
    createTestMediaItem,
    ensureTestUser,
    generateTestUserId,
    insertTestMediaItem,
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    upsertMediaFile,
    attachFileToItem,
    getFilesForMediaItem,
    findMediaFileByPath,
    loadMediaFilesByPrefix,
    findMediaItemByFilePath,
    findParentMediaItemByFolder,
    findParentMediaItemsByFolders,
    findArtistByChildFolder,
    getLinkedMediaItemIds,
    getEditionsForMediaItem,
    markFileMissing,
    clearFileMissing,
    getUnprobedFiles,
    updateFileStat,
    getFilesWithoutKeyframes,
    deleteStaleMediaFile,
    promoteHighestQualityVersion,
    invalidateFileProbeData,
    findDescendantDirAnchors,
    listScanIssues,
    recordFileScanIssue,
    removeReviewedHealthIssues,
    recordDecodeHealthIssue,
    type FileHealthIssue,
} from './media-files.queries.js';
import { clearStaleRefusalAndEnsureChangeDetection } from '../../tasks/builtin/native/media-sources/_helpers/file-scanner/shared.js';
import { upsertLocalArtwork } from './media-artwork.queries.js';
import { cleanupOrphanedMediaFiles } from './database-cleanup.queries.js';
import { UNLINKED_FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline.js';

describe('Media Files Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // CASCADE handles all FK-referencing tables (play_sessions, media_segments, etc.)
        await sql.unsafe('TRUNCATE TABLE media_file_items, media_files, media_items CASCADE');
    });

    describe('removeReviewedHealthIssues', () => {
        const reviewed: FileHealthIssue = {
            type: 'video_ends_early',
            detected_at: '2026-10-01T00:00:00Z',
        };
        const gap: FileHealthIssue = {
            type: 'video_decode_gaps',
            detected_at: '2026-10-02T00:00:00Z',
        };

        async function seed(issues: FileHealthIssue[]): Promise<string> {
            const { id } = await upsertMediaFile(sql, { filePath: '/media/review.mkv' });
            await sql`UPDATE media_files
                      SET health_issues = ${sql.json(issues as unknown as postgres.JSONValue)},
                          audit_run_job_id = 'original-run-42'
                      WHERE id = ${id}::uuid`;
            return id;
        }

        it('removes reviewed evidence, preserves unrelated issues and audit provenance', async () => {
            const id = await seed([reviewed, gap]);
            expect(await removeReviewedHealthIssues(sql, id, [reviewed])).toEqual({
                removed: 1,
                remaining: [gap],
            });
            const [row] =
                await sql`SELECT health_issues, audit_run_job_id FROM media_files WHERE id = ${id}::uuid`;
            expect(row.health_issues).toEqual([gap]);
            expect(row.audit_run_job_id).toBe('original-run-42');
        });

        it('preserves a newer issue of the same type from a stale probe snapshot', async () => {
            const newer = {
                ...reviewed,
                detail: 'fresh evidence',
                detected_at: '2026-10-03T00:00:00Z',
            };
            const id = await seed([newer, gap]);
            expect(await removeReviewedHealthIssues(sql, id, [reviewed])).toEqual({
                removed: 0,
                remaining: [newer, gap],
            });
        });

        it('clears the audit link only when the last reviewed issue is removed', async () => {
            const id = await seed([reviewed]);
            expect(await removeReviewedHealthIssues(sql, id, [reviewed])).toEqual({
                removed: 1,
                remaining: [],
            });
            const [row] =
                await sql`SELECT health_issues, audit_run_job_id FROM media_files WHERE id = ${id}::uuid`;
            expect(row.health_issues).toBeNull();
            expect(row.audit_run_job_id).toBeNull();
        });

        it.each([false, true])(
            'waits for the decode-writer lock and honors cancellation=%s',
            async (cancel) => {
                const id = await seed([reviewed]);
                const writer = postgres(getTestDatabaseUrl(), { max: 1 });
                const reviewer = postgres(getTestDatabaseUrl(), { max: 1 });
                let releaseWriter!: () => void;
                let writerReady!: () => void;
                const release = new Promise<void>((resolve) => {
                    releaseWriter = resolve;
                });
                const ready = new Promise<void>((resolve) => {
                    writerReady = resolve;
                });
                const writing = writer.begin(async (tx) => {
                    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
                    await tx`UPDATE media_files SET health_issues = ${tx.json([reviewed, gap] as unknown as postgres.JSONValue)} WHERE id = ${id}::uuid`;
                    writerReady();
                    await release;
                });
                let reviewing: ReturnType<typeof removeReviewedHealthIssues> | undefined;
                try {
                    await ready;
                    const [{ pid }] = await reviewer<
                        { pid: number }[]
                    >`SELECT pg_backend_pid() AS pid`;
                    const controller = new AbortController();
                    reviewing = removeReviewedHealthIssues(
                        reviewer,
                        id,
                        [reviewed],
                        controller.signal,
                    );
                    let blocked = false;
                    for (let attempt = 0; attempt < 200; attempt++) {
                        const [{ waiting }] = await sql<{ waiting: boolean }[]>`
                        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND NOT granted AND locktype = 'advisory') AS waiting
                    `;
                        if (waiting) {
                            blocked = true;
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    expect(blocked).toBe(true);
                    if (cancel) controller.abort();
                    releaseWriter();
                    await writing;
                    if (cancel) {
                        await expect(reviewing).rejects.toThrow(/abort/i);
                        const [row] =
                            await sql`SELECT health_issues FROM media_files WHERE id = ${id}::uuid`;
                        expect(row.health_issues).toEqual([reviewed, gap]);
                    } else {
                        expect(await reviewing).toEqual({ removed: 1, remaining: [gap] });
                    }
                } finally {
                    releaseWriter();
                    await writing;
                    await reviewing?.catch(() => {});
                    await writer.end();
                    await reviewer.end();
                }
            },
        );

        it('rejects a pre-cancelled review before opening a transaction or waiting on locks', async () => {
            const controller = new AbortController();
            controller.abort();
            const untouched = vi.fn();
            await expect(
                removeReviewedHealthIssues(
                    untouched as unknown as postgres.Sql,
                    'unused',
                    [reviewed],
                    controller.signal,
                ),
            ).rejects.toThrow(/abort/i);
            expect(untouched).not.toHaveBeenCalled();
        });

        it('rolls back removed issues when cancellation arrives after the mutation', async () => {
            const id = await seed([reviewed]);
            const controller = new AbortController();
            const originalCheck = controller.signal.throwIfAborted.bind(controller.signal);
            let checks = 0;
            const check = vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
                if (++checks === 4) controller.abort();
                originalCheck();
            });
            try {
                await expect(
                    removeReviewedHealthIssues(sql, id, [reviewed], controller.signal),
                ).rejects.toThrow(/abort/i);
                expect(check).toHaveBeenCalledTimes(4);
                const [row] =
                    await sql`SELECT health_issues, audit_run_job_id FROM media_files WHERE id = ${id}::uuid`;
                expect(row.health_issues).toEqual([reviewed]);
                expect(row.audit_run_job_id).toBe('original-run-42');
            } finally {
                check.mockRestore();
            }
        });

        it('sets a five-second transaction-local lock wait bound', async () => {
            const id = await seed([reviewed]);
            await sql.begin(async (tx) => {
                await removeReviewedHealthIssues(tx as unknown as postgres.Sql, id, [reviewed]);
                const [{ timeout }] = await tx<
                    { timeout: string }[]
                >`SELECT current_setting('lock_timeout') AS timeout`;
                expect(timeout).toBe('5s');
            });
        });

        it('keeps a decode writer update made after the probe snapshot', async () => {
            const id = await seed([reviewed]);
            await recordDecodeHealthIssue(sql, {
                fileId: id,
                type: 'video_decode_gaps',
                detail: 'interior decode damage',
            });
            const result = await removeReviewedHealthIssues(sql, id, [reviewed]);
            expect(result?.removed).toBe(1);
            expect(result?.remaining).toEqual([
                expect.objectContaining({
                    type: 'video_decode_gaps',
                    detail: 'interior decode damage',
                }),
            ]);
        });
    });

    // =========================================================================
    // upsertMediaFile
    // =========================================================================

    describe('upsertMediaFile', () => {
        it('inserts a new file row and returns created=true', async () => {
            const result = await upsertMediaFile(sql, {
                filePath: '/media/movies/Daydream (2010).mkv',
            });

            expect(result.id).toBeTruthy();
            expect(result.created).toBe(true);
        });

        it('returns created=false on duplicate file_path', async () => {
            const params = { filePath: '/media/movies/Daydream (2010).mkv' };
            const first = await upsertMediaFile(sql, params);
            const second = await upsertMediaFile(sql, params);

            expect(second.id).toBe(first.id);
            expect(second.created).toBe(false);
        });

        it('updates edition and part_number on conflict', async () => {
            const filePath = '/media/movies/The Lantern (1999).mkv';
            await upsertMediaFile(sql, { filePath });
            await upsertMediaFile(sql, {
                filePath,
                edition: 'Directors Cut',
                partNumber: 1,
            });

            const found = await findMediaFileByPath(sql, filePath);
            expect(found?.edition).toBe('Directors Cut');
            expect(found?.part_number).toBe(1);
        });

        it('stores edition as null when not provided', async () => {
            await upsertMediaFile(sql, {
                filePath: '/media/movies/No Edition.mkv',
            });
            const found = await findMediaFileByPath(sql, '/media/movies/No Edition.mkv');
            expect(found?.edition).toBeNull();
            expect(found?.part_number).toBeNull();
        });

        it('clears is_missing and nulls probed_at when a missing file is re-upserted', async () => {
            const filePath = '/media/movies/Rediscovered.mkv';
            const { id: fileId } = await upsertMediaFile(sql, { filePath });

            await markFileMissing(sql, fileId);

            // Verify sentinel was set
            const [missing] = await sql<Array<{ is_missing: boolean; probed_at: Date | null }>>`
                SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(missing.is_missing).toBe(true);
            expect(missing.probed_at).not.toBeNull();

            // Re-upsert the same path (simulates file scanner re-detecting the path)
            await upsertMediaFile(sql, { filePath });

            const [after] = await sql<Array<{ is_missing: boolean; probed_at: Date | null }>>`
                SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(after.is_missing).toBe(false);
            expect(after.probed_at).toBeNull();
        });

        it('does not reset probed_at when re-upserting a healthy (non-missing) file', async () => {
            const filePath = '/media/movies/Healthy.mkv';
            const { id: fileId } = await upsertMediaFile(sql, { filePath });

            // Simulate probe completion
            await sql`UPDATE media_files SET probed_at = NOW() WHERE id = ${fileId}::uuid`;

            const [before] = await sql<Array<{ probed_at: Date | null }>>`
                SELECT probed_at FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(before.probed_at).not.toBeNull();
            const probedAtBefore = before.probed_at;

            // Re-upsert (metadata refresh path — file is healthy, not missing)
            await upsertMediaFile(sql, { filePath, edition: 'Remaster' });

            const [after] = await sql<Array<{ is_missing: boolean; probed_at: Date | null }>>`
                SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(after.is_missing).toBe(false);
            // probed_at must be preserved (CASE branch: is_missing was false)
            expect(after.probed_at?.getTime()).toBe(probedAtBefore?.getTime());
        });

        // fix #5 (rename-race follow-up): file_hash_head must be populated at
        // ingest time (part of the same INSERT), not left for a later,
        // separate updateFileStat() write — closing the window where a fast
        // rename right after first-ingest sees dismissed_content_hash = NULL
        // and reclaim-by-hash silently misses.
        it('ingest populates file_hash_head immediately when passed to upsertMediaFile', async () => {
            const tempDir = await mkdtemp(join(tmpdir(), 'lumastra-media-files-test-'));
            try {
                const absPath = join(tempDir, 'track.flac');
                await writeFile(absPath, 'some real bytes for head-hash computation');
                const expectedHash = await hashFileHead(absPath);

                const { id: fileId, created } = await upsertMediaFile(sql, {
                    filePath: absPath,
                    fileHashHead: expectedHash,
                });
                expect(created).toBe(true);

                const [row] = await sql<Array<{ file_hash_head: string | null }>>`
                    SELECT file_hash_head FROM media_files WHERE id = ${fileId}::uuid
                `;
                expect(row.file_hash_head).toBe(expectedHash);
            } finally {
                await rm(tempDir, { recursive: true, force: true });
            }
        });

        it('does not clobber an existing file_hash_head on conflict', async () => {
            const filePath = '/media/movies/Already-Hashed.mkv';
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath,
                fileHashHead: 'original-hash',
            });
            const [before] = await sql<Array<{ file_hash_head: string | null }>>`
                SELECT file_hash_head FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(before.file_hash_head).toBe('original-hash');

            // Re-upsert (e.g. metadata refresh path) without a hash — the
            // ON CONFLICT branch must not touch file_hash_head at all,
            // matching pre-existing upsertMediaFile semantics (hash lifecycle
            // is owned by updateFileStat/change-detection after first ingest).
            await upsertMediaFile(sql, { filePath, edition: 'Remaster' });

            const [after] = await sql<Array<{ file_hash_head: string | null }>>`
                SELECT file_hash_head FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(after.file_hash_head).toBe('original-hash');
        });
    });

    describe('upsertMediaFile: absolute_episode', () => {
        const filePath = '/media/tv/Show/Season 09/Show - S09E21 - 188 - Title.mkv';
        const stored = async (): Promise<number | null> => {
            const [row] = await sql<{ absolute_episode: number | null }[]>`
                SELECT absolute_episode FROM media_files WHERE file_path = ${filePath}
            `;
            return row.absolute_episode;
        };

        it('a number sets the column on insert', async () => {
            await upsertMediaFile(sql, { filePath, absoluteEpisode: 188 });
            expect(await stored()).toBe(188);
        });

        it('undefined keeps the stored value on conflict', async () => {
            await upsertMediaFile(sql, { filePath, absoluteEpisode: 188 });
            await upsertMediaFile(sql, { filePath, edition: 'Extended' });
            expect(await stored()).toBe(188);
        });

        it('null clears the stored value on conflict', async () => {
            await upsertMediaFile(sql, { filePath, absoluteEpisode: 188 });
            await upsertMediaFile(sql, { filePath, absoluteEpisode: null });
            expect(await stored()).toBeNull();
        });

        it('a number replaces the stored value on conflict', async () => {
            await upsertMediaFile(sql, { filePath, absoluteEpisode: 188 });
            await upsertMediaFile(sql, { filePath, absoluteEpisode: 189 });
            expect(await stored()).toBe(189);
        });

        it('findMediaFileByPath and the bulk prefix load both carry the column', async () => {
            await upsertMediaFile(sql, { filePath, absoluteEpisode: 188 });

            expect((await findMediaFileByPath(sql, filePath))?.absolute_episode).toBe(188);
            const known = await loadMediaFilesByPrefix(sql, '/media/tv/Show');
            expect(known.get(filePath)?.absolute_episode).toBe(188);
        });
    });

    // =========================================================================
    // findMediaFileByPath
    // =========================================================================

    describe('findMediaFileByPath', () => {
        it('returns null when path does not exist', async () => {
            const result = await findMediaFileByPath(sql, '/media/nonexistent.mkv');
            expect(result).toBeNull();
        });

        it('returns the row with all fields populated', async () => {
            const filePath = '/media/movies/Dawn (2021).mkv';
            await upsertMediaFile(sql, {
                filePath,
                edition: 'IMAX',
                partNumber: 2,
            });

            const found = await findMediaFileByPath(sql, filePath);
            expect(found).not.toBeNull();
            expect(found?.file_path).toBe(filePath);
            expect(found?.edition).toBe('IMAX');
            expect(found?.part_number).toBe(2);
            expect(found?.id).toBeTruthy();
        });
    });

    // =========================================================================
    // attachFileToItem + getFilesForMediaItem
    // =========================================================================

    describe('attachFileToItem / getFilesForMediaItem', () => {
        it('links a file to a media item and retrieves it', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Solo File.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const files = await getFilesForMediaItem(sql, item.id);
            expect(files).toHaveLength(1);
            expect(files[0].id).toBe(fileId);
            expect(files[0].file_path).toBe('/media/movies/Solo File.mkv');
        });

        it('returns empty array when media item has no files', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const files = await getFilesForMediaItem(sql, item.id);
            expect(files).toHaveLength(0);
        });

        it('attachFileToItem is idempotent', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Idempotent.mkv',
            });

            // Call twice — should not throw on second call
            await attachFileToItem(sql, fileId, item.id);
            await attachFileToItem(sql, fileId, item.id);

            const files = await getFilesForMediaItem(sql, item.id);
            expect(files).toHaveLength(1);
        });

        it('orders files by part_number NULLS FIRST', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileNullPart } = await upsertMediaFile(sql, {
                filePath: '/media/ep/Part_null.mkv',
            });
            const { id: filePart2 } = await upsertMediaFile(sql, {
                filePath: '/media/ep/Part2.mkv',
                partNumber: 2,
            });
            const { id: filePart1 } = await upsertMediaFile(sql, {
                filePath: '/media/ep/Part1.mkv',
                partNumber: 1,
            });

            await attachFileToItem(sql, fileNullPart, item.id);
            await attachFileToItem(sql, filePart2, item.id);
            await attachFileToItem(sql, filePart1, item.id);

            const files = await getFilesForMediaItem(sql, item.id);
            expect(files).toHaveLength(3);
            // NULL part_number comes first, then ascending
            expect(files[0].part_number).toBeNull();
            expect(files[1].part_number).toBe(1);
            expect(files[2].part_number).toBe(2);
        });

        it('one file can be linked to multiple media items (multi-episode file)', async () => {
            const ep1 = createTestMediaItem({ media_type: 'episode' });
            const ep2 = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/ShowS01E01E02.mkv',
            });
            await attachFileToItem(sql, fileId, ep1.id);
            await attachFileToItem(sql, fileId, ep2.id);

            const filesForEp1 = await getFilesForMediaItem(sql, ep1.id);
            const filesForEp2 = await getFilesForMediaItem(sql, ep2.id);
            expect(filesForEp1[0].id).toBe(fileId);
            expect(filesForEp2[0].id).toBe(fileId);
        });
    });

    // =========================================================================
    // getLinkedMediaItemIds — core logic for multi-episode completion
    // =========================================================================

    describe('findMediaItemByFilePath / findParentMediaItemByFolder (extra parent resolution)', () => {
        it('resolves the exact primary linked to a file path', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Film (2020)/B.mkv',
            });
            await attachFileToItem(sql, fileId, movie.id);

            expect(await findMediaItemByFilePath(sql, '/media/movies/Film (2020)/B.mkv')).toBe(
                movie.id,
            );
            expect(
                await findMediaItemByFilePath(sql, '/media/movies/Film (2020)/missing.mkv'),
            ).toBe(null);
        });

        it('does not resolve a path linked only to an extra', async () => {
            // test fixture: deliberately builds an 'extra' row, which the
            // factory's type does not model, to prove it is not resolvable
            // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
            const extra = createTestMediaItem({ media_type: 'extra' as 'movie' });
            await insertTestMediaItem(sql, extra);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Film (2020)/Film-trailer.mkv',
            });
            await attachFileToItem(sql, fileId, extra.id);

            expect(
                await findMediaItemByFilePath(sql, '/media/movies/Film (2020)/Film-trailer.mkv'),
            ).toBe(null);
        });

        it('exact match picks the right primary where the folder lookup is ambiguous', async () => {
            // Two primaries in one flat folder; a trailer belongs to B.
            const a = createTestMediaItem({ media_type: 'movie' });
            const b = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, a);
            await insertTestMediaItem(sql, b);
            const { id: fileA } = await upsertMediaFile(sql, { filePath: '/media/flat/A.mkv' });
            const { id: fileB } = await upsertMediaFile(sql, { filePath: '/media/flat/B.mkv' });
            await attachFileToItem(sql, fileA, a.id);
            await attachFileToItem(sql, fileB, b.id);

            // Exact match returns B specifically (the walker's name-matched hint).
            expect(await findMediaItemByFilePath(sql, '/media/flat/B.mkv')).toBe(b.id);
            // Folder lookup is deterministic (ORDER BY file_path → A.mkv) but not
            // necessarily the intended parent — hence the exact-match hint.
            expect(await findParentMediaItemByFolder(sql, '/media/flat')).toBe(a.id);
        });
    });

    describe('findArtistByChildFolder (artist-folder artwork target)', () => {
        /** An album by `artistId` whose one track lives at `filePath`. */
        async function albumWithTrackAt(artistId: string, filePath: string): Promise<void> {
            const album = createTestAlbum(artistId);
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);
            const { id: fileId } = await upsertMediaFile(sql, { filePath });
            await attachFileToItem(sql, fileId, track.id);
        }

        it('a folder of compilations named after no artist belongs to nobody', async () => {
            // Prod: every album in juno/ is a compilation, and juno's photo,
            // backdrop and logo became the Various Artists artist's.
            const va = createTestArtist({ title: 'Various Artists' });
            await insertTestArtist(sql, va);
            await albumWithTrackAt(va.id, '/music/juno/Hands_Up_Heroes/01-track.flac');

            expect(await findArtistByChildFolder(sql, '/music/juno')).toBeNull();
        });

        it('a folder is its own artist’s, not that of another artist with tracks in it', async () => {
            const va = createTestArtist({
                title: 'Various Artists',
                custom_metadata: { nfo_source_path: '/music/Various Artists/artist.nfo' },
            });
            const ziggy = createTestArtist({ title: 'Ziggy Nebula' });
            await insertTestArtist(sql, va);
            await insertTestArtist(sql, ziggy);
            await albumWithTrackAt(ziggy.id, '/music/Various Artists/A Single/01.mp3');
            await albumWithTrackAt(va.id, '/music/Various Artists/Trance 62/CD 01/01.mp3');

            expect(await findArtistByChildFolder(sql, '/music/Various Artists')).toBe(va.id);
        });

        it('matches the folder name loosely (underscores, case, punctuation)', async () => {
            const artist = createTestArtist({ title: 'Darren Nightfall' });
            await insertTestArtist(sql, artist);
            await albumWithTrackAt(artist.id, '/music/Darren_Nightfall/Feel (2010)/01.mp3');

            expect(await findArtistByChildFolder(sql, '/music/Darren_Nightfall')).toBe(artist.id);
        });

        it('a duo’s folder does not go to one half of the duo', async () => {
            const half = createTestArtist({ title: 'W' });
            await insertTestArtist(sql, half);
            await albumWithTrackAt(half.id, '/music/W&W/Rave Culture/01.mp3');

            expect(await findArtistByChildFolder(sql, '/music/W&W')).toBeNull();
        });
    });

    describe('findParentMediaItemsByFolders (batched folder lookup)', () => {
        it('answers every folder exactly as findParentMediaItemByFolder does', async () => {
            const link = async (filePath: string, mediaType: string): Promise<string> => {
                // test fixture: 'extra' is not in the factory's media_type union
                // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
                const item = createTestMediaItem({ media_type: mediaType as 'movie' });
                await insertTestMediaItem(sql, item);
                const { id } = await upsertMediaFile(sql, { filePath });
                await attachFileToItem(sql, id, item.id);
                return item.id;
            };
            // Two primaries in one folder: ORDER BY file_path picks A.
            await link('/lib/flat/B.mkv', 'movie');
            await link('/lib/flat/A.mkv', 'movie');
            // Only an extra directly inside: excluded.
            await link('/lib/extra-only/trailer.mkv', 'extra');
            // Only a file one level down: not a direct child.
            await link('/lib/series/Season 01/e1.mkv', 'movie');
            // LIKE wildcards in names are literal, not patterns.
            await link('/lib/a_b/x.mkv', 'movie');
            await link('/lib/axb/y.mkv', 'movie');
            await link('/lib/100%/z.mkv', 'movie');
            // An unlinked file row is invisible.
            await upsertMediaFile(sql, { filePath: '/lib/unlinked/u.mkv' });

            const folders = [
                '/lib/flat',
                '/lib/flat/',
                '/lib/extra-only',
                '/lib/series',
                '/lib/series/Season 01',
                '/lib/a_b',
                '/lib/axb',
                '/lib/a%b',
                '/lib/100%',
                '/lib/unlinked',
                '/lib/missing',
                '/lib',
                '/lib/flat',
            ];
            const batched = await findParentMediaItemsByFolders(sql, folders);
            const single = new Map<string, string | null>();
            for (const f of folders) single.set(f, await findParentMediaItemByFolder(sql, f));

            expect(Object.fromEntries(batched)).toEqual(Object.fromEntries(single));
            // Guard against both being wrong the same way.
            expect(batched.get('/lib/flat')).not.toBeNull();
            expect(batched.get('/lib/flat')).toBe(batched.get('/lib/flat/'));
            expect(batched.get('/lib/extra-only')).toBeNull();
            expect(batched.get('/lib/series')).toBeNull();
            expect(batched.get('/lib/series/Season 01')).not.toBeNull();
            expect(batched.get('/lib/a_b')).not.toBe(batched.get('/lib/axb'));
            expect(batched.get('/lib/a%b')).toBeNull();
            expect(batched.get('/lib/100%')).not.toBeNull();
            expect(batched.get('/lib/unlinked')).toBeNull();
            expect(batched.get('/lib')).toBeNull();
        });

        it('returns an empty map for no folders and handles more than one chunk', async () => {
            expect((await findParentMediaItemsByFolders(sql, [])).size).toBe(0);

            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const { id } = await upsertMediaFile(sql, { filePath: '/lib/f1500/m.mkv' });
            await attachFileToItem(sql, id, movie.id);

            const folders = Array.from({ length: 2100 }, (_, i) => `/lib/f${i}`);
            const batched = await findParentMediaItemsByFolders(sql, folders);
            expect(batched.size).toBe(2100);
            expect(batched.get('/lib/f1500')).toBe(movie.id);
            expect([...batched.values()].filter((v) => v !== null)).toEqual([movie.id]);
        });
    });

    describe('getLinkedMediaItemIds', () => {
        it('returns empty array when media item has no files', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const ids = await getLinkedMediaItemIds(sql, item.id);
            expect(ids).toHaveLength(0);
        });

        it('returns only the item itself for a solo-episode file', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Show S01E01.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const ids = await getLinkedMediaItemIds(sql, item.id);
            expect(ids).toEqual([item.id]);
        });

        it('returns all episode IDs sharing the same multi-episode file', async () => {
            const ep1 = createTestMediaItem({ media_type: 'episode' });
            const ep2 = createTestMediaItem({ media_type: 'episode' });
            const ep3 = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);
            await insertTestMediaItem(sql, ep3);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/ShowS01E01-E03.mkv',
            });
            await attachFileToItem(sql, fileId, ep1.id);
            await attachFileToItem(sql, fileId, ep2.id);
            await attachFileToItem(sql, fileId, ep3.id);

            const ids = await getLinkedMediaItemIds(sql, ep1.id);
            expect(ids.sort()).toEqual([ep1.id, ep2.id, ep3.id].sort());
        });

        it('does not leak IDs from unrelated files', async () => {
            const ep1 = createTestMediaItem({ media_type: 'episode' });
            const ep2 = createTestMediaItem({ media_type: 'episode' });
            const unrelated = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);
            await insertTestMediaItem(sql, unrelated);

            // ep1 + ep2 share a file
            const { id: sharedFile } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SharedEp.mkv',
            });
            await attachFileToItem(sql, sharedFile, ep1.id);
            await attachFileToItem(sql, sharedFile, ep2.id);

            // unrelated has its own file
            const { id: otherFile } = await upsertMediaFile(sql, {
                filePath: '/media/tv/OtherEp.mkv',
            });
            await attachFileToItem(sql, otherFile, unrelated.id);

            const idsForEp1 = await getLinkedMediaItemIds(sql, ep1.id);
            expect(idsForEp1.sort()).toEqual([ep1.id, ep2.id].sort());
            expect(idsForEp1).not.toContain(unrelated.id);
        });

        it('handles split files (episode spanning multiple files)', async () => {
            // One episode, two part files — linked IDs should just be the episode itself
            const ep = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, ep);

            const { id: part1Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/LongEpPart1.mkv',
                partNumber: 1,
            });
            const { id: part2Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/LongEpPart2.mkv',
                partNumber: 2,
            });
            await attachFileToItem(sql, part1Id, ep.id);
            await attachFileToItem(sql, part2Id, ep.id);

            const ids = await getLinkedMediaItemIds(sql, ep.id);
            // DISTINCT ensures the single episode id appears only once
            expect(ids).toHaveLength(1);
            expect(ids[0]).toBe(ep.id);
        });
    });

    // =========================================================================
    // getEditionsForMediaItem
    // =========================================================================

    describe('getEditionsForMediaItem', () => {
        it('returns empty array when no files exist', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const editions = await getEditionsForMediaItem(sql, item.id);
            expect(editions).toHaveLength(0);
        });

        it('returns empty array when files have no edition', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/No Edition.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const editions = await getEditionsForMediaItem(sql, item.id);
            expect(editions).toHaveLength(0);
        });

        it('returns distinct editions for a media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: theatricalId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Movie Theatrical.mkv',
                edition: 'Theatrical',
            });
            const { id: directorsId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Movie Directors Cut.mkv',
                edition: "Director's Cut",
            });
            await attachFileToItem(sql, theatricalId, item.id);
            await attachFileToItem(sql, directorsId, item.id);

            const editions = await getEditionsForMediaItem(sql, item.id);
            expect(editions.sort()).toEqual(['Theatrical', "Director's Cut"].sort());
        });

        it('does not return editions from other media items', async () => {
            const item1 = createTestMediaItem({ media_type: 'movie' });
            const item2 = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item1);
            await insertTestMediaItem(sql, item2);

            const { id: file1Id } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Movie1 IMAX.mkv',
                edition: 'IMAX',
            });
            const { id: file2Id } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Movie2 4K.mkv',
                edition: '4K',
            });
            await attachFileToItem(sql, file1Id, item1.id);
            await attachFileToItem(sql, file2Id, item2.id);

            const editions = await getEditionsForMediaItem(sql, item1.id);
            expect(editions).toEqual(['IMAX']);
        });

        it('returns each edition only once even if multiple files share it', async () => {
            // Part 1 and Part 2 of the same "IMAX" edition
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: part1Id } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Long Movie IMAX Part1.mkv',
                edition: 'IMAX',
                partNumber: 1,
            });
            const { id: part2Id } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Long Movie IMAX Part2.mkv',
                edition: 'IMAX',
                partNumber: 2,
            });
            await attachFileToItem(sql, part1Id, item.id);
            await attachFileToItem(sql, part2Id, item.id);

            const editions = await getEditionsForMediaItem(sql, item.id);
            expect(editions).toHaveLength(1);
            expect(editions[0]).toBe('IMAX');
        });
    });

    // =========================================================================
    // markFileMissing / clearFileMissing
    // =========================================================================

    describe('markFileMissing', () => {
        it('sets is_missing = true and probed_at = non-null', async () => {
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Gone.mkv',
            });

            await markFileMissing(sql, fileId);

            const [row] = await sql<Array<{ is_missing: boolean; probed_at: Date | null }>>`
                SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(row.is_missing).toBe(true);
            expect(row.probed_at).not.toBeNull();
        });

        it('is idempotent — calling twice does not throw', async () => {
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Gone2.mkv',
            });

            await markFileMissing(sql, fileId);
            await markFileMissing(sql, fileId);

            const [row] = await sql<Array<{ is_missing: boolean }>>`
                SELECT is_missing FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(row.is_missing).toBe(true);
        });
    });

    describe('clearFileMissing', () => {
        it('resets is_missing to false', async () => {
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Returned.mkv',
            });

            await markFileMissing(sql, fileId);
            await clearFileMissing(sql, fileId);

            const [row] = await sql<Array<{ is_missing: boolean }>>`
                SELECT is_missing FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(row.is_missing).toBe(false);
        });
    });

    // =========================================================================
    // getUnprobedFiles — excludes is_missing rows
    // =========================================================================

    describe('getUnprobedFiles', () => {
        it('returns unprobed linked files', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Unprobed.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const rows = await getUnprobedFiles(sql, 10);
            expect(rows.some((r) => r.id === fileId)).toBe(true);
        });

        it('carries the committed stat, comparable with a scan-time probe stat', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/StatCarried.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);
            const mtime = new Date('2026-10-20T12:34:56.789Z');
            await updateFileStat(sql, fileId, mtime, 3_221_225_472, 'hash');

            const row = (await getUnprobedFiles(sql, 10)).find((r) => r.id === fileId);
            expect(row?.file_mtime).toBeInstanceOf(Date);
            expect(row?.file_mtime?.getTime()).toBe(mtime.getTime());
            expect(Number(row?.file_size_bytes)).toBe(3_221_225_472);
        });

        it('excludes files with is_missing = true', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Missing.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);
            await markFileMissing(sql, fileId);

            const rows = await getUnprobedFiles(sql, 10);
            expect(rows.some((r) => r.id === fileId)).toBe(false);
        });

        it('excludes files with probed_at already set', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/AlreadyProbed.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);
            await sql`UPDATE media_files SET probed_at = NOW() WHERE id = ${fileId}::uuid`;

            const rows = await getUnprobedFiles(sql, 10);
            expect(rows.some((r) => r.id === fileId)).toBe(false);
        });
    });

    // =========================================================================
    // getFilesWithoutKeyframes — excludes is_missing rows
    // =========================================================================

    describe('getFilesWithoutKeyframes', () => {
        it('returns probed video files without keyframes', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/NoKeyframes.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);
            // Set probed_at and insert a video stream so the file qualifies
            await sql`UPDATE media_files SET probed_at = NOW() WHERE id = ${fileId}::uuid`;
            await sql`
                INSERT INTO media_streams (file_id, stream_index, stream_type, codec)
                VALUES (${fileId}::uuid, 0, 'video', 'h264')
            `;

            const rows = await getFilesWithoutKeyframes(sql, 10);
            expect(rows.some((r) => r.id === fileId)).toBe(true);
        });

        it('excludes files with is_missing = true', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/MissingNoKf.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);
            // Mark missing (which also sets probed_at)
            await markFileMissing(sql, fileId);
            await sql`
                INSERT INTO media_streams (file_id, stream_index, stream_type, codec)
                VALUES (${fileId}::uuid, 0, 'video', 'h264')
            `;

            const rows = await getFilesWithoutKeyframes(sql, 10);
            expect(rows.some((r) => r.id === fileId)).toBe(false);
        });
    });

    // =========================================================================
    // deleteStaleMediaFile — sibling promotion
    // =========================================================================

    describe('deleteStaleMediaFile', () => {
        it('sole file deleted — no remaining files, no promotion attempted', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Sole.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            // Sanity: one file, is_default=true
            const before = await getFilesForMediaItem(sql, item.id);
            expect(before).toHaveLength(1);

            await expect(deleteStaleMediaFile(sql, '/media/tv/Sole.mkv')).resolves.toMatchObject({
                deleted: true,
            });

            const after = await getFilesForMediaItem(sql, item.id);
            expect(after).toHaveLength(0);
        });

        it('an attach racing the delete of the default file waits, then becomes the default', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { id: oldId } = await upsertMediaFile(sql, { filePath: '/media/m/Old.mkv' });
            await attachFileToItem(sql, oldId, item.id);
            const { id: newId } = await upsertMediaFile(sql, { filePath: '/media/m/New.mkv' });

            // Hold the delete's transaction open while the attach starts. Without
            // the advisory lock the attach saw the old default, linked its file as
            // non-default, and failed the one-default trigger at its commit.
            let attach!: Promise<void>;
            let attachSettled = false;
            await sql.begin(async (tx) => {
                await deleteStaleMediaFile(tx as unknown as postgres.Sql, '/media/m/Old.mkv');
                attach = attachFileToItem(sql, newId, item.id).finally(() => {
                    attachSettled = true;
                });
                attach.catch(() => undefined);
                await new Promise((r) => setTimeout(r, 300));
                expect(attachSettled).toBe(false);
            });
            await expect(attach).resolves.toBeUndefined();

            const rows = await sql<{ file_id: string; is_default: boolean }[]>`
                SELECT file_id, is_default FROM media_file_items WHERE media_item_id = ${item.id}::uuid
            `;
            expect(rows).toEqual([{ file_id: newId, is_default: true }]);
        });

        it('default file deleted with one sibling — sibling becomes default', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            // File A is the default (attached first)
            const { id: fileAId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/EpA.mkv',
            });
            await attachFileToItem(sql, fileAId, item.id);

            // File B is the sibling (is_default=false)
            const { id: fileBId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/EpB.mkv',
            });
            await attachFileToItem(sql, fileBId, item.id);

            // Confirm initial state
            const [rowA] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${fileAId}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(rowA.is_default).toBe(true);

            // Delete the default file
            await deleteStaleMediaFile(sql, '/media/tv/EpA.mkv');

            // Sibling B must now be the default
            const [rowB] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${fileBId}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(rowB.is_default).toBe(true);
        });

        it('default file deleted with two siblings — lowest sort_order wins', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileAId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Default.mkv',
            });
            await attachFileToItem(sql, fileAId, item.id);

            const { id: fileBId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SiblingB.mkv',
            });
            const { id: fileCId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SiblingC.mkv',
            });

            // Manually insert siblings with explicit sort_order so we control
            // which one should win (C has lower sort_order)
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileBId}::uuid, ${item.id}::uuid, FALSE, 2),
                       (${fileCId}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            await deleteStaleMediaFile(sql, '/media/tv/Default.mkv');

            // C (sort_order=1) must become the default
            const [rowC] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${fileCId}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(rowC.is_default).toBe(true);

            const [rowB] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${fileBId}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(rowB.is_default).toBe(false);
        });

        it('non-default file deleted — existing default remains untouched', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileAId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Default720p.mkv',
            });
            await attachFileToItem(sql, fileAId, item.id);

            const { id: fileBId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/NonDefault1080p.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileBId}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            // Delete the non-default file
            await deleteStaleMediaFile(sql, '/media/tv/NonDefault1080p.mkv');

            // Original default must still be default
            const [rowA] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${fileAId}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(rowA.is_default).toBe(true);
        });

        it('file linked to multiple media items — promotion runs per item', async () => {
            // Shared file (multi-episode) is default for both ep1 and ep2
            const ep1 = createTestMediaItem({ media_type: 'episode' });
            const ep2 = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);

            const { id: sharedId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SharedEp1E2.mkv',
            });
            await attachFileToItem(sql, sharedId, ep1.id);
            await attachFileToItem(sql, sharedId, ep2.id);

            // Each episode also has a sibling file
            const { id: sib1Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Ep1Sibling.mkv',
            });
            const { id: sib2Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Ep2Sibling.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${sib1Id}::uuid, ${ep1.id}::uuid, FALSE, 1),
                       (${sib2Id}::uuid, ${ep2.id}::uuid, FALSE, 1)
            `;

            await deleteStaleMediaFile(sql, '/media/tv/SharedEp1E2.mkv');

            // Both siblings should now be the default for their respective episodes
            const [r1] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${sib1Id}::uuid AND media_item_id = ${ep1.id}::uuid
            `;
            const [r2] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${sib2Id}::uuid AND media_item_id = ${ep2.id}::uuid
            `;
            expect(r1.is_default).toBe(true);
            expect(r2.is_default).toBe(true);
        });

        it('referenced by historical play_sessions — file is deleted, play_sessions.file_id is SET NULL (migration 16.8.0)', async () => {
            // Regression: pre-16.8.0 the FK had no ON DELETE clause and any
            // historical play_sessions row referencing the file aborted the
            // whole deleteStaleMediaFile transaction. Now the FK is
            // ON DELETE SET NULL — the play_sessions audit row survives,
            // its file_id link is cleared, and the file is deleted.
            // play_sessions.user_id is uuid REFERENCES users(id) since mig 16.46.0.
            const TEST_USER = generateTestUserId('stale-cleanup-fk-test-user');
            await ensureTestUser(sql, TEST_USER);

            // 3 files: one is referenced by play_sessions, two are not.
            const ep1 = createTestMediaItem({ media_type: 'episode' });
            const ep2 = createTestMediaItem({ media_type: 'episode' });
            const ep3 = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);
            await insertTestMediaItem(sql, ep3);

            const { id: fileRefId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Referenced.mkv',
            });
            const { id: fileA } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Unreferenced-A.mkv',
            });
            const { id: fileB } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Unreferenced-B.mkv',
            });
            await attachFileToItem(sql, fileRefId, ep1.id);
            await attachFileToItem(sql, fileA, ep2.id);
            await attachFileToItem(sql, fileB, ep3.id);

            // Historical play_sessions row pointing to the file we will delete.
            const [{ id: sessionId }] = await sql<{ id: string }[]>`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, ip_address, play_method,
                    file_id, status, stopped_at
                ) VALUES (
                    ${ep1.id}::uuid, ${TEST_USER}, 'test-device',
                    '127.0.0.1'::inet, 'direct',
                    ${fileRefId}::uuid, 'COMPLETED', now()
                )
                RETURNING id
            `;

            // Batch-delete all three files. Without the FK fix, the first
            // delete would have aborted because of the play_sessions reference.
            await deleteStaleMediaFile(sql, '/media/tv/Referenced.mkv');
            await deleteStaleMediaFile(sql, '/media/tv/Unreferenced-A.mkv');
            await deleteStaleMediaFile(sql, '/media/tv/Unreferenced-B.mkv');

            // All three files were deleted.
            const remaining = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM media_files
                 WHERE file_path IN (
                     '/media/tv/Referenced.mkv',
                     '/media/tv/Unreferenced-A.mkv',
                     '/media/tv/Unreferenced-B.mkv'
                 )
            `;
            expect(remaining[0].count).toBe('0');

            // The play_sessions row survives, but its file_id was SET NULL.
            const [session] = await sql<{ file_id: string | null }[]>`
                SELECT file_id FROM play_sessions WHERE id = ${sessionId}::uuid
            `;
            expect(session).toBeDefined();
            expect(session.file_id).toBeNull();
        });
    });

    // =========================================================================
    // F1d (fix round 2) — the operator-notes.md remediation for a playlist-
    // class-rejected file must go through deleteStaleMediaFile, never a raw
    // DELETE. These run the real remediation path against seeded rows for
    // the two scenarios the reviewer named: a single-file item, and a
    // multi-version item whose default file is the hostile one.
    // =========================================================================

    describe('F1d — safe remediation for a playlist-class-rejected file', () => {
        it('single-file item: remediation flips has_files to false and soft-dismisses the item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Hostile.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const before = await sql<{ has_files: boolean; is_dismissed: boolean }[]>`
                SELECT has_files, is_dismissed FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(before[0]).toMatchObject({ has_files: true, is_dismissed: false });

            // The remediation the operator is told to perform: move/remove the
            // file, then let the rescan retire it via deleteStaleMediaFile.
            await expect(
                deleteStaleMediaFile(sql, '/media/movies/Hostile.mkv'),
            ).resolves.toMatchObject({ deleted: true });

            const after = await sql<{ has_files: boolean; is_dismissed: boolean }[]>`
                SELECT has_files, is_dismissed FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(after[0]).toMatchObject({ has_files: false, is_dismissed: true });

            const remainingFiles = await getFilesForMediaItem(sql, item.id);
            expect(remainingFiles).toHaveLength(0);
        });

        it('multi-version item whose default is the hostile file: a sibling is promoted and the item stays available', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Hostile file is attached first, so it is the is_default=true row.
            const { id: hostileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Hostile-2160p.mkv',
            });
            await attachFileToItem(sql, hostileId, item.id);

            const { id: siblingId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/Clean-1080p.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${siblingId}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            await expect(
                deleteStaleMediaFile(sql, '/media/movies/Hostile-2160p.mkv'),
            ).resolves.toMatchObject({ deleted: true });

            const [siblingRow] = await sql<{ is_default: boolean }[]>`
                SELECT is_default FROM media_file_items
                 WHERE file_id = ${siblingId}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(siblingRow.is_default).toBe(true);

            const [itemRow] = await sql<{ has_files: boolean; is_dismissed: boolean }[]>`
                SELECT has_files, is_dismissed FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(itemRow).toMatchObject({ has_files: true, is_dismissed: false });
        });

        // Control (F1d): documents WHY the operator must not hand-write the
        // DELETE. A raw DELETE on a multi-version item's default file never
        // promotes a sibling, so the check_media_file_items_one_default()
        // constraint trigger raises at COMMIT and the whole transaction is
        // rolled back — the file isn't even removed.
        it('control: a raw DELETE on a multi-version default file fails at COMMIT', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: hostileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/RawDelete-Hostile.mkv',
            });
            await attachFileToItem(sql, hostileId, item.id);

            const { id: siblingId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/RawDelete-Clean.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${siblingId}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            await expect(
                sql`DELETE FROM media_files WHERE id = ${hostileId}::uuid`,
            ).rejects.toThrow(/media_file_items invariant violated/);

            // The failed transaction rolled back — the hostile file is still there.
            const stillThere = await findMediaFileByPath(
                sql,
                '/media/movies/RawDelete-Hostile.mkv',
            );
            expect(stillThere).not.toBeNull();
        });
    });

    // =========================================================================
    // promoteHighestQualityVersion
    // =========================================================================

    describe('promoteHighestQualityVersion', () => {
        it('single file — no-op, returns promoted=false', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/OnlyFile.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const result = await promoteHighestQualityVersion(sql, item.id);
            expect(result.promoted).toBe(false);
            expect(result.chosenFileId).toBe(fileId);
        });

        it('two files without stream rows — deterministic tiebreak by created_at ASC keeps first-created as default', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: file1Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/NoStream1.mkv',
            });
            await attachFileToItem(sql, file1Id, item.id);

            const { id: file2Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/NoStream2.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${file2Id}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            // No stream rows for either file — both have max_height=0 and
            // duration_seconds=null. Tiebreak is created_at ASC then file_id ASC.
            // file1 was created first so it should remain (or become) default.
            const result = await promoteHighestQualityVersion(sql, item.id);

            // The function may or may not promote depending on whether file1 is
            // already the default — but chosenFileId must be the first-created file.
            expect(result.chosenFileId).toBe(file1Id);
        });

        it('two files with stream rows: 720p vs 1080p — 1080p wins', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: file720Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/720p.mkv',
            });
            await attachFileToItem(sql, file720Id, item.id);

            const { id: file1080Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/1080p.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${file1080Id}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            // Insert stream rows with heights
            await sql`
                INSERT INTO media_streams (file_id, stream_index, stream_type, codec, height)
                VALUES (${file720Id}::uuid, 0, 'video', 'h264', 720)
            `;
            await sql`
                INSERT INTO media_streams (file_id, stream_index, stream_type, codec, height)
                VALUES (${file1080Id}::uuid, 0, 'video', 'h264', 1080)
            `;

            const result = await promoteHighestQualityVersion(sql, item.id);
            expect(result.promoted).toBe(true);
            expect(result.chosenFileId).toBe(file1080Id);

            // Verify DB state
            const [row1080] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${file1080Id}::uuid AND media_item_id = ${item.id}::uuid
            `;
            const [row720] = await sql<[{ is_default: boolean }]>`
                SELECT is_default FROM media_file_items WHERE file_id = ${file720Id}::uuid AND media_item_id = ${item.id}::uuid
            `;
            expect(row1080.is_default).toBe(true);
            expect(row720.is_default).toBe(false);
        });

        it('three files with same height — tiebreak by duration DESC then created_at ASC', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const { id: fileAId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SameHeight_A.mkv',
            });
            await attachFileToItem(sql, fileAId, item.id);

            const { id: fileBId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SameHeight_B.mkv',
            });
            const { id: fileCId } = await upsertMediaFile(sql, {
                filePath: '/media/tv/SameHeight_C.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileBId}::uuid, ${item.id}::uuid, FALSE, 1),
                       (${fileCId}::uuid, ${item.id}::uuid, FALSE, 2)
            `;

            // All three have height 1080 but different durations: B is longest
            await sql`
                INSERT INTO media_streams (file_id, stream_index, stream_type, codec, height)
                VALUES (${fileAId}::uuid, 0, 'video', 'h264', 1080),
                       (${fileBId}::uuid, 0, 'video', 'h264', 1080),
                       (${fileCId}::uuid, 0, 'video', 'h264', 1080)
            `;
            await sql`
                UPDATE media_files SET duration_seconds = 3600 WHERE id = ${fileAId}::uuid
            `;
            await sql`
                UPDATE media_files SET duration_seconds = 7200 WHERE id = ${fileBId}::uuid
            `;
            await sql`
                UPDATE media_files SET duration_seconds = 3000 WHERE id = ${fileCId}::uuid
            `;

            const result = await promoteHighestQualityVersion(sql, item.id);
            // B has the longest duration — should win
            expect(result.chosenFileId).toBe(fileBId);
        });

        it('current default is already the highest quality — returns promoted=false', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            // 1080p file is inserted first so it starts as the default
            const { id: file1080Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Already1080.mkv',
            });
            await attachFileToItem(sql, file1080Id, item.id);

            const { id: file720Id } = await upsertMediaFile(sql, {
                filePath: '/media/tv/Lower720.mkv',
            });
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${file720Id}::uuid, ${item.id}::uuid, FALSE, 1)
            `;

            await sql`
                INSERT INTO media_streams (file_id, stream_index, stream_type, codec, height)
                VALUES (${file1080Id}::uuid, 0, 'video', 'h264', 1080),
                       (${file720Id}::uuid, 0, 'video', 'h264', 720)
            `;

            const result = await promoteHighestQualityVersion(sql, item.id);
            expect(result.promoted).toBe(false);
            expect(result.chosenFileId).toBe(file1080Id);
        });
    });

    // =========================================================================
    // processing_state scalar anomaly guard — invalidateFileProbeData
    // =========================================================================
    describe('invalidateFileProbeData — processing_state scalar guard', () => {
        it('does not throw when processing_state is a JSONB scalar', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Inject a JSONB scalar (not an object) — the data anomaly that
            // causes `jsonb_object_keys` / `? key` to throw on unguarded queries.
            await sql`
                UPDATE media_items
                SET processing_state = '"some-string"'::jsonb
                WHERE id = ${item.id}
            `;

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/music/track-scalar-state.flac',
            });
            await attachFileToItem(sql, fileId, item.id);

            await expect(invalidateFileProbeData(sql, fileId)).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // custom_{type}_url invariant — invalidateFileProbeData
    // =========================================================================
    describe('invalidateFileProbeData — local artwork pointer invariant', () => {
        it('clears custom_{type}_url for every local artwork row it deletes', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/pointer-invariant.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            // Register local artwork through the invariant's own chokepoint, so
            // the custom_*_url columns are populated exactly as production does.
            for (const artworkType of ['poster', 'backdrop', 'logo', 'thumb'] as const) {
                await upsertLocalArtwork(sql, {
                    mediaItemId: item.id,
                    artworkType,
                    filePath: `/data/art/${item.id}-${artworkType}.jpg`,
                });
            }

            const [before] = await sql<
                {
                    poster: string | null;
                    backdrop: string | null;
                    logo: string | null;
                    thumb: string | null;
                }[]
            >`
                SELECT custom_poster_url AS poster, custom_backdrop_url AS backdrop,
                       custom_logo_url AS logo, custom_thumb_url AS thumb
                FROM media_items WHERE id = ${item.id}
            `;
            expect(before.poster).toBe(`/api/image/custom/${item.id}/poster`);
            expect(before.backdrop).toBe(`/api/image/custom/${item.id}/backdrop`);
            expect(before.logo).toBe(`/api/image/custom/${item.id}/logo`);
            expect(before.thumb).toBe(`/api/image/custom/${item.id}/thumb`);

            await invalidateFileProbeData(sql, fileId);

            // The artwork rows are gone (step 7 deletes source='local')...
            const survivors = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM media_artwork
                WHERE media_item_id = ${item.id} AND source = 'local'
            `;
            expect(survivors[0].n).toBe(0);

            // ...so the pointers must not outlive them.
            const [after] = await sql<
                {
                    poster: string | null;
                    backdrop: string | null;
                    logo: string | null;
                    thumb: string | null;
                }[]
            >`
                SELECT custom_poster_url AS poster, custom_backdrop_url AS backdrop,
                       custom_logo_url AS logo, custom_thumb_url AS thumb
                FROM media_items WHERE id = ${item.id}
            `;
            expect(after.poster).toBeNull();
            expect(after.backdrop).toBeNull();
            expect(after.logo).toBeNull();
            expect(after.thumb).toBeNull();
        });

        it('preserves provider URLs that do not point at our own proxy endpoint', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/media/movies/provider-url-preserved.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: `/data/art/${item.id}-poster.jpg`,
            });
            // An admin/provider URL claimed the backdrop column — not ours to clear.
            await sql`
                UPDATE media_items
                SET custom_backdrop_url = 'https://image.tmdb.org/t/p/original/abc.jpg'
                WHERE id = ${item.id}
            `;

            await invalidateFileProbeData(sql, fileId);

            const [after] = await sql<{ poster: string | null; backdrop: string | null }[]>`
                SELECT custom_poster_url AS poster, custom_backdrop_url AS backdrop
                FROM media_items WHERE id = ${item.id}
            `;
            expect(after.poster).toBeNull();
            expect(after.backdrop).toBe('https://image.tmdb.org/t/p/original/abc.jpg');
        });
    });
    // =========================================================================
    // findDescendantDirAnchors
    //
    // Container rows (artist, album, tv, season) never own a media_files row,
    // so admin artwork upload has to reach through to descendants to find the
    // folder the container lives in. These exercise the real recursive CTE —
    // the service-level unit tests mock this function out, so a broken join
    // here is invisible to them.
    // =========================================================================

    describe('findDescendantDirAnchors', () => {
        /** Create an item under `parentId` and attach a file at `filePath`. */
        async function itemWithFile(
            mediaType: 'track' | 'episode',
            parentId: string,
            filePath: string,
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: mediaType, parent_id: parentId });
            await insertTestMediaItem(sql, item);
            const { id: fileId } = await upsertMediaFile(sql, { filePath });
            await attachFileToItem(sql, fileId, item.id);
            return item.id;
        }

        async function container(
            mediaType: 'artist' | 'album' | 'tv' | 'season',
            parentId?: string,
            title?: string,
        ) {
            const item = createTestMediaItem({
                media_type: mediaType,
                parent_id: parentId ?? null,
                // Albums are unique per (parent, title), so siblings need
                // distinct titles.
                ...(title ? { title } : {}),
            });
            await insertTestMediaItem(sql, item);
            return item.id;
        }

        it('returns an empty array for an item with no descendants', async () => {
            const artistId = await container('artist');
            await expect(findDescendantDirAnchors(sql, artistId)).resolves.toEqual([]);
        });

        it("folds an album's tracks into one depth-1 anchor", async () => {
            const albumId = await container('album');
            await itemWithFile('track', albumId, '/lib/music/Artist/Album/01.flac');
            await itemWithFile('track', albumId, '/lib/music/Artist/Album/02.flac');

            const anchors = await findDescendantDirAnchors(sql, albumId);
            expect(anchors).toEqual([
                {
                    depth: 1,
                    minDir: '/lib/music/Artist/Album',
                    maxDir: '/lib/music/Artist/Album',
                },
            ]);
        });

        it('spans disc folders in a multi-disc album via min/max', async () => {
            const albumId = await container('album');
            await itemWithFile('track', albumId, '/lib/music/Artist/Album/CD 01/01.flac');
            await itemWithFile('track', albumId, '/lib/music/Artist/Album/CD 02/01.flac');

            const anchors = await findDescendantDirAnchors(sql, albumId);
            expect(anchors).toHaveLength(1);
            expect(anchors[0].depth).toBe(1);
            expect(anchors[0].minDir).toBe('/lib/music/Artist/Album/CD 01');
            expect(anchors[0].maxDir).toBe('/lib/music/Artist/Album/CD 02');
        });

        it('reports depth 2 for artist → album → track', async () => {
            const artistId = await container('artist');
            const albumId = await container('album', artistId);
            await itemWithFile('track', albumId, '/lib/music/Artist/Album/01.flac');

            const anchors = await findDescendantDirAnchors(sql, artistId);
            expect(anchors).toEqual([
                {
                    depth: 2,
                    minDir: '/lib/music/Artist/Album',
                    maxDir: '/lib/music/Artist/Album',
                },
            ]);
        });

        it('returns one anchor per album for a multi-album artist', async () => {
            const artistId = await container('artist');
            const albumA = await container('album', artistId, 'Album A');
            const albumB = await container('album', artistId, 'Album B');
            await itemWithFile('track', albumA, '/lib/music/Artist/Album A/01.flac');
            await itemWithFile('track', albumB, '/lib/music/Artist/Album B/01.flac');

            const anchors = await findDescendantDirAnchors(sql, artistId);
            expect(anchors).toHaveLength(2);
            expect(anchors.every((a) => a.depth === 2)).toBe(true);
            expect(anchors.map((a) => a.minDir).sort()).toEqual([
                '/lib/music/Artist/Album A',
                '/lib/music/Artist/Album B',
            ]);
        });

        it('reports depth 2 for tv → season → episode', async () => {
            const showId = await container('tv');
            const seasonId = await container('season', showId);
            await itemWithFile('episode', seasonId, '/lib/series/Show/Season 01/ep1.mkv');

            const anchors = await findDescendantDirAnchors(sql, showId);
            expect(anchors).toEqual([
                {
                    depth: 2,
                    minDir: '/lib/series/Show/Season 01',
                    maxDir: '/lib/series/Show/Season 01',
                },
            ]);
        });

        it('stops at depth 2 and ignores deeper descendants', async () => {
            // An extra nested under an episode sits at depth 3 from the show.
            // Including it would drag its own subfolder into the show's span.
            const showId = await container('tv');
            const seasonId = await container('season', showId);
            const episodeId = await itemWithFile(
                'episode',
                seasonId,
                '/lib/series/Show/Season 01/ep1.mkv',
            );
            const extra = createTestMediaItem({ media_type: 'extra', parent_id: episodeId });
            await insertTestMediaItem(sql, extra);
            const { id: extraFileId } = await upsertMediaFile(sql, {
                filePath: '/lib/series/Show/Season 01/featurettes/behind.mkv',
            });
            await attachFileToItem(sql, extraFileId, extra.id);

            const anchors = await findDescendantDirAnchors(sql, showId);
            expect(anchors).toEqual([
                {
                    depth: 2,
                    minDir: '/lib/series/Show/Season 01',
                    maxDir: '/lib/series/Show/Season 01',
                },
            ]);
        });
    });

    // =========================================================================
    // listScanIssues + cleanupOrphanedMediaFiles — F2 (fix plan 6, Task 7 fix
    // round 1): the Ingest Map query and orphan cleanup's do-not-delete guard
    // each hard-coded the three older FILE_HEALTH_ISSUE_TYPES literals, so the
    // two new types (unsafe_filename, playlist_container_rejected) never
    // surfaced on the Ingest Map and orphan cleanup deleted them outright
    // (resetting the scanner's retry backoff). Both now derive from the
    // single-sourced UNLINKED_FILE_HEALTH_ISSUE_TYPES; this proves every type
    // in that list is covered by both consumers, with filename_not_utf8 as
    // the reviewer's control (the pre-existing type that already worked).
    // =========================================================================

    describe('F2: every UNLINKED_FILE_HEALTH_ISSUE_TYPES type is listed on the Ingest Map and survives orphan cleanup', () => {
        it.each(UNLINKED_FILE_HEALTH_ISSUE_TYPES)('%s', async (type) => {
            const filePath = `/lib/scan-issues/${type}.mkv`;
            await recordFileScanIssue(sql, { filePath, type, detail: 'test fixture' });

            const before = await listScanIssues(sql, 500);
            expect(before.some((r) => r.file_path === filePath)).toBe(true);

            await cleanupOrphanedMediaFiles(sql, 10_000);

            const [row] = await sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files WHERE file_path = ${filePath}
            `;
            expect(row?.file_path).toBe(filePath);

            const after = await listScanIssues(sql, 500);
            expect(after.some((r) => r.file_path === filePath)).toBe(true);
        });

        // Control: an orphan with NO scan issue is still deleted by cleanup —
        // proves the guard is issue-type-specific, not "never delete anything".
        it('still deletes a genuine orphan with no health issue (control)', async () => {
            const filePath = '/lib/scan-issues/genuine-orphan.mkv';
            await upsertMediaFile(sql, { filePath });

            await cleanupOrphanedMediaFiles(sql, 10_000);

            const [row] = await sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files WHERE file_path = ${filePath}
            `;
            expect(row).toBeUndefined();
        });
    });

    // =========================================================================
    // clearStaleRefusalAndEnsureChangeDetection — M2 (fix plan 6, Task 7 fix
    // round 2): refuse → fix → re-ingest cycle.
    //
    // A previously-refused file (unsafe_filename / playlist_container_rejected)
    // reuses the SAME stub row upsertMediaFile writes on a legitimate
    // re-ingest at the same path (ON CONFLICT, created=false). Before this
    // fix: the stub's health_issues badge survived forever (upsertMediaFile's
    // ON CONFLICT never touches it) and the scanner's
    // `if (created) initFileChangeDetection(...)` skipped re-initializing the
    // hash for a row that already existed. This drives the REAL exported
    // function video-processor.ts's chokepoint calls, against real Postgres
    // AND a real on-disk file (initFileChangeDetection inside it does a real
    // fs.stat + 64KB head-hash read) — the level the bug actually lived at.
    // =========================================================================

    describe('clearStaleRefusalAndEnsureChangeDetection (M2)', () => {
        let m2Dir: string;

        beforeAll(async () => {
            m2Dir = await mkdtemp(join(tmpdir(), 'lumastra-m2-reingest-'));
        });

        afterAll(async () => {
            await rm(m2Dir, { recursive: true, force: true });
        });

        it('clears playlist_container_rejected and sets the hash on re-ingest of a fixed file', async () => {
            const filePath = join(m2Dir, 'movie.mkv');
            await writeFile(filePath, 'real media bytes after the fix');

            // 1. Refuse: the scanner's playlist-class guard records the issue,
            //    which upserts a STUB row (no media_item link, no hash).
            await recordFileScanIssue(sql, {
                filePath,
                type: 'playlist_container_rejected',
                detail: 'Probed as a playlist/reference container (concat), which is never ingested.',
            });
            const [stub] = await sql<
                { id: string; health_issues: unknown; file_hash_head: string | null }[]
            >`
                SELECT id, health_issues, file_hash_head FROM media_files WHERE file_path = ${filePath}
            `;
            expect(stub.file_hash_head).toBeNull();
            expect(JSON.stringify(stub.health_issues)).toContain('playlist_container_rejected');

            // 2. Fix: the admin replaces the file with real media at the SAME
            //    path. Re-ingest calls upsertMediaFile again — ON CONFLICT
            //    hits the stub row, created=false.
            const { id: reingestedId, created } = await upsertMediaFile(sql, { filePath });
            expect(created).toBe(false);
            expect(reingestedId).toBe(stub.id);

            // 3. The scanner's M2 fix, called exactly as video-processor.ts's
            //    chokepoint calls it.
            await clearStaleRefusalAndEnsureChangeDetection(sql, stub, filePath);

            const [after] = await sql<{ health_issues: unknown; file_hash_head: string | null }[]>`
                SELECT health_issues, file_hash_head FROM media_files WHERE id = ${reingestedId}::uuid
            `;
            expect(after.health_issues).toBeNull();
            expect(after.file_hash_head).toBeTruthy();
        });

        // Control: an UNRELATED health issue type on the same row (a
        // decode-quality issue from trickplay, say) must survive the clear —
        // clearFileScanIssue only drops the two named types. Asserts only
        // the survivor, so it is green whether or not the clear runs (the
        // test above is the one that needs the clear).
        it('control: an unrelated health issue on the row survives the clear', async () => {
            const filePath = join(m2Dir, 'unrelated-issue.mkv');
            await writeFile(filePath, 'real media bytes');
            await recordFileScanIssue(sql, {
                filePath,
                type: 'unsafe_filename',
                detail: 'test fixture',
            });
            // Simulate an unrelated decode-quality issue also present on the row.
            await sql`
                UPDATE media_files
                   SET health_issues = health_issues || ${sql.json([
                       { type: 'container_unreadable', detected_at: new Date().toISOString() },
                   ] as unknown as postgres.JSONValue)}
                 WHERE file_path = ${filePath}
            `;
            const [stub] = await sql<{ id: string; file_hash_head: string | null }[]>`
                SELECT id, file_hash_head FROM media_files WHERE file_path = ${filePath}
            `;

            await clearStaleRefusalAndEnsureChangeDetection(sql, stub, filePath);

            const [row] = await sql<{ health_issues: { type: string }[] }[]>`
                SELECT health_issues FROM media_files WHERE file_path = ${filePath}
            `;
            expect(row.health_issues.map((i) => i.type)).toContain('container_unreadable');
        });

        // Control: an already-linked file falling through the SAME chokepoint
        // (e.g. the multi-episode-range re-processing escape) keeps its
        // EXISTING hash untouched — the re-init is scoped to rows with no
        // hash yet, not every row that passes through here.
        it('control: a row that already has a hash is left untouched', async () => {
            const filePath = join(m2Dir, 'already-hashed.mkv');
            await writeFile(filePath, 'real media bytes');
            const { id } = await upsertMediaFile(sql, { filePath, fileHashHead: 'original-hash' });

            await clearStaleRefusalAndEnsureChangeDetection(
                sql,
                { id, file_hash_head: 'original-hash' },
                filePath,
            );

            const [row] = await sql<{ file_hash_head: string | null }[]>`
                SELECT file_hash_head FROM media_files WHERE id = ${id}::uuid
            `;
            expect(row.file_hash_head).toBe('original-hash');
        });
    });
});
