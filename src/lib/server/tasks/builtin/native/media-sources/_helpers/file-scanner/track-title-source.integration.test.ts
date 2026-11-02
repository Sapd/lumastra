// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `media_items.title_source` is written next to every track title the music
 * scanner writes — the music-hygiene "title from file name" finding reads
 * nothing else, so a write path that forgets it drops (or keeps) rows from that
 * list silently.
 *
 * Drives the REAL scanner (`processVideoFile` → `processAudioFile`) against
 * real Postgres and real files; real audio is generated with ffmpeg.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import {
    updateAndLockMediaItem,
    confirmFilenameTitle,
    backfillLocalMediaContent,
    applyLocalNfoDisplayMetadata,
} from '../../../../../../database/queries/media-items.queries.js';
import type { FileScannerContext } from './shared.js';
import { linkRemixerArtists } from './audio-processor.js';
import { processVideoFile } from './video-processor.js';

const execFileAsync = promisify(execFile);

/**
 * Write an mp3. `title: null` writes NO title tag, which is what sends the tag
 * parser to its filename fallback. `seconds` changes the file's size, so a
 * rewrite is seen as a content change on the next scan.
 */
async function makeAudio(out: string, title: string | null, seconds = 1): Promise<void> {
    await execFileAsync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-c:a',
        'libmp3lame',
        ...(title === null ? [] : ['-metadata', `title=${title}`]),
        '-metadata',
        'artist=Source Artist',
        '-metadata',
        'album=Source Album',
        out,
    ]);
}

describe('music scanner records where a track title came from (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let albumDir: string;
    let libraryPath: LibraryPathRow;
    const logger = {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
        debug: (): void => undefined,
    };
    let context: FileScannerContext;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger } as unknown as FileScannerContext;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-title-source-'));
        albumDir = join(root, 'Source Artist', 'Source Album');
        await mkdir(albumDir, { recursive: true });
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`title-source-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group!.id}, true)
            RETURNING *
        `;
        libraryPath = lp!;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp!.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group!.id}`;
        };
    });

    const scan = (filePath: string): ReturnType<typeof processVideoFile> =>
        processVideoFile(sql, filePath, libraryPath, [], context);

    async function track(
        filePath: string,
    ): Promise<{ id: string; title: string; title_source: string | null }> {
        const [row] = await sql<{ id: string; title: string; title_source: string | null }[]>`
            SELECT mi.id, mi.title, mi.title_source
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path = ${filePath}
        `;
        expect(row, `no track linked to ${filePath}`).toBeDefined();
        return row!;
    }

    describe('first scan (insert path)', () => {
        it('a title tag is recorded as tag', async () => {
            const p = join(albumDir, '01 - Other Name.mp3');
            await makeAudio(p, 'Real Tag Title');
            expect(await scan(p)).toBe('added');
            expect(await track(p)).toMatchObject({ title: 'Real Tag Title', title_source: 'tag' });
        }, 60_000);

        it.each([
            ['the Artist - Title split', '02 - Some Artist - Real Song.mp3', 'Real Song'],
            ['the track-number-stripped stem', '03 Plain Title.mp3', 'Plain Title'],
            ['the underscore-normalised stem', 'another_song_here.mp3', 'another song here'],
        ])(
            'no title tag: %s is recorded as filename',
            async (_label, name, title) => {
                const p = join(albumDir, name);
                await makeAudio(p, null);
                expect(await scan(p)).toBe('added');
                expect(await track(p)).toMatchObject({ title, title_source: 'filename' });
            },
            60_000,
        );
    });

    describe('re-scan of a changed file', () => {
        it('follows the file: a tag that disappears becomes filename, and back', async () => {
            const p = join(albumDir, '04 Plain Title.mp3');
            await makeAudio(p, 'Tagged First');
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);

            await makeAudio(p, null, 2);
            await scan(p);
            expect(await track(p)).toMatchObject({
                id,
                title: 'Plain Title',
                title_source: 'filename',
            });

            await makeAudio(p, 'Tagged Again', 3);
            await scan(p);
            expect(await track(p)).toMatchObject({
                id,
                title: 'Tagged Again',
                title_source: 'tag',
            });
        }, 60_000);

        it('a locked row keeps its title AND its source', async () => {
            const p = join(albumDir, '05 Locked.mp3');
            await makeAudio(p, 'Tag Title');
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}`;

            await makeAudio(p, null, 2);
            await scan(p);
            expect(await track(p)).toMatchObject({ id, title: 'Tag Title', title_source: 'tag' });
        }, 60_000);
    });

    /**
     * An unchanged file whose stored title carries U+FFFD is re-parsed and
     * healed. Both directions, so a heal that writes a constant fails one.
     */
    describe('mojibake heal of an unchanged file', () => {
        it('a healed tag title is recorded as tag', async () => {
            const p = join(albumDir, '07 Heal Tagged.mp3');
            await makeAudio(p, 'Healed Tag');
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);
            await sql`
                UPDATE media_items SET title = ${'Healed \uFFFD'}, title_source = NULL
                WHERE id = ${id}
            `;

            await scan(p);
            expect(await track(p)).toMatchObject({ id, title: 'Healed Tag', title_source: 'tag' });
        }, 60_000);

        it('a healed filename title is recorded as filename', async () => {
            const p = join(albumDir, '08 Heal Untagged.mp3');
            await makeAudio(p, null);
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);
            await sql`
                UPDATE media_items SET title = ${'Heal \uFFFD'}, title_source = 'tag'
                WHERE id = ${id}
            `;

            await scan(p);
            expect(await track(p)).toMatchObject({
                id,
                title: 'Heal Untagged',
                title_source: 'filename',
            });
        }, 60_000);
    });

    /**
     * Rows marked `filename` by the 16.276.0 backfill cannot tell "tag equals
     * the stem" from "no tag", and an unchanged file is never re-parsed by the
     * content-change path. The unchanged-file check re-reads the tags once and
     * writes the marker the tags prove; a confirmed-untagged file is recorded as
     * verified so it is not re-read on every scan.
     */
    describe('filename-marked row of an unchanged file', () => {
        async function trackMeta(
            filePath: string,
        ): Promise<{ title_source: string | null; verified: unknown }> {
            const [row] = await sql<{ title_source: string | null; verified: unknown }[]>`
                SELECT mi.title_source, mi.custom_metadata->'title_source_verified' AS verified
                FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                JOIN media_items mi ON mi.id = mfi.media_item_id
                WHERE mf.file_path = ${filePath}
            `;
            return row!;
        }

        it('a title tag equal to the stem is recorded as tag on re-scan', async () => {
            const p = join(albumDir, '13 Plain Title.mp3');
            await makeAudio(p, 'Plain Title');
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);
            expect((await track(p)).title_source).toBe('tag');
            await sql`UPDATE media_items SET title_source = 'filename' WHERE id = ${id}`;

            await scan(p);
            expect(await track(p)).toMatchObject({
                id,
                title: 'Plain Title',
                title_source: 'tag',
            });
        }, 60_000);

        it('a tagless file stays filename and is recorded as verified', async () => {
            const p = join(albumDir, '14 Tagless Song.mp3');
            await makeAudio(p, null);
            expect(await scan(p)).toBe('added');
            expect(await trackMeta(p)).toMatchObject({ title_source: 'filename', verified: null });

            await scan(p);
            expect(await trackMeta(p)).toMatchObject({ title_source: 'filename', verified: true });
        }, 60_000);

        it('a verified filename row is not re-read on the next scan', async () => {
            const p = join(albumDir, '15 Verified Song.mp3');
            await makeAudio(p, 'Tagged Now');
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);
            await sql`
                UPDATE media_items
                SET title_source = 'filename',
                    custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                        || '{"title_source_verified": true}'::jsonb
                WHERE id = ${id}
            `;

            await scan(p);
            expect(await trackMeta(p)).toMatchObject({ title_source: 'filename', verified: true });
        }, 60_000);

        it('a locked row keeps its title and its source', async () => {
            const p = join(albumDir, '16 Locked Filename.mp3');
            await makeAudio(p, 'Locked Tag');
            expect(await scan(p)).toBe('added');
            const { id } = await track(p);
            await sql`
                UPDATE media_items
                SET title = 'Admin Title', title_source = 'filename', metadata_locked = true
                WHERE id = ${id}
            `;

            await scan(p);
            expect(await track(p)).toMatchObject({
                id,
                title: 'Admin Title',
                title_source: 'filename',
            });
        }, 60_000);
    });

    /**
     * A track row left without a file by an interrupted prior scan is ADOPTED
     * rather than duplicated (`findAdoptableOrphanTrack`); the insert that
     * would have recorded the source never runs.
     */
    describe('orphan adoption', () => {
        async function orphanNextTo(
            siblingPath: string,
            opts: { locked: boolean; titleSource: 'tag' | null },
        ): Promise<string> {
            await makeAudio(siblingPath, 'Sibling');
            expect(await scan(siblingPath)).toBe('added');
            const [sibling] = await sql<{ parent_id: string }[]>`
                SELECT parent_id FROM media_items WHERE id = ${(await track(siblingPath)).id}
            `;
            const [orphan] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, parent_id, metadata_locked, title_source)
                VALUES ('Adopted Title', 'track', 'active', ${sibling!.parent_id},
                        ${opts.locked}, ${opts.titleSource})
                RETURNING id
            `;
            return orphan!.id;
        }

        it('records the source on the adopted row', async () => {
            const orphanId = await orphanNextTo(join(albumDir, '09 Sibling.mp3'), {
                locked: false,
                titleSource: null,
            });
            const p = join(albumDir, '10 Adopted Title.mp3');
            await makeAudio(p, null);
            await scan(p);
            expect(await track(p)).toMatchObject({ id: orphanId, title_source: 'filename' });
        }, 60_000);

        it('leaves a locked adopted row its source', async () => {
            const orphanId = await orphanNextTo(join(albumDir, '11 Sibling.mp3'), {
                locked: true,
                titleSource: 'tag',
            });
            const p = join(albumDir, '12 Adopted Title.mp3');
            await makeAudio(p, null);
            await scan(p);
            expect(await track(p)).toMatchObject({ id: orphanId, title_source: 'tag' });
        }, 60_000);
    });

    it('a confirmed filename title survives genuinely changed tagged ingest and NFO backfill with its manual protection intact', async () => {
        const p = join(albumDir, '17 You Da One (Ekoglow Remix).mp3');
        await makeAudio(p, null);
        expect(await scan(p)).toBe('added');
        const { id, title } = await track(p);
        expect(title).toBe('You Da One (Ekoglow Remix)');
        await sql`UPDATE media_items SET overview = NULL, year = NULL,
            custom_metadata = (custom_metadata - 'track_artist_credits') || '{"sentinel":{"nested":[1,"keep"]}}'::jsonb
            WHERE id = ${id}`;
        const [remixer] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,media_type,status) VALUES ('Ekoglow','artist','active') RETURNING id`;
        expect(
            await confirmFilenameTitle(sql, id, 'reviewing-admin', {
                title,
                source: 'filename',
                locked: false,
            }),
        ).toBe('confirmed');
        const [before] =
            await sql`SELECT to_jsonb(mi) - 'updated_at' - 'media_segment_generation' AS item FROM media_items mi WHERE id = ${id}`;
        const originalLinks =
            await sql`SELECT to_jsonb(mfi) AS link FROM media_file_items mfi WHERE media_item_id = ${id}`;
        // The scanner reads real changed bytes and a conflicting real tag, with a
        // real NFO beside it. No parse/provider seam is mocked.
        await writeFile(
            join(albumDir, 'album.nfo'),
            '<album><title>Source Album</title><review>NFO review</review><year>2020</year></album>',
        );
        await makeAudio(p, 'Different Tagged Title');
        const changedBytes = await readFile(p);
        expect(await scan(p)).toBe('updated');
        await linkRemixerArtists(sql, context);
        expect(await track(p)).toMatchObject({
            id,
            title: 'You Da One (Ekoglow Remix)',
            title_source: null,
        });
        // d046376876: changed bytes invalidate segment evidence even on a title-locked
        // item. Keep the full metadata comparison, and assert the fence separately.
        const [generation] =
            await sql`SELECT media_segment_generation FROM media_items WHERE id = ${id}`;
        expect(generation.media_segment_generation).toEqual(expect.any(String));
        const [after] =
            await sql`SELECT to_jsonb(mi) - 'updated_at' - 'media_segment_generation' AS item FROM media_items mi WHERE id = ${id}`;
        expect(after).toEqual(before);
        expect([
            ...(await sql`SELECT to_jsonb(mfi) AS link FROM media_file_items mfi WHERE media_item_id = ${id}`),
        ]).toEqual([...originalLinks]);
        expect(
            await backfillLocalMediaContent(sql, id, {
                overview: 'Unseen NFO overview',
                year: 2022,
            }),
        ).toBe(false);
        await applyLocalNfoDisplayMetadata(sql, id, { overview: 'Unseen NFO display', year: 2022 });
        expect([
            ...(await sql`SELECT to_jsonb(mi) - 'updated_at' - 'media_segment_generation' AS item FROM media_items mi WHERE id = ${id}`),
        ]).toEqual([before]);
        expect(
            (await sql`SELECT media_segment_generation FROM media_items WHERE id = ${id}`)[0],
        ).toEqual(generation);
        expect(await sql`SELECT * FROM provider_metadata WHERE media_id = ${id}`).toHaveLength(0);
        expect(await readFile(p)).toEqual(changedBytes);
        await sql`UPDATE media_items SET metadata_locked=false WHERE id=${id}`;
        expect(await linkRemixerArtists(sql, context)).toBeGreaterThan(0);
        const [unlocked] = await sql<
            { ids: string[] }[]
        >`SELECT custom_metadata->'remixer_artist_ids' AS ids FROM media_items WHERE id=${id}`;
        expect(unlocked.ids).toContain(remixer.id);
    }, 60_000);

    describe('admin title edit', () => {
        it('a rename clears the source; re-saving the same title keeps it', async () => {
            const p = join(albumDir, '06 Edited.mp3');
            await makeAudio(p, null);
            expect(await scan(p)).toBe('added');
            const { id, title } = await track(p);
            expect(title).toBe('Edited');

            // The edit form always sends the title; an unchanged one is not a
            // hand-typed title, and locking it does not make it a tag.
            await updateAndLockMediaItem(sql, id, 'admin', { title, overview: 'note' });
            expect((await track(p)).title_source).toBe('filename');

            await updateAndLockMediaItem(sql, id, 'admin', { title: 'Typed By Hand' });
            expect(await track(p)).toMatchObject({ title: 'Typed By Hand', title_source: null });
        }, 60_000);
    });
});
