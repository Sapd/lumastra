// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode-scope image scans must not hand an episode a SIBLING's thumbnail.
 *
 * The per-item image-sync stage runs `scanImages({ scope: 'episode' })` for every
 * new episode. It walks the episode's folder — shared with every sibling — and
 * used to attach every image in it to the episode, so the single local thumb row
 * ended on whichever `-thumb.jpg` readdir returned last. Prod, 2026-09: S13E01
 * on a stale S13E03 WEBDL sidecar, all twelve episodes of a season on E12's,
 * each then re-pointed by the retired episode-thumbnail-repair task.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import { getOwnLocalArtwork } from '../database/queries/media-artwork.queries.js';
import { upsertMediaFile, attachFileToItem } from '../database/queries/media-files.queries.js';
import { config } from '../config.js';
import { scanImages } from './image-scanner.service.js';
import { extractPosterForItem } from './video-frame-extractor.service.js';
import * as metadataStorage from './metadata-storage.service.js';

const SHOW = 'American Horror Story';
const execFileAsync = promisify(execFile);

describe('scanImages episode scope — sibling thumbnails in a shared folder', () => {
    let sql: postgres.Sql;
    let root: string;
    let seasonDir: string;
    let seasonId: string;
    let seriesId: string;
    const episodeIds = new Map<number, string>();

    const episodeVideo = (n: number) =>
        join(seasonDir, `${SHOW} - S13E${String(n).padStart(2, '0')} - WEBRip-1080p.mkv`);

    async function addEpisode(n: number, withFile: boolean): Promise<string> {
        const ep = createTestMediaItem({
            media_type: 'episode',
            parent_id: seasonId,
            has_files: withFile,
        });
        await insertTestMediaItem(sql, ep);
        await sql`
            UPDATE media_items SET season_number = 13, episode_number = ${n}
            WHERE id = ${ep.id}::uuid
        `;
        if (withFile) {
            const { id: fileId } = await upsertMediaFile(sql, { filePath: episodeVideo(n) });
            await attachFileToItem(sql, fileId, ep.id);
        }
        episodeIds.set(n, ep.id);
        return ep.id;
    }

    const touch = (name: string) => writeFile(join(seasonDir, name), 'jpg');

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        vi.spyOn(config, 'IMAGE_SYNC_LOCAL_FILE_SCANNING', 'get').mockReturnValue(true);
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_artwork',
            'media_artwork_suppressions',
        ]);
        episodeIds.clear();

        root = await mkdtemp(join(tmpdir(), 'image-scan-sibling-'));
        seasonDir = join(root, SHOW, 'Season 13');
        await mkdir(seasonDir, { recursive: true });

        const series = createTestMediaItem({ media_type: 'tv', title: SHOW, has_files: true });
        const season = createTestMediaItem({
            media_type: 'season',
            parent_id: series.id,
            has_files: true,
        });
        await insertTestMediaItem(sql, series);
        await insertTestMediaItem(sql, season);
        await sql`UPDATE media_items SET season_number = 13 WHERE id = ${season.id}::uuid`;
        seasonId = season.id;
        seriesId = series.id;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
    });

    it('preserves the extractor registration when rediscovering its thumbnail', async () => {
        const id = await addEpisode(1, true);
        const name = `${SHOW} - S13E01 - WEBRip-1080p-${id.slice(0, 8)}-thumb.jpg`;
        await execFileAsync(config.FFMPEG_PATH, [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=320x180:rate=10:duration=2',
            episodeVideo(1),
        ]);
        // Fix only the output location to exercise rediscovery of the historical
        // alongside filename. Extraction and writer registration remain real.
        vi.spyOn(metadataStorage, 'resolveWritePath').mockResolvedValue({
            filePath: join(seasonDir, name),
            location: 'alongside',
        });
        const extraction = await extractPosterForItem(sql, {
            mediaItemId: id,
            artworkType: 'thumb',
            videoFilePath: episodeVideo(1),
            durationSeconds: 2,
            timestampPercent: 50,
        });
        expect(extraction).toEqual({ extracted: true, filePath: join(seasonDir, name) });
        const before = await sql`SELECT * FROM image_candidates
            WHERE media_item_id = ${id} AND artwork_type = 'thumb'`;
        expect(before).toHaveLength(1);
        expect(before[0].provider).toBe('frame-extract');

        for (let scan = 0; scan < 2; scan++) {
            const result = await scanImages(sql, {
                scope: 'episode',
                mode: 'execute',
                mediaItemId: id,
            });
            expect(result.matched).toBe(1);
            const rows = await sql`SELECT * FROM image_candidates
                WHERE media_item_id = ${id} AND artwork_type = 'thumb'`;
            expect([...rows]).toEqual([...before]);
        }
    }, 60_000);

    it('classifies an outside tool’s new id-suffixed thumbnail as local-folder', async () => {
        const id = await addEpisode(1, true);
        const name = `${SHOW} - S13E01 - WEBRip-1080p-${id.slice(0, 8)}-thumb.jpg`;
        await touch(name);
        expect(await getOwnLocalArtwork(sql, id, 'thumb')).toBeNull();

        await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: id });

        const rows = await sql`SELECT provider, remote_url, file_path FROM image_candidates
            WHERE media_item_id = ${id} AND artwork_type = 'thumb'`;
        expect([...rows]).toEqual([
            { provider: 'local-folder', remote_url: null, file_path: join(seasonDir, name) },
        ]);
    });

    it('a stale sibling sidecar is not taken by an episode without its own thumb', async () => {
        const e01 = await addEpisode(1, true);
        await addEpisode(3, true);
        // E03's thumb from a replaced WEBDL release — the exact prod shape.
        await touch(`${SHOW} - S13E03 - Rauhnacht - WEBDL-1080p-thumb.jpg`);
        await touch('poster.jpg');

        await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: e01 });

        expect(await getOwnLocalArtwork(sql, e01, 'thumb')).toBeNull();
        // The season's poster is the season's, not the episode's.
        expect(await getOwnLocalArtwork(sql, e01, 'poster')).toBeNull();
    });

    it("an episode takes its own sidecar, never a sibling's, whatever the readdir order", async () => {
        const e02 = await addEpisode(2, true);
        await addEpisode(1, true);
        await addEpisode(3, true);
        const own = `${SHOW} - S13E02 - WEBRip-1080p-thumb.jpg`;
        await touch(`${SHOW} - S13E01 - WEBRip-1080p-thumb.jpg`);
        await touch(own);
        await touch(`${SHOW} - S13E03 - WEBRip-1080p-thumb.jpg`);

        await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: e02 });

        expect((await getOwnLocalArtwork(sql, e02, 'thumb'))?.file_path).toBe(join(seasonDir, own));
    });

    it.each(['episode', 'series'] as const)(
        'rescans mixed-case video stems and artwork suffixes in %s scope',
        async (scope) => {
            const id = await addEpisode(2, true);
            const name = `${SHOW.toLowerCase()} - s13e02 - webrip-1080p-THUMB.JPG`;
            await touch(name);
            for (let scan = 0; scan < 2; scan++) {
                await scanImages(sql, {
                    scope,
                    mode: 'execute',
                    mediaItemId: id,
                    seriesMediaId: seriesId,
                });
                expect((await getOwnLocalArtwork(sql, id, 'thumb'))?.file_path).toBe(
                    join(seasonDir, name),
                );
            }
        },
    );

    it('episodes sharing a folder do not all collapse onto the one thumb in it', async () => {
        // Aiura shape: twelve episodes scanned right after creation, one thumb
        // (E12's) in the folder — every episode used to end on it.
        for (let n = 1; n <= 12; n++) await addEpisode(n, true);
        const e12Thumb = `${SHOW} - S13E12 - WEBRip-1080p-thumb.jpg`;
        await touch(e12Thumb);

        for (const id of episodeIds.values()) {
            await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: id });
        }

        const rows = await sql<{ media_item_id: string; file_path: string }[]>`
            SELECT media_item_id, file_path FROM media_artwork
            WHERE artwork_type = 'thumb' AND source = 'local'
        `;
        expect(rows).toEqual([
            { media_item_id: episodeIds.get(12), file_path: join(seasonDir, e12Thumb) },
        ]);
    });

    it('a file-less episode gains no thumb from a season-scope scan of its folder', async () => {
        await addEpisode(1, true);
        const fileless = await addEpisode(2, false);
        await touch(`${SHOW} - S13E01 - WEBRip-1080p-thumb.jpg`);

        await scanImages(sql, { scope: 'season', mode: 'execute', seasonMediaId: seasonId });

        expect(await getOwnLocalArtwork(sql, fileless, 'thumb')).toBeNull();
        // Nor does the season take an episode's thumbnail as its own.
        expect(await getOwnLocalArtwork(sql, seasonId, 'thumb')).toBeNull();
    });
    it('does not take a replaced release sidecar merely because its episode number matches', async () => {
        const id = await addEpisode(2, true);
        await touch(`${SHOW} - S13E02 - Different Release-thumb.jpg`);
        await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: id });
        expect(await getOwnLocalArtwork(sql, id, 'thumb')).toBeNull();
    });

    it("does not take the other segment's id-suffixed sidecar of a combined file", async () => {
        const first = await addEpisode(1, true);
        const second = await addEpisode(2, false);
        const video = join(seasonDir, `${SHOW} - S13E01-02.mkv`);
        const { id: file } = await upsertMediaFile(sql, { filePath: video });
        await attachFileToItem(sql, file, second);
        await touch(`${SHOW} - S13E01-02-${first.slice(0, 8)}-thumb.jpg`);
        await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: second });
        expect(await getOwnLocalArtwork(sql, second, 'thumb')).toBeNull();
    });
    it.each(['episode', 'series'] as const)(
        'keeps configured thumb patterns in %s scans',
        async (scope) => {
            vi.spyOn(config, 'IMAGE_SYNC_LOCAL_PATTERNS', 'get').mockReturnValue([
                'S##E##-thumb',
                'part#_ep###-thumb',
            ]);
            const id = await addEpisode(2, true);
            await touch('S13E02-thumb.JPG');
            await touch('S13E03-thumb.jpg');
            await scanImages(sql, {
                scope,
                mode: 'execute',
                mediaItemId: id,
                seriesMediaId: seriesId,
            });
            expect((await getOwnLocalArtwork(sql, id, 'thumb'))?.file_path).toBe(
                join(seasonDir, 'S13E02-thumb.JPG'),
            );
        },
    );

    it.each(['thumb.JPG', 'season13-thumb.jpg'])(
        'keeps container artwork %s during series scans',
        async (name) => {
            vi.spyOn(config, 'IMAGE_SYNC_LOCAL_PATTERNS', 'get').mockReturnValue(['season#-thumb']);
            await addEpisode(2, true);
            await touch(name);
            await scanImages(sql, { scope: 'series', mode: 'execute', seriesMediaId: seriesId });
            const owner = name.startsWith('season') ? seasonId : seriesId;
            expect((await getOwnLocalArtwork(sql, owner, 'thumb'))?.file_path).toBe(
                join(seasonDir, name),
            );
        },
    );
    it.each([
        'S13E02-thumb.JPG',
        '13x02-thumb.PNG',
        'Season 13 Ep02-thumb.AVIF',
        'part13_ep002-thumb.webp',
    ])('discovers supported numbering %s beside a release-named video', async (name) => {
        vi.spyOn(config, 'IMAGE_SYNC_LOCAL_PATTERNS', 'get').mockReturnValue(['part#_ep###-thumb']);
        const id = await addEpisode(2, true);
        await touch(name);
        await scanImages(sql, { scope: 'episode', mode: 'execute', mediaItemId: id });
        expect((await getOwnLocalArtwork(sql, id, 'thumb'))?.file_path).toBe(join(seasonDir, name));
    });
});
