// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import {
    appendFile,
    copyFile,
    mkdir,
    mkdtemp,
    rm,
    rename,
    writeFile,
    stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTx } from '$lib/server/database/with-tx.js';
import { findOrCreatePersonalEpisode } from '$lib/server/database/queries/media-items.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parseMediaFilename } from '$lib/server/utils/filename-parser.js';
import { getTestDb, getTestDatabaseUrl } from './setup/test-database.js';
import {
    createLibraryPath,
    type LibraryPathRow,
} from '$lib/server/database/queries/library-paths.queries.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '$lib/server/database/queries/media-files.queries.js';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import {
    processVideoFile,
    findOrCreateSeriesHierarchy,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/video-processor.js';
import { ensureTestUser } from './fixtures/user.fixtures.js';
import { withVerifiedSeriesFolderOwner } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/series-folder-owner.js';
import { matchFileToMetadata } from '$lib/server/services/metadata-matching.service.js';

// Keep the scanner, ffprobe, catalog, filesystem and PostgreSQL real. Only
// provider network and asynchronous lifecycle enqueueing cross this boundary.
vi.mock('$lib/server/tasks/plugin-context.js', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => true),
}));
vi.mock('$lib/server/providers/implementations/tmdb/resolve-external.js', () => ({
    tmdbResolveExternalId: vi.fn(async () => null),
}));
vi.mock('$lib/server/services/metadata-matching.service.js', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async () => ({ matched: false })),
}));
vi.mock('$lib/server/services/media-lifecycle.service.js', async (original) => {
    const actual = await original<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: vi.fn(async () => undefined),
            afterReclaimed: vi.fn(async () => undefined),
        }),
    };
});

interface Fixture {
    library: LibraryPathRow;
    folder: string;
    seriesId: string;
    seasonId: string;
    episodes: string[];
    files: string[];
}

describe('new episodes keep the established exact-folder series owner', () => {
    let sql: postgres.Sql;
    let root: string;
    const groups: string[] = [];
    const rootIds: string[] = [];
    const userId = randomUUID();
    let nextTmdb = 9400000;
    const logger = Logger.for('SeriesFolderRecurrenceTest');

    beforeAll(async () => {
        sql = getTestDb();
        await ensureTestUser(sql, userId);
        root = await mkdtemp(join(tmpdir(), 'series-folder-recurrence-'));
    });
    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ANY(${rootIds}::uuid[])`;
        for (const id of groups) {
            await sql`DELETE FROM media_items WHERE library_group_id = ${id}::uuid`;
            await sql`DELETE FROM media_files WHERE library_group_id = ${id}::uuid`;
            await sql`DELETE FROM library_paths WHERE library_group_id = ${id}::uuid`;
            await sql`DELETE FROM library_groups WHERE id = ${id}::uuid`;
        }
        await sql`DELETE FROM users WHERE id = ${userId}`;
        if (root) await rm(root, { recursive: true, force: true });
    });

    async function video(folder: string, episode: number): Promise<string> {
        await mkdir(folder, { recursive: true });
        const file = join(folder, `Lantern Courier S01E${String(episode).padStart(2, '0')}.mp4`);
        await copyFile('tests/fixtures/test-video.mp4', file);
        // Distinct bytes: hash reclaim/version matching cannot explain a pass.
        await appendFile(file, `\nfixture-${episode}-${randomUUID()}`);
        return file;
    }

    async function fixture(): Promise<Fixture> {
        const groupId = randomUUID();
        groups.push(groupId);
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}, ${groupId})`;
        const library = await createLibraryPath(sql, {
            path: join(root, groupId),
            media_type: 'tv',
            library_group_id: groupId,
        });
        const folder = join(library.path, 'Lantern Courier', 'Season01');
        const [series] = await sql<{ id: string }[]>`INSERT INTO media_items
            (title, media_type, year, library_group_id) VALUES
            ('Lantern Courier: Across the Pale Sea', 'tv', 2026, ${groupId}) RETURNING id`;
        rootIds.push(series.id);
        await createCatalogService(sql).upsertExternalId(series.id, {
            provider: 'tmdb',
            id: String(nextTmdb++),
            mediaType: 'tv',
            source: 'test',
        });
        const [season] = await sql<{ id: string }[]>`INSERT INTO media_items
            (title, media_type, parent_id, season_number, library_group_id) VALUES
            ('Season 1', 'season', ${series.id}, 1, ${groupId}) RETURNING id`;
        const episodes: string[] = [],
            files: string[] = [];
        for (let n = 1; n <= 3; n++) {
            const [episode] = await sql<{ id: string }[]>`INSERT INTO media_items
                (title, media_type, parent_id, season_number, episode_number, library_group_id) VALUES
                (${`Repaired episode ${n}`}, 'episode', ${season.id}, 1, ${n}, ${groupId}) RETURNING id`;
            const filePath = await video(folder, n);
            const file = await upsertMediaFile(sql, { filePath, libraryGroupId: groupId });
            await attachFileToItem(sql, file.id, episode.id);
            episodes.push(episode.id);
            files.push(file.id);
        }
        return { library, folder, seriesId: series.id, seasonId: season.id, episodes, files };
    }

    async function scan(f: Fixture, file: string, connection = sql): Promise<string> {
        return processVideoFile(connection, file, f.library, ['tmdb-metadata-provider'], {
            sql: connection,
            logger,
        });
    }
    async function owner(file: string): Promise<string[]> {
        const rows = await sql<{ id: string }[]>`SELECT series.id FROM media_files mf
            JOIN media_file_items link ON link.file_id = mf.id
            JOIN media_items ep ON ep.id = link.media_item_id
            JOIN media_items season ON season.id = ep.parent_id
            JOIN media_items series ON series.id = season.parent_id
            WHERE mf.file_path = ${file}`;
        return rows.map((r) => r.id);
    }

    it('real scanner clean provider miss puts distinct E4 under the repaired long-title series', async () => {
        const f = await fixture();
        await sql`UPDATE media_file_items SET offset_source = 'manual', start_offset_ms = 0,
            end_offset_ms = 1000 WHERE file_id = ${f.files[0]}`;
        const alternative = await video(f.folder, 90);
        const alternateFile = await upsertMediaFile(sql, {
            filePath: alternative,
            libraryGroupId: f.library.library_group_id,
        });
        await attachFileToItem(sql, alternateFile.id, f.episodes[0]);
        f.files.push(alternateFile.id);
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms)
            VALUES (${userId}, ${f.episodes[0]}, true, 4321)`;
        const watch = await sql`SELECT * FROM user_media_state WHERE user_id = ${userId}`;
        const before =
            await sql`SELECT * FROM media_file_items WHERE file_id = ANY(${f.files}::uuid[]) ORDER BY file_id`;
        const identities =
            await sql`SELECT * FROM external_ids WHERE media_id = ${f.seriesId} ORDER BY id`;
        const e4 = await video(f.folder, 4);
        vi.mocked(matchFileToMetadata).mockClear();
        expect(await scan(f, e4)).toBe('added');
        expect(matchFileToMetadata).toHaveBeenCalled();
        expect(await owner(e4)).toEqual([f.seriesId]);
        expect(await scan(f, e4)).toBe('skipped');
        expect(
            await sql`SELECT * FROM media_file_items WHERE file_id = ANY(${f.files}::uuid[]) ORDER BY file_id`,
        ).toEqual(before);
        expect(
            await sql`SELECT * FROM external_ids WHERE media_id = ${f.seriesId} ORDER BY id`,
        ).toEqual(identities);
        expect(await sql`SELECT * FROM user_media_state WHERE user_id = ${userId}`).toEqual(watch);
        expect(
            await sql`SELECT id FROM media_items WHERE media_type = 'tv' AND library_group_id = ${f.library.library_group_id}`,
        ).toHaveLength(1);
    });

    it('simultaneous E4/E5/E6 scans on independent connections remain idempotent, with contended files retried', async () => {
        const f = await fixture();
        const paths = await Promise.all([4, 5, 6].map((n) => video(f.folder, n)));
        const clients = paths.map(() => postgres(getTestDatabaseUrl(), { max: 1 }));
        try {
            const results = await Promise.all(paths.map((p, i) => scan(f, p, clients[i])));
            expect(results.every((r) => r === 'added' || r === 'skipped')).toBe(true);
            // NOWAIT deliberately abstains under contention. The next scan is
            // the normal retry, and must reuse the same owner and episode IDs.
            for (const p of paths) {
                await scan(f, p);
                expect(await owner(p)).toEqual([f.seriesId]);
            }
            const before =
                await sql`SELECT ep.id FROM media_items ep WHERE ep.parent_id = ${f.seasonId} ORDER BY ep.id`;
            for (const p of paths) await scan(f, p);
            expect(
                await sql`SELECT ep.id FROM media_items ep WHERE ep.parent_id = ${f.seasonId} ORDER BY ep.id`,
            ).toEqual(before);
            expect(before).toHaveLength(6);
            expect(
                await sql`SELECT id FROM media_items WHERE media_type = 'tv' AND library_group_id = ${f.library.library_group_id}`,
            ).toHaveLength(1);
        } finally {
            await Promise.all(clients.map((c) => c.end()));
        }
    });

    it.each([
        'missing',
        'transient',
        'is_missing',
        'dismissed',
        'deleted',
        'bad-ancestry',
        'cross-library',
        'wrong-series-library',
        'year',
    ] as const)(
        'abstains on %s ownership evidence instead of creating a short-title owner',
        async (kind) => {
            const f = await fixture();
            if (kind === 'missing') await rm(join(f.folder, 'Lantern Courier S01E01.mp4'));
            if (kind === 'transient') {
                await rename(f.library.path, f.library.path + '-offline');
                const result = await withVerifiedSeriesFolderOwner(
                    sql,
                    join(f.folder, 'E4.mp4'),
                    f.library,
                    {},
                    async () => 'wrong',
                );
                expect(result.kind).toBe('uncertain');
                await rename(f.library.path + '-offline', f.library.path);
                return;
            }
            if (kind === 'is_missing')
                await sql`UPDATE media_files SET is_missing = true WHERE id = ${f.files[0]}`;
            if (kind === 'dismissed')
                await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${f.episodes[0]}`;
            if (kind === 'deleted')
                await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${f.episodes[0]}`;
            if (kind === 'bad-ancestry')
                await sql`UPDATE media_items SET parent_id = ${f.seriesId} WHERE id = ${f.episodes[0]}`;
            if (kind === 'cross-library') {
                const other = await fixture();
                await sql`UPDATE media_files SET library_group_id = ${other.library.library_group_id} WHERE id = ${f.files[0]}`;
            }
            if (kind === 'wrong-series-library')
                await sql`UPDATE media_items SET library_group_id = NULL WHERE id = ${f.seriesId}`;
            if (kind === 'year')
                await sql`UPDATE media_items SET year = 2001 WHERE id = ${f.seriesId}`;
            let e4 = await video(f.folder, 4);
            if (kind === 'year') {
                const named = e4.replace('S01E04', '(2026) S01E04');
                await rename(e4, named);
                e4 = named;
            }
            expect(await scan(f, e4)).toBe('skipped');
            expect(await owner(e4)).toEqual([]);
            expect(
                await sql`SELECT id FROM media_items WHERE media_type = 'tv' AND library_group_id = ${f.library.library_group_id}`,
            ).toHaveLength(kind === 'wrong-series-library' ? 0 : 1);
        },
    );

    it.each(['shared-file', 'different-sibling', 'nested-show'] as const)(
        'counts %s conflict before accepting one owner',
        async (kind) => {
            const f = await fixture(),
                other = await fixture();
            await sql`UPDATE media_items SET library_group_id = ${f.library.library_group_id}
            WHERE id = ANY(${[other.seriesId, other.seasonId, ...other.episodes]}::uuid[])`;
            if (kind === 'shared-file') await attachFileToItem(sql, f.files[0], other.episodes[0]);
            else {
                const p = await video(
                    kind === 'nested-show'
                        ? join(f.folder, 'Different Show', 'Season01')
                        : f.folder,
                    80,
                );
                const file = await upsertMediaFile(sql, {
                    filePath: p,
                    libraryGroupId: f.library.library_group_id,
                });
                await attachFileToItem(sql, file.id, other.episodes[0]);
            }
            const e4 = await video(f.folder, 4);
            expect(await scan(f, e4)).toBe('skipped');
            expect(await owner(e4)).toEqual([]);
        },
    );

    it('literal wildcard/same-prefix neighbours never become owners, and flat library roots establish none', async () => {
        const f = await fixture();
        const newFolder = join(f.library.path, 'Lantern Courier_%', 'Season01');
        const e4 = await video(newFolder, 4);
        expect(
            await withVerifiedSeriesFolderOwner(sql, e4, f.library, {}, async () => 'wrong'),
        ).toEqual({ kind: 'none' });
        const prefix = join(f.library.path, 'Lantern Courier-Backup', 'Season01');
        const backup = await video(prefix, 4);
        expect(
            await withVerifiedSeriesFolderOwner(sql, backup, f.library, {}, async () => 'wrong'),
        ).toEqual({ kind: 'none' });
        const flat = await video(f.library.path, 4);
        expect(
            await withVerifiedSeriesFolderOwner(sql, flat, f.library, {}, async () => 'wrong'),
        ).toEqual({ kind: 'none' });
    });

    it.each(['imdb', 'tmdb'] as const)(
        'series NFO %s conflict abstains; episode-scoped IDs do not identify a series',
        async (provider) => {
            const f = await fixture(),
                e4 = await video(f.folder, 4);
            const nfoPath = e4.replace(/\.mp4$/, '.nfo');
            const id = provider === 'imdb' ? 'tt9999999' : '9999999';
            await writeFile(
                nfoPath,
                `<tvshow><uniqueid type="${provider}">${id}</uniqueid></tvshow>`,
            );
            expect(await scan(f, e4)).toBe('skipped');
            expect(await owner(e4)).toEqual([]);
            await writeFile(
                nfoPath,
                `<episodedetails><uniqueid type="${provider}">${id}</uniqueid></episodedetails>`,
            );
            expect(await scan(f, e4)).toBe('added');
            expect(await owner(e4)).toEqual([f.seriesId]);
        },
    );

    it('keeps trusted provider matches ahead of folder ownership', async () => {
        const f = await fixture(),
            other = await fixture(),
            e4 = await video(f.folder, 4);
        const [id] = await sql<
            { external_id: string }[]
        >`SELECT external_id FROM external_ids WHERE media_id = ${other.seriesId} AND provider = 'tmdb' AND media_type = 'tv'`;
        vi.mocked(matchFileToMetadata).mockResolvedValueOnce({
            matched: true,
            parsed: parseMediaFilename(e4),
            candidate: {
                provider: 'tmdb',
                externalId: id.external_id,
                mediaType: 'tv',
                title: 'Lantern Courier: Across the Pale Sea',
                year: 2026,
                confidence: 1,
            },
        });
        expect(await scan(f, e4)).toBe('added');
        expect(await owner(e4)).toEqual([other.seriesId]);
    });

    it.each(['file', 'ancestor', 'item-advisory', 'provider'] as const)(
        'abstains while a %s witness lock is held, then safely retries',
        async (kind) => {
            const f = await fixture(),
                e4 = await video(f.folder, 4);
            const client = postgres(getTestDatabaseUrl(), { max: 1 });
            try {
                await client.begin(async (tx) => {
                    if (kind === 'file')
                        await tx`SELECT id FROM media_files WHERE id = ${f.files[0]} FOR UPDATE`;
                    if (kind === 'ancestor')
                        await tx`SELECT id FROM media_items WHERE id = ${f.seriesId} FOR UPDATE`;
                    if (kind === 'item-advisory')
                        await tx`SELECT pg_advisory_xact_lock(hashtext(${f.episodes[0]}))`;
                    if (kind === 'provider')
                        await tx`SELECT external_id FROM external_ids WHERE media_id = ${f.seriesId} FOR UPDATE`;
                    expect(await scan(f, e4)).toBe('skipped');
                    expect(await owner(e4)).toEqual([]);
                });
                expect(await scan(f, e4)).toBe('added');
                expect(await owner(e4)).toEqual([f.seriesId]);
            } finally {
                await client.end();
            }
        },
    );

    it('keeps file and ancestor witnesses fenced through the attachment callback', async () => {
        const f = await fixture(),
            e4 = await video(f.folder, 4);
        const editor = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            const result = await withVerifiedSeriesFolderOwner(sql, e4, f.library, {}, async () => {
                for (const kind of ['file', 'ancestor', 'provider']) {
                    await expect(
                        editor.begin(async (tx) => {
                            await tx`SET LOCAL lock_timeout = '100ms'`;
                            if (kind === 'file')
                                await tx`UPDATE media_files SET is_missing = true WHERE id = ${f.files[0]}`;
                            else if (kind === 'provider')
                                await tx`DELETE FROM external_ids WHERE media_id = ${f.seriesId}`;
                            else
                                await tx`UPDATE media_items SET is_dismissed = true WHERE id = ${f.seriesId}`;
                        }),
                    ).rejects.toMatchObject({ code: '55P03' });
                }
                return 'attached';
            });
            expect(result).toEqual({ kind: 'reused', value: 'attached' });
        } finally {
            await editor.end();
        }
    });

    it('rolls back its own attachment when a rival new-owner file commits during the attachment decision', async () => {
        const f = await fixture(),
            other = await fixture();
        await sql`UPDATE media_items SET library_group_id = ${f.library.library_group_id}
            WHERE id = ANY(${[other.seriesId, other.seasonId, ...other.episodes]}::uuid[])`;
        const e4 = await video(f.folder, 4),
            rivalPath = await video(f.folder, 80);
        const rival = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            const result = await withVerifiedSeriesFolderOwner(
                sql,
                e4,
                f.library,
                {},
                async (tx, seriesId) => {
                    // Fresh ownership has been read and all EXISTING witnesses are
                    // locked. This distinct new file/owner is a deterministic phantom.
                    const file = await upsertMediaFile(rival, {
                        filePath: rivalPath,
                        libraryGroupId: f.library.library_group_id,
                    });
                    await attachFileToItem(rival, file.id, other.episodes[0]);
                    return findOrCreateSeriesHierarchy(
                        tx,
                        e4,
                        parseMediaFilename(e4),
                        { sql: tx, logger },
                        {
                            resolvedSeriesId: seriesId,
                            libraryRoot: f.library.path,
                            libraryGroupId: f.library.library_group_id,
                        },
                    );
                },
            );
            expect(result.kind).toBe('uncertain');
            expect(await owner(e4)).toEqual([]);
            expect(await sql`SELECT id FROM media_files WHERE file_path = ${e4}`).toHaveLength(0);
            expect(
                await sql`SELECT id FROM media_items WHERE parent_id = ${f.seasonId} AND episode_number = 4`,
            ).toHaveLength(0);
            expect(await owner(rivalPath)).toEqual([other.seriesId]);
        } finally {
            await rival.end();
        }
    });

    it('abstains on a busy pre-existing E4 target instead of waiting into a lock cycle or creating a fallback series', async () => {
        const f = await fixture(),
            e4 = await video(f.folder, 4);
        const episode = await findOrCreatePersonalEpisode(sql, {
            seasonId: f.seasonId,
            seasonNumber: 1,
            episodeNumber: 4,
            title: 'Canonical E4',
        });
        const editor = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            await editor.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtext(${episode.id}))`;
                expect(await scan(f, e4)).toBe('skipped');
                expect(await owner(e4)).toEqual([]);
                expect(
                    await sql`SELECT id FROM media_items WHERE media_type = 'tv' AND library_group_id = ${f.library.library_group_id}`,
                ).toHaveLength(1);
                const [stub] = await sql<{ health_issues: { type: string }[] }[]>`
                    SELECT health_issues FROM media_files WHERE file_path = ${e4}
                `;
                expect(stub.health_issues).toEqual([
                    expect.objectContaining({ type: 'series_folder_contention' }),
                ]);
            });
            expect(await scan(f, e4)).toBe('updated');
            const [healed] = await sql<
                { health_issues: unknown }[]
            >`SELECT health_issues FROM media_files WHERE file_path = ${e4}`;
            expect(healed.health_issues ?? []).toEqual([]);
            expect(await owner(e4)).toEqual([f.seriesId]);
            expect(
                await sql`SELECT id FROM media_items WHERE parent_id = ${f.seasonId} AND episode_number = 4`,
            ).toEqual([{ id: episode.id }]);
        } finally {
            await editor.end();
        }
    });

    it('restores a caller transaction lock timeout after a successful ownership callback', async () => {
        const f = await fixture(),
            e4 = await video(f.folder, 4);
        await withTx(sql, async (tx) => {
            await tx`SET LOCAL lock_timeout = '2s'`;
            expect(
                await withVerifiedSeriesFolderOwner(tx, e4, f.library, {}, async () => 'done'),
            ).toEqual({ kind: 'reused', value: 'done' });
            const [setting] = await tx<{ lock_timeout: string }[]>`SHOW lock_timeout`;
            expect(setting.lock_timeout).toBe('2s');
        });
    });

    it.each(['automatic', 'manual', 'runtime-split'] as const)(
        'new dedicated E4 permits only legitimate %s range arbitration',
        async (kind) => {
            const f = await fixture();
            const episode = await findOrCreatePersonalEpisode(sql, {
                seasonId: f.seasonId,
                seasonNumber: 1,
                episodeNumber: 4,
                title: 'Canonical E4',
            });
            const temporary = await video(f.folder, 80);
            const rangePath = join(f.folder, 'Lantern Courier S01E03E04.mp4');
            await rename(temporary, rangePath);
            const range = await upsertMediaFile(sql, {
                filePath: rangePath,
                libraryGroupId: f.library.library_group_id,
            });
            await attachFileToItem(sql, range.id, f.episodes[2]);
            await attachFileToItem(sql, range.id, episode.id);
            if (kind !== 'automatic') {
                await sql`UPDATE media_file_items SET offset_source = ${kind}, start_offset_ms = 0,
                end_offset_ms = 500 WHERE file_id = ${range.id} AND media_item_id = ${f.episodes[2]}`;
                await sql`UPDATE media_file_items SET offset_source = ${kind}, start_offset_ms = 500,
                end_offset_ms = 1000 WHERE file_id = ${range.id} AND media_item_id = ${episode.id}`;
            }
            const before =
                await sql`SELECT * FROM media_file_items WHERE file_id = ${range.id} ORDER BY media_item_id`;
            const e4 = await video(f.folder, 4);
            expect(await scan(f, e4)).toBe('added');
            expect(await owner(e4)).toEqual([f.seriesId]);
            const after =
                await sql`SELECT * FROM media_file_items WHERE file_id = ${range.id} ORDER BY media_item_id`;
            expect(after).toEqual(
                kind === 'automatic'
                    ? before.filter((row) => row.media_item_id !== episode.id)
                    : before,
            );
            const [dedicated] = await sql<
                { is_default: boolean }[]
            >`SELECT link.is_default FROM media_file_items link
            JOIN media_files file ON file.id = link.file_id WHERE file.file_path = ${e4} AND link.media_item_id = ${episode.id}`;
            expect(dedicated.is_default).toBe(kind === 'automatic');
            expect(await scan(f, e4)).toBe('skipped');
            expect(
                await sql`SELECT * FROM media_file_items WHERE file_id = ${range.id} ORDER BY media_item_id`,
            ).toEqual(after);
            expect(
                await sql`SELECT id FROM media_items WHERE media_type = 'tv' AND library_group_id = ${f.library.library_group_id}`,
            ).toHaveLength(1);
        },
    );

    it('last automatic range eviction records a current proof within the verified owner transaction', async () => {
        const f = await fixture();
        const episode = await findOrCreatePersonalEpisode(sql, {
            seasonId: f.seasonId,
            seasonNumber: 1,
            episodeNumber: 4,
            title: 'Canonical E4',
        });
        const temporary = await video(f.folder, 80);
        const rangePath = join(f.folder, 'Lantern Courier S01E03E04.mp4');
        await rename(temporary, rangePath);
        const range = await upsertMediaFile(sql, {
            filePath: rangePath,
            libraryGroupId: f.library.library_group_id,
        });
        // E3 already has its dedicated file. Only the last automatic E4 link
        // remains, which the arriving E4 legitimately evicts inside ownership.
        await attachFileToItem(sql, range.id, episode.id);
        for (const id of [range.id, f.files[2]]) {
            const [file] = await sql<
                { file_path: string }[]
            >`SELECT file_path FROM media_files WHERE id = ${id}`;
            const physical = await stat(file.file_path);
            await sql`UPDATE media_files SET file_mtime = ${physical.mtime}, file_size_bytes = ${physical.size} WHERE id = ${id}`;
        }
        const e4 = await video(f.folder, 4);
        expect(await scan(f, e4)).toBe('added');
        expect(await owner(e4)).toEqual([f.seriesId]);
        expect(await sql`SELECT * FROM media_file_items WHERE file_id = ${range.id}`).toHaveLength(
            0,
        );
        const [stub] =
            await sql`SELECT health_issues, current_range_mapping_proof(id) AS current FROM media_files WHERE id = ${range.id}`;
        expect(stub.health_issues.map((issue: { type: string }) => issue.type)).toContain(
            'range_superseded',
        );
        expect(stub.current).toBe(true);
        expect(
            await sql`SELECT * FROM file_range_mapping_proofs WHERE file_id = ${range.id}`,
        ).toHaveLength(1);
    });

    it.each(['owner-year', 'filename-year', 'folder-year'] as const)(
        'series NFO %s contradiction abstains through the real scanner',
        async (kind) => {
            const f = await fixture();
            if (kind === 'folder-year') {
                const original = join(f.library.path, 'Lantern Courier');
                const explicit = original + ' (2026)';
                await rename(original, explicit);
                await sql`UPDATE media_files SET file_path = replace(file_path, ${original}, ${explicit})
                WHERE id = ANY(${f.files}::uuid[])`;
                f.folder = join(explicit, 'Season01');
            }
            let e4 = await video(f.folder, 4);
            if (kind === 'filename-year') {
                const explicit = e4.replace('S01E04', '(2026) S01E04');
                await rename(e4, explicit);
                e4 = explicit;
            }
            await writeFile(e4.replace(/\.mp4$/, '.nfo'), '<tvshow><year>2001</year></tvshow>');
            expect(await scan(f, e4)).toBe('skipped');
            expect(await owner(e4)).toEqual([]);
            expect(
                await sql`SELECT id FROM media_items WHERE parent_id = ${f.seasonId} AND episode_number = 4`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT id FROM media_items WHERE media_type = 'tv' AND library_group_id = ${f.library.library_group_id}`,
            ).toHaveLength(1);
        },
    );

    it.each(['unreported', 'manual', 'runtime-split'] as const)(
        'does not permit an %s witness removal through the callback delta',
        async (kind) => {
            const f = await fixture(),
                e4 = await video(f.folder, 4);
            if (kind !== 'unreported')
                await sql`UPDATE media_file_items SET offset_source = ${kind},
            start_offset_ms = 0, end_offset_ms = 1000 WHERE file_id = ${f.files[0]}`;
            const before = await sql`SELECT * FROM media_file_items WHERE file_id = ${f.files[0]}`;
            const result = await withVerifiedSeriesFolderOwner(
                sql,
                e4,
                f.library,
                {},
                async (tx, _seriesId, recordEvictions) => {
                    await tx`DELETE FROM media_file_items WHERE file_id = ${f.files[0]}`;
                    if (kind !== 'unreported')
                        recordEvictions(f.episodes[0], [
                            join(f.folder, 'Lantern Courier S01E01.mp4'),
                        ]);
                    return 'removed';
                },
            );
            expect(result.kind).toBe('uncertain');
            expect(await sql`SELECT * FROM media_file_items WHERE file_id = ${f.files[0]}`).toEqual(
                before,
            );
        },
    );
});
