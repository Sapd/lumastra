// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../tests/integration/setup/test-database.js';
import { TEST_TABLES, truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { albumArtistSnapshot, saveAlbumArtist } from './album-artist-edit.js';
import { repairOrphanMusicLinks } from './orphan-link-repair.js';

const ARTIST = '10000000-0000-4000-8000-000000000001';
const ALBUM = 'f0000000-0000-4000-8000-000000000001';
const TRACK = 'f0000000-0000-4000-8000-000000000002';
let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    await sql`INSERT INTO media_items(id,media_type,title) VALUES
        (${ARTIST},'artist','Woven Assembly'),(${ALBUM},'album','Paper Solstice')`;
    await sql`INSERT INTO media_items(id,media_type,title,parent_id,custom_metadata) VALUES
        (${TRACK},'track','Small Lantern',${ALBUM},'{"album":"Paper Solstice","album_artist":"Woven Assembly"}'::jsonb)`;
    const [file] = await sql<{ id: string }[]>`INSERT INTO media_files(file_path,is_missing)
        VALUES ('/invented/Paper Solstice/Small Lantern.flac',false) RETURNING id`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${file.id},${TRACK},true)`;
});
afterAll(async () => {
    await closeTestDb();
});

async function waitForRowWait(pid: number): Promise<void> {
    const deadline = Date.now() + 1500;
    do {
        const [row] = await sql<
            { waiting: boolean }[]
        >`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS waiting`;
        if (row.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error('Worker never reached the expected row-lock wait');
}

/** Independent connections prove the worker waits on the lower UUID before holding the higher one. */
async function whileBlocked(
    blockerId: string,
    operation: (worker: postgres.Sql) => Promise<unknown>,
    probe: () => Promise<unknown>,
): Promise<void> {
    const blocker = postgres(getTestDatabaseUrl(), { max: 1 });
    const worker = postgres(getTestDatabaseUrl(), { max: 1 });
    let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
        const [row] = await worker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await blocker.begin(async (tx) => {
            await tx`SELECT id FROM media_items WHERE id=${blockerId} FOR NO KEY UPDATE`;
            pending = operation(worker).then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
            );
            await waitForRowWait(row.pid);
            await probe();
        });
        expect(await pending).toMatchObject({ ok: true });
    } finally {
        await pending;
        await Promise.all([blocker.end(), worker.end()]);
    }
}

describe('music editing lock and snapshot boundaries', () => {
    it('reads the album snapshot without waiting for an album row lock', async () => {
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        const reader = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { lock_timeout: 150 },
        });
        try {
            await writer.begin(async (tx) => {
                await tx`SELECT id FROM media_items WHERE id=${ALBUM} FOR UPDATE`;
                await expect(albumArtistSnapshot(reader, ALBUM)).resolves.toMatch(/^[a-f0-9]{64}$/);
            });
        } finally {
            await Promise.all([writer.end(), reader.end()]);
        }
    });

    it('allows ownership save after unrelated enrichment but refuses changed ownership or title', async () => {
        const before = await albumArtistSnapshot(sql, ALBUM);
        await sql`UPDATE media_items SET overview='A new description',custom_metadata='{"genre":"Invented Folk"}'::jsonb,
            updated_at=clock_timestamp() WHERE id=${ALBUM}`;
        expect(await albumArtistSnapshot(sql, ALBUM)).toBe(before);
        await expect(
            saveAlbumArtist(sql, ALBUM, 'curator', { artistId: ARTIST }, before),
        ).resolves.toMatchObject({ artistId: ARTIST });
        const current = await albumArtistSnapshot(sql, ALBUM);
        await sql`UPDATE media_items SET title='Different Solstice' WHERE id=${ALBUM}`;
        await expect(
            saveAlbumArtist(sql, ALBUM, 'curator', { artistId: ARTIST }, current),
        ).rejects.toThrow('changed');
    });

    it.each(['manual ownership', 'orphan repair'] as const)(
        '%s waits for the lower artist UUID before taking the album lock',
        async (mode) => {
            await whileBlocked(
                ARTIST,
                (worker) =>
                    mode === 'manual ownership'
                        ? saveAlbumArtist(worker, ALBUM, 'curator', { artistId: ARTIST })
                        : repairOrphanMusicLinks(worker),
                () =>
                    sql.begin(async (tx) => {
                        await tx`SELECT id FROM media_items WHERE id=${ALBUM} FOR NO KEY UPDATE NOWAIT`;
                    }),
            );
            expect(
                (await sql`SELECT parent_id FROM media_items WHERE id=${ALBUM}`)[0].parent_id,
            ).toBe(ARTIST);
        },
    );

    it('orphan repair allows container FK checks while waiting on a track', async () => {
        // NO KEY UPDATE on containers must coexist with the scanner's KEY SHARE checks.
        await whileBlocked(
            TRACK,
            (worker) => repairOrphanMusicLinks(worker),
            () =>
                sql.begin(async (tx) => {
                    await tx`SELECT id FROM media_items WHERE id=ANY(${[ARTIST, ALBUM]}::uuid[]) ORDER BY id FOR KEY SHARE NOWAIT`;
                }),
        );
        expect((await sql`SELECT parent_id FROM media_items WHERE id=${ALBUM}`)[0].parent_id).toBe(
            ARTIST,
        );
    });
});
