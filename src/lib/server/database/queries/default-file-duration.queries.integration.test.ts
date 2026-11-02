// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getDefaultFileDurationMs — the file duration the /watch loader judges a
 * "finished" resume against (resumePositionForStart). It must read the file the
 * item actually plays by default, as buildLumastraInfo picks it, or the loader
 * and /info disagree on where playback starts.
 *
 * Runs inside a transaction that is always rolled back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getDefaultFileDurationMs } from './media-files.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

let sql: postgres.Sql;

beforeAll(() => {
    sql = postgres(getTestDatabaseUrl(), { max: 2, onnotice: () => {} });
});

afterAll(async () => {
    await sql?.end();
});

class Rollback extends Error {}

async function inRolledBackTx(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    try {
        await sql.begin(async (tx) => {
            await body(tx as postgres.TransactionSql);
            throw new Rollback();
        });
    } catch (err) {
        if (!(err instanceof Rollback)) throw err;
    }
}

async function seedMovie(tx: postgres.TransactionSql): Promise<string> {
    const [movie] = (await tx`
        INSERT INTO media_items (title, media_type, status, has_files, runtime_seconds)
        VALUES ('Default File Duration Fixture', 'movie', 'active', true, 420)
        RETURNING id
    `) as { id: string }[];
    return movie.id;
}

async function linkFile(
    tx: postgres.TransactionSql,
    movieId: string,
    opts: { path: string; durationSeconds: number | null; isDefault: boolean; sortOrder: number },
): Promise<void> {
    const [file] = (await tx`
        INSERT INTO media_files (file_path, duration_seconds)
        VALUES (${opts.path}, ${opts.durationSeconds})
        RETURNING id
    `) as { id: string }[];
    await tx`
        INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
        VALUES (${file.id}, ${movieId}, ${opts.isDefault}, ${opts.sortOrder})
    `;
}

describe('getDefaultFileDurationMs', () => {
    it('reads the DEFAULT file, not the first by sort order', async () => {
        await inRolledBackTx(async (tx) => {
            const movieId = await seedMovie(tx);
            await linkFile(tx, movieId, {
                path: '/fixture/dfd/theatrical.mkv',
                durationSeconds: 420.021,
                isDefault: false,
                sortOrder: 0,
            });
            await linkFile(tx, movieId, {
                path: '/fixture/dfd/extended.mkv',
                durationSeconds: 600,
                isDefault: true,
                sortOrder: 1,
            });
            expect(await getDefaultFileDurationMs(tx as unknown as postgres.Sql, movieId)).toBe(
                600_000,
            );
        });
    });

    it('rounds a fractional probe duration to whole milliseconds', async () => {
        await inRolledBackTx(async (tx) => {
            const movieId = await seedMovie(tx);
            await linkFile(tx, movieId, {
                path: '/fixture/dfd/only.mkv',
                durationSeconds: 420.021,
                isDefault: true,
                sortOrder: 0,
            });
            expect(await getDefaultFileDurationMs(tx as unknown as postgres.Sql, movieId)).toBe(
                420_021,
            );
        });
    });

    it('is null for an unprobed file and for an item without files', async () => {
        await inRolledBackTx(async (tx) => {
            const movieId = await seedMovie(tx);
            expect(
                await getDefaultFileDurationMs(tx as unknown as postgres.Sql, movieId),
            ).toBeNull();
            await linkFile(tx, movieId, {
                path: '/fixture/dfd/unprobed.mkv',
                durationSeconds: null,
                isDefault: true,
                sortOrder: 0,
            });
            expect(
                await getDefaultFileDurationMs(tx as unknown as postgres.Sql, movieId),
            ).toBeNull();
        });
    });
});
