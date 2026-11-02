// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real files and PG. Fictional names retain the production split's shape. */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import * as connection from '$lib/server/database/connection.js';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal, type PrincipalKind } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import { def as artistDef } from '$lib/server/api/defs/admin/media/[id]/artist.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import {
    findOrCreateMusicArtist,
    findOrCreateMusicAlbum,
    unlockMediaItem,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    lockMusicNfoSnapshot,
    readMusicNfoSnapshot,
} from '$lib/server/database/queries/music-nfo.queries.js';
import { reparentAlbumToArtist } from '$lib/server/database/queries/artist-merge.queries.js';
import { ingestSingleFile, scanForSync } from '../../file-scanner.js';
import {
    mergeOversizedCompilationArtists,
    mergeVariousArtistsAliases,
    processAudioFile,
} from './audio-processor.js';
import { autoMergeDuplicateArtists } from '$lib/server/database/queries/database-cleanup.queries.js';
import { alignFolderAlbumParent, albumArtistDecision } from './album-artist-evidence.js';
import { resolveFolderAlbumArtist } from './folder-album-artist.js';
import { findAlbumArtistEvidence } from '$lib/server/database/queries/music-album-folder.queries.js';
import { parseAudioTags } from './audio-tag-parser.js';
import * as audioTagParser from './audio-tag-parser.js';
import * as mediaFilesQueries from '$lib/server/database/queries/media-files.queries.js';
import {
    findTrackFilesMissingDiscNumberByPrefix,
    loadMediaFilesByPrefix,
} from '$lib/server/database/queries/media-files.queries.js';
import { triageFiles } from './shared.js';
import { getArtistCreditEvidence } from './artist-credit-evidence.js';
import { findExistingFolderAlbum } from './album-folder-resolver.js';
import type { FileScannerContext } from './shared.js';
import { ID3_UTF8, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    getScanProgress: async () => null,
    deleteScanProgress: async () => {},
    getAnyScanProgress: async () => null,
    getAggregateScanProgress: async () => null,
    getScanProgressByKey: async () => new Map(),
}));
// Enqueuing downstream work is unrelated to the persisted scanner identity.
vi.mock('./flow-debouncer.js', () => ({
    getWatcherFlowDebouncer: () => ({ signal: () => {} }),
}));

const RELEASE_A = '11111111-1111-4111-8111-111111111111';
const RELEASE_B = '22222222-2222-4222-8222-222222222222';

describe('album folder identity after its parent artist changed', () => {
    let sql: postgres.Sql;
    let root: string;
    let dir: string;
    let lp: LibraryPathRow;
    let albumId: string;
    const logger = mockLogger();
    const ctx = (): never => ({ sql, logger }) as never;

    beforeAll(() => {
        sql = getTestDb();
        vi.spyOn(connection, 'getDb').mockReturnValue(sql);
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'album-folder-'));
        dir = join(root, 'Curator', 'Festival (2026)');
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${randomUUID()}) RETURNING id
        `;
        [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group.id}, true) RETURNING *
        `;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM users WHERE username LIKE 'manual-assignment-%'`;
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function writeTrack(
        file: string,
        artist: string,
        year = '2026',
        release?: string,
        albumArtist = 'Curator',
        compilation = false,
        title = 'Festival (2026)',
        disc?: string,
    ): Promise<void> {
        await mkdir(join(file, '..'), { recursive: true });
        await writeId3Mp3(file, 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, [artist + ' song']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, [title]) },
            ...(disc ? [{ id: 'TPOS', body: textFrameBody(ID3_UTF8, [disc]) }] : []),
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, [artist]) },
            ...(albumArtist ? [{ id: 'TPE2', body: textFrameBody(ID3_UTF8, [albumArtist]) }] : []),
            ...(compilation ? [{ id: 'TCMP', body: textFrameBody(ID3_UTF8, ['1']) }] : []),
            { id: 'TDRC', body: textFrameBody(ID3_UTF8, [year]) },
            ...(release
                ? [
                      {
                          id: 'TXXX',
                          body: textFrameBody(ID3_UTF8, ['MusicBrainz Album Id', release]),
                      },
                  ]
                : []),
        ]);
    }

    /** A swallowed per-file scan error otherwise surfaces later as a missing row. */
    async function scanClean(): Promise<void> {
        const result = await scanForSync(lp.id, ctx());
        expect(result.errors).toEqual([]);
    }

    async function albumFor(file: string): Promise<string> {
        const [row] = await sql<{ parent_id: string }[]>`
            SELECT t.parent_id FROM media_files f
            JOIN media_file_items fi ON fi.file_id=f.id
            JOIN media_items t ON t.id=fi.media_item_id WHERE f.file_path=${file}
        `;
        return row.parent_id;
    }

    async function initialScan(release?: string): Promise<void> {
        const old = join(dir, 'Old.mp3');
        await writeTrack(old, 'First Performer', '2026', release);
        await writeTrack(join(dir, 'Other.mp3'), 'Second Performer', '2026', release);
        await scanClean();
        albumId = await albumFor(old);
        // Reproduce the existing PROD catalogue: album under VA, unchanged
        // ALBUMARTIST=Curator on its tracks. Its historic reparent is not the bug.
        const va = await findOrCreateMusicArtist(sql, { name: 'Various Artists' });
        await reparentAlbumToArtist(sql, albumId, va);
    }

    it('uses stored track titles to reject copied artist tags during maintenance', async () => {
        await initialScan();
        const third = join(dir, 'Paper Comet.mp3');
        await writeTrack(third, 'Paper Comet [feat. Amber Current]');
        await processAudioFile(sql, third, lp, ctx() as FileScannerContext);
        await sql`UPDATE media_items SET title=custom_metadata->>'artist',
            custom_metadata=custom_metadata-'album_artist'-'album_artists'-'title'
            WHERE parent_id=${albumId}`;
        expect(await albumArtistDecision(sql, albumId, { logger })).toMatchObject({
            artist: 'Curator',
            various: false,
            source: 'fallback',
        });
    });

    async function assign(
        method: 'PATCH' | 'POST',
        body: unknown,
        admin = true,
        principalOnly = false,
        token?: { kind: PrincipalKind; scopes: string[]; ownerIsAdmin?: boolean },
    ): Promise<Response> {
        const url = new URL(`http://localhost/api/admin/media/${albumId}/artist`);
        const event = {
            url,
            params: { id: albumId },
            request: new Request(url, {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
            locals: {
                user: principalOnly ? undefined : { username: 'legacy curator' },
                principal: token
                    ? buildPrincipal({
                          kind: token.kind,
                          userId: toUserId('00000000-0000-4000-8000-000000000001'),
                          username: 'token curator',
                          userGroups: ['admins'],
                          tokenScopes: token.scopes,
                          ownerIsAdmin: token.ownerIsAdmin ?? true,
                      })
                    : { isAdmin: admin, username: 'curator' },
            },
            setHeaders: vi.fn(),
        } as unknown as RequestEvent;
        return mount(artistDef, { surface: 'internal' })[method]!(event);
    }

    // Deliberately model broken compilation tags: every ALBUMARTIST is the
    // individual performer, with no compilation flag or shared release credit.
    function compilationFile(index: number): string {
        return join(dir, index % 2 === 0 ? 'CD 01' : 'CD 02', `${index}.mp3`);
    }

    async function writeCompilationTrack(
        index: number,
        title = 'Prismatic Lanterns',
        release?: string,
    ): Promise<void> {
        const performer = `Lantern Ensemble ${index}`;
        await writeTrack(
            compilationFile(index),
            performer,
            '2026',
            release,
            performer,
            false,
            title,
        );
    }

    async function expectCompilation(count: number, id: string, artist: string): Promise<void> {
        expect(
            await sql`SELECT id FROM media_items WHERE media_type='album' AND status='active'`,
        ).toEqual([{ id }]);
        const rows = await sql<{ id: string; parent_id: string; artist: string }[]>`
            SELECT t.id,t.parent_id,p.title AS artist FROM media_items t
            JOIN media_items a ON a.id=t.parent_id JOIN media_items p ON p.id=a.parent_id
            WHERE t.media_type='track' AND t.status='active'
        `;
        expect(rows).toHaveLength(count);
        for (const row of rows) expect(row).toMatchObject({ parent_id: id, artist });
        const links = await sql`SELECT fi.file_id,fi.media_item_id FROM media_file_items fi
            JOIN media_files f ON f.id=fi.file_id WHERE f.is_missing IS NOT TRUE`;
        expect(links).toHaveLength(count);
        expect(new Set(links.map((row) => row.media_item_id)).size).toBe(count);
    }

    it('keeps same-title files with conflicting release IDs under separate albums', async () => {
        const first = join(dir, 'First.mp3');
        const second = join(dir, 'Second.mp3');
        await writeTrack(first, 'Cobalt Finch', '2026', RELEASE_A, '', false, 'Velvet Observatory');
        await writeTrack(
            second,
            'Amber Current',
            '2026',
            RELEASE_B,
            '',
            false,
            'Velvet Observatory',
        );
        await scanClean();
        expect(await albumFor(first)).not.toBe(await albumFor(second));
    });

    it('reuses the album when a second performer arrives with an inconsistent album artist tag', async () => {
        const first = join(dir, 'First.mp3');
        const second = join(dir, 'Second.mp3');
        await writeTrack(
            first,
            'Cobalt Finch',
            '2026',
            undefined,
            'Cobalt Finch',
            false,
            'Velvet Observatory',
        );
        await scanClean();
        const original = await albumFor(first);
        await writeTrack(
            second,
            'Amber Current',
            '2026',
            undefined,
            'Amber Current',
            false,
            'Velvet Observatory',
        );
        await scanClean();
        expect(await albumFor(first)).toBe(original);
        expect(await albumFor(second)).toBe(original);
        const [row] = await sql<
            { artist: string }[]
        >`SELECT p.title artist FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${original}`;
        expect(row.artist).toBe('Amber Current');
    });

    it('keeps two untagged performers in one album tree under the majority performer', async () => {
        const first = join(dir, 'CD1', 'First.mp3');
        await writeTrack(first, 'Cobalt Finch', '2026', undefined, '', false, 'Velvet Observatory');
        await writeTrack(
            join(dir, 'CD2', 'Second.mp3'),
            'Amber Current',
            '2026',
            undefined,
            '',
            false,
            'Velvet Observatory',
        );
        await writeTrack(
            join(dir, 'CD2', 'Third.mp3'),
            'Cobalt Finch',
            '2026',
            undefined,
            '',
            false,
            'Velvet Observatory',
        );
        await scanClean();
        const [row] = await sql<{ albums: number; artist: string }[]>`
            SELECT count(DISTINCT a.id)::int albums,min(p.title) artist
            FROM media_files f JOIN media_file_items fi ON fi.file_id=f.id
            JOIN media_items t ON t.id=fi.media_item_id JOIN media_items a ON a.id=t.parent_id
            JOIN media_items p ON p.id=a.parent_id WHERE f.library_group_id=${lp.library_group_id}
        `;
        expect(row).toEqual({ albums: 1, artist: 'Cobalt Finch' });
    });

    it('groups disc-suffixed album tags across CD folders and preserves placement on disc-only retags', async () => {
        const first = join(dir, 'CD 01', 'First.mp3');
        const second = join(dir, 'CD 02', 'Second.mp3');
        await writeTrack(
            first,
            'Dusk Ensemble',
            '2026',
            undefined,
            'Various Artists',
            true,
            'Night Drive Sessions 9 CD1',
        );
        await writeTrack(
            second,
            'Dawn Ensemble',
            '2026',
            undefined,
            'Various Artists',
            true,
            'Night Drive Sessions 9 - CD 2',
        );
        await scanClean();
        const id = await albumFor(first);
        expect(await albumFor(second)).toBe(id);
        expect(
            await sql`SELECT title FROM media_items WHERE media_type='album' AND status='active'`,
        ).toEqual([{ title: 'Night Drive Sessions 9' }]);
        const before =
            await sql`SELECT id,parent_id,custom_metadata->>'disc_number' AS disc FROM media_items WHERE media_type='track' ORDER BY id`;
        expect(before.map((row) => row.disc).sort()).toEqual(['1', '2']);
        // A curated merge title must survive a change of suffix spelling alone.
        await sql`UPDATE media_items SET title='Night Drive Anthology' WHERE id=${id}`;
        await writeTrack(
            second,
            'Dawn Ensemble',
            '2026',
            undefined,
            'Various Artists',
            true,
            'Night Drive Sessions 9 (Disc 2)',
        );
        const later = new Date(Date.now() + 60_000);
        await utimes(second, later, later);
        expect(await processAudioFile(sql, second, lp, ctx() as FileScannerContext)).toBe(
            'updated',
        );
        expect(
            await sql`SELECT id,parent_id,custom_metadata->>'disc_number' AS disc FROM media_items WHERE media_type='track' ORDER BY id`,
        ).toEqual(before);
        expect(await sql`SELECT title FROM media_items WHERE id=${id}`).toEqual([
            { title: 'Night Drive Anthology' },
        ]);
    }, 60_000);

    it('does not strip a lone suffix using evidence from another album folder', async () => {
        const plain = join(root, 'Loom Ensemble', 'Archive', 'Plain.mp3');
        const first = join(root, 'Loom Ensemble', 'Box Amber', 'First.mp3');
        const second = join(root, 'Loom Ensemble', 'Box Teal', 'Second.mp3');
        await writeTrack(
            plain,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon',
        );
        await processAudioFile(sql, plain, lp, ctx() as FileScannerContext);
        await writeTrack(
            first,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon CD1',
        );
        await processAudioFile(sql, first, lp, ctx() as FileScannerContext);
        await writeTrack(
            second,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon Disc 2',
        );
        await processAudioFile(sql, second, lp, ctx() as FileScannerContext);
        expect(new Set(await Promise.all([plain, first, second].map(albumFor))).size).toBe(3);
        expect(
            (
                await sql<
                    { title: string }[]
                >`SELECT title FROM media_items WHERE media_type='album' ORDER BY title`
            ).map((row) => row.title),
        ).toEqual(['Copper Horizon', 'Copper Horizon CD1', 'Copper Horizon Disc 2']);
        // Without same-folder evidence, changing a suffix changes placement too.
        await writeTrack(
            first,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon CD3',
        );
        const later = new Date(Date.now() + 60_000);
        await utimes(first, later, later);
        await processAudioFile(sql, first, lp, ctx() as FileScannerContext);
        expect(await sql`SELECT title FROM media_items WHERE id=${await albumFor(first)}`).toEqual([
            { title: 'Copper Horizon CD3' },
        ]);
    }, 60_000);

    it('uses different same-folder markers on the first scan, including cleaned scene tails', async () => {
        const first = join(dir, 'First.mp3');
        const second = join(dir, 'Second.mp3');
        await writeTrack(
            first,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon CD1 (2000)',
        );
        await writeTrack(
            second,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon Disc 2 WEB',
        );
        await scanClean();
        expect(await albumFor(first)).toBe(await albumFor(second));
        expect(await sql`SELECT title FROM media_items WHERE media_type='album'`).toEqual([
            { title: 'Copper Horizon' },
        ]);
        const numbers = await sql<{ disc: string }[]>`
            SELECT custom_metadata->>'disc_number' AS disc FROM media_items WHERE media_type='track' ORDER BY disc`;
        expect(numbers.map((row) => row.disc)).toEqual(['1', '2']);
    }, 60_000);

    it('reuses exact unrepaired disc albums, then the oldest, without creating a third base album', async () => {
        // Seed two independent existing albums before collapsing their physical folder.
        const seeds = [
            join(root, 'Seed Amber', 'First.mp3'),
            join(root, 'Seed Teal', 'Second.mp3'),
        ];
        const existing: string[] = [];
        for (const [index, file] of seeds.entries()) {
            await writeTrack(
                file,
                'Loom Ensemble',
                '2026',
                undefined,
                'Loom Ensemble',
                false,
                `Copper Horizon CD${index + 1}`,
            );
            await processAudioFile(sql, file, lp, ctx() as FileScannerContext);
            existing.push(await albumFor(file));
        }
        expect(existing[0]).not.toBe(existing[1]);
        await sql`UPDATE media_items SET created_at='2026-01-01' WHERE id=${existing[0]}`;
        await sql`UPDATE media_items SET created_at='2026-02-01' WHERE id=${existing[1]}`;
        await mkdir(dir, { recursive: true });
        for (const [index, seed] of seeds.entries()) {
            const destination = join(dir, `Seed${index}.mp3`);
            await rename(seed, destination);
            await sql`UPDATE media_files SET file_path=${destination} WHERE file_path=${seed}`;
        }
        const added = join(dir, 'Added.mp3');
        await writeTrack(
            added,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon CD2',
        );
        await processAudioFile(sql, added, lp, ctx() as FileScannerContext);
        expect(await albumFor(added)).toBe(existing[1]);
        // A real retag (year changes too) must also prefer the exact CD2 album.
        await writeTrack(
            added,
            'Loom Ensemble',
            '2025',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon CD2',
        );
        const later = new Date(Date.now() + 60_000);
        await utimes(added, later, later);
        await processAudioFile(sql, added, lp, ctx() as FileScannerContext);
        expect(await albumFor(added)).toBe(existing[1]);
        const thirdDisc = join(dir, 'Third.mp3');
        await writeTrack(
            thirdDisc,
            'Loom Ensemble',
            '2026',
            undefined,
            'Loom Ensemble',
            false,
            'Copper Horizon CD3',
        );
        await processAudioFile(sql, thirdDisc, lp, ctx() as FileScannerContext);
        expect(await albumFor(thirdDisc)).toBe(existing[0]);
        await sql`UPDATE media_items SET created_at='2026-01-01' WHERE id=ANY(${existing}::uuid[])`;
        expect(
            await findExistingFolderAlbum(
                sql,
                dir,
                'Copper Horizon',
                { album: 'Copper Horizon CD4', albumArtist: 'Loom Ensemble' },
                lp.library_group_id,
            ),
        ).toBe([...existing].sort()[0]);
        expect(
            await sql`SELECT title FROM media_items WHERE media_type='album' ORDER BY title`,
        ).toEqual([{ title: 'Copper Horizon CD1' }, { title: 'Copper Horizon CD2' }]);
    }, 60_000);

    it('uses tag, then folder, then suffix for disc numbers on create and backfill', async () => {
        const files = [
            join(dir, 'CD 05', 'Tagged.mp3'),
            join(dir, 'CD 02', 'Folder.mp3'),
            join(dir, 'Suffix.mp3'),
        ];
        await writeTrack(
            files[0],
            'Cloud Ensemble',
            '2026',
            undefined,
            'Curator',
            false,
            'Cloud Transit CD6',
            '4',
        );
        await writeTrack(
            files[1],
            'Cloud Ensemble',
            '2026',
            undefined,
            'Curator',
            false,
            'Cloud Transit CD7',
        );
        await writeTrack(
            files[2],
            'Cloud Ensemble',
            '2026',
            undefined,
            'Curator',
            false,
            'Cloud Transit [Disc 3]',
        );
        const discs = async (): Promise<string[]> => {
            const values: string[] = [];
            for (const file of files) {
                const [row] = await sql<
                    { disc: string }[]
                >`SELECT t.custom_metadata->>'disc_number' AS disc FROM media_items t JOIN media_file_items fi ON fi.media_item_id=t.id JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${file}`;
                values.push(row.disc);
            }
            return values;
        };
        for (const file of files)
            await processAudioFile(sql, file, lp, ctx() as FileScannerContext);
        expect(new Set(await Promise.all(files.map(albumFor))).size).toBe(1);
        expect(await discs()).toEqual(['4', '2', '3']);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata-'disc_number' WHERE media_type='track'`;
        for (const file of files)
            await processAudioFile(sql, file, lp, ctx() as FileScannerContext);
        expect(await discs()).toEqual(['4', '2', '3']);
    }, 60_000);

    it('a full scan backfills missing disc numbers on unchanged one-folder tracks only once', async () => {
        const discFile = join(dir, '02 Lantern Song.mp3');
        const ordinaryFile = join(root, 'Cloud Ensemble', 'Plain Album', '01 Plain Song.mp3');
        await writeTrack(
            discFile,
            'Cloud Ensemble',
            '2026',
            undefined,
            'Curator',
            false,
            'Cloud Transit - CD2',
        );
        await writeTrack(
            ordinaryFile,
            'Cloud Ensemble',
            '2026',
            undefined,
            'Cloud Ensemble',
            false,
            'Plain Album',
        );
        await scanClean();
        const [before] = await sql<
            { id: string; parent_id: string; custom_metadata: Record<string, unknown> }[]
        >`
            SELECT t.id, t.parent_id, t.custom_metadata FROM media_items t
            JOIN media_file_items fi ON fi.media_item_id=t.id
            JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${discFile}`;
        expect(before.custom_metadata.disc_number).toBe(2);
        // Model a pre-fix row: track number already present, only disc missing.
        await sql`UPDATE media_items SET custom_metadata=(custom_metadata-'disc_number') || '{"track_number":2}'::jsonb WHERE id=${before.id}`;
        const [fileBefore] = await sql`SELECT * FROM media_files WHERE file_path=${discFile}`;
        const known = await loadMediaFilesByPrefix(sql, root);
        expect((await triageFiles([discFile, ordinaryFile], known)).unchanged.sort()).toEqual(
            [discFile, ordinaryFile].sort(),
        );
        expect(await findTrackFilesMissingDiscNumberByPrefix(sql, root)).toEqual([
            { file_path: discFile, album: 'Cloud Transit - CD2' },
        ]);
        const parser = vi.spyOn(audioTagParser, 'parseAudioTags');
        try {
            await scanClean();
            const [after] = await sql<
                { id: string; parent_id: string; custom_metadata: Record<string, unknown> }[]
            >`
                SELECT id,parent_id,custom_metadata FROM media_items WHERE id=${before.id}`;
            expect(after.custom_metadata.disc_number).toBe(2);
            expect(after.custom_metadata.track_number).toBe(2);
            expect(after.parent_id).toBe(before.parent_id);
            expect(parser.mock.calls.some(([file]) => file === discFile)).toBe(true);
            expect(parser.mock.calls.some(([file]) => file === ordinaryFile)).toBe(false);
            expect((await sql`SELECT * FROM media_files WHERE file_path=${discFile}`)[0]).toEqual(
                fileBefore,
            );
            parser.mockClear();
            await scanClean();
            expect(parser).not.toHaveBeenCalled();
        } finally {
            parser.mockRestore();
        }
    }, 60_000);

    it('backfills an unchanged CD1 folder track once without an album-tag marker', async () => {
        const file = join(dir, 'CD1', '01 Opal Song.mp3');
        await writeTrack(file, 'Opal Ensemble');
        await scanClean();
        await sql`UPDATE media_items SET custom_metadata=custom_metadata-'disc_number' WHERE media_type='track'`;
        expect(await findTrackFilesMissingDiscNumberByPrefix(sql, root + '/')).toEqual([
            { file_path: file, album: 'Festival (2026)' },
        ]);
        const parser = vi.spyOn(audioTagParser, 'parseAudioTags');
        try {
            await scanClean();
            expect(parser.mock.calls.some(([path]) => path === file)).toBe(true);
            expect(
                await sql`SELECT custom_metadata->'disc_number' AS disc FROM media_items WHERE media_type='track'`,
            ).toEqual([{ disc: 1 }]);
            expect(await findTrackFilesMissingDiscNumberByPrefix(sql, root)).toEqual([]);
            parser.mockClear();
            await scanClean();
            expect(parser).not.toHaveBeenCalled();
        } finally {
            parser.mockRestore();
        }
    }, 60_000);

    it('keeps ordinary, locked, dismissed, segmented and multi-link files out of disc catch-up', async () => {
        const names = ['Plain', 'Locked', 'Dismissed', 'Segment', 'Multi'];
        const files = names.map((name) => join(dir, name + '.mp3'));
        for (const [index, file] of files.entries()) {
            await writeTrack(
                file,
                `Opal Ensemble ${index}`,
                '2026',
                undefined,
                'Curator',
                false,
                index === 0 ? 'Opal Horizon' : 'Opal Horizon - CD2',
            );
        }
        await scanClean();
        await sql`UPDATE media_items SET custom_metadata=custom_metadata-'disc_number' WHERE media_type='track'`;
        await sql`UPDATE media_items SET metadata_locked=true WHERE id IN (
            SELECT fi.media_item_id FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${files[1]})`;
        await sql`UPDATE media_items SET is_dismissed=true WHERE id IN (
            SELECT fi.media_item_id FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${files[2]})`;
        await sql`UPDATE media_file_items SET start_offset_ms=0, end_offset_ms=1000 WHERE file_id IN (
            SELECT id FROM media_files WHERE file_path=${files[3]})`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"disc_number":2}'::jsonb WHERE id IN (
            SELECT fi.media_item_id FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${files[4]})`;
        // The processor picks an arbitrary first link. A second whole-file link
        // (or a segment beside a whole-file link) must not become a disc candidate.
        const [extra] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,media_type,title_source,custom_metadata)
            VALUES ('Opal Alternate', 'track', 'tag', '{"album":"Opal Horizon - CD2"}'::jsonb) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default)
            SELECT id,${extra.id},true FROM media_files WHERE file_path=${files[4]}`;
        const candidates = await findTrackFilesMissingDiscNumberByPrefix(sql, root);
        expect(candidates.filter((row) => row.file_path === files[4])).toEqual([]);
        expect(candidates).toEqual([]);
        const parser = vi.spyOn(audioTagParser, 'parseAudioTags');
        try {
            for (let pass = 0; pass < 2; pass++) {
                await scanClean();
                expect(parser).not.toHaveBeenCalled();
                expect(await findTrackFilesMissingDiscNumberByPrefix(sql, root)).toEqual([]);
            }
            await sql`UPDATE media_file_items SET start_offset_ms=0, end_offset_ms=1000 WHERE media_item_id=${extra.id}`;
            expect(await findTrackFilesMissingDiscNumberByPrefix(sql, root)).toEqual([]);
        } finally {
            parser.mockRestore();
        }
    }, 60_000);

    it('prefilters disc ordinals and cleaned scene markers within literal path bounds', async () => {
        const folder = join(root, 'Opal%_Archive');
        const file = join(folder, '01 Opal Song.mp3');
        const neighbor = join(root, 'OpalXXArchive', '02 Opal Song.mp3');
        await writeTrack(file, 'Opal Ensemble');
        await writeTrack(neighbor, 'Amber Ensemble');
        await scanClean();
        for (const album of [
            'Opal Horizon CD1',
            'Opal Horizon - CD 02',
            'Opal Horizon [Disc 3]',
            'Opal Horizon (Disk 4)',
            'Opal Horizon — Disc 5',
            'Opal Horizon: Disk 6',
            'Opal Horizon, CD7',
            'Opal Horizon [Disc 8 of 9]',
            'Opal Horizon CD20',
            'Opal Horizon CD2 (2000)',
            'Opal Horizon CD2 WEB',
            'Opal_Horizon__CD2',
        ]) {
            await sql`UPDATE media_items SET custom_metadata=(custom_metadata-'disc_number') || jsonb_build_object('album',${album}::text) WHERE media_type='track'`;
            expect(await findTrackFilesMissingDiscNumberByPrefix(sql, folder)).toEqual([
                { file_path: file, album },
            ]);
        }
        for (const album of [
            'Opal Horizon',
            'Opal Horizon 2CD',
            'Opal Horizon CD0',
            'Opal Horizon CD21',
            'Opal Horizon Part 2',
        ]) {
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || jsonb_build_object('album',${album}::text) WHERE media_type='track'`;
            expect(await findTrackFilesMissingDiscNumberByPrefix(sql, folder)).toEqual([]);
        }
    }, 60_000);

    it('does not query disc candidates when triage has no unchanged files', async () => {
        const file = join(dir, '01 Opal Song.mp3');
        await writeTrack(file, 'Opal Ensemble');
        await scanClean();
        await writeTrack(file, 'Opal Ensemble with changed tags');
        const later = new Date(Date.now() + 60_000);
        await utimes(file, later, later);
        const candidates = vi.spyOn(mediaFilesQueries, 'findTrackFilesMissingDiscNumberByPrefix');
        try {
            await scanClean();
            expect(candidates).not.toHaveBeenCalled();
        } finally {
            candidates.mockRestore();
        }
    }, 60_000);

    it('full scan groups twelve per-track ALBUMARTIST performers across CD 01 and CD 02', async () => {
        for (let i = 0; i < 12; i++) await writeCompilationTrack(i);
        await scanClean();
        await expectCompilation(12, await albumFor(compilationFile(0)), 'Various Artists');
    }, 120_000);

    it('incremental scans retain the first lone track album as twelve performers arrive', async () => {
        await writeCompilationTrack(0);
        await scanClean();
        const firstAlbum = await albumFor(compilationFile(0));
        await expectCompilation(1, firstAlbum, 'Lantern Ensemble 0');
        for (let i = 1; i < 12; i++) {
            await writeCompilationTrack(i);
            await scanClean();
            expect(await albumFor(compilationFile(i))).toBe(firstAlbum);
            expect(
                await sql`SELECT id FROM media_items WHERE media_type='album' AND status='active'`,
            ).toEqual([{ id: firstAlbum }]);
        }
        await expectCompilation(12, firstAlbum, 'Various Artists');
    }, 180_000);

    // Same-title releases told apart only by MusicBrainz release id still collapse;
    // release-aware album identity is deferred until after 1.0 ('release id' case).
    it.each<'title' | 'release id'>(['title'])(
        'keeps two compilations separate in one CD folder tree by %s',
        async (difference) => {
            for (let i = 0; i < 24; i++) {
                await writeCompilationTrack(
                    i,
                    difference === 'title' && i >= 12 ? 'Opaline Horizons' : 'Prismatic Lanterns',
                    difference === 'release id' ? (i < 12 ? RELEASE_A : RELEASE_B) : undefined,
                );
            }
            await scanClean();
            const first = await albumFor(compilationFile(0));
            const second = await albumFor(compilationFile(12));
            expect(first).not.toBe(second);
            expect(
                await sql`SELECT id FROM media_items WHERE media_type='album' AND status='active'`,
            ).toHaveLength(2);
            for (let i = 0; i < 24; i++)
                expect(await albumFor(compilationFile(i))).toBe(i < 12 ? first : second);
            expect(
                await sql`SELECT parent_id,count(*)::int AS n FROM media_items
                WHERE media_type='track' GROUP BY parent_id ORDER BY parent_id`,
            ).toEqual([first, second].sort().map((id) => ({ parent_id: id, n: 12 })));
            if (difference === 'release id') {
                const [album] = await sql<{ parent_id: string }[]>`
                    SELECT parent_id FROM media_items WHERE id=${first}
                `;
                const temporaryParent = await findOrCreateMusicArtist(sql, {
                    name: 'Opaline Ensemble',
                    libraryGroupId: lp.library_group_id,
                });
                await reparentAlbumToArtist(sql, second, temporaryParent);
                expect(await alignFolderAlbumParent(sql, second, album.parent_id)).toBe(second);
                expect(await albumFor(compilationFile(12))).toBe(second);
                expect(
                    await sql`SELECT id FROM media_items WHERE media_type='album' AND status='active'`,
                ).toHaveLength(2);
            }
        },
        120_000,
    );

    it('preserves an admin-locked artist while twelve per-track album artists arrive', async () => {
        await writeCompilationTrack(0);
        await scanClean();
        albumId = await albumFor(compilationFile(0));
        const response = await assign('POST', { artistName: 'Opaline Curator' });
        expect(response.status).toBe(200);
        for (let i = 1; i < 12; i++) await writeCompilationTrack(i);
        await scanClean();
        await expectCompilation(12, albumId, 'Opaline Curator');
        expect(await sql`SELECT metadata_locked FROM media_items WHERE id=${albumId}`).toEqual([
            { metadata_locked: true },
        ]);
    }, 120_000);

    it.each(['PATCH', 'POST'] as const)(
        'manual %s survives an actual normal scan with contradictory tags',
        async (method) => {
            await initialScan();
            // Seed the existing catalogue shape: two physical copies per track.
            // Register both paths before scanning, avoiding rename-by-hash's
            // inference for an unregistered byte-identical file.
            for (const name of ['Old.mp3', 'Other.mp3']) {
                const original = join(dir, name);
                const copy = join(dir, 'Copy-' + name);
                await copyFile(original, copy);
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path,library_group_id,file_size_bytes,file_mtime,file_hash_head)
                    SELECT ${copy},library_group_id,file_size_bytes,file_mtime,file_hash_head FROM media_files WHERE file_path=${original}
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id,media_item_id,is_default)
                    SELECT ${file.id},fi.media_item_id,false FROM media_file_items fi
                    JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${original}
                `;
            }
            const user = randomUUID();
            await sql`INSERT INTO users (id,username) VALUES (${user},${'manual-assignment-' + user})`;
            await sql`INSERT INTO user_media_state (user_id,media_id,is_watched,resume_position_ms) VALUES (${user},${albumId},true,12345)`;
            // Actual nonempty persisted canonical credits, rather than an empty
            // JSON object comparison. Keep file-tag evidence unchanged.
            const tracks = await sql<
                { id: string; artist: string }[]
            >`SELECT id,custom_metadata->>'artist' AS artist FROM media_items WHERE parent_id=${albumId} AND media_type='track' ORDER BY id`;
            for (const track of tracks) {
                const performer = await findOrCreateMusicArtist(sql, { name: track.artist });
                await sql`UPDATE media_items SET custom_metadata=jsonb_set(custom_metadata,'{track_artist_credits}',${sql.json([{ id: performer, credited_name: track.artist }])}) WHERE id=${track.id}`;
            }
            const beforeCredits =
                await sql`SELECT id,custom_metadata->'track_artist_credits' AS credits FROM media_items WHERE parent_id=${albumId} AND media_type='track' ORDER BY id`;
            expect(beforeCredits).toHaveLength(2);
            for (const row of beforeCredits) expect(row.credits).toHaveLength(1);
            // Linked-file decoder verdict, unrelated to successful ID3 parsing.
            await sql`UPDATE media_files SET health_issues='[{"type":"container_unreadable","detected_at":"2026-01-01T00:00:00Z","detail":"Decoder review required"}]'::jsonb WHERE file_path=${join(dir, 'Old.mp3')}`;
            const beforeWarnings =
                await sql`SELECT id,health_issues FROM media_files WHERE health_issues IS NOT NULL ORDER BY id`;
            const beforeState = await sql`SELECT * FROM user_media_state WHERE user_id=${user}`;
            const beforeAlbum =
                await sql`SELECT id,title,custom_metadata FROM media_items WHERE id=${albumId}`;
            const beforeArtists =
                await sql`SELECT id,title FROM media_items WHERE media_type='artist' ORDER BY id`;
            const chosen = await findOrCreateMusicArtist(sql, { name: 'Manual curator' });
            const beforeTracks =
                await sql`SELECT id,parent_id,custom_metadata FROM media_items WHERE media_type='track' ORDER BY id`;
            const beforeFiles = await sql`SELECT id,file_path FROM media_files ORDER BY id`;
            const beforeLinks =
                await sql`SELECT file_id,media_item_id FROM media_file_items ORDER BY file_id,media_item_id`;
            expect(beforeTracks).toHaveLength(2);
            expect(beforeFiles).toHaveLength(4);
            const response = await assign(
                method,
                method === 'PATCH' ? { artistId: chosen } : { artistName: 'New curator' },
                true,
                method === 'POST',
            );
            expect(response.status).toBe(200);
            const { artistId } = await response.json();
            // A genuinely new track forces normal folder-parent alignment;
            // the original four copies retain their original IDs/credits/state.
            await writeTrack(join(dir, 'New-while-locked.mp3'), 'New Guest');
            // The originals retain their unchanged contradictory artist tags.
            for (const name of ['Old.mp3', 'Other.mp3', 'Copy-Old.mp3', 'Copy-Other.mp3']) {
                const file = join(dir, name);
                const date = new Date(Date.now() + 5000);
                await utimes(file, date, date);
            }
            await scanClean();
            expect(await albumFor(join(dir, 'Old.mp3'))).toBe(albumId);
            const [album] =
                await sql`SELECT parent_id,metadata_locked,metadata_locked_by,metadata_locked_at FROM media_items WHERE id=${albumId}`;
            expect(album).toMatchObject({
                parent_id: artistId,
                metadata_locked: true,
                metadata_locked_by: 'curator',
            });
            expect(album.metadata_locked_at).toBeTruthy();
            expect(
                await sql`SELECT id,custom_metadata->'track_artist_credits' AS credits FROM media_items WHERE id=ANY(${beforeCredits.map((r) => r.id)}::uuid[]) ORDER BY id`,
            ).toEqual(beforeCredits);
            expect(
                await sql`SELECT id,health_issues FROM media_files WHERE health_issues IS NOT NULL ORDER BY id`,
            ).toEqual(beforeWarnings);
            expect(
                await sql`SELECT file_id,media_item_id FROM media_file_items ORDER BY file_id,media_item_id`,
            ).toEqual(expect.arrayContaining(beforeLinks));
            expect(await sql`SELECT file_id FROM media_file_items`).toHaveLength(5);
            expect(await sql`SELECT * FROM user_media_state WHERE user_id=${user}`).toEqual(
                beforeState,
            );
            expect(
                await sql`SELECT id,title,custom_metadata FROM media_items WHERE id=${albumId}`,
            ).toEqual(beforeAlbum);
            expect(
                await sql`SELECT id,title FROM media_items WHERE media_type='artist' ORDER BY id`,
            ).toEqual(expect.arrayContaining(beforeArtists));
            expect(
                await sql`SELECT id,parent_id,custom_metadata FROM media_items WHERE media_type='track' ORDER BY id`,
            ).toEqual(expect.arrayContaining(beforeTracks));
            expect(await sql`SELECT id FROM media_items WHERE media_type='track'`).toHaveLength(3);
            expect(await sql`SELECT id,file_path FROM media_files ORDER BY id`).toEqual(
                expect.arrayContaining(beforeFiles),
            );
            expect(await sql`SELECT id FROM media_files`).toHaveLength(5);
        },
    );

    it('same-parent confirmation locks, while rejected requests leave the album unlocked', async () => {
        await initialScan();
        const [before] = await sql`SELECT parent_id FROM media_items WHERE id=${albumId}`;
        expect((await assign('PATCH', { artistId: before.parent_id }, false)).status).toBe(403);
        expect((await assign('POST', { artistName: 'No authorization' }, false)).status).toBe(403);
        expect((await assign('POST', { artistName: 'x'.repeat(256) })).status).toBe(422);
        expect((await assign('PATCH', { artistId: 'invalid' })).status).toBe(422);
        expect((await assign('PATCH', { artistId: randomUUID() })).status).toBe(404);
        expect(
            (await sql`SELECT metadata_locked FROM media_items WHERE id=${albumId}`)[0]
                .metadata_locked,
        ).toBe(false);
        expect((await assign('PATCH', { artistId: before.parent_id }, true, true)).status).toBe(
            200,
        );
        expect(
            (
                await sql`SELECT metadata_locked,metadata_locked_by FROM media_items WHERE id=${albumId}`
            )[0],
        ).toMatchObject({ metadata_locked: true, metadata_locked_by: 'curator' });
        const wrong = await findOrCreateMusicArtist(sql, {
            name: 'Contradictory automatic parent',
        });
        await alignFolderAlbumParent(sql, albumId, wrong);
        expect(
            (await sql`SELECT parent_id FROM media_items WHERE id=${albumId}`)[0].parent_id,
        ).toBe(before.parent_id);
        await sql`UPDATE media_items SET metadata_locked_by='previous editor',metadata_locked_at='2020-01-01' WHERE id=${albumId}`;
        expect((await assign('PATCH', { artistId: wrong })).status).toBe(200);
        expect(
            (
                await sql`SELECT parent_id,metadata_locked,metadata_locked_by,metadata_locked_at > '2020-01-01'::timestamptz AS refreshed FROM media_items WHERE id=${albumId}`
            )[0],
        ).toMatchObject({
            parent_id: wrong,
            metadata_locked: true,
            metadata_locked_by: 'curator',
            refreshed: true,
        });
    });

    it('assignment conflicts roll back without locking or changing either album', async () => {
        await initialScan();
        const target = await findOrCreateMusicArtist(sql, { name: 'Collision artist' });
        const [album] = await sql`SELECT title,parent_id FROM media_items WHERE id=${albumId}`;
        await findOrCreateMusicAlbum(sql, { title: album.title, artistId: target });
        expect((await assign('PATCH', { artistId: target })).status).toBe(409);
        expect((await assign('POST', { artistName: 'Collision artist' })).status).toBe(409);
        expect(
            (await sql`SELECT parent_id,metadata_locked FROM media_items WHERE id=${albumId}`)[0],
        ).toMatchObject({ parent_id: album.parent_id, metadata_locked: false });
    });

    it.each(['manual-first', 'scanner-first', 'manual-again'] as const)(
        '%s competing transactions preserve the manual assignment',
        async (order) => {
            await initialScan();
            const manual = await findOrCreateMusicArtist(sql, { name: 'Chosen curator' });
            const automatic = await findOrCreateMusicArtist(sql, { name: 'Tag curator' });
            const first = postgres(getTestDatabaseUrl(), { max: 1 });
            const second = postgres(getTestDatabaseUrl(), {
                max: 1,
                connection: { application_name: 'manual-artist-contender' },
            });
            let release!: () => void;
            let ready!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const locked = new Promise<void>((resolve) => {
                ready = resolve;
            });
            const operation = (db: postgres.Sql, isManual: boolean): Promise<unknown> =>
                isManual
                    ? reparentAlbumToArtist(db, albumId, manual, { manualActor: 'winning curator' })
                    : alignFolderAlbumParent(db, albumId, automatic);
            const holder = first.begin(async (tx) => {
                if (order === 'manual-again') {
                    await reparentAlbumToArtist(tx as unknown as postgres.Sql, albumId, automatic, {
                        manualActor: 'first editor',
                    });
                } else {
                    await operation(tx as unknown as postgres.Sql, order === 'manual-first');
                }
                ready();
                await gate;
            });
            let contender: Promise<unknown> | undefined;
            try {
                await locked;
                contender = operation(second, order !== 'manual-first');
                await vi.waitFor(async () => {
                    const [row] =
                        await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='manual-artist-contender' AND cardinality(pg_blocking_pids(pid)) > 0`;
                    expect(row.count).toBe(1);
                });
                release();
                await holder;
                await contender;
                expect(
                    (
                        await sql`SELECT parent_id,metadata_locked,metadata_locked_by FROM media_items WHERE id=${albumId}`
                    )[0],
                ).toMatchObject({
                    parent_id: manual,
                    metadata_locked: true,
                    metadata_locked_by: 'winning curator',
                });
            } finally {
                release();
                await Promise.allSettled([holder, contender]);
                await first.end();
                await second.end();
            }
        },
    );

    it.each(['album', 'artist', 'album-type', 'artist-type'] as const)(
        'revalidates a concurrently changed %s and rolls back all writes',
        async (kind) => {
            await initialScan();
            const target = await findOrCreateMusicArtist(sql, { name: 'Current target' });
            const holderDb = postgres(getTestDatabaseUrl(), { max: 1 });
            const requestDb = postgres(getTestDatabaseUrl(), {
                max: 1,
                connection: { application_name: 'manual-stale-target' },
            });
            let ready!: () => void;
            let release!: () => void;
            const locked = new Promise<void>((resolve) => {
                ready = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const albumChange = kind.startsWith('album');
            const heldId = albumChange ? albumId : target;
            const holder = holderDb.begin(async (tx) => {
                if (kind.endsWith('-type')) {
                    await tx`UPDATE media_items SET media_type='movie' WHERE id=${heldId}`;
                } else {
                    await tx`UPDATE media_items SET status='deleted' WHERE id=${heldId}`;
                }
                ready();
                await gate;
            });
            let request: Promise<Response> | undefined;
            try {
                await locked;
                vi.mocked(connection.getDb).mockReturnValueOnce(requestDb);
                // Ordinary validation sees the old committed active row. Validation
                // under the row lock must see the deletion after the wait instead.
                request = albumChange
                    ? assign('POST', { artistName: 'Must roll back newly inserted artist' })
                    : assign('PATCH', { artistId: target });
                await vi.waitFor(async () => {
                    const [row] =
                        await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='manual-stale-target' AND cardinality(pg_blocking_pids(pid)) > 0`;
                    expect(row.count).toBe(1);
                });
                release();
                await holder;
                expect((await request).status).toBe(kind === 'album-type' ? 422 : 404);
                expect(
                    (await sql`SELECT metadata_locked FROM media_items WHERE id=${albumId}`)[0]
                        .metadata_locked,
                ).toBe(false);
                expect(
                    await sql`SELECT id FROM media_items WHERE title='Must roll back newly inserted artist'`,
                ).toHaveLength(0);
            } finally {
                release();
                await Promise.allSettled([holder, request]);
                await holderDb.end();
                await requestDb.end();
            }
        },
    );

    it('the established unlock restores actual contradictory-tag scanner alignment', async () => {
        await initialScan();
        const manual = await findOrCreateMusicArtist(sql, { name: 'Unlocked manual choice' });
        expect((await assign('PATCH', { artistId: manual })).status).toBe(200);
        const originalTracks =
            await sql`SELECT id,parent_id,custom_metadata FROM media_items WHERE media_type='track' ORDER BY id`;
        const originalFiles = await sql`SELECT id,file_path FROM media_files ORDER BY id`;
        const originalLinks =
            await sql`SELECT file_id,media_item_id FROM media_file_items ORDER BY file_id`;
        await writeTrack(join(dir, 'New-while-locked.mp3'), 'Locked New Performer');
        await scanClean();
        expect(
            (await sql`SELECT parent_id,metadata_locked FROM media_items WHERE id=${albumId}`)[0],
        ).toMatchObject({ parent_id: manual, metadata_locked: true });
        expect(await albumFor(join(dir, 'New-while-locked.mp3'))).toBe(albumId);
        expect(await unlockMediaItem(sql, albumId)).toBe(true);
        expect(
            (
                await sql`SELECT metadata_locked,metadata_locked_by,metadata_locked_at FROM media_items WHERE id=${albumId}`
            )[0],
        ).toMatchObject({
            metadata_locked: false,
            metadata_locked_by: null,
            metadata_locked_at: null,
        });
        for (const name of ['Old.mp3', 'Other.mp3']) {
            const date = new Date(Date.now() + 5000);
            await utimes(join(dir, name), date, date);
        }
        await writeTrack(join(dir, 'New-after-unlock.mp3'), 'New Performer');
        await scanClean();
        const [album] =
            await sql`SELECT a.parent_id,p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${albumId}`;
        expect(album.parent_id).not.toBe(manual);
        expect(album.title).toBe('Curator');
        expect(await albumFor(join(dir, 'Old.mp3'))).toBe(albumId);
        expect(
            await sql`SELECT id,parent_id,custom_metadata FROM media_items WHERE media_type='track' ORDER BY id`,
        ).toEqual(expect.arrayContaining(originalTracks));
        expect(await sql`SELECT id,file_path FROM media_files ORDER BY id`).toEqual(
            expect.arrayContaining(originalFiles),
        );
        expect(
            await sql`SELECT file_id,media_item_id FROM media_file_items ORDER BY file_id`,
        ).toEqual(expect.arrayContaining(originalLinks));
        expect(await sql`SELECT id FROM media_items WHERE media_type='track'`).toHaveLength(4);
        expect(await sql`SELECT id FROM media_files`).toHaveLength(4);
    });

    it.each(['PATCH', 'POST'] as const)(
        '%s rolls back a real lock-write failure after the parent UPDATE',
        async (method) => {
            await initialScan();
            const target = await findOrCreateMusicArtist(sql, { name: 'Failure target' });
            const before =
                await sql`SELECT parent_id,metadata_locked,metadata_locked_by,metadata_locked_at FROM media_items WHERE id=${albumId}`;
            const artists =
                await sql`SELECT id,title FROM media_items WHERE media_type='artist' ORDER BY id`;
            // Sequences are nontransactional: its increment independently proves
            // that the parent UPDATE ran before the lock-write exception/rollback.
            await sql`CREATE SEQUENCE manual_artist_parent_updates`;
            await sql.unsafe(`CREATE FUNCTION manual_artist_lock_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.id='${albumId}'::uuid THEN
                IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN PERFORM nextval('manual_artist_parent_updates'); END IF;
                IF NEW.metadata_locked IS TRUE AND OLD.metadata_locked IS FALSE THEN RAISE EXCEPTION 'injected metadata-lock SQL failure'; END IF;
            END IF;
            RETURN NEW;
        END $$`);
            await sql`CREATE TRIGGER manual_artist_lock_failure BEFORE UPDATE ON media_items FOR EACH ROW EXECUTE FUNCTION manual_artist_lock_failure()`;
            try {
                const response = await assign(
                    method,
                    method === 'PATCH'
                        ? { artistId: target }
                        : { artistName: 'Must roll back lock-failure artist' },
                );
                expect(response.status).toBe(500);
                expect(
                    (await sql`SELECT is_called FROM manual_artist_parent_updates`)[0].is_called,
                ).toBe(true);
                expect(
                    await sql`SELECT parent_id,metadata_locked,metadata_locked_by,metadata_locked_at FROM media_items WHERE id=${albumId}`,
                ).toEqual(before);
                expect(
                    await sql`SELECT id,title FROM media_items WHERE media_type='artist' ORDER BY id`,
                ).toEqual(artists);
            } finally {
                await sql`DROP TRIGGER manual_artist_lock_failure ON media_items`;
                await sql`DROP FUNCTION manual_artist_lock_failure()`;
                await sql`DROP SEQUENCE manual_artist_parent_updates`;
            }
        },
    );

    it.each(['PATCH', 'POST'] as const)(
        '%s retains scoped-token authority and principal actor precedence',
        async (method) => {
            await initialScan();
            const target = await findOrCreateMusicArtist(sql, { name: 'Scoped target' });
            for (const kind of ['pat', 'service_token', 'bearer'] as const) {
                const before =
                    await sql`SELECT parent_id,metadata_locked,metadata_locked_by,metadata_locked_at FROM media_items WHERE id=${albumId}`;
                const artists =
                    await sql`SELECT id,title FROM media_items WHERE media_type='artist' ORDER BY id`;
                const denied = await assign(
                    method,
                    method === 'PATCH' ? { artistId: target } : { artistName: 'Denied ' + kind },
                    true,
                    false,
                    { kind, scopes: ['read'] },
                );
                expect(denied.status).toBe(403);
                expect(
                    await sql`SELECT parent_id,metadata_locked,metadata_locked_by,metadata_locked_at FROM media_items WHERE id=${albumId}`,
                ).toEqual(before);
                expect(
                    await sql`SELECT id,title FROM media_items WHERE media_type='artist' ORDER BY id`,
                ).toEqual(artists);
            }
            // buildPrincipal uses the same owner+scope policy as resolveAuth/mount;
            // token username intentionally differs from legacy locals.user.
            for (const kind of ['pat', 'service_token'] as const) {
                const allowed = await assign(
                    method,
                    method === 'PATCH' ? { artistId: target } : { artistName: 'Allowed ' + kind },
                    true,
                    false,
                    { kind, scopes: ['admin'] },
                );
                expect(allowed.status).toBe(200);
                expect(
                    (await sql`SELECT metadata_locked_by FROM media_items WHERE id=${albumId}`)[0]
                        .metadata_locked_by,
                ).toBe('token curator');
            }
            expect(
                (
                    await assign('PATCH', { artistId: target }, true, true, {
                        kind: 'pat',
                        scopes: ['admin'],
                    })
                ).status,
            ).toBe(200);
            expect(
                (await sql`SELECT metadata_locked_by FROM media_items WHERE id=${albumId}`)[0]
                    .metadata_locked_by,
            ).toBe('token curator');
        },
    );

    it('manual owner locks remain compatible with concurrent scanner foreign-key checks', async () => {
        await initialScan();
        const target = await findOrCreateMusicArtist(sql, { name: 'FK-compatible target' });
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        const reader = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            await writer.begin(async (raw) => {
                await reparentAlbumToArtist(raw as unknown as postgres.Sql, albumId, target, {
                    manualActor: 'curator',
                });
                // FK checks use KEY SHARE. This must succeed while the manual
                // transaction still holds both owner locks, rather than wait.
                expect(
                    await reader`SELECT id FROM media_items WHERE id=ANY(${[albumId, target]}::uuid[]) ORDER BY id FOR KEY SHARE NOWAIT`,
                ).toHaveLength(2);
            });
        } finally {
            await writer.end();
            await reader.end();
        }
    });

    it('same-parent confirmation and actual NFO settling share sorted owner lock order', async () => {
        const artist = '00000000-0000-4000-8000-000000000001';
        albumId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const track = '88888888-8888-4888-8888-888888888888';
        await sql`INSERT INTO media_items (id,title,media_type) VALUES (${artist},'NFO owner','artist')`;
        await sql`INSERT INTO media_items (id,title,media_type,parent_id) VALUES (${albumId},'NFO album','album',${artist}),(${track},'NFO track','track',${albumId})`;
        const path = join(dir, 'NFO.mp3');
        const [file] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES (${path}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${track},true)`;
        const source = { fileId: file.id, trackId: track, filePath: path };
        const snapshot = await readMusicNfoSnapshot(sql, source);
        if (!snapshot) throw new Error('Expected real NFO snapshot');
        const nfoDb = postgres(getTestDatabaseUrl(), { max: 1 });
        const manualDb = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { application_name: 'manual-nfo-contender' },
        });
        let ready!: () => void;
        let proceed!: () => void;
        const prefixLocked = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            proceed = resolve;
        });
        const settling = nfoDb.begin(async (raw) => {
            const tx = raw as unknown as postgres.Sql;
            // Deterministic prefix of NFO's file-then-sorted-owner acquisition.
            // The current artist sorts before the track and album, as in PROD.
            await tx`SELECT id FROM media_files WHERE id=${file.id} FOR UPDATE`;
            await tx`SELECT id FROM media_items WHERE id=${artist} FOR UPDATE`;
            ready();
            await gate;
            await lockMusicNfoSnapshot(tx, source, snapshot, [], true);
        });
        let manual: Promise<unknown> | undefined;
        try {
            await prefixLocked;
            manual = reparentAlbumToArtist(manualDb, albumId, artist, { manualActor: 'curator' });
            await vi.waitFor(async () => {
                const [row] =
                    await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='manual-nfo-contender' AND cardinality(pg_blocking_pids(pid))>0`;
                expect(row.count).toBe(1);
            });
            proceed();
            const outcomes = await Promise.allSettled([settling, manual]);
            expect(
                outcomes.flatMap((r) =>
                    r.status === 'rejected'
                        ? [
                              {
                                  message: String(r.reason),
                                  code: (r.reason as { code?: string }).code,
                              },
                          ]
                        : [],
                ),
            ).toEqual([]);
            expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
            expect(
                (
                    await sql`SELECT parent_id,metadata_locked,metadata_locked_by FROM media_items WHERE id=${albumId}`
                )[0],
            ).toMatchObject({
                parent_id: artist,
                metadata_locked: true,
                metadata_locked_by: 'curator',
            });
        } finally {
            proceed();
            await Promise.allSettled([settling, manual]);
            await nfoDb.end();
            await manualDb.end();
        }
    });

    it('scanner and maintenance agree on 80% readable tags and ignore missing/unlinked/inactive tracks', async () => {
        const files = Array.from({ length: 5 }, (_, i) => join(dir, `${i}.mp3`));
        for (let i = 0; i < files.length; i++)
            await writeTrack(files[i], `Guest ${i}`, '2026', undefined, i === 4 ? '' : 'Michael');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'broken.flac'), 'invalid audio');
        expect((await parseAudioTags(join(dir, 'broken.flac'))).parseError).toBe('corrupt');
        const run = ctx() as FileScannerContext;
        for (const file of files) await processAudioFile(sql, file, lp, run);
        const id = await albumFor(files[0]);
        for (const kind of ['missing', 'unlinked', 'inactive']) {
            const [track] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,parent_id,status,custom_metadata) VALUES (${kind}, 'track', ${id}, ${kind === 'inactive' ? 'deleted' : 'active'}, '{"album_artist":"Wrong","compilation":true}'::jsonb) RETURNING id`;
            if (kind !== 'unlinked') {
                const [file] = await sql<
                    { id: string }[]
                >`INSERT INTO media_files (file_path,is_missing) VALUES (${join(dir, kind + '.mp3')}, ${kind === 'missing'}) RETURNING id`;
                await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${track.id},true)`;
            }
        }
        expect((await findAlbumArtistEvidence(sql, id))?.track_metadata).toHaveLength(5);
        const scan = await resolveFolderAlbumArtist(
            sql,
            files[0],
            await parseAudioTags(files[0]),
            lp,
            ctx() as FileScannerContext,
        );
        const maintenance = await albumArtistDecision(sql, id, { logger });
        expect(scan).toMatchObject({ artist: 'Michael', source: 'album-tag' });
        const { discEvidence, ...scanDecision } = scan;
        expect(discEvidence).toBe(false);
        expect(maintenance).toEqual(scanDecision);
        // No tags/primary names: both paths derive the same folder fallback.
        await sql`UPDATE media_items SET custom_metadata='{}'::jsonb WHERE parent_id=${id} AND media_type='track'`;
        expect(await albumArtistDecision(sql, id, { logger })).toMatchObject({
            artist: 'Curator',
            source: 'fallback',
        });
        for (const file of files) await writeTrack(file, '', '2026', undefined, '');
        expect(
            await resolveFolderAlbumArtist(
                sql,
                files[0],
                await parseAudioTags(files[0]),
                lp,
                ctx() as FileScannerContext,
            ),
        ).toMatchObject((await albumArtistDecision(sql, id, { logger }))!);
    });

    it('scanner splits a proven collaborative ALBUMARTIST without creating a combined artist row', async () => {
        const solo = await findOrCreateMusicArtist(sql, {
            name: 'Wilhart',
            libraryGroupId: lp.library_group_id,
        });
        const album = await findOrCreateMusicAlbum(sql, {
            title: 'Solo',
            artistId: solo,
            libraryGroupId: lp.library_group_id,
        });
        for (const artist of ['Wilhart', 'Wilhart feat. Jo']) {
            await sql`INSERT INTO media_items (title,media_type,parent_id,custom_metadata) VALUES (${artist},'track',${album},${sql.json({ artist })})`;
        }
        await getArtistCreditEvidence(sql, { fresh: true });
        const file = join(dir, 'Collab.mp3');
        await writeTrack(file, 'Wilhart & Solara', '2026', undefined, 'Wilhart & Solara');
        await processAudioFile(sql, file, lp, ctx() as FileScannerContext);
        expect(
            await sql`SELECT 1 FROM media_items WHERE media_type='artist' AND title='Wilhart & Solara'`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${await albumFor(file)}`,
        ).toEqual([{ title: 'Wilhart' }]);
    });

    it('scanner and watcher use the whole folder before placing any track', async () => {
        const files = ['A', 'B', 'C'].map((name) => join(dir, name + '.mp3'));
        for (let i = 0; i < files.length; i++)
            await writeTrack(files[i], `Performer ${i}`, '2026', undefined, '');
        await ingestSingleFile(sql, files[0], lp, ctx());
        await scanClean();
        const [album] = await sql<{ title: string }[]>`
            SELECT artist.title FROM media_items a JOIN media_items artist ON artist.id=a.parent_id
            WHERE a.id=${await albumFor(files[0])}
        `;
        expect(album.title).toBe('Various Artists');
        expect(await albumFor(files[1])).toBe(await albumFor(files[0]));
        expect(await albumFor(files[2])).toBe(await albumFor(files[0]));
    }, 60_000);

    it('keeps the artist when half the folder shares that performer', async () => {
        const names = ['Dominant', 'Dominant', 'Guest B', 'Guest C'];
        const files = names.map((_, i) => join(dir, `${i}.mp3`));
        for (let i = 0; i < names.length; i++)
            await writeTrack(files[i], names[i], '2026', undefined, '');
        for (const file of files)
            await processAudioFile(sql, file, lp, ctx() as FileScannerContext);
        const [parent] = await sql<{ title: string }[]>`
            SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${await albumFor(files[0])}
        `;
        expect(parent.title).toBe('Dominant');
        expect(new Set(await Promise.all(files.map(albumFor))).size).toBe(1);
    });

    it('reads TCMP compilation from real MP3 bytes without ALBUMARTIST', async () => {
        const file = join(dir, 'Compilation.mp3');
        await writeTrack(file, 'One Performer', '2026', undefined, '', true);
        await processAudioFile(sql, file, lp, ctx() as FileScannerContext);
        const [parent] = await sql<{ title: string }[]>`
            SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${await albumFor(file)}
        `;
        expect(parent.title).toBe('Various Artists');
    });

    it('preserves a locked manual album when a new track arrives and merge passes run', async () => {
        await initialScan();
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${albumId}`;
        const file = join(dir, 'Later.mp3');
        await writeTrack(file, 'New Performer');
        await ingestSingleFile(sql, file, lp, ctx());
        await mergeVariousArtistsAliases(sql, ctx() as FileScannerContext);
        const [parent] = await sql<{ title: string }[]>`
            SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${albumId}
        `;
        expect(parent.title).toBe('Various Artists');
        expect(await albumFor(file)).toBe(albumId);
    });

    it('keeps a manually locked folder parent even when ALBUMARTIST is absent', async () => {
        const first = join(dir, 'First.mp3');
        await writeTrack(first, 'One', '2026', undefined, '');
        await processAudioFile(sql, first, lp, ctx() as FileScannerContext);
        const id = await albumFor(first);
        const manual = await findOrCreateMusicArtist(sql, {
            name: 'Manual Parent',
            libraryGroupId: lp.library_group_id,
        });
        await reparentAlbumToArtist(sql, id, manual);
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${id}`;
        const second = join(dir, 'Second.mp3');
        await writeTrack(second, 'Two', '2026', undefined, '');
        await processAudioFile(sql, second, lp, ctx() as FileScannerContext);
        expect(await albumFor(second)).toBe(id);
        const [album] = await sql<
            { parent_id: string }[]
        >`SELECT parent_id FROM media_items WHERE id=${id}`;
        expect(album.parent_id).toBe(manual);
    });

    it('alias merging cannot take a locked album away from its manual parent', async () => {
        await initialScan();
        const [aliasRow] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title,media_type,library_group_id)
            VALUES ('V.A.','artist',${lp.library_group_id}) RETURNING id
        `;
        const alias = aliasRow.id;
        await reparentAlbumToArtist(sql, albumId, alias);
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${albumId}`;
        await mergeVariousArtistsAliases(sql, ctx() as FileScannerContext);
        const [album] = await sql<
            { parent_id: string }[]
        >`SELECT parent_id FROM media_items WHERE id=${albumId}`;
        expect(album.parent_id).toBe(alias);
    });

    it('merges the split pair through existing reference-preserving helpers once both resolve to the curator', async () => {
        await initialScan();
        const originalTracks = await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE parent_id=${albumId} ORDER BY id`;
        const curator = await findOrCreateMusicArtist(sql, {
            name: 'Curator',
            libraryGroupId: lp.library_group_id,
        });
        const target = await findOrCreateMusicAlbum(sql, {
            title: 'Festival (2026)',
            artistId: curator,
            libraryGroupId: lp.library_group_id,
        });
        expect(await alignFolderAlbumParent(sql, albumId, curator)).toBe(target);
        const mergedTracks = await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE parent_id=${target} ORDER BY id`;
        expect(mergedTracks).toEqual(originalTracks);
        const [active] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM media_items WHERE media_type='album' AND status='active'`;
        expect(active.n).toBe(1);
    });

    it.each([false, true])(
        'periodic duplicate-artist cleanup also respects the album rule (locked=%s)',
        async (locked) => {
            await initialScan();
            const [aliasRow] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title,media_type,library_group_id)
                VALUES ('V.A.','artist',${lp.library_group_id}) RETURNING id
            `;
            const alias = aliasRow.id;
            await reparentAlbumToArtist(sql, albumId, alias);
            if (locked) {
                await sql`UPDATE media_items SET metadata_locked=true WHERE id=${albumId}`;
                await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album_artist":"Various Artists"}'::jsonb WHERE parent_id=${albumId}`;
            }
            const outcome = await autoMergeDuplicateArtists(sql, logger, {
                albumArtistDecision: (tx, id) => albumArtistDecision(tx, id, { logger }),
            });
            expect(outcome.merged).toBe(0);
            expect(outcome.skipped).toBeGreaterThan(0);
            const [album] = await sql<
                { parent_id: string }[]
            >`SELECT parent_id FROM media_items WHERE id=${albumId}`;
            expect(album.parent_id).toBe(alias);
        },
    );

    it('oversized credit pass leaves a curator album alone, and cannot move a locked album', async () => {
        await initialScan();
        const giant = await findOrCreateMusicArtist(sql, {
            name: 'A, B, C, D, E, F',
            libraryGroupId: lp.library_group_id,
        });
        await reparentAlbumToArtist(sql, albumId, giant);
        await mergeOversizedCompilationArtists(sql, ctx() as FileScannerContext);
        const [album] = await sql<
            { parent_id: string }[]
        >`SELECT parent_id FROM media_items WHERE id=${albumId}`;
        expect(album.parent_id).toBe(giant);
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${albumId}`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata-'album_artist' || '{"compilation":true}'::jsonb WHERE parent_id=${albumId}`;
        await mergeOversizedCompilationArtists(sql, ctx() as FileScannerContext);
        const [locked] = await sql<
            { parent_id: string }[]
        >`SELECT parent_id FROM media_items WHERE id=${albumId}`;
        expect(locked.parent_id).toBe(giant);
    });

    it.each(['watcher', 'full scan'] as const)(
        '%s adds later tracks to the existing album despite different track artists and years',
        async (mode) => {
            await initialScan();
            const added = join(dir, 'New.mp3');
            await writeTrack(added, 'Third Performer', '2024');
            if (mode === 'watcher') {
                expect((await ingestSingleFile(sql, added, lp, ctx())).status).toBe('ingested');
            } else {
                await scanClean();
            }
            expect(await albumFor(added)).toBe(albumId);
            const [parent] = await sql<{ title: string }[]>`
                SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${albumId}
            `;
            expect(parent.title).toBe('Curator');
            const albums = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE media_type='album' AND status='active'
            `;
            expect(albums).toEqual([{ id: albumId }]);
        },
        60_000,
    );

    it('collapses CD2 to the same folder and matches case/whitespace in album credits', async () => {
        await initialScan();
        const added = join(dir, 'CD2', 'New.mp3');
        await writeTrack(added, 'Third Performer', '2024', undefined, '  cURATOR  ');
        expect(await processAudioFile(sql, added, lp, ctx() as FileScannerContext)).toBe('added');
        expect(await albumFor(added)).toBe(albumId);
    });

    it('a year retag also preserves the existing folder album', async () => {
        await initialScan();
        const old = join(dir, 'Old.mp3');
        await writeTrack(old, 'First Performer', '2024');
        const later = new Date(Date.now() + 60_000);
        await utimes(old, later, later);
        expect(await processAudioFile(sql, old, lp, ctx() as FileScannerContext)).toBe('updated');
        expect(await albumFor(old)).toBe(albumId);
    });

    it.each([undefined, RELEASE_A])('accepts compatible release evidence (%s)', async (release) => {
        await initialScan(RELEASE_A);
        const added = join(dir, 'New.mp3');
        await writeTrack(added, 'Third Performer', '2026', release);
        await processAudioFile(sql, added, lp, ctx() as FileScannerContext);
        expect(await albumFor(added)).toBe(albumId);
    });

    it('does not absorb another MusicBrainz edition in the same folder', async () => {
        await initialScan(RELEASE_A);
        const added = join(dir, 'Other edition.mp3');
        await writeTrack(added, 'Third Performer', '2026', RELEASE_B);
        await processAudioFile(sql, added, lp, ctx() as FileScannerContext);
        expect(await albumFor(added)).not.toBe(albumId);
    });

    it('preserves the majority ALBUMARTIST when a minority credit differs across the folder', async () => {
        await initialScan();
        const curator = await findOrCreateMusicArtist(sql, {
            name: 'Curator',
            libraryGroupId: lp.library_group_id,
        });
        await reparentAlbumToArtist(sql, albumId, curator);
        const added = join(dir, 'Different artist.mp3');
        await writeTrack(added, 'Third Performer', '2026', undefined, 'Another Curator');
        await processAudioFile(sql, added, lp, ctx() as FileScannerContext);
        expect(await albumFor(added)).toBe(albumId);
        const [parent] = await sql<{ title: string }[]>`
            SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${albumId}
        `;
        expect(parent.title).toBe('Curator');
    });

    it('a minority ALBUMARTIST retag preserves the majority parent without splitting the folder', async () => {
        await initialScan();
        const curator = await findOrCreateMusicArtist(sql, {
            name: 'Curator',
            libraryGroupId: lp.library_group_id,
        });
        await reparentAlbumToArtist(sql, albumId, curator);
        const third = join(dir, 'Third.mp3');
        await writeTrack(third, 'Third Performer');
        await processAudioFile(sql, third, lp, ctx() as FileScannerContext);
        await writeTrack(third, 'Third Performer', '2026', undefined, 'Other Curator');
        const later = new Date(Date.now() + 60_000);
        await utimes(third, later, later);
        expect(await processAudioFile(sql, third, lp, ctx() as FileScannerContext)).toBe('updated');
        expect(await albumFor(third)).toBe(albumId);
        const [parent] = await sql<{ title: string }[]>`
            SELECT p.title FROM media_items a JOIN media_items p ON p.id=a.parent_id WHERE a.id=${albumId}
        `;
        expect(parent.title).toBe('Curator');
        const albums =
            await sql`SELECT id FROM media_items WHERE media_type='album' AND status='active'`;
        expect(albums).toHaveLength(1);
    });

    it('does not absorb a same-title album in a different release folder', async () => {
        await initialScan();
        const added = join(root, 'Curator', 'Festival (2026) Deluxe', 'New.mp3');
        await writeTrack(added, 'Third Performer');
        await processAudioFile(sql, added, lp, ctx() as FileScannerContext);
        expect(await albumFor(added)).not.toBe(albumId);
    });

    it('does not use a release-group match to override a different release edition', async () => {
        await initialScan(RELEASE_A);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata ||
            ${sql.json({ musicbrainz_releasegroup_id: RELEASE_A })} WHERE id=${albumId}`;
        expect(
            await findExistingFolderAlbum(
                sql,
                dir,
                'Festival (2026)',
                {
                    album: 'Festival (2026)',
                    albumArtist: 'Curator',
                    releaseMbid: RELEASE_B,
                    releaseGroupMbid: RELEASE_A,
                },
                lp.library_group_id,
            ),
        ).toBeNull();
    });

    it('does not reuse folder evidence from another library group', async () => {
        await initialScan();
        expect(
            await findExistingFolderAlbum(
                sql,
                dir,
                'Festival (2026)',
                {
                    album: 'Festival (2026)',
                    albumArtist: 'Curator',
                },
                randomUUID(),
            ),
        ).toBeNull();
    });

    it('leaves an already split folder ambiguous instead of choosing an arbitrary album', async () => {
        await initialScan();
        const second = join(dir, 'Other curator.mp3');
        await writeTrack(second, 'Fourth Performer', '2026', undefined, 'Other Curator');
        await processAudioFile(sql, second, lp, ctx() as FileScannerContext);
        // Model a pre-existing split explicitly; new inconsistent-tag ingestion
        // now follows album-wide fallback evidence instead of creating a split.
        const otherArtist = await findOrCreateMusicArtist(sql, {
            name: 'Other Curator',
            libraryGroupId: lp.library_group_id,
        });
        const otherAlbum = await findOrCreateMusicAlbum(sql, {
            title: 'Festival (2026)',
            artistId: otherArtist,
            libraryGroupId: lp.library_group_id,
        });
        await sql`UPDATE media_items SET parent_id=${otherAlbum}
            WHERE id IN (SELECT fi.media_item_id FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${second})`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata ||
            ${sql.json({ album_artist: 'Curator' })}
            WHERE id IN (SELECT media_item_id FROM media_file_items fi
                JOIN media_files f ON f.id=fi.file_id WHERE f.file_path=${second})`;
        expect(
            await findExistingFolderAlbum(
                sql,
                dir,
                'Festival (2026)',
                {
                    album: 'Festival (2026)',
                    albumArtist: 'Curator',
                },
                lp.library_group_id,
            ),
        ).toBeNull();
    });
});
