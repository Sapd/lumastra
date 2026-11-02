// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for migration 16.150.0: the quality_resolution_tier(),
 * quality_hdr_tier(), quality_codec() SQL functions and the
 * media_item_quality projection table shape.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    refreshItemQuality,
    refreshQualityForFile,
    refreshSeriesQuality,
    rebuildAllQuality,
} from './media-item-quality.queries.js';

describe('quality_resolution_tier', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('buckets heights into resolution tiers', async () => {
        const rows = await sql<{ input: number | null; out: string | null }[]>`
            SELECT h AS input, quality_resolution_tier(h) AS out
            FROM (VALUES (2160),(1080),(720),(480),(0)) AS v(h)`;
        const map = Object.fromEntries(rows.map((r) => [r.input, r.out]));
        expect(map).toMatchObject({
            2160: '4K',
            1080: '1080p',
            720: '720p',
            480: 'SD',
            0: null,
        });
        const [nullRow] = await sql<{ out: string | null }[]>`
            SELECT quality_resolution_tier(NULL) AS out`;
        expect(nullRow.out).toBeNull();
    });
});

describe('quality_hdr_tier', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('maps video_range values to HDR tiers', async () => {
        const rows = await sql<{ input: string; out: string | null }[]>`
            SELECT r AS input, quality_hdr_tier(r) AS out
            FROM (VALUES ('Dolby Vision'),('DOVIWithHDR10'),('HDR10'),('HLG'),('SDR'),('whatever')) AS v(r)`;
        const map = Object.fromEntries(rows.map((r) => [r.input, r.out]));
        expect(map).toMatchObject({
            'Dolby Vision': 'dolby_vision',
            DOVIWithHDR10: 'dolby_vision',
            HDR10: 'hdr',
            HLG: 'hdr',
            SDR: 'sdr',
            whatever: null,
        });
        const [nullRow] = await sql<{ out: string | null }[]>`
            SELECT quality_hdr_tier(NULL) AS out`;
        expect(nullRow.out).toBeNull();
    });
});

describe('quality_codec', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('normalizes known codecs and buckets the rest as other', async () => {
        const rows = await sql<{ input: string; out: string | null }[]>`
            SELECT c AS input, quality_codec(c) AS out
            FROM (VALUES ('hevc'),('H264'),('av1'),('mpeg2video')) AS v(c)`;
        const map = Object.fromEntries(rows.map((r) => [r.input, r.out]));
        expect(map).toMatchObject({
            hevc: 'hevc',
            H264: 'h264',
            av1: 'av1',
            mpeg2video: 'other',
        });
        const [emptyRow] = await sql<{ out: string | null }[]>`
            SELECT quality_codec('') AS out`;
        expect(emptyRow.out).toBeNull();
        const [nullRow] = await sql<{ out: string | null }[]>`
            SELECT quality_codec(NULL) AS out`;
        expect(nullRow.out).toBeNull();
    });
});

describe('media_item_quality table shape', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('created the projection table with the expected columns', async () => {
        const cols = await sql<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'media_item_quality' ORDER BY column_name`;
        expect(cols.map((c) => c.column_name)).toEqual([
            'codec',
            // Accessibility/audio badge signals (migration 16.163.0). has_audio
            // and has_subtitle are PRESENCE columns, needed so the series
            // rollup can compute strict-majority denominators from episode rows
            // without re-scanning media_streams.
            'has_ad',
            'has_atmos',
            'has_audio',
            'has_cc',
            'has_sdh',
            'has_subtitle',
            'hdr_tier',
            'hdr_type',
            'media_item_id',
            'resolution_tier',
        ]);
    });
});

describe('quality_hdr_type (fine classification)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('keys off video_range_type when present, else falls back to video_range', async () => {
        const rows = await sql<{ vrt: string | null; vr: string | null; out: string | null }[]>`
            SELECT vrt, vr, quality_hdr_type(vrt, vr) AS out
            FROM (VALUES
                ('HDR10Plus', 'HDR10'),          -- fine wins over coarse
                ('HDR10', 'HDR10'),
                ('HLG', 'HLG'),
                ('DOVI', 'Dolby Vision'),
                ('DOVIWithHDR10', 'DOVIWithHDR10'),
                (NULL, 'HDR10'),                 -- legacy local row: fall back to video_range
                (NULL, 'Dolby Vision'),
                ('', 'HLG'),                     -- empty vrt treated as absent
                (NULL, 'HDR'),                   -- modern Jellyfin coarse
                (NULL, 'SDR'),
                (NULL, 'whatever')
            ) AS v(vrt, vr)`;
        const map = Object.fromEntries(rows.map((r) => [`${r.vrt ?? 'NULL'}|${r.vr}`, r.out]));
        expect(map).toMatchObject({
            'HDR10Plus|HDR10': 'hdr10_plus',
            'HDR10|HDR10': 'hdr10',
            'HLG|HLG': 'hlg',
            'DOVI|Dolby Vision': 'dolby_vision',
            'DOVIWithHDR10|DOVIWithHDR10': 'dolby_vision',
            'NULL|HDR10': 'hdr10',
            'NULL|Dolby Vision': 'dolby_vision',
            '|HLG': 'hlg',
            'NULL|HDR': 'hdr10',
            'NULL|SDR': 'sdr',
            'NULL|whatever': null,
        });
    });

    it('ranks DV > HDR10+ > HDR10 > HLG > SDR and derives the coarse tier', async () => {
        const [ranks] = await sql<
            { dv: number; hp: number; h10: number; hlg: number; sdr: number; none: number }[]
        >`SELECT quality_hdr_rank('dolby_vision') AS dv, quality_hdr_rank('hdr10_plus') AS hp,
                 quality_hdr_rank('hdr10') AS h10, quality_hdr_rank('hlg') AS hlg,
                 quality_hdr_rank('sdr') AS sdr, quality_hdr_rank(NULL) AS none`;
        expect(ranks.dv).toBeGreaterThan(ranks.hp);
        expect(ranks.hp).toBeGreaterThan(ranks.h10);
        expect(ranks.h10).toBeGreaterThan(ranks.hlg);
        expect(ranks.hlg).toBeGreaterThan(ranks.sdr);
        expect(ranks.sdr).toBeGreaterThan(ranks.none);

        const tiers = await sql<{ t: string; out: string | null }[]>`
            SELECT t, quality_hdr_tier_from_type(t) AS out
            FROM (VALUES ('dolby_vision'),('hdr10_plus'),('hdr10'),('hlg'),('sdr')) AS v(t)`;
        expect(Object.fromEntries(tiers.map((r) => [r.t, r.out]))).toEqual({
            dolby_vision: 'dolby_vision',
            hdr10_plus: 'hdr',
            hdr10: 'hdr',
            hlg: 'hdr',
            sdr: 'sdr',
        });
    });
});

let fixtureCounter = 0;

async function seedItem(
    sql: postgres.Sql,
    mediaType: string,
    parentId: string | null = null,
): Promise<string> {
    const [item] = await sql<{ id: string }[]>`
        INSERT INTO media_items (media_type, title, status, has_files, parent_id)
        VALUES (${mediaType}, 'Fixture', 'active', true, ${parentId}) RETURNING id`;
    return item.id;
}

async function seedFile(sql: postgres.Sql): Promise<string> {
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path)
        VALUES (${`/fixtures/quality-${fixtureCounter++}.mkv`}) RETURNING id`;
    return file.id;
}

async function linkFile(
    sql: postgres.Sql,
    itemId: string,
    fileId: string,
    isDefault = true,
): Promise<void> {
    await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
              VALUES (${itemId}, ${fileId}, ${isDefault})`;
}

async function seedVideoStream(
    sql: postgres.Sql,
    fileId: string,
    opts: {
        height: number | null;
        codec: string | null;
        videoRange?: string | null;
        videoRangeType?: string | null;
        index?: number;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_streams (file_id, stream_type, stream_index, height, codec, video_range, video_range_type)
        VALUES (${fileId}, 'video', ${opts.index ?? 0}, ${opts.height}, ${opts.codec ?? 'unknown'}, ${opts.videoRange ?? null}, ${opts.videoRangeType ?? null})
    `;
}

async function seedMovieWithVideoFile(
    sql: postgres.Sql,
    opts: {
        height: number | null;
        codec: string | null;
        videoRange?: string | null;
        videoRangeType?: string | null;
    },
): Promise<{ itemId: string; fileId: string }> {
    const itemId = await seedItem(sql, 'movie');
    const fileId = await seedFile(sql);
    await linkFile(sql, itemId, fileId);
    await seedVideoStream(sql, fileId, opts);
    return { itemId, fileId };
}

describe('refreshItemQuality', () => {
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

    it('tags a movie with a 4K Dolby Vision HEVC stream', async () => {
        const { itemId } = await seedMovieWithVideoFile(sql, {
            height: 2160,
            codec: 'hevc',
            videoRange: 'Dolby Vision',
        });
        await refreshItemQuality(sql, itemId);
        const [row] = await sql<
            {
                resolution_tier: string;
                hdr_tier: string | null;
                hdr_type: string | null;
                codec: string | null;
            }[]
        >`SELECT resolution_tier, hdr_tier, hdr_type, codec FROM media_item_quality WHERE media_item_id = ${itemId}`;
        expect(row).toEqual({
            resolution_tier: '4K',
            hdr_tier: 'dolby_vision',
            hdr_type: 'dolby_vision',
            codec: 'hevc',
        });
    });

    it('records the fine hdr_type from video_range_type (HDR10+ distinct from HDR10)', async () => {
        const { itemId } = await seedMovieWithVideoFile(sql, {
            height: 2160,
            codec: 'hevc',
            videoRange: 'HDR10', // coarse collapses HDR10+ → HDR10
            videoRangeType: 'HDR10Plus', // fine preserves it
        });
        await refreshItemQuality(sql, itemId);
        const [row] = await sql<{ hdr_tier: string | null; hdr_type: string | null }[]>`
            SELECT hdr_tier, hdr_type FROM media_item_quality WHERE media_item_id = ${itemId}`;
        // Coarse tier still 'hdr' (so /browse is unaffected); fine type is HDR10+.
        expect(row).toEqual({ hdr_tier: 'hdr', hdr_type: 'hdr10_plus' });
    });

    it('picks the best HDR across versions by fine rank (HDR10+ beats HDR10, HLG loses)', async () => {
        const itemId = await seedItem(sql, 'movie');
        const fHlg = await seedFile(sql);
        await linkFile(sql, itemId, fHlg);
        await seedVideoStream(sql, fHlg, {
            height: 2160,
            codec: 'hevc',
            videoRangeType: 'HLG',
            index: 0,
        });
        const fHdr10 = await seedFile(sql);
        await linkFile(sql, itemId, fHdr10, false);
        await seedVideoStream(sql, fHdr10, {
            height: 2160,
            codec: 'hevc',
            videoRangeType: 'HDR10',
            index: 1,
        });
        const fHdr10p = await seedFile(sql);
        await linkFile(sql, itemId, fHdr10p, false);
        await seedVideoStream(sql, fHdr10p, {
            height: 2160,
            codec: 'hevc',
            videoRangeType: 'HDR10Plus',
            index: 2,
        });

        await refreshItemQuality(sql, itemId);
        const [row] = await sql<{ hdr_type: string | null }[]>`
            SELECT hdr_type FROM media_item_quality WHERE media_item_id = ${itemId}`;
        expect(row.hdr_type).toBe('hdr10_plus');
    });

    it('falls back to legacy video_range when video_range_type is absent', async () => {
        const { itemId } = await seedMovieWithVideoFile(sql, {
            height: 2160,
            codec: 'hevc',
            videoRange: 'HLG', // legacy row, fine type NULL
        });
        await refreshItemQuality(sql, itemId);
        const [row] = await sql<{ hdr_tier: string | null; hdr_type: string | null }[]>`
            SELECT hdr_tier, hdr_type FROM media_item_quality WHERE media_item_id = ${itemId}`;
        expect(row).toEqual({ hdr_tier: 'hdr', hdr_type: 'hlg' });
    });

    it('picks the best-resolution file across multiple files for the same item', async () => {
        const itemId = await seedItem(sql, 'movie');
        const file1080 = await seedFile(sql);
        await linkFile(sql, itemId, file1080);
        await seedVideoStream(sql, file1080, { height: 1080, codec: 'h264' });
        const file4k = await seedFile(sql);
        await linkFile(sql, itemId, file4k, false);
        await seedVideoStream(sql, file4k, { height: 2160, codec: 'hevc' });

        await refreshItemQuality(sql, itemId);

        const [row] = await sql<{ resolution_tier: string; codec: string | null }[]>`
            SELECT resolution_tier, codec FROM media_item_quality WHERE media_item_id = ${itemId}`;
        expect(row).toEqual({ resolution_tier: '4K', codec: 'hevc' });
    });

    it('leaves no row for an item with only an audio stream (no video)', async () => {
        const itemId = await seedItem(sql, 'movie');
        const fileId = await seedFile(sql);
        await linkFile(sql, itemId, fileId);
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                  VALUES (${fileId}, 'audio', 0, 'eng')`;

        await refreshItemQuality(sql, itemId);

        const rows = await sql<{ media_item_id: string }[]>`
            SELECT media_item_id FROM media_item_quality WHERE media_item_id = ${itemId}`;
        expect(rows).toHaveLength(0);
    });
});

describe('refreshQualityForFile / refreshSeriesQuality', () => {
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

    it('rolls a series up to 4K once its best episode is refreshed via the file hook', async () => {
        const seriesId = await seedItem(sql, 'tv');
        const ep1Id = await seedItem(sql, 'episode', seriesId);
        const ep1File = await seedFile(sql);
        await linkFile(sql, ep1Id, ep1File);
        await seedVideoStream(sql, ep1File, { height: 1080, codec: 'h264' });
        await refreshItemQuality(sql, ep1Id);

        const ep2Id = await seedItem(sql, 'episode', seriesId);
        const ep2File = await seedFile(sql);
        await linkFile(sql, ep2Id, ep2File);
        await seedVideoStream(sql, ep2File, { height: 2160, codec: 'hevc' });

        await refreshQualityForFile(sql, ep2File);

        const [seriesRow] = await sql<{ resolution_tier: string }[]>`
            SELECT resolution_tier FROM media_item_quality WHERE media_item_id = ${seriesId}`;
        expect(seriesRow.resolution_tier).toBe('4K');
    });

    it('survives concurrent refreshes of one series and one item (no pkey race)', async () => {
        // Prod 2026-09-22..24: 775x media_item_quality_pkey — DELETE and INSERT
        // are separate statements, so two concurrent refreshes both deleted and
        // the second INSERT collided.
        const seriesId = await seedItem(sql, 'tv');
        const epId = await seedItem(sql, 'episode', seriesId);
        const file = await seedFile(sql);
        await linkFile(sql, epId, file);
        await seedVideoStream(sql, file, { height: 2160, codec: 'hevc' });
        await refreshItemQuality(sql, epId);

        await Promise.all(
            Array.from({ length: 16 }, (_, i) =>
                i % 2 === 0 ? refreshSeriesQuality(sql, seriesId) : refreshItemQuality(sql, epId),
            ),
        );

        const rows = await sql<{ media_item_id: string; resolution_tier: string }[]>`
            SELECT media_item_id, resolution_tier FROM media_item_quality
            WHERE media_item_id IN (${seriesId}, ${epId}) ORDER BY media_item_id`;
        expect(rows.map((r) => r.resolution_tier)).toEqual(['4K', '4K']);
    });

    it("rolls a series' hdr_type up to its best episode's fine HDR class", async () => {
        const seriesId = await seedItem(sql, 'tv');
        const ep1Id = await seedItem(sql, 'episode', seriesId);
        const ep1File = await seedFile(sql);
        await linkFile(sql, ep1Id, ep1File);
        await seedVideoStream(sql, ep1File, {
            height: 2160,
            codec: 'hevc',
            videoRangeType: 'HDR10',
        });
        await refreshItemQuality(sql, ep1Id);

        const ep2Id = await seedItem(sql, 'episode', seriesId);
        const ep2File = await seedFile(sql);
        await linkFile(sql, ep2Id, ep2File);
        await seedVideoStream(sql, ep2File, {
            height: 2160,
            codec: 'hevc',
            videoRangeType: 'HDR10Plus',
        });

        await refreshQualityForFile(sql, ep2File);

        const [seriesRow] = await sql<{ hdr_tier: string | null; hdr_type: string | null }[]>`
            SELECT hdr_tier, hdr_type FROM media_item_quality WHERE media_item_id = ${seriesId}`;
        expect(seriesRow).toEqual({ hdr_tier: 'hdr', hdr_type: 'hdr10_plus' });
    });
});

let rebuildFixtureCounter = 0;

describe('rebuildAllQuality', () => {
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

    it('backfills a seeded movie and series from raw streams in one pass', async () => {
        const movieId = await seedItem(sql, 'movie');
        const movieFile = await seedFile(sql);
        await linkFile(sql, movieId, movieFile);
        await seedVideoStream(sql, movieFile, { height: 2160, codec: 'hevc', videoRange: 'HDR10' });

        const seriesId = await seedItem(sql, 'tv');
        const mkEpisode = async (height: number): Promise<void> => {
            const epId = await seedItem(sql, 'episode', seriesId);
            const fileId = await seedFile(sql);
            await linkFile(sql, epId, fileId);
            await seedVideoStream(sql, fileId, {
                height,
                codec: 'h264',
                index: rebuildFixtureCounter++,
            });
        };
        await mkEpisode(1080);
        await mkEpisode(720);

        // No refresh called — rows absent until rebuild:
        await rebuildAllQuality(sql);

        const [movieRow] = await sql<
            { resolution_tier: string; hdr_tier: string | null; hdr_type: string | null }[]
        >`SELECT resolution_tier, hdr_tier, hdr_type FROM media_item_quality WHERE media_item_id = ${movieId}`;
        // videoRange 'HDR10' with no video_range_type → falls back to 'hdr10'.
        expect(movieRow).toEqual({ resolution_tier: '4K', hdr_tier: 'hdr', hdr_type: 'hdr10' });

        const [seriesRow] = await sql<{ resolution_tier: string }[]>`
            SELECT resolution_tier FROM media_item_quality WHERE media_item_id = ${seriesId}`;
        expect(seriesRow.resolution_tier).toBe('1080p');
    });
});
