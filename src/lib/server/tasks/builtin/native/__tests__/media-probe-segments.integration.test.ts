// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test: a probe that stores the duration of a combined file
 * recomputes its episode windows.
 *
 * The scanner links every episode row of `S01E03-E04 - …mkv` before any probe
 * has run, so the first segment derivation finds no duration and derives
 * nothing. Only chapter sync used to recompute later, and a file without
 * chapters never got windows, so the second episode kept start 0 and played
 * from the top of the file. writeProbeResult must close that gap in the same
 * transaction that stores the duration.
 */

import { describe, it, expect, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    closeTestDb,
    getTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import type { MediaProbeResult } from '../../../../utils/ffprobe.js';
import { writeProbeResult } from '../media-probe.js';

class Rollback extends Error {}

/** Run body inside a transaction that is always rolled back. */
async function inRolledBackTx(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    try {
        await getTestDb().begin(async (tx) => {
            await body(tx as postgres.TransactionSql);
            throw new Rollback();
        });
    } catch (err) {
        if (!(err instanceof Rollback)) throw err;
    }
}

/** Seed a season with two episode rows (3 and 4, 73 s each) on one unprobed file. */
async function seedCombinedFile(
    tx: postgres.TransactionSql,
): Promise<{ fileId: string; episodeIds: string[] }> {
    const [series] = (await tx`
        INSERT INTO media_items (title, media_type, status, has_files)
        VALUES ('Quillon Harbour', 'tv', 'active', true)
        RETURNING id
    `) as { id: string }[];
    const [season] = (await tx`
        INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
        VALUES ('Season 1', 'season', 'active', true, ${series.id}, 1)
        RETURNING id
    `) as { id: string }[];
    const [file] = (await tx`
        INSERT INTO media_files (file_path, duration_seconds)
        VALUES (${`/test/multi-ep-probe/${crypto.randomUUID()}/S01E03-E04 - Two Lanterns.mkv`}, NULL)
        RETURNING id
    `) as { id: string }[];

    const episodeIds: string[] = [];
    for (const episodeNumber of [3, 4]) {
        const [episode] = (await tx`
            INSERT INTO media_items
                (title, media_type, status, has_files, parent_id, season_number, episode_number, runtime_seconds)
            VALUES (${`Episode ${episodeNumber}`}, 'episode', 'active', true, ${season.id}, 1,
                    ${episodeNumber}, 73)
            RETURNING id
        `) as { id: string }[];
        await tx`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}, ${episode.id}, true)
        `;
        episodeIds.push(episode.id);
    }
    return { fileId: file.id, episodeIds };
}

/** Probe result of the 145.092 s file; no streams, so only the file row is written. */
const PROBE: MediaProbeResult = {
    success: true,
    video: null,
    audioStreams: [],
    subtitleStreams: [],
    duration: 145.092,
    container: 'matroska,webm',
    fileSize: 1_000_000,
    formatBitrate: null,
};

afterAll(async () => {
    await closeTestDb();
});

describe('writeProbeResult on a combined file', () => {
    it('derives the episode windows in the same transaction that stores the duration', async () => {
        await inRolledBackTx(async (tx) => {
            const { fileId, episodeIds } = await seedCombinedFile(tx);

            await writeProbeResult(tx as unknown as postgres.Sql, fileId, PROBE, episodeIds);

            const rows = (await tx`
                SELECT mi.episode_number, mfi.start_offset_ms, mfi.end_offset_ms, mfi.offset_source
                FROM media_file_items mfi
                JOIN media_items mi ON mi.id = mfi.media_item_id
                WHERE mfi.file_id = ${fileId}
                ORDER BY mi.episode_number
            `) as {
                episode_number: number;
                start_offset_ms: number | null;
                end_offset_ms: number | null;
                offset_source: string | null;
            }[];

            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({
                episode_number: 3,
                start_offset_ms: 0,
                end_offset_ms: 72546,
                offset_source: 'runtime-split',
            });
            expect(rows[1]).toMatchObject({
                episode_number: 4,
                start_offset_ms: 72546,
                end_offset_ms: 145092,
                offset_source: 'runtime-split',
            });
        });
    });
});
