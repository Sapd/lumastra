// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real scanner and PostgreSQL: every episode is linked or visible to an admin. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import * as folderOwner from './series-folder-owner.js';
import * as scannerShared from './shared.js';
import * as filePresence from '$lib/server/utils/file-presence.js';
import { listSeriesFilePaths } from '$lib/server/database/queries/file-rematch.queries.js';
import { processVideoFile } from './video-processor.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    getScanProgress: async () => null,
    deleteScanProgress: async () => {},
    getAnyScanProgress: async () => null,
    getAggregateScanProgress: async () => null,
    getScanProgressByKey: async () => new Map(),
}));

import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { scanForSync } from '../../file-scanner.js';
import {
    deleteStaleMediaFile,
    listScanIssues,
} from '../../../../../../database/queries/media-files.queries.js';

import { insertTestExternalIds } from '../../../../../../../../../tests/integration/fixtures/index.js';

const VIDEO = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

interface ItemRow {
    id: string;
    title: string;
    status: string;
    is_dismissed: boolean;
    parent_id: string | null;
}

async function writeVideo(file: string, tag: string): Promise<string> {
    await mkdir(dirname(file), { recursive: true });
    const payload = Buffer.from(`lumastra-test:${tag}`, 'utf8');
    const box = Buffer.alloc(8);
    box.writeUInt32BE(8 + payload.length, 0);
    box.write('free', 4, 'latin1');
    await writeFile(file, Buffer.concat([await readFile(VIDEO), box, payload]));
    return file;
}

describe('unidentified series folder ingestion (real PG, real ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let groupId: string;
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        for (const method of Object.values(logger)) method.mockClear();
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        root = await mkdtemp(join(tmpdir(), 'lumastra-series-folder-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`series-folder-${Date.now()}`})
            RETURNING id
        `;
        groupId = group.id;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function library(mediaType: 'tv'): Promise<string> {
        const libRoot = join(root, mediaType);
        await mkdir(libRoot, { recursive: true });
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, scan_chapters)
            VALUES (${libRoot}, ${mediaType}, ${groupId}, true, true) RETURNING id
        `;
        return lp.id;
    }

    const scan = async (pathId: string, scanSql = sql): Promise<void> => {
        const result = await scanForSync(pathId, { sql: scanSql, logger } as never);
        expect(result.errors).toEqual([]);
    };

    async function itemOf(filePath: string): Promise<ItemRow | undefined> {
        const [row] = await sql<ItemRow[]>`
            SELECT mi.id, mi.title, mi.status, mi.is_dismissed, mi.parent_id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path = ${filePath}
        `;
        return row;
    }

    async function item(id: string): Promise<ItemRow> {
        const [row] = await sql<ItemRow[]>`
            SELECT id, title, status, is_dismissed, parent_id FROM media_items WHERE id = ${id}
        `;
        return row;
    }

    async function seriesOf(episodeId: string): Promise<ItemRow> {
        const episode = await item(episodeId);
        const season = await item(episode.parent_id!);
        return season.parent_id ? item(season.parent_id) : season;
    }

    it('links every file of an unidentified series, including specials and absent episodes', async () => {
        const pathId = await library('tv');
        const seriesDir = join(root, 'tv', 'Quillon Harbour (2031)');
        // The onboarding layout: specials, a combined episode, a missing
        // numbered episode, and bare numbers whose season comes from the folder.
        const fixtures = [
            ['Season 00/Quillon Harbour (2031) - S00E01 - Harbour Lights Special.mkv', 0, 1],
            ['Season 00/Quillon Harbour (2031) - S00E02 - Behind the Fog.mkv', 0, 2],
            ['Season 01/Quillon Harbour (2031) - S01E01 - Lantern Ferry.mkv', 1, 1],
            ['Season 01/Quillon Harbour (2031) - S01E02 - Salt Market.mkv', 1, 2],
            ['Season 01/Quillon Harbour (2031) - S01E03-E04 - Two Lanterns.mkv', 1, 3],
            ['Season 01/Quillon Harbour (2031) - S01E06 - Night Bells.mkv', 1, 6],
            ['Season 02/Quillon Harbour (2031) - 07.mkv', 2, 7],
            ['Season 02/Quillon Harbour (2031) - 08.mkv', 2, 8],
            ['Season 02/Quillon Harbour (2031) - 09.mkv', 2, 9],
        ] as const;
        await mkdir(seriesDir, { recursive: true });
        await writeFile(
            join(seriesDir, 'tvshow.nfo'),
            '<tvshow><title>Quillon Harbour</title><year>2031</year></tvshow>',
        );
        for (const [name, season, episode] of fixtures) {
            const file = await writeVideo(join(seriesDir, name), name);
            await writeFile(
                file.replace(/\.mkv$/, '.nfo'),
                `<episodedetails><title>Local episode ${episode}</title><season>${season}</season><episode>${episode}</episode></episodedetails>`,
            );
            await writeFile(
                join(dirname(file), 'season.nfo'),
                `<season><seasonnumber>${season}</seasonnumber></season>`,
            );
        }
        await scan(pathId);
        const links = await sql<
            {
                file_path: string;
                season_number: number;
                episode_number: number;
                series_id: string;
            }[]
        >`
            SELECT mf.file_path, ep.season_number, ep.episode_number, series.id AS series_id
            FROM media_files mf
            JOIN media_file_items link ON link.file_id = mf.id
            JOIN media_items ep ON ep.id = link.media_item_id
            JOIN media_items season ON season.id = ep.parent_id
            JOIN media_items series ON series.id = season.parent_id
        `;
        expect(
            new Set(links.map((r) => r.file_path)).size,
            JSON.stringify(logger.warn.mock.calls),
        ).toBe(9);
        expect(new Set(links.map((r) => r.series_id)).size).toBe(1);
        expect(await listScanIssues(sql)).toEqual([]);
        for (const [name, season, episode] of fixtures) {
            expect(links).toContainEqual(
                expect.objectContaining({
                    file_path: join(seriesDir, name),
                    season_number: season,
                    episode_number: episode,
                }),
            );
        }
        expect(links).toHaveLength(10); // S01E03-E04 links to both episodes.
        await scan(pathId);
        for (const row of links) expect((await itemOf(row.file_path))?.id).toBeDefined();
    }, 120_000);

    it('queues sibling scans before taking pool connections while another connection owns the folder lock', async () => {
        const pathId = await library('tv');
        const folder = join(root, 'tv', 'Quillon Harbour (2031)');
        const files = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                writeVideo(
                    join(
                        folder,
                        'Season 01',
                        `Quillon Harbour - S01E${String(i + 1).padStart(2, '0')}.mkv`,
                    ),
                    `pool-${i}`,
                ),
            ),
        );
        const blocker = postgres(getTestDatabaseUrl(), { max: 1 });
        const taskDb = getTaskDb()!; // The production task pool has seven connections.
        const entered = vi.spyOn(folderOwner, 'withSeriesFolderLock');
        const hashed = vi.spyOn(scannerShared, 'tryHashFileHead');
        let running: Promise<void> | undefined;
        try {
            await blocker.begin(async (tx) => {
                const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`series-folder:${folder}`}, 0))`;
                running = scan(pathId, taskDb);
                await expect.poll(() => entered.mock.calls.length, { timeout: 30_000 }).toBe(8);
                for (const file of files) {
                    const hashIndex = hashed.mock.calls.findIndex(([path]) => path === file);
                    const lockIndex = entered.mock.calls.findIndex(([, path]) => path === file);
                    expect(hashIndex).toBeGreaterThanOrEqual(0);
                    expect(hashed.mock.invocationCallOrder[hashIndex]).toBeLessThan(
                        entered.mock.invocationCallOrder[lockIndex],
                    );
                }
                // Observe an actual server wait, not a timing assumption. All
                // siblings reached the helper, but only one may reserve a connection.
                await expect
                    .poll(
                        async () => {
                            const [row] = await tx<{ count: number }[]>`
                        SELECT count(*)::int AS count FROM pg_stat_activity
                        WHERE ${holder.pid} = ANY(pg_blocking_pids(pid))
                    `;
                            return row.count;
                        },
                        { timeout: 5_000 },
                    )
                    .toBe(1);
                const probe = taskDb`SELECT 1 AS available`;
                const timer = setTimeout(() => {
                    void probe.cancel();
                }, 2_000);
                try {
                    await expect(probe).resolves.toMatchObject([{ available: 1 }]);
                } finally {
                    clearTimeout(timer);
                }
                for (const file of files) expect(await itemOf(file)).toBeUndefined();
            });
            await running;
            for (const file of files) expect(await itemOf(file)).toBeDefined();
            expect(await listScanIssues(sql)).toEqual([]);
        } finally {
            entered.mockRestore();
            hashed.mockRestore();
            await blocker.end();
            await running;
        }
    }, 120_000);

    it('releases the local mutex after callback failure and restores the caller timeout', async () => {
        const pathId = await library('tv');
        const [lp] = await sql<LibraryPathRow[]>`SELECT * FROM library_paths WHERE id = ${pathId}`;
        const file = join(root, 'tv', 'Quillon Harbour (2031)', 'S01E01.mkv');
        const failure = new Error('attachment failed');
        await withTx(sql, async (tx) => {
            await tx`SET LOCAL lock_timeout = '45s'`;
            await expect(
                folderOwner.withSeriesFolderLock(tx, file, lp, async () => {
                    throw failure;
                }),
            ).rejects.toBe(failure);
            await expect(
                folderOwner.withSeriesFolderLock(tx, file, lp, async () => 'attached'),
            ).resolves.toBe('attached');
            const [timeout] = await tx<
                { timeout: string }[]
            >`SELECT current_setting('lock_timeout') AS timeout`;
            expect(timeout.timeout).toBe('45s');
        });
    });

    it('maps a real folder advisory-lock timeout to retryable uncertainty and a scan skip', async () => {
        const pathId = await library('tv');
        const [lp] = await sql<LibraryPathRow[]>`SELECT * FROM library_paths WHERE id = ${pathId}`;
        const folder = join(root, 'tv', 'Quillon Harbour (2031)');
        const file = await writeVideo(
            join(folder, 'Season 01', 'Quillon Harbour - S01E01.mkv'),
            'timeout',
        );
        const blocker = postgres(getTestDatabaseUrl(), { max: 1 });
        const worker = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { lock_timeout: 50 },
        });
        const attach = vi.fn(async () => 'attached');
        const onError = vi.fn();
        try {
            await blocker.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`series-folder:${folder}`}, 0))`;
                await expect(
                    folderOwner.withSeriesFolderLock(worker, file, lp, attach),
                ).resolves.toEqual({
                    kind: 'uncertain',
                    retryable: true,
                    reason: 'series folder lock is contended',
                    contention: true,
                });
                expect(attach).not.toHaveBeenCalled();
                expect(
                    await processVideoFile(
                        worker,
                        file,
                        lp,
                        [],
                        { sql: worker, logger } as never,
                        undefined,
                        undefined,
                        undefined,
                        false,
                        undefined,
                        undefined,
                        undefined,
                        onError,
                    ),
                ).toBe('skipped');
                expect(onError).not.toHaveBeenCalled();
                expect(await itemOf(file)).toBeUndefined();
                expect(await listScanIssues(sql)).toContainEqual(
                    expect.objectContaining({
                        file_path: file,
                        issues: [
                            expect.objectContaining({
                                type: 'series_folder_contention',
                                attempt_count: 1,
                            }),
                        ],
                    }),
                );
            });
            // The rejected tail is removed; the next call can acquire and link.
            await scan(pathId);
            expect(await itemOf(file)).toBeDefined();
            expect(await listScanIssues(sql)).toEqual([]);
        } finally {
            await blocker.end();
            await worker.end();
        }
    }, 120_000);

    it('maps a hierarchy lock timeout with no folder owner to a retryable scan skip', async () => {
        const pathId = await library('tv');
        const [lp] = await sql<LibraryPathRow[]>`SELECT * FROM library_paths WHERE id = ${pathId}`;
        const file = await writeVideo(
            join(root, 'tv', 'Quillon Harbour (2031)', 'S01E01.mkv'),
            'callback-timeout',
        );
        const blocker = postgres(getTestDatabaseUrl(), { max: 1 });
        const worker = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { lock_timeout: 50 },
        });
        const onError = vi.fn();
        const ownerCheck = vi.spyOn(folderOwner, 'withVerifiedSeriesFolderOwner');
        try {
            await blocker.begin(async (tx) => {
                const lockKey = 'series:quillon harbour:tv';
                await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
                expect(
                    await processVideoFile(
                        worker,
                        file,
                        lp,
                        [],
                        { sql: worker, logger } as never,
                        undefined,
                        undefined,
                        undefined,
                        false,
                        undefined,
                        undefined,
                        undefined,
                        onError,
                    ),
                ).toBe('skipped');
                expect(ownerCheck).toHaveBeenCalledOnce();
                await expect(ownerCheck.mock.results[0].value).resolves.toEqual({ kind: 'none' });
                expect(onError).not.toHaveBeenCalled();
                expect(await itemOf(file)).toBeUndefined();
                expect(await sql`SELECT id FROM media_items`).toHaveLength(0);
                expect(await listScanIssues(sql)).toContainEqual(
                    expect.objectContaining({
                        file_path: file,
                        issues: [expect.objectContaining({ type: 'series_folder_contention' })],
                    }),
                );
            });
            await scan(pathId);
            expect(await itemOf(file)).toBeDefined();
            expect(await listScanIssues(sql)).toEqual([]);
        } finally {
            ownerCheck.mockRestore();
            await blocker.end();
            await worker.end();
        }
    }, 120_000);

    it('checks range candidates only in the requested season and episode span before locking', async () => {
        const pathId = await library('tv');
        const [lp] = await sql<LibraryPathRow[]>`SELECT * FROM library_paths WHERE id = ${pathId}`;
        const folder = join(root, 'tv', 'Quillon Harbour (2031)');
        const inRange = await writeVideo(join(folder, 'Season 01', 'S01E01.mkv'), 'range-1');
        const outsideRange = await writeVideo(join(folder, 'Season 01', 'S01E09.mkv'), 'range-9');
        const otherSeason = await writeVideo(join(folder, 'Season 02', 'S02E01.mkv'), 'range-s2');
        await scan(pathId);
        const firstEpisode = (await itemOf(inRange))!;
        const secondSeasonEpisode = (await itemOf(otherSeason))!;
        const series = await seriesOf(firstEpisode.id);
        // Parent seasons are authoritative. Episode-level season_number can
        // be absent or stale and must neither hide nor admit a candidate.
        await sql`UPDATE media_items SET season_number = NULL WHERE id = ${firstEpisode.id}`;
        await sql`UPDATE media_items SET season_number = 1 WHERE id = ${secondSeasonEpisode.id}`;
        expect(await listSeriesFilePaths(sql, series.id, { season: 1, start: 1, end: 2 })).toEqual([
            inRange,
        ]);
        const file = await writeVideo(join(folder, 'Season 01', 'S01E01-E02.mkv'), 'range-new');
        const presence = vi.spyOn(filePresence, 'assessFilePresence');
        const lock = vi.spyOn(folderOwner, 'withSeriesFolderLock');
        try {
            expect(await processVideoFile(sql, file, lp, [], { sql, logger } as never)).toBe(
                'added',
            );
            expect(lock).toHaveBeenCalledOnce();
            const beforeLock = presence.mock.calls
                .filter(
                    (_, i) =>
                        presence.mock.invocationCallOrder[i] < lock.mock.invocationCallOrder[0],
                )
                .map(([candidate]) => candidate);
            expect(beforeLock).toContain(inRange);
            expect(beforeLock).not.toContain(outsideRange);
            expect(beforeLock).not.toContain(otherSeason);
            const links = await sql<{ episode_number: number }[]>`
                SELECT ep.episode_number FROM media_files mf
                JOIN media_file_items link ON link.file_id = mf.id
                JOIN media_items ep ON ep.id = link.media_item_id
                WHERE mf.file_path = ${file}
            `;
            expect(links).toEqual([{ episode_number: 2 }]);
        } finally {
            presence.mockRestore();
            lock.mockRestore();
        }
    }, 120_000);

    it('keeps transient-contention cooldowns separate from real identity conflicts', async () => {
        const pathId = await library('tv');
        const file = await writeVideo(
            join(root, 'tv', 'Quillon Harbour (2031)', 'S01E01.mkv'),
            'cooldown',
        );
        for (const type of ['series_folder_contention', 'series_identity_conflict'] as const) {
            for (let pass = 0; pass < 3; pass++)
                await scannerShared.recordScanIssueWithCooldown(sql, file, groupId, type, type);
        }
        const [recorded] = await listScanIssues(sql);
        expect(recorded.issues).toEqual([
            expect.objectContaining({ type: 'series_folder_contention', attempt_count: 3 }),
            expect.objectContaining({ type: 'series_identity_conflict', attempt_count: 3 }),
        ]);
        for (const type of ['series_folder_contention', 'series_identity_conflict'] as const)
            await scannerShared.recordScanIssueWithCooldown(sql, file, groupId, type, type);
        expect(await listScanIssues(sql)).toEqual([recorded]);
        await scan(pathId);
        expect(await itemOf(file)).toBeDefined();
        expect(await listScanIssues(sql)).toEqual([]);
    }, 120_000);

    it.each(['imdbid-tt99001001', 'tmdbid-99001001'])(
        'sequential unmatched siblings reuse their personal owner without promoting %s',
        async (tag) => {
            const pathId = await library('tv');
            const [lp] = await sql<
                LibraryPathRow[]
            >`SELECT * FROM library_paths WHERE id = ${pathId}`;
            const folder = join(root, 'tv', `Quillon Harbour (2031) [${tag}]`, 'Season 01');
            const first = await writeVideo(join(folder, 'Quillon Harbour - S01E01.mkv'), 'tag-1');
            const second = await writeVideo(join(folder, 'Quillon Harbour - S01E02.mkv'), 'tag-2');
            // A sequential call forces the second episode through ownership
            // validation; concurrent calls on main could both observe no owner.
            for (const file of [first, second])
                expect(await processVideoFile(sql, file, lp, [], { sql, logger } as never)).toBe(
                    'added',
                );
            const series = await seriesOf((await itemOf(first))!.id);
            expect((await seriesOf((await itemOf(second))!.id)).id).toBe(series.id);
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${series.id}`).toEqual([]);
            expect(await listScanIssues(sql)).toEqual([]);
        },
        120_000,
    );

    it.each([false, true])(
        'validates an identified folder owner against its TMDB folder tag (matching: %s)',
        async (matching) => {
            const pathId = await library('tv');
            const [lp] = await sql<
                LibraryPathRow[]
            >`SELECT * FROM library_paths WHERE id = ${pathId}`;
            const folder = join(
                root,
                'tv',
                'Quillon Harbour (2031) [tmdbid-99001001]',
                'Season 01',
            );
            const witness = await writeVideo(
                join(folder, 'Quillon Harbour - S01E01.mkv'),
                'identified-1',
            );
            expect(await processVideoFile(sql, witness, lp, [], { sql, logger } as never)).toBe(
                'added',
            );
            const series = await seriesOf((await itemOf(witness))!.id);
            await insertTestExternalIds(sql, [
                {
                    media_id: series.id,
                    provider: 'tmdb',
                    external_id: matching ? '99001001' : '99001002',
                    media_type: 'tv',
                    is_primary: true,
                },
                {
                    media_id: series.id,
                    provider: 'imdb',
                    external_id: 'tt99001001',
                    media_type: 'tv',
                    is_primary: false,
                },
            ]);
            const incoming = await writeVideo(
                join(folder, 'Quillon Harbour - S01E02.mkv'),
                'identified-2',
            );
            // A TMDB tag with no provider configured reaches the real ownership
            // fence even on a match (IMDb has an earlier DB shortcut).
            const verify = vi.spyOn(folderOwner, 'withVerifiedSeriesFolderOwner');
            try {
                expect(
                    await processVideoFile(sql, incoming, lp, [], { sql, logger } as never),
                ).toBe(matching ? 'added' : 'skipped');
                expect(verify).toHaveBeenCalledOnce();
                if (matching) {
                    await expect(verify.mock.results[0].value).resolves.toMatchObject({
                        kind: 'reused',
                        value: { seriesId: series.id },
                    });
                    expect((await seriesOf((await itemOf(incoming))!.id)).id).toBe(series.id);
                    expect(await listScanIssues(sql)).toEqual([]);
                } else {
                    await expect(verify.mock.results[0].value).resolves.toMatchObject({
                        kind: 'uncertain',
                        retryable: false,
                        reason: 'folder owner conflicts with explicit provider identity',
                    });
                    expect(await itemOf(incoming)).toBeUndefined();
                    expect(await listScanIssues(sql)).toContainEqual(
                        expect.objectContaining({
                            file_path: incoming,
                            issues: [
                                expect.objectContaining({
                                    type: 'series_identity_conflict',
                                    detail: expect.stringContaining(
                                        'folder owner conflicts with explicit provider identity',
                                    ),
                                }),
                            ],
                        }),
                    );
                }
            } finally {
                verify.mockRestore();
            }
        },
        120_000,
    );

    it('keeps a folder/NFO year disagreement out of run errors and cools down its visible issue', async () => {
        const pathId = await library('tv');
        const folder = join(root, 'tv', 'Quillon Harbour (2019)');
        const file = await writeVideo(join(folder, 'Quillon Harbour - S01E01.mkv'), 'year');
        await writeFile(
            file.replace(/\.mkv$/, '.nfo'),
            '<tvshow><title>Quillon Harbour</title><year>2018</year></tvshow>',
        );
        for (let pass = 0; pass < 3; pass++) await scan(pathId);
        expect(await itemOf(file)).toBeUndefined();
        const issues = await listScanIssues(sql);
        expect(issues).toContainEqual(
            expect.objectContaining({
                file_path: file,
                issues: [
                    expect.objectContaining({
                        type: 'series_identity_conflict',
                        attempt_count: 3,
                        detail: expect.stringContaining('2019'),
                        next_retry_at: expect.any(String),
                    }),
                ],
            }),
        );
        await scan(pathId);
        expect(await listScanIssues(sql)).toEqual(issues);
        await writeFile(
            file.replace(/\.mkv$/, '.nfo'),
            '<tvshow><title>Quillon Harbour</title><year>2019</year></tvshow>',
        );
        await scan(pathId);
        expect(await itemOf(file)).toBeDefined();
        expect(await listScanIssues(sql)).toEqual([]);
    }, 120_000);

    it('creates missing episodes under the sole folder owner even when its catalog title differs', async () => {
        const pathId = await library('tv');
        const seriesDir = join(root, 'tv', 'Quillon Harbour (2031)');
        const first = await writeVideo(
            join(seriesDir, 'Season 01', 'Quillon Harbour - S01E01.mkv'),
            'known',
        );
        await scan(pathId);
        const episode = (await itemOf(first))!;
        const series = await seriesOf(episode.id);
        await sql`UPDATE media_items SET title = 'Quillon Harbour Catalog Title' WHERE id = ${series.id}`;
        await insertTestExternalIds(sql, [
            {
                media_id: series.id,
                provider: 'tmdb',
                external_id: '99001001',
                media_type: 'tv',
                is_primary: true,
            },
            {
                media_id: episode.id,
                provider: 'tmdb',
                external_id: '99001002',
                media_type: 'episode',
                is_primary: true,
            },
        ]);
        for (const [name, season, episodeNumber] of [
            ['Season 00/Quillon Harbour - S00E02 - Behind the Fog.mkv', 0, 2],
            ['Season 01/Quillon Harbour - S01E06 - Night Bells.mkv', 1, 6],
            ['Season 02/Quillon Harbour - 08.mkv', 2, 8],
        ] as const) {
            const file = await writeVideo(join(seriesDir, name), name);
            await scan(pathId);
            const linked = (await itemOf(file))!;
            expect(linked).toBeDefined();
            expect((await seriesOf(linked.id)).id).toBe(series.id);
            const [numbers] = await sql<{ season_number: number; episode_number: number }[]>`
                SELECT season_number, episode_number FROM media_items WHERE id = ${linked.id}
            `;
            expect(numbers).toEqual({ season_number: season, episode_number: episodeNumber });
        }
        expect(await listScanIssues(sql)).toEqual([]);
    }, 120_000);

    it('surfaces mixed folder ownership in the admin scan issues and heals after resolution', async () => {
        const pathId = await library('tv');
        const season = join(root, 'tv', 'Quillon Harbour (2031)', 'Season 01');
        const witness = await writeVideo(join(season, 'Quillon Harbour - S01E01.mkv'), 'owner');
        const alien = await writeVideo(
            join(root, 'tv', 'Cinder Estuary (2031)', 'Season 01', 'Cinder Estuary - S01E02.mkv'),
            'alien',
        );
        await scan(pathId);
        const series = await seriesOf((await itemOf(witness))!.id);
        const mixed = join(season, 'Cinder Estuary - S01E02.mkv');
        await mkdir(dirname(mixed), { recursive: true });
        await writeFile(mixed, await readFile(alien));
        await rm(alien);
        await sql`UPDATE media_files SET file_path = ${mixed} WHERE file_path = ${alien}`;
        const incoming = await writeVideo(
            join(season, 'Quillon Harbour - S01E06 - Night Bells.mkv'),
            'new',
        );
        await scan(pathId);
        expect(await itemOf(incoming)).toBeUndefined();
        expect(await listScanIssues(sql)).toContainEqual(
            expect.objectContaining({
                file_path: incoming,
                library_group_id: groupId,
                issues: expect.arrayContaining([
                    expect.objectContaining({
                        type: 'series_identity_conflict',
                        detail: expect.stringContaining('folder'),
                    }),
                ]),
            }),
        );
        await rm(mixed);
        await deleteStaleMediaFile(sql, mixed);
        await scan(pathId);
        expect((await seriesOf((await itemOf(incoming))!.id)).id).toBe(series.id);
        expect(await listScanIssues(sql)).toEqual([]);
        const [file] = await sql<
            { health_issues: unknown }[]
        >`SELECT health_issues FROM media_files WHERE file_path = ${incoming}`;
        expect(file.health_issues ?? []).toEqual([]);
    }, 120_000);
});
