// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../tests/integration/fixtures/index.js';
const { parseTags } = vi.hoisted(() => ({ parseTags: vi.fn() }));
vi.mock('../tasks/builtin/native/media-sources/_helpers/file-scanner/audio-tag-parser.js', () => ({
    parseAudioTags: parseTags,
}));
import { findFilesWithMissingMusicArtwork } from '../tasks/builtin/native/media-sources/file-scanner.js';
import {
    findLocalAlbumArtCandidates,
    getAlbumReleaseIdentifiers,
    markLocalAlbumArtChecked,
} from '../database/queries/album-local-art.queries.js';
import { recoverLocalAlbumArt, backfillLocalAlbumArt } from './album-local-art.js';
import { markFileMissing, recomputeHasFiles } from '../database/queries/media-files.queries.js';

describe('local album recovery without rescanning', () => {
    let sql: postgres.Sql;
    let dir: string;
    let albumId: string;
    let tracks: string[];
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        parseTags.mockResolvedValue({});
        await truncateTables(sql, TEST_TABLES.media);
        if (dir) await rm(dir, { recursive: true, force: true });
        dir = await mkdtemp(path.join(tmpdir(), 'album-local-'));
        const artist = createTestArtist();
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id);
        await insertTestAlbum(sql, album);
        albumId = album.id;
        tracks = [];
        for (let n = 1; n <= 2; n++) {
            const track = createTestTrack(album.id, n);
            await insertTestTrack(sql, track);
            tracks.push(track.id);
            await sql`UPDATE media_files SET file_path = ${path.join(dir, `${n}.mp3`)} WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${track.id})`;
        }
        await recomputeHasFiles(sql, tracks[0]);
    });
    afterAll(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });
    async function poster(): Promise<string | undefined> {
        const [row] =
            await sql`SELECT file_path FROM media_artwork WHERE media_item_id = ${albumId} AND artwork_type = 'poster'`;
        return row?.file_path as string | undefined;
    }
    it('leaves flagged albums to the local sweep instead of re-triaging them', async () => {
        await writeFile(path.join(dir, 'cover.jpg'), 'cover');
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || '{"needs_cover_art_fetch":true}'::jsonb WHERE id = ${albumId}`;
        const files = [path.join(dir, '1.mp3'), path.join(dir, '2.mp3')];
        const result = await findFilesWithMissingMusicArtwork(sql, files, { logger: mockLogger() });
        expect(result.size).toBe(0);
        expect(
            await backfillLocalAlbumArt(sql, mockLogger(), new AbortController().signal, 2),
        ).toBe(1);
        expect(await poster()).toBe(path.join(dir, 'cover.jpg'));
    });
    it('still triages unflagged albums with a new sidecar', async () => {
        await writeFile(path.join(dir, 'cover.jpg'), 'cover');
        expect(
            (
                await findFilesWithMissingMusicArtwork(sql, [path.join(dir, '1.mp3')], {
                    logger: mockLogger(),
                })
            ).size,
        ).toBe(1);
    });
    it('excludes covered albums without updating their daily check timestamp', async () => {
        const file = path.join(dir, 'cover.jpg');
        await writeFile(file, 'cover');
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path) VALUES (${albumId}, 'poster', 'local', ${file})`;
        expect((await findLocalAlbumArtCandidates(sql, 50)).some((row) => row.id === albumId)).toBe(
            false,
        );
        expect(
            await backfillLocalAlbumArt(sql, mockLogger(), new AbortController().signal, 2),
        ).toBe(0);
        await markLocalAlbumArtChecked(sql, albumId);
        const [row] =
            await sql`SELECT album_local_art_checked_at FROM media_items WHERE id = ${albumId}`;
        expect(row.album_local_art_checked_at).toBeNull();
    });
    it('keeps an uncovered album with only a backdrop eligible', async () => {
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path) VALUES (${albumId}, 'backdrop', 'local', ${path.join(dir, 'backdrop.jpg')})`;
        expect((await findLocalAlbumArtCandidates(sql, 50)).some((row) => row.id === albumId)).toBe(
            true,
        );
    });
    it('recovers embedded art from a non-first track', async () => {
        parseTags.mockImplementation(async (file: string) =>
            file.endsWith('2.mp3')
                ? { embeddedArt: { format: 'image/jpeg', data: Buffer.from('cover') } }
                : {},
        );
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(true);
        expect(await poster()).toBeDefined();
        expect(parseTags.mock.calls.map(([file]) => file)).toEqual([
            path.join(dir, '1.mp3'),
            path.join(dir, '2.mp3'),
        ]);
    });
    it.each(['cover.jpg', 'folder.jpg', 'release-front.jpg'])(
        'recovers the sidecar %s',
        async (name) => {
            await writeFile(path.join(dir, name), 'cover');
            expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(true);
            expect(await poster()).toBe(path.join(dir, name));
        },
    );
    it('promotes an existing track poster', async () => {
        const file = path.join(dir, 'track-image.jpg');
        await writeFile(file, 'cover');
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path) VALUES (${tracks[1]}, 'poster', 'local', ${file})`;
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(true);
        expect(await poster()).toBe(file);
        expect(parseTags).not.toHaveBeenCalled();
    });
    it('does not promote a missing track poster or recover a file-less album', async () => {
        const file = path.join(dir, 'deleted-track.jpg');
        await writeFile(file, 'stale cover');
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
            VALUES (${tracks[1]}, 'poster', 'local', ${file})`;
        const files = await sql<{ file_id: string }[]>`
            SELECT file_id FROM media_file_items WHERE media_item_id = ${tracks[1]}
        `;
        await markFileMissing(sql, files[0].file_id);
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(false);
        expect(await poster()).toBeUndefined();
        const [remaining] =
            await sql`SELECT file_id FROM media_file_items WHERE media_item_id = ${tracks[0]}`;
        await markFileMissing(sql, remaining.file_id);
        expect((await findLocalAlbumArtCandidates(sql, 50)).map((r) => r.id)).not.toContain(
            albumId,
        );
    });
    it('skips an empty sidecar and chooses another usable poster', async () => {
        await writeFile(path.join(dir, 'cover.jpg'), '');
        await writeFile(path.join(dir, 'folder.jpg'), 'cover');
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(true);
        expect(await poster()).toBe(path.join(dir, 'folder.jpg'));
    });
    it('replaces a zero-byte album poster', async () => {
        const file = path.join(dir, 'empty.jpg');
        await writeFile(file, '');
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path) VALUES (${albumId}, 'poster', 'local', ${file})`;
        await writeFile(path.join(dir, 'cover.jpg'), 'cover');
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(true);
        expect(await poster()).toBe(path.join(dir, 'cover.jpg'));
    });
    it.each(['no-match-upstream', 'no-image-bytes', 'ineligible'])(
        'backfills permanent %s without reopening the network chain',
        async (reason) => {
            await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, skipped_reason)
            VALUES (${albumId}, 'album-enrichment', 2, 'skipped_permanent', ${reason})`;
            await sql`UPDATE media_items SET processing_state = '{"album-enrichment":{"version":2,"status":"no-match"}}'::jsonb WHERE id = ${albumId}`;
            await writeFile(path.join(dir, 'cover.jpg'), 'cover');
            expect(
                (await findLocalAlbumArtCandidates(sql, 50)).some((row) => row.id === albumId),
            ).toBe(true);
            expect(
                await backfillLocalAlbumArt(sql, mockLogger(), new AbortController().signal, 2),
            ).toBe(1);
            const [stage] =
                await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ${albumId} AND stage_id = 'album-enrichment'`;
            expect(stage.status).toBe('completed');
            expect(await poster()).toBe(path.join(dir, 'cover.jpg'));
            expect(
                (await findLocalAlbumArtCandidates(sql, 50)).some((row) => row.id === albumId),
            ).toBe(false);
        },
    );
    it('persists release identifiers from a later track without a rescan', async () => {
        await sql`UPDATE media_items SET year = 2020 WHERE id = ${albumId}`;
        parseTags.mockImplementation(async (file: string) =>
            file.endsWith('2.mp3')
                ? { barcode: '0194111012158', catalogueNumber: 'ZYX 83064-2' }
                : { parseError: 'corrupt' },
        );
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(false);
        expect(await getAlbumReleaseIdentifiers(sql, albumId)).toEqual({
            barcode: '0194111012158',
            catalogueNumber: 'ZYX 83064-2',
            year: 2020,
        });
    });
    it('does not borrow a sidecar from a shared album directory', async () => {
        const [parent] = await sql`SELECT parent_id FROM media_items WHERE id = ${albumId}`;
        const sibling = createTestAlbum(parent.parent_id as string);
        await insertTestAlbum(sql, sibling);
        const track = createTestTrack(sibling.id, 1);
        await insertTestTrack(sql, track);
        await sql`UPDATE media_files SET file_path = ${path.join(dir, 'other.mp3')} WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${track.id})`;
        await writeFile(path.join(dir, 'cover.jpg'), 'sibling cover');
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || '{"needs_cover_art_fetch":true}'::jsonb WHERE id IN (${albumId}, ${sibling.id})`;
        for (let scan = 0; scan < 2; scan++) {
            expect(
                (
                    await findFilesWithMissingMusicArtwork(
                        sql,
                        [path.join(dir, '1.mp3'), path.join(dir, 'other.mp3')],
                        { logger: mockLogger() },
                    )
                ).size,
            ).toBe(0);
        }
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(false);
        expect(await poster()).toBeUndefined();
    });
    it('respects an explicit removal of a sidecar', async () => {
        const file = path.join(dir, 'cover.jpg');
        await writeFile(file, 'cover');
        await sql`INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path) VALUES (${albumId}, 'poster', ${file})`;
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger())).toBe(false);
        expect(await poster()).toBeUndefined();
    });
    it('stops local parsing on cancellation', async () => {
        const ac = new AbortController();
        parseTags.mockImplementation(async () => {
            ac.abort();
            return {};
        });
        expect(await recoverLocalAlbumArt(sql, albumId, mockLogger(), ac.signal)).toBe(false);
        expect(parseTags).toHaveBeenCalledTimes(1);
    });
    it('applies the local sweep budget to in-flight tag reads', async () => {
        const budget = new AbortController();
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
        parseTags.mockImplementation(async (_file: string, options: { signal: AbortSignal }) => {
            budget.abort();
            expect(options.signal.aborted).toBe(true);
            return { parseError: 'aborted' };
        });
        try {
            expect(
                await backfillLocalAlbumArt(sql, mockLogger(), new AbortController().signal, 2),
            ).toBe(0);
            expect(parseTags).toHaveBeenCalledTimes(1);
        } finally {
            timeout.mockRestore();
        }
    });
});
