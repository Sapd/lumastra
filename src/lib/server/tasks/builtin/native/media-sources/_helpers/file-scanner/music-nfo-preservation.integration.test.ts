// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, stat, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerInstance } from '../../../../../../utils/logger.js';
import type { FileScannerContext } from './shared.js';

vi.mock('../../../../../../utils/nfo-parser.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../../../../utils/nfo-parser.js')>();
    return {
        ...original,
        readAlbumNfo: vi.fn(original.readAlbumNfo),
        readArtistNfo: vi.fn(original.readArtistNfo),
    };
});
import { readAlbumNfo, readArtistNfo } from '../../../../../../utils/nfo-parser.js';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import {
    confirmArtistCredits,
    getArtistCreditReview,
} from '$lib/server/services/music/artist-credit-review.js';
import { processAudioFile } from './audio-processor.js';
import { writeMusicNfoBackfill } from '../../../../../../database/queries/music-nfo.queries.js';
vi.mock('../../../../../../database/queries/music-nfo.queries.js', async (importOriginal) => {
    const original =
        await importOriginal<
            typeof import('../../../../../../database/queries/music-nfo.queries.js')
        >();
    return { ...original, writeMusicNfoBackfill: vi.fn(original.writeMusicNfoBackfill) };
});
import { backfillMusicNfo } from './music-nfo-backfill.js';
import { writeId3Mp3, textFrameBody, ID3_UTF8 } from './id3-mp3-fixture.test-helpers.js';

interface Owners {
    file_id: string;
    track_id: string;
    album_id: string;
    artist_id: string;
}

describe('music NFO preservation (real PostgreSQL and scanner callers)', () => {
    let sql: postgres.Sql;
    let editor: postgres.Sql;
    let root: string;
    let albumDir: string;
    let artistDir: string;
    let filePath: string;
    let lp: LibraryPathRow;
    let owners: Owners;
    const logger = new LoggerInstance('MusicNfoPreservationTest');
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const context = (signal?: AbortSignal): FileScannerContext => ({
        sql,
        logger,
        abortSignal: signal,
    });
    const original = () =>
        vi.importActual<typeof import('../../../../../../utils/nfo-parser.js')>(
            '../../../../../../utils/nfo-parser.js',
        );

    beforeAll(() => {
        sql = getTestDb();
        // Dedicated independent connection: edits really commit while scanner I/O is paused.
        editor = postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    });
    afterAll(async () => {
        await editor.end();
    });
    beforeEach(async () => {
        const real = await original();
        const queries = await vi.importActual<
            typeof import('../../../../../../database/queries/music-nfo.queries.js')
        >('../../../../../../database/queries/music-nfo.queries.js');
        vi.mocked(writeMusicNfoBackfill)
            .mockReset()
            .mockImplementation(queries.writeMusicNfoBackfill);
        vi.mocked(readAlbumNfo).mockReset().mockImplementation(real.readAlbumNfo);
        vi.mocked(readArtistNfo).mockReset().mockImplementation(real.readArtistNfo);
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'nfo-preservation-'));
        artistDir = join(root, 'Source Artist');
        albumDir = join(artistDir, 'Source Album');
        filePath = join(albumDir, '01 Song.mp3');
        await mkdir(albumDir, { recursive: true });
        const [group] = await sql<
            { id: string }[]
        >`INSERT INTO library_groups (name) VALUES (${randomUUID()}) RETURNING id`;
        [lp] = await sql<
            LibraryPathRow[]
        >`INSERT INTO library_paths (path, media_type, library_group_id, enabled) VALUES (${root}, 'music', ${group.id}, true) RETURNING *`;
        await writeId3Mp3(filePath, 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Song']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Source Album']) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Source Artist']) },
            { id: 'TPE2', body: textFrameBody(ID3_UTF8, ['Source Artist']) },
        ]);
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function ingest(): Promise<void> {
        expect(await processAudioFile(sql, filePath, lp, context())).toBe('added');
        [owners] = await sql<
            Owners[]
        >`SELECT f.id AS file_id, t.id AS track_id, a.id AS album_id, ar.id AS artist_id
            FROM media_files f JOIN media_file_items fi ON fi.file_id=f.id JOIN media_items t ON t.id=fi.media_item_id
            JOIN media_items a ON a.id=t.parent_id JOIN media_items ar ON ar.id=a.parent_id WHERE f.file_path=${filePath}`;
    }
    async function sidecars(
        albumTitle: string | null = 'Source Album',
        artistName: string | null = 'Source Artist',
    ): Promise<void> {
        await writeFile(
            join(albumDir, 'album.nfo'),
            `<album>${albumTitle === null ? '' : `<title>${albumTitle}</title>`}<year>2001</year><genre>Rock</genre><review>NFO review</review><musicbrainzalbumid>release-a</musicbrainzalbumid></album>`,
        );
        await writeFile(
            join(artistDir, 'artist.nfo'),
            `<artist>${artistName === null ? '' : `<name>${artistName}</name>`}<biography>NFO biography</biography><genre>Rock</genre></artist>`,
        );
    }
    async function seed(): Promise<void> {
        await ingest();
        await sql`UPDATE media_items SET custom_metadata='{"sentinel":"keep"}'::jsonb, year=NULL WHERE id IN (${owners.album_id}, ${owners.artist_id})`;
        await sidecars();
    }
    async function state(
        id: string,
    ): Promise<{ custom_metadata: Record<string, unknown>; year: number | null }> {
        const [row] = await sql<
            { custom_metadata: Record<string, unknown>; year: number | null }[]
        >`SELECT custom_metadata, year FROM media_items WHERE id=${id}`;
        return row;
    }
    async function scan(signal?: AbortSignal): Promise<void> {
        await processAudioFile(sql, filePath, lp, context(signal), signal);
    }
    async function duringRead(
        kind: 'album' | 'artist',
        edit: () => Promise<unknown>,
        signal?: AbortSignal,
    ): Promise<void> {
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const real = await original();
        if (kind === 'album')
            vi.mocked(readAlbumNfo).mockImplementationOnce(async (dir) => {
                const data = await real.readAlbumNfo(dir);
                entered();
                await gate;
                return data;
            });
        else
            vi.mocked(readArtistNfo).mockImplementationOnce(async (dir) => {
                const data = await real.readArtistNfo(dir);
                entered();
                await gate;
                return data;
            });
        const running = scan(signal);
        try {
            await waitForBarrier(started, running, 'NFO reader');
            await edit();
        } finally {
            release();
            await running;
        }
    }

    async function waitForBarrier(
        started: Promise<void>,
        running: Promise<unknown>,
        label: string,
    ): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                started,
                running.then(() => {
                    throw new Error(`${label}: scanner completed before reaching the barrier`);
                }),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`${label}: barrier not reached within 5s`)),
                        5000,
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    async function settleWork(
        work: Array<Promise<unknown> | undefined>,
        close: () => Promise<void>,
    ): Promise<void> {
        const results = await Promise.allSettled(
            work.filter((item): item is Promise<unknown> => item !== undefined),
        );
        try {
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        } finally {
            await close();
        }
    }
    async function waitForBlocked(name: string): Promise<void> {
        await vi.waitFor(
            async () => {
                const [row] = await sql<
                    { blocked: boolean }[]
                >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${name} AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`;
                expect(row.blocked).toBe(true);
            },
            { interval: 10, timeout: 5000 },
        );
    }
    function backfillOn(
        worker: postgres.Sql = sql,
        argumentSignal?: AbortSignal,
        contextSignal?: AbortSignal,
    ): Promise<void> {
        return backfillMusicNfo(
            worker,
            { fileId: owners.file_id, trackId: owners.track_id, filePath },
            albumDir,
            { sql: worker, logger, abortSignal: contextSignal },
            argumentSignal,
        );
    }
    async function sibling(
        relativePath = '02 Sibling.mp3',
        albumId = owners.album_id,
    ): Promise<{ file_id: string; track_id: string }> {
        const [track] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id, custom_metadata) VALUES ('Sibling', 'track', 'active', ${albumId}, '{"album":"Source Album"}'::jsonb) RETURNING id`;
        const [file] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path, library_group_id) VALUES (${join(albumDir, relativePath)}, ${lp.library_group_id}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}, ${track.id})`;
        return { file_id: file.id, track_id: track.id };
    }

    it.each([
        ['album', 'change'],
        ['album', 'disappear'],
        ['album', 'compatible'],
        ['artist', 'change'],
        ['artist', 'disappear'],
        ['artist', 'compatible'],
    ] as const)('refreshes %s sidecar evidence after lock-wait %s', async (kind, action) => {
        await seed();
        const name = `nfo-sidecar-wait-${randomUUID()}`;
        const worker = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { application_name: name },
            onnotice: () => {},
        });
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const real = await original();
        let reads = 0;
        async function readerBarrier(): Promise<void> {
            // NOWAIT proves that each sidecar read, including a retry, runs
            // after the settling transaction released its file/owner locks.
            await editor.begin(async (tx) => {
                await tx`SELECT id FROM media_files WHERE id=${owners.file_id} FOR UPDATE NOWAIT`;
                await tx`SELECT id FROM media_items WHERE id IN (${owners.album_id}, ${owners.artist_id}) ORDER BY id FOR UPDATE NOWAIT`;
            });
            if (++reads === 1) {
                entered();
                await gate;
            }
        }
        if (kind === 'album')
            vi.mocked(readAlbumNfo).mockImplementation(async (dir) => {
                const data = await real.readAlbumNfo(dir);
                await readerBarrier();
                return data;
            });
        else
            vi.mocked(readArtistNfo).mockImplementation(async (dir) => {
                const data = await real.readArtistNfo(dir);
                await readerBarrier();
                return data;
            });
        const running = backfillOn(worker);
        try {
            await waitForBarrier(started, running, 'sidecar contention read');
            await editor.begin(async (tx) => {
                await tx`SELECT id FROM media_files WHERE id=${owners.file_id} FOR UPDATE`;
                release();
                await waitForBlocked(name);
                const nfoFile = join(kind === 'album' ? albumDir : artistDir, `${kind}.nfo`);
                if (action === 'disappear') await rm(nfoFile);
                else {
                    const identity =
                        action === 'change'
                            ? 'Unrelated Identity'
                            : kind === 'album'
                              ? 'Source Album'
                              : 'Source Artist';
                    await writeFile(
                        nfoFile,
                        kind === 'album'
                            ? `<album><title>${identity}</title><review>Fresh review</review></album>`
                            : `<artist><name>${identity}</name><biography>Fresh biography</biography></artist>`,
                    );
                    const later = new Date(Date.now() + 60_000);
                    await utimes(nfoFile, later, later);
                }
            });
            await running;
            const after = (await state(kind === 'album' ? owners.album_id : owners.artist_id))
                .custom_metadata;
            if (action === 'compatible')
                expect(after[kind === 'album' ? 'description' : 'biography']).toBe(
                    kind === 'album' ? 'Fresh review' : 'Fresh biography',
                );
            else expect(after).not.toHaveProperty('nfo_mtime');
        } finally {
            release();
            await settleWork([running], () => worker.end());
        }
    });

    it.each(['tags', 'release', 'link'] as const)(
        'rejects a sibling %s correction made during album NFO I/O',
        async (change) => {
            await seed();
            const other = await sibling();
            await duringRead('album', () =>
                change === 'tags'
                    ? editor`UPDATE media_items SET custom_metadata='{"album":"Unrelated"}'::jsonb WHERE id=${other.track_id}`
                    : change === 'release'
                      ? editor`UPDATE media_items SET custom_metadata=custom_metadata || '{"musicbrainz_album_id":"release-b"}'::jsonb WHERE id=${other.track_id}`
                      : editor`DELETE FROM media_file_items WHERE file_id=${other.file_id}`,
            );
            expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['tags', 'release', 'link'] as const)(
        'serializes a sibling %s correction attempted after final validation',
        async (change) => {
            await seed();
            const other = await sibling();
            const name = `nfo-sibling-edit-${randomUUID()}`;
            const correction = postgres(getTestDatabaseUrl(), {
                max: 1,
                connection: { application_name: name },
                onnotice: () => {},
            });
            const real = await vi.importActual<
                typeof import('../../../../../../database/queries/music-nfo.queries.js')
            >('../../../../../../database/queries/music-nfo.queries.js');
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            vi.mocked(writeMusicNfoBackfill).mockImplementationOnce(async (...args) => {
                entered();
                await gate;
                return real.writeMusicNfoBackfill(...args);
            });
            const running = backfillOn();
            let editing: Promise<unknown> | undefined;
            try {
                await waitForBarrier(started, running, 'final validation');
                editing = Promise.resolve(
                    change === 'tags'
                        ? correction`UPDATE media_items SET custom_metadata='{"album":"Unrelated"}'::jsonb WHERE id=${other.track_id}`
                        : change === 'release'
                          ? correction`UPDATE media_items SET custom_metadata=custom_metadata || '{"musicbrainz_album_id":"release-b"}'::jsonb WHERE id=${other.track_id}`
                          : correction`DELETE FROM media_file_items WHERE file_id=${other.file_id}`,
                );
                await waitForBlocked(name);
            } finally {
                release();
                await settleWork([running, editing], () => correction.end());
            }
            expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
        },
    );

    it('preserves confirmed canonical performers and remixers through changed ID3 ingest and NFO backfill', async () => {
        await ingest();
        const prior = await getArtistCreditReview(sql, owners.track_id);
        await confirmArtistCredits(sql, owners.track_id, 'fixture-editor', {
            snapshot: prior.snapshot,
            credits: [
                {
                    artist: { newName: 'Deliberate Guest' },
                    creditedAs: 'Guest credit',
                    role: 'performer',
                },
                {
                    artist: { newName: 'Deliberate Remixer' },
                    creditedAs: 'Remix credit',
                    role: 'remixer',
                },
            ],
        });
        const saved = await getArtistCreditReview(sql, owners.track_id);
        const [before] =
            await sql`SELECT parent_id,title,title_source,custom_metadata FROM media_items WHERE id=${owners.track_id}`;
        const links =
            await sql`SELECT to_jsonb(l) AS value FROM media_file_items l WHERE media_item_id=${owners.track_id}`;
        await writeId3Mp3(filePath, 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Changed physical tag title']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Source Album']) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Wrong New Physical Artist']) },
            { id: 'TPE2', body: textFrameBody(ID3_UTF8, ['Source Artist']) },
        ]);
        const changed = new Date(Date.now() + 5000);
        await utimes(filePath, changed, changed);
        expect(await processAudioFile(sql, filePath, lp, context())).toBe('updated');
        await sidecars();
        await backfillOn();
        const after = await getArtistCreditReview(sql, owners.track_id);
        expect(after.credits).toEqual(saved.credits);
        expect(after.protection.lockedBy).toBe('fixture-editor');
        const [row] =
            await sql`SELECT parent_id,title,title_source,custom_metadata FROM media_items WHERE id=${owners.track_id}`;
        expect(row).toEqual(before);
        expect([
            ...(await sql`SELECT to_jsonb(l) AS value FROM media_file_items l WHERE media_item_id=${owners.track_id}`),
        ]).toEqual([...links]);
    });

    it('does not let irrelevant nested albums consume the resolved-occupant cap', async () => {
        await seed();
        const tracks = Array.from({ length: 1001 }, () => ({
            id: randomUUID(),
            title: 'Nested',
            media_type: 'track',
            status: 'active',
            parent_id: owners.album_id,
        }));
        await sql`INSERT INTO media_items ${sql(tracks)}`;
        const files = tracks.map((track, index) => ({
            id: randomUUID(),
            file_path: join(albumDir, `Unrelated ${index}`, 'song.mp3'),
            library_group_id: lp.library_group_id,
        }));
        await sql`INSERT INTO media_files ${sql(files)}`;
        await sql`INSERT INTO media_file_items ${sql(files.map((file, index) => ({ file_id: file.id, media_item_id: tracks[index].id })))}`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
    });

    it.each(['missing', 'track-inactive', 'album-inactive'] as const)(
        'ignores a historical %s occupant when judging physical NFO ambiguity',
        async (kind) => {
            await seed();
            const [album] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title, media_type, status, parent_id) VALUES ('Old Album', 'album', 'active', ${owners.artist_id}) RETURNING id`;
            const old = await sibling('Old Song.mp3', album.id);
            if (kind === 'missing')
                await sql`UPDATE media_files SET is_missing=true WHERE id=${old.file_id}`;
            else
                await sql`UPDATE media_items SET status='deleted' WHERE id=${kind === 'track-inactive' ? old.track_id : album.id}`;
            await scan();
            expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
        },
    );

    it.each(['matching', 'contradictory', 'plural', 'performer-only'] as const)(
        'respects %s tag-only album-artist provider evidence',
        async (kind) => {
            await seed();
            await writeFile(
                join(artistDir, 'artist.nfo'),
                '<artist><name>Source Artist</name><biography>NFO biography</biography><musicbrainzartistid>artist-a</musicbrainzartistid></artist>',
            );
            const meta =
                kind === 'performer-only'
                    ? { musicbrainz_artist_ids: ['artist-b'] }
                    : {
                          musicbrainz_album_artist_ids:
                              kind === 'plural'
                                  ? ['artist-b', 'artist-c']
                                  : [kind === 'matching' ? 'artist-a' : 'artist-b'],
                      };
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json(meta as never)} WHERE id=${owners.track_id}`;
            await scan();
            expect((await state(owners.artist_id)).custom_metadata.biography).toBe(
                kind === 'contradictory' ? undefined : 'NFO biography',
            );
            if (kind === 'contradictory')
                expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty(
                    'nfo_mtime',
                );
        },
    );

    it('rejects changed tag-only album-artist IDs while reading artist NFO', async () => {
        await seed();
        await duringRead(
            'artist',
            () =>
                editor`UPDATE media_items SET custom_metadata=custom_metadata || '{"musicbrainz_album_artist_ids":["artist-b"]}'::jsonb WHERE id=${owners.track_id}`,
        );
        expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it.each(['album', 'artist'] as const)(
        'accepts entity-encoded %s names that agree with decoded stored identity',
        async (kind) => {
            await seed();
            if (kind === 'album') {
                await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album":"Source & Album 2"}'::jsonb WHERE id=${owners.track_id}`;
                await writeFile(
                    join(albumDir, 'album.nfo'),
                    '<album><title>Source &amp; Album &#x32;</title><review>NFO review</review></album>',
                );
            } else {
                const moved = join(root, 'Source & Artist 2');
                await rename(artistDir, moved);
                artistDir = moved;
                albumDir = join(artistDir, 'Source Album');
                filePath = join(albumDir, '01 Song.mp3');
                await sql`UPDATE media_files SET file_path=${filePath} WHERE id=${owners.file_id}`;
                await sql`UPDATE media_items SET title='Source & Artist 2' WHERE id=${owners.artist_id}`;
                await writeFile(
                    join(artistDir, 'artist.nfo'),
                    '<artist><name>Source &amp; Artist &#50;</name><biography>NFO biography</biography></artist>',
                );
            }
            await scan();
            expect(
                (await state(kind === 'album' ? owners.album_id : owners.artist_id)).custom_metadata
                    .nfo_mtime,
            ).toEqual(expect.any(String));
        },
    );

    it.each(['album', 'artist'] as const)(
        'treats compatible and contradictory %s CDATA names as identity',
        async (kind) => {
            await seed();
            const file = join(kind === 'album' ? albumDir : artistDir, `${kind}.nfo`);
            const name = kind === 'album' ? 'Source Album' : 'Source Artist';
            const identityTag = kind === 'album' ? 'title' : 'name';
            const body =
                kind === 'album'
                    ? '<review>NFO review</review>'
                    : '<biography>NFO biography</biography>';
            await writeFile(
                file,
                `<${kind}><!-- <${identityTag}>Wrong Comment</${identityTag}> --><${identityTag}><![CDATA[${name}]]></${identityTag}>${body}</${kind}>`,
            );
            await scan();
            expect(
                (await state(kind === 'album' ? owners.album_id : owners.artist_id)).custom_metadata
                    .nfo_mtime,
            ).toEqual(expect.any(String));
            await sql`UPDATE media_items SET custom_metadata='{"sentinel":"keep"}'::jsonb WHERE id=${kind === 'album' ? owners.album_id : owners.artist_id}`;
            await writeFile(
                file,
                `<${kind}><${identityTag}><![CDATA[Unrelated Identity]]></${identityTag}>${body}</${kind}>`,
            );
            await scan();
            expect(
                (await state(kind === 'album' ? owners.album_id : owners.artist_id))
                    .custom_metadata,
            ).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rolls back the actual %s UPDATE on argument-only cancellation after the write',
        async (kind) => {
            await cancellationAfterWrite(kind, 'argument');
        },
    );
    it.each(['album', 'artist'] as const)(
        'rolls back the actual %s UPDATE on context-only cancellation after the write',
        async (kind) => {
            await cancellationAfterWrite(kind, 'context');
        },
    );
    async function cancellationAfterWrite(
        kind: 'album' | 'artist',
        channel: 'argument' | 'context',
    ): Promise<void> {
        await seed();
        const id = kind === 'album' ? owners.album_id : owners.artist_id;
        const before = await state(id);
        const controller = new AbortController();
        const real = await vi.importActual<
            typeof import('../../../../../../database/queries/music-nfo.queries.js')
        >('../../../../../../database/queries/music-nfo.queries.js');
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(writeMusicNfoBackfill).mockImplementation(async (...args) => {
            const written = await real.writeMusicNfoBackfill(...args);
            if (args[1].id === id) {
                entered();
                await gate;
            }
            return written;
        });
        const running = backfillOn(
            sql,
            channel === 'argument' ? controller.signal : undefined,
            channel === 'context' ? controller.signal : undefined,
        );
        const handled = running.catch((error: unknown) => {
            expect((error as Error).name).toBe('AbortError');
        });
        try {
            await waitForBarrier(started, handled, 'post-update cancellation');
            controller.abort();
        } finally {
            release();
            await handled;
        }
        const [after] = await editor`SELECT custom_metadata, year FROM media_items WHERE id=${id}`;
        expect(after).toEqual(before);
    }

    it('keeps literal path escaping and collapsed disc-folder evidence', async () => {
        await seed();
        const oldDir = albumDir;
        albumDir = join(artistDir, 'Source_100% Album');
        await rename(oldDir, albumDir);
        filePath = join(albumDir, '01 Song.mp3');
        await sql`UPDATE media_files SET file_path=${filePath} WHERE id=${owners.file_id}`;
        const [outside] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id) VALUES ('Outside Album', 'album', 'active', ${owners.artist_id}) RETURNING id`;
        await sibling('../SourceX100Y Album/outside.mp3', outside.id);
        await scan();
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
        const disc = await sibling('CD 2/02 Sibling.mp3');
        await sql`UPDATE media_items SET custom_metadata='{"album":"Contradictory Disc"}'::jsonb WHERE id=${disc.track_id}`;
        await sql`UPDATE media_items SET custom_metadata='{"sentinel":"keep"}'::jsonb WHERE id=${owners.album_id}`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it('conservatively skips genuinely oversized resolved evidence', async () => {
        await seed();
        const tracks = Array.from({ length: 1000 }, () => ({
            id: randomUUID(),
            title: 'Occupant',
            media_type: 'track',
            status: 'active',
            parent_id: owners.album_id,
        }));
        await sql`INSERT INTO media_items ${sql(tracks)}`;
        const files = tracks.map((_track, index) => ({
            id: randomUUID(),
            file_path: join(albumDir, `${index}.mp3`),
            library_group_id: lp.library_group_id,
        }));
        await sql`INSERT INTO media_files ${sql(files)}`;
        await sql`INSERT INTO media_file_items ${sql(files.map((file, index) => ({ file_id: file.id, media_item_id: tracks[index].id })))}`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it.each([
        ['album', 'argument'],
        ['album', 'context'],
        ['artist', 'argument'],
        ['artist', 'context'],
    ] as const)(
        'honors %s cancellation through the independent %s channel during I/O',
        async (kind, channel) => {
            await seed();
            const controller = new AbortController();
            const real = await original();
            if (kind === 'album')
                vi.mocked(readAlbumNfo).mockImplementationOnce(async (dir) => {
                    const data = await real.readAlbumNfo(dir);
                    controller.abort();
                    return data;
                });
            else
                vi.mocked(readArtistNfo).mockImplementationOnce(async (dir) => {
                    const data = await real.readArtistNfo(dir);
                    controller.abort();
                    return data;
                });
            await backfillOn(
                sql,
                channel === 'argument' ? controller.signal : undefined,
                channel === 'context' ? controller.signal : undefined,
            );
            expect(
                (await state(kind === 'album' ? owners.album_id : owners.artist_id))
                    .custom_metadata,
            ).not.toHaveProperty('nfo_mtime');
        },
    );

    it('reports a bypassed reader immediately and settles the scanner', async () => {
        await seed();
        await rm(join(albumDir, 'album.nfo'));
        await rm(join(artistDir, 'artist.nfo'));
        const running = backfillOn();
        await expect(
            waitForBarrier(new Promise<void>(() => {}), running, 'bypassed reader'),
        ).rejects.toThrow('scanner completed before reaching the barrier');
        await running;
    });

    it('serializes two source tracks from the same folder without inverting their locks', async () => {
        await seed();
        const other = await sibling();
        const name = `nfo-second-source-${randomUUID()}`;
        const worker = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { application_name: name },
            onnotice: () => {},
        });
        const real = await vi.importActual<
            typeof import('../../../../../../database/queries/music-nfo.queries.js')
        >('../../../../../../database/queries/music-nfo.queries.js');
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(writeMusicNfoBackfill).mockImplementationOnce(async (...args) => {
            entered();
            await gate;
            return real.writeMusicNfoBackfill(...args);
        });
        const first = backfillOn();
        let second: Promise<void> | undefined;
        try {
            await waitForBarrier(started, first, 'first source validation');
            second = backfillMusicNfo(
                worker,
                {
                    fileId: other.file_id,
                    trackId: other.track_id,
                    filePath: join(albumDir, '02 Sibling.mp3'),
                },
                albumDir,
                { sql: worker, logger },
            );
            await waitForBlocked(name);
        } finally {
            release();
            await settleWork([first, second], () => worker.end());
        }
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
    });

    it('defers nested transaction callers without performing filesystem I/O, then safely retries', async () => {
        await seed();
        vi.mocked(readAlbumNfo).mockClear();
        vi.mocked(readArtistNfo).mockClear();
        await sql.begin(async (tx) => {
            await tx`SELECT id FROM media_items WHERE id=${owners.album_id} FOR UPDATE`;
            await backfillOn(tx as unknown as postgres.Sql);
            expect(readAlbumNfo).not.toHaveBeenCalled();
            expect(readArtistNfo).not.toHaveBeenCalled();
        });
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        await backfillOn();
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
    });

    it('rejects a sibling album-artist tag correction during artist NFO I/O', async () => {
        await seed();
        const other = await sibling();
        await duringRead(
            'artist',
            () =>
                editor`UPDATE media_items SET custom_metadata=custom_metadata || '{"musicbrainz_album_artist_ids":["artist-b"]}'::jsonb WHERE id=${other.track_id}`,
        );
        expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it.each(['track', 'album'] as const)(
        'does not treat a dismissed %s as a live source context',
        async (kind) => {
            await seed();
            await sql`UPDATE media_items SET is_dismissed=true WHERE id=${kind === 'track' ? owners.track_id : owners.album_id}`;
            await backfillOn();
            expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it('closes owned workers after settling rejected barrier work', async () => {
        const close = vi.fn(async () => {});
        await expect(
            settleWork([Promise.reject(new Error('reader rejected')), Promise.resolve()], close),
        ).rejects.toThrow('reader rejected');
        expect(close).toHaveBeenCalledOnce();
    });

    it('backfills valid missing fields on new ingest and keeps manual fields on the unchanged caller', async () => {
        await sidecars();
        await ingest();
        expect(await state(owners.album_id)).toMatchObject({
            year: 2001,
            custom_metadata: {
                description: 'NFO review',
                genre: ['Rock'],
                nfo_source_path: join(albumDir, 'album.nfo'),
            },
        });
        expect(await state(owners.artist_id)).toMatchObject({
            custom_metadata: { biography: 'NFO biography' },
        });
        await sql`UPDATE media_items SET custom_metadata='{"description":"Manual","genre":["Jazz"],"sentinel":"keep"}'::jsonb, year=1999 WHERE id=${owners.album_id}`;
        await scan();
        expect(await state(owners.album_id)).toMatchObject({
            year: 1999,
            custom_metadata: {
                description: 'Manual',
                genre: ['Jazz'],
                sentinel: 'keep',
                nfo_mtime: expect.any(String),
            },
        });
    });

    it.each(['album', 'artist'] as const)('preserves a %s locked before NFO work', async (kind) => {
        await seed();
        const id = kind === 'album' ? owners.album_id : owners.artist_id;
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${id}`;
        await scan();
        expect(await state(id)).toMatchObject({
            year: null,
            custom_metadata: { sentinel: 'keep' },
        });
        expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        expect((await state(id)).custom_metadata).not.toHaveProperty(
            kind === 'album' ? 'description' : 'biography',
        );
    });

    it.each(['album', 'artist'] as const)(
        'preserves a %s locked while reading NFO',
        async (kind) => {
            await seed();
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            await duringRead(
                kind,
                () => editor`UPDATE media_items SET metadata_locked=true WHERE id=${id}`,
            );
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
            expect((await state(id)).year).toBeNull();
        },
    );

    it.each(['album', 'artist'] as const)(
        'preserves concurrent %s metadata and year without success provenance',
        async (kind) => {
            await seed();
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            await duringRead(
                kind,
                () =>
                    editor`UPDATE media_items SET custom_metadata='{"manual":"new"}'::jsonb, year=2020 WHERE id=${id}`,
            );
            expect(await state(id)).toEqual({ custom_metadata: { manual: 'new' }, year: 2020 });
        },
    );

    it.each(['album', 'artist'] as const)(
        'rejects stale %s evidence after the track changes albums',
        async (kind) => {
            await seed();
            await duringRead(
                kind,
                () => editor`UPDATE media_items SET parent_id=NULL WHERE id=${owners.track_id}`,
            );
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rejects stale %s evidence after the album changes artists',
        async (kind) => {
            await seed();
            await duringRead(
                kind,
                () => editor`UPDATE media_items SET parent_id=NULL WHERE id=${owners.album_id}`,
            );
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rejects stale %s evidence after a file link is removed',
        async (kind) => {
            await seed();
            await duringRead(
                kind,
                () => editor`DELETE FROM media_file_items WHERE file_id=${owners.file_id}`,
            );
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rechecks a different %s source path even when mtime is equal',
        async (kind) => {
            await seed();
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            const source = join(kind === 'album' ? albumDir : artistDir, `${kind}.nfo`);
            const mtime = (await stat(source)).mtime.toISOString();
            await sql`UPDATE media_items SET custom_metadata=${sql.json({ nfo_source_path: '/old/unrelated.nfo', nfo_mtime: mtime })} WHERE id=${id}`;
            await scan();
            expect((await state(id)).custom_metadata.nfo_source_path).toBe(source);
        },
    );

    it.each(['album', 'artist'] as const)(
        'preserves a concurrent %s year-only correction',
        async (kind) => {
            await seed();
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            await duringRead(kind, () => editor`UPDATE media_items SET year=2022 WHERE id=${id}`);
            expect((await state(id)).year).toBe(2022);
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'preserves a concurrent %s identity correction',
        async (kind) => {
            await seed();
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            await duringRead(
                kind,
                () => editor`UPDATE media_items SET title='Corrected Identity' WHERE id=${id}`,
            );
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rejects stale %s evidence after the physical path changes',
        async (kind) => {
            await seed();
            await duringRead(
                kind,
                () =>
                    editor`UPDATE media_files SET file_path=${filePath + '.moved'} WHERE id=${owners.file_id}`,
            );
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rechecks the fresh %s snapshot after waiting for an actual PostgreSQL lock',
        async (kind) => {
            await seed();
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            const name = `nfo-contention-${randomUUID()}`;
            const worker = postgres(getTestDatabaseUrl(), {
                max: 1,
                connection: { application_name: name },
                onnotice: () => {},
            });
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const real = await original();
            if (kind === 'album')
                vi.mocked(readAlbumNfo).mockImplementationOnce(async (dir) => {
                    const data = await real.readAlbumNfo(dir);
                    entered();
                    await gate;
                    return data;
                });
            else
                vi.mocked(readArtistNfo).mockImplementationOnce(async (dir) => {
                    const data = await real.readArtistNfo(dir);
                    entered();
                    await gate;
                    return data;
                });
            const running = backfillMusicNfo(
                worker,
                { fileId: owners.file_id, trackId: owners.track_id, filePath },
                albumDir,
                { sql: worker, logger },
            );
            try {
                await waitForBarrier(started, running, 'NFO reader');
                await editor.begin(async (tx) => {
                    await tx`SELECT id FROM media_files WHERE id=${owners.file_id} FOR UPDATE`;
                    release();
                    await vi.waitFor(
                        async () => {
                            const [row] = await sql<
                                { blocked: boolean }[]
                            >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${name} AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`;
                            expect(row.blocked).toBe(true);
                        },
                        { interval: 10, timeout: 5000 },
                    );
                    await tx`UPDATE media_items SET custom_metadata='{"after_wait":"preserve"}'::jsonb, metadata_locked=true, year=2024 WHERE id=${id}`;
                });
                await running;
                expect(await state(id)).toEqual({
                    custom_metadata: { after_wait: 'preserve' },
                    year: 2024,
                });
            } finally {
                release();
                await settleWork([running], () => worker.end());
            }
        },
    );

    it('checks established provider mappings as well as custom metadata', async () => {
        await seed();
        await sql`INSERT INTO external_ids (media_id, media_type, provider, external_id) VALUES (${owners.album_id}, 'album', 'musicbrainz_release', 'release-b')`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it('rejects a provider correction committed during an album read', async () => {
        await seed();
        await duringRead(
            'album',
            () =>
                editor`INSERT INTO external_ids (media_id, media_type, provider, external_id) VALUES (${owners.album_id}, 'album', 'musicbrainz_release', 'release-b')`,
        );
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it.each(['before', 'during'] as const)(
        'rejects contradictory artist provider identity committed %s reading',
        async (when) => {
            await seed();
            await writeFile(
                join(artistDir, 'artist.nfo'),
                '<artist><name>Source Artist</name><biography>NFO biography</biography><musicbrainzartistid>artist-a</musicbrainzartistid></artist>',
            );
            const edit = () =>
                editor`INSERT INTO external_ids (media_id, media_type, provider, external_id) VALUES (${owners.artist_id}, 'artist', 'musicbrainz', 'artist-b')`;
            if (when === 'before') {
                await edit();
                await scan();
            } else await duringRead('artist', edit);
            expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
            expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty('biography');
        },
    );

    it('does not resolve conflicting established identity evidence merely because the NFO lacks an ID', async () => {
        await seed();
        await writeFile(
            join(albumDir, 'album.nfo'),
            '<album><title>Source Album</title><review>NFO review</review></album>',
        );
        await sql`UPDATE media_items SET custom_metadata='{"musicbrainz_album_id":"release-a"}'::jsonb WHERE id=${owners.album_id}`;
        await sql`INSERT INTO external_ids (media_id, media_type, provider, external_id) VALUES (${owners.album_id}, 'album', 'musicbrainz_release', 'release-b')`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it('does not lose legacy NULL metadata when backfilling missing fields', async () => {
        await seed();
        await sql`UPDATE media_items SET custom_metadata=NULL WHERE id IN (${owners.album_id}, ${owners.artist_id})`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
        expect((await state(owners.artist_id)).custom_metadata.biography).toBe('NFO biography');
    });

    it('cheaply skips the same trusted source and mtime', async () => {
        await seed();
        await scan();
        vi.mocked(readAlbumNfo).mockClear();
        vi.mocked(readArtistNfo).mockClear();
        await scan();
        expect(readAlbumNfo).not.toHaveBeenCalled();
        expect(readArtistNfo).not.toHaveBeenCalled();
    });

    it.each(['flat-single', 'flat-set', 'disc-folder'] as const)(
        'uses the folder disc-evidence rule for NFO title matching: %s',
        async (layout) => {
            await ingest();
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album":"Copper Horizon CD1 WEB"}'::jsonb WHERE id=${owners.track_id}`;
            if (layout === 'disc-folder') {
                const moved = join(albumDir, 'CD1', '01 Song.mp3');
                await mkdir(join(albumDir, 'CD1'));
                await rename(filePath, moved);
                await sql`UPDATE media_files SET file_path=${moved} WHERE id=${owners.file_id}`;
                filePath = moved;
            } else {
                // An unrelated nested release never supplies local evidence.
                const other = await sibling(
                    layout === 'flat-set' ? '02 Sibling.mp3' : 'Other Release/02 Sibling.mp3',
                );
                await sql`UPDATE media_items SET custom_metadata='{"album":"Copper Horizon Disc 2 (2000)"}'::jsonb WHERE id=${other.track_id}`;
            }
            await sidecars('Copper Horizon', null);
            await backfillOn();
            if (layout === 'flat-single') {
                expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty(
                    'nfo_mtime',
                );
                await sidecars('Copper Horizon CD1', null);
                await backfillOn();
            }
            expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
        },
    );

    it('accepts tag/NFO agreement despite a historical album display title', async () => {
        await seed();
        await sql`UPDATE media_items SET title='Old - CD1' WHERE id=${owners.album_id}`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
    });

    it('does not fill unrelated album or artist data from contradictory explicit NFO names', async () => {
        await seed();
        await sidecars('Unrelated Album', 'Unrelated Artist');
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it('does not fill album metadata when an established release identity conflicts', async () => {
        await seed();
        await sql`UPDATE media_items SET custom_metadata='{"musicbrainz_album_id":"release-b"}'::jsonb WHERE id=${owners.album_id}`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('description');
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it('retains compatible support for NFOs without names', async () => {
        await seed();
        await sidecars(null, null);
        await scan();
        expect((await state(owners.album_id)).custom_metadata.description).toBe('NFO review');
        expect((await state(owners.artist_id)).custom_metadata.biography).toBe('NFO biography');
    });

    it('does not apply one album NFO to an ambiguous shared folder', async () => {
        await seed();
        const [album] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id) VALUES ('Other Album', 'album', 'active', ${owners.artist_id}) RETURNING id`;
        const [track] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id) VALUES ('Other Track', 'track', 'active', ${album.id}) RETURNING id`;
        const [file] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES (${join(albumDir, '02 Other.mp3')}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}, ${track.id})`;
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });

    it.each(['album', 'artist'] as const)(
        'does not stamp %s success when cancelled during the read',
        async (kind) => {
            await seed();
            const controller = new AbortController();
            await duringRead(
                kind,
                async () => {
                    controller.abort();
                },
                controller.signal,
            );
            const id = kind === 'album' ? owners.album_id : owners.artist_id;
            expect((await state(id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'honors a concurrent %s lock through the actual new-ingest caller',
        async (kind) => {
            await sidecars();
            const real = await original();
            let id: string | undefined;
            async function lockTarget(): Promise<void> {
                const [row] = await editor<
                    { id: string }[]
                >`SELECT id FROM media_items WHERE media_type=${kind}`;
                id = row.id;
                await editor`UPDATE media_items SET metadata_locked=true WHERE id=${id}`;
            }
            if (kind === 'album')
                vi.mocked(readAlbumNfo).mockImplementationOnce(async (dir) => {
                    const data = await real.readAlbumNfo(dir);
                    await lockTarget();
                    return data;
                });
            else
                vi.mocked(readArtistNfo).mockImplementationOnce(async (dir) => {
                    const data = await real.readArtistNfo(dir);
                    await lockTarget();
                    return data;
                });
            expect(await processAudioFile(sql, filePath, lp, context())).toBe('added');
            expect(id).toBeDefined();
            expect((await state(id!)).custom_metadata).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'rejects an already stale known %s placement before reading sidecars',
        async (kind) => {
            await seed();
            vi.mocked(readAlbumNfo).mockClear();
            vi.mocked(readArtistNfo).mockClear();
            await backfillMusicNfo(
                sql,
                {
                    fileId: owners.file_id,
                    trackId: owners.track_id,
                    filePath,
                    albumId: kind === 'album' ? randomUUID() : owners.album_id,
                    artistId: kind === 'artist' ? randomUUID() : owners.artist_id,
                },
                albumDir,
                context(),
            );
            expect(readAlbumNfo).not.toHaveBeenCalled();
            expect(readArtistNfo).not.toHaveBeenCalled();
        },
    );

    it.each(['album', 'artist'] as const)(
        'does not stamp %s success if the sidecar disappears during reading',
        async (kind) => {
            await seed();
            await duringRead(kind, () =>
                rm(join(kind === 'album' ? albumDir : artistDir, `${kind}.nfo`)),
            );
            expect(
                (await state(kind === 'album' ? owners.album_id : owners.artist_id))
                    .custom_metadata,
            ).not.toHaveProperty('nfo_mtime');
        },
    );

    it.each(['album', 'artist'] as const)(
        'does not stamp %s success on a failed NFO read',
        async (kind) => {
            await seed();
            if (kind === 'album')
                vi.mocked(readAlbumNfo).mockRejectedValueOnce(new Error('NFO parse failed'));
            else vi.mocked(readArtistNfo).mockRejectedValueOnce(new Error('NFO parse failed'));
            await scan();
            expect(
                (await state(kind === 'album' ? owners.album_id : owners.artist_id))
                    .custom_metadata,
            ).not.toHaveProperty('nfo_mtime');
        },
    );

    it('does not stamp success for unreadable or empty NFO data', async () => {
        await seed();
        await writeFile(join(albumDir, 'album.nfo'), '<album>broken</album>');
        await writeFile(join(artistDir, 'artist.nfo'), '<artist>broken</artist>');
        await scan();
        expect((await state(owners.album_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
        expect((await state(owners.artist_id)).custom_metadata).not.toHaveProperty('nfo_mtime');
    });
});
