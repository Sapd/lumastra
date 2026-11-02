// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for multi-episode link arbitration against a real database.
 *
 * `evictRangeLinksSupersededByDedicatedFile` DELETEs rows, so the parts that
 * decide WHETHER to delete — the dedicated-file re-check, the segment-offset
 * exemption, and the default-flag handover — are exercised here rather than
 * only through the pure predicates.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import {
    evictRangeLinksSupersededByDedicatedFile,
    findDedicatedFileForEpisodeNumber,
} from './multi-episode-links.js';

const DIR = '/kids/Hafentage (1997)/Season 06';
const COMBINED = `${DIR}/HarborfolksHafentage-S06E01E03-Die Nacht der lebenden Finsters.mkv`;
const SEGMENT_1 = `${DIR}/HarborfolksHafentage-S06E01E01-Immer wenn sie Chips aß.mkv`;
const OWN_FILE = `${DIR}/HarborfolksHafentage-S06E02-Mikey und Kurst.mkv`;

describe('multi-episode link arbitration (integration)', () => {
    let sql: postgres.Sql;
    let seasonId: string;
    let episodeId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['media_file_items', 'media_files', 'media_items']);

        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, season_number)
            VALUES ('Season 6', 'season', 'active', 6)
            RETURNING id
        `;
        seasonId = season.id;

        const [episode] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number)
            VALUES ('Kurst the Not So Bad', 'episode', 'active', ${seasonId}::uuid, 6, 2)
            RETURNING id
        `;
        episodeId = episode.id;
    });

    async function addFile(path: string, duration: number): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds)
            VALUES (${path}, ${duration})
            RETURNING id
        `;
        return row.id;
    }

    /** Insert both links in ONE statement — the deferred one-default trigger checks at commit. */
    async function link(
        rangeFileId: string,
        dedicatedFileId: string,
        opts: { rangeIsDefault: boolean; offsetSource?: string },
    ): Promise<void> {
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, offset_source, start_offset_ms, end_offset_ms)
            VALUES (${rangeFileId}::uuid, ${episodeId}::uuid, ${opts.rangeIsDefault},
                    ${opts.offsetSource ?? null}, ${opts.offsetSource ? 0 : null}, ${opts.offsetSource ? 682480 : null}),
                   (${dedicatedFileId}::uuid, ${episodeId}::uuid, ${!opts.rangeIsDefault}, NULL, NULL, NULL)
        `;
    }

    async function linkRows(): Promise<{ file_path: string; is_default: boolean }[]> {
        return sql<{ file_path: string; is_default: boolean }[]>`
            SELECT mf.file_path, mfi.is_default
            FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mfi.media_item_id = ${episodeId}
            ORDER BY mf.file_path
        `;
    }

    it('evicts the range link and hands the default to the dedicated file', async () => {
        const combinedId = await addFile(COMBINED, 344);
        const ownId = await addFile(OWN_FILE, 632);
        await link(combinedId, ownId, { rangeIsDefault: true });

        const evicted = await evictRangeLinksSupersededByDedicatedFile(
            sql,
            episodeId,
            2,
            ownId,
            OWN_FILE,
        );

        expect(evicted).toEqual([COMBINED]);
        expect(await linkRows()).toEqual([{ file_path: OWN_FILE, is_default: true }]);
    });

    it('leaves a surviving default alone when the evicted row did not hold it', async () => {
        const combinedId = await addFile(COMBINED, 344);
        const ownId = await addFile(OWN_FILE, 632);
        await link(combinedId, ownId, { rangeIsDefault: false });

        await evictRangeLinksSupersededByDedicatedFile(sql, episodeId, 2, ownId, OWN_FILE);

        expect(await linkRows()).toEqual([{ file_path: OWN_FILE, is_default: true }]);
    });

    it('never evicts a link carrying segment offsets', async () => {
        // Harborfolk S01E20-21 shape: a genuine combined file with runtime-split
        // offsets, alongside a standalone rip. Deleting the segmented link would
        // discard working playback data.
        const combinedId = await addFile(COMBINED, 344);
        const ownId = await addFile(OWN_FILE, 632);
        await link(combinedId, ownId, { rangeIsDefault: true, offsetSource: 'runtime-split' });

        const evicted = await evictRangeLinksSupersededByDedicatedFile(
            sql,
            episodeId,
            2,
            ownId,
            OWN_FILE,
        );

        expect(evicted).toEqual([]);
        const rows = await linkRows();
        expect(rows).toHaveLength(2);
        // The segmented link keeps the default it already held.
        expect(rows.find((r) => r.file_path === COMBINED)!.is_default).toBe(true);
    });

    it('does nothing when the "dedicated" file is a self-referential range', async () => {
        // S06E01E01 passes the caller's episodeCount === 1 gate. If the callee
        // trusted that, part 1 of a split anthology would delete parts 2 and 3.
        const combinedId = await addFile(COMBINED, 344);
        const segment1Id = await addFile(SEGMENT_1, 401);
        await link(combinedId, segment1Id, { rangeIsDefault: true });

        const evicted = await evictRangeLinksSupersededByDedicatedFile(
            sql,
            episodeId,
            2,
            segment1Id,
            SEGMENT_1,
        );

        expect(evicted).toEqual([]);
        expect(await linkRows()).toHaveLength(2);
    });

    describe('findDedicatedFileForEpisodeNumber', () => {
        it('finds a dedicated file linked to the episode', async () => {
            const combinedId = await addFile(COMBINED, 344);
            const ownId = await addFile(OWN_FILE, 632);
            await link(combinedId, ownId, { rangeIsDefault: true });

            expect(await findDedicatedFileForEpisodeNumber(sql, seasonId, 2, COMBINED)).toBe(
                OWN_FILE,
            );
        });

        it('returns null when only range-form files are linked', async () => {
            const combinedId = await addFile(COMBINED, 344);
            const segment1Id = await addFile(SEGMENT_1, 401);
            await link(combinedId, segment1Id, { rangeIsDefault: true });

            expect(await findDedicatedFileForEpisodeNumber(sql, seasonId, 2, COMBINED)).toBeNull();
        });

        it('ignores files flagged missing', async () => {
            const combinedId = await addFile(COMBINED, 344);
            const ownId = await addFile(OWN_FILE, 632);
            await link(combinedId, ownId, { rangeIsDefault: true });
            await sql`UPDATE media_files SET is_missing = true WHERE id = ${ownId}`;

            expect(await findDedicatedFileForEpisodeNumber(sql, seasonId, 2, COMBINED)).toBeNull();
        });
    });
});
