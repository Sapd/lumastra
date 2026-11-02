// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMovie } from '../../../../../tests/integration/fixtures/index.js';
import {
    deleteSegmentsForSourceByTypes,
    getSegmentsForChildren,
    getAnimePreviewInputs,
    getSegmentsByMediaId,
    upsertSegments,
} from './media-segments.queries.js';

describe('media-segments queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'media_segments']);
    });

    it('returns empty array when no segments exist', async () => {
        const { id } = await createAndInsertTestMovie(sql);
        const result = await getSegmentsByMediaId(sql, id);
        expect(result).toEqual([]);
    });

    it('upserts and retrieves segments', async () => {
        const { id } = await createAndInsertTestMovie(sql);
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 10, endTime: 90 }],
            'lumastra-intro-analyzer',
        );
        const result = await getSegmentsByMediaId(sql, id);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('Intro');
        expect(result[0].source).toBe('lumastra-intro-analyzer');
    });

    it('upsert replaces existing segment for same source', async () => {
        const { id } = await createAndInsertTestMovie(sql);
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 10, endTime: 90 }],
            'lumastra-intro-analyzer',
        );
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 15, endTime: 85 }],
            'lumastra-intro-analyzer',
        );
        const result = await getSegmentsByMediaId(sql, id);
        expect(result).toHaveLength(1);
        expect(result[0].start_time).toBe(15);
    });

    it('isolates two cuts while retaining media-wide rows and independent upserts', async () => {
        const { id } = await createAndInsertTestMovie(sql);
        const fileA = randomUUID();
        const fileB = randomUUID();
        for (const fileId of [fileA, fileB]) {
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}, ${'/test/' + fileId + '.mkv'})`;
        }
        await upsertSegments(sql, id, [{ type: 'Recap', startTime: 0, endTime: 5 }], 'detector');
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 10, endTime: 20 }],
            'detector',
            fileA,
        );
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 30, endTime: 40 }],
            'detector',
            fileB,
        );
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 11, endTime: 21 }],
            'detector',
            fileA,
        );
        expect((await getSegmentsByMediaId(sql, id, fileA)).map((r) => r.start_time)).toEqual([
            0, 11,
        ]);
        expect((await getSegmentsByMediaId(sql, id, fileB)).map((r) => r.start_time)).toEqual([
            0, 30,
        ]);
        await sql`DELETE FROM media_files WHERE id = ${fileA}`;
        expect(await getSegmentsByMediaId(sql, id)).toHaveLength(1);
    });

    it('prefers the selected scope, resolves the default, and supersedes all cuts on media-wide writes/retractions', async () => {
        const { id } = await createAndInsertTestMovie(sql);
        const fileA = randomUUID();
        const fileB = randomUUID();
        // The default must exist from the first link on (deferred invariant trigger): link B (the default) first.
        for (const fileId of [fileB, fileA]) {
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}, ${'/test/' + fileId + '.mkv'})`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${id}, ${fileId}, ${fileId === fileB})`;
        }
        const source = 'lumastra-intro-analyzer';
        await upsertSegments(sql, id, [{ type: 'Intro', startTime: 1, endTime: 9 }], source);
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 20, endTime: 30 }],
            source,
            fileA,
        );
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 40, endTime: 50 }],
            source,
            fileB,
        );
        expect((await getSegmentsByMediaId(sql, id, fileA)).map((r) => r.start_time)).toEqual([20]);
        expect((await getSegmentsByMediaId(sql, id)).map((r) => r.start_time)).toEqual([40]);
        // Manual overrides/repair use a NULL write through this same query.
        await upsertSegments(sql, id, [{ type: 'Intro', startTime: 2, endTime: 10 }], source);
        const stored = await sql`SELECT file_id FROM media_segments WHERE media_id = ${id}`;
        expect(stored.map((r) => r.file_id)).toEqual([null]);
        expect((await getSegmentsByMediaId(sql, id, fileB)).map((r) => r.start_time)).toEqual([2]);
        await upsertSegments(
            sql,
            id,
            [{ type: 'Intro', startTime: 20, endTime: 30 }],
            source,
            fileA,
        );
        await deleteSegmentsForSourceByTypes(sql, id, source, ['Intro'], fileB);
        expect(await getSegmentsByMediaId(sql, id, fileA)).toHaveLength(1);
        await deleteSegmentsForSourceByTypes(sql, id, source, ['Intro']);
        expect(await sql`SELECT id FROM media_segments WHERE media_id = ${id}`).toHaveLength(0);
    });

    it('uses each child default cut without duplicate media-wide markers', async () => {
        const series = randomUUID();
        const season = randomUUID();
        const episode = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${series}, 'Series', 'tv')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number) VALUES (${season}, 'Season', 'season', ${series}, 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, episode_number) VALUES (${episode}, 'Episode', 'episode', ${season}, 1)`;
        const file = randomUUID();
        await sql`INSERT INTO media_files (id, file_path) VALUES (${file}, ${'/test/' + file + '.mkv'})`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${episode}, ${file}, true)`;
        await upsertSegments(
            sql,
            episode,
            [{ type: 'Intro', startTime: 0, endTime: 10 }],
            'detector',
        );
        await upsertSegments(
            sql,
            episode,
            [{ type: 'Intro', startTime: 20, endTime: 30 }],
            'detector',
            file,
        );
        for (const [parent, type] of [
            [series, 'tv'],
            [season, 'season'],
        ] as const) {
            const rows = await getSegmentsForChildren(sql, parent, type);
            expect(rows).toHaveLength(1);
            expect(rows[0].file_id).toBe(file);
        }
    });

    it('uses scope precedence for anime-preview inputs and plugin list/write operations', async () => {
        const { buildMediaSegmentStore } = await import('$lib/server/tasks/plugin-stores.js');
        const { id } = await createAndInsertTestMovie(sql);
        const file = randomUUID();
        await sql`INSERT INTO media_files (id, file_path) VALUES (${file}, ${'/test/' + file + '.mkv'})`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${id}, ${file}, true)`;
        await upsertSegments(sql, id, [{ type: 'Outro', startTime: 50, endTime: 100 }], 'plugin');
        await upsertSegments(
            sql,
            id,
            [{ type: 'Outro', startTime: 10, endTime: 20 }],
            'plugin',
            file,
        );
        expect((await getAnimePreviewInputs(sql, [id], 'plugin'))[0].outroEndSec).toBe(20);
        const store = buildMediaSegmentStore(sql, 'plugin');
        expect(await store.list(id)).toEqual([
            { type: 'outro', startTime: 10, endTime: 20, source: 'plugin' },
        ]);
        await store.upsert(id, [{ type: 'outro', startTime: 30, endTime: 40 }]);
        expect(
            (await getSegmentsByMediaId(sql, id, file)).map((row) => [row.file_id, row.start_time]),
        ).toEqual([[null, 30]]);
        expect(
            await sql`SELECT id FROM media_segments WHERE media_id = ${id} AND file_id IS NOT NULL`,
        ).toHaveLength(0);
    });

    describe('getAnimePreviewInputs', () => {
        it('executes against the real schema and reports Outro/Preview state', async () => {
            const { id } = await createAndInsertTestMovie(sql);
            await upsertSegments(
                sql,
                id,
                [{ type: 'Outro', startTime: 1200, endTime: 1380 }],
                'lumastra-intro-analyzer',
            );

            const rows = await getAnimePreviewInputs(sql, [id], 'lumastra-intro-analyzer');

            expect(rows).toHaveLength(1);
            expect(rows[0].episodeId).toBe(id);
            expect(rows[0].outroEndSec).toBe(1380);
            expect(rows[0].hasExistingPreview).toBe(false);
        });

        it('flags an already-synthesised Preview so chapter detection is not overwritten', async () => {
            const { id } = await createAndInsertTestMovie(sql);
            await upsertSegments(
                sql,
                id,
                [
                    { type: 'Outro', startTime: 1200, endTime: 1380 },
                    { type: 'Preview', startTime: 1380, endTime: 1440 },
                ],
                'lumastra-intro-analyzer',
            );

            const rows = await getAnimePreviewInputs(sql, [id], 'lumastra-intro-analyzer');

            expect(rows).toHaveLength(1);
            expect(rows[0].hasExistingPreview).toBe(true);
        });

        it('returns an empty array for an empty id list without touching the database', async () => {
            expect(await getAnimePreviewInputs(sql, [], 'lumastra-intro-analyzer')).toEqual([]);
        });
    });
});
