// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the audiobook query module.
 *
 * The SQL here is the part of the sweep unit tests cannot reach: the
 * `custom_metadata #>> '{audiobookshelf,…}'` path reads that partition local rows
 * by ABS library, the jsonb merge that must not clobber other subsystems' keys,
 * and the `ANY(...::uuid[])` batch flag update. Each of these is a silent
 * data-loss bug if it is wrong, so they are pinned against a real database.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
    countAudiobooks,
    getAudiobookFileCodec,
    insertAudiobook,
    listAudiobooksForAbsLibrary,
    resolveAudiobookPlaybackTarget,
    setAudiobookFlags,
    updateAudiobookFromRemote,
    type AudiobookWriteParams,
    type AudiobookshelfMetadata,
} from './audiobooks.queries.js';

const TEST_GROUP_ID = '00000000-0000-0000-0000-0000000ab001';
/** A second group, standing in for one an operator moved a book into by hand. */
const OTHER_GROUP_ID = '00000000-0000-0000-0000-0000000ab002';
const ABS_LIBRARY_A = 'abs-lib-a';
const ABS_LIBRARY_B = 'abs-lib-b';

function metadata(overrides: Partial<AudiobookshelfMetadata> = {}): AudiobookshelfMetadata {
    return {
        derivedSeries: { name: null, sequence: null, source: 'none' },
        audioFiles: [],
        libraryId: ABS_LIBRARY_A,
        libraryPathId: '11111111-1111-1111-1111-111111111111',
        updatedAt: 1_700_000_000_000,
        mtimeMs: 1_699_000_000_000,
        addedAt: 1_698_000_000_000,
        relPath: 'Autor/Buch',
        coverPath: '/covers/1.jpg',
        subtitle: null,
        authors: ['Autor'],
        narrators: ['Sprecher'],
        series: [{ id: 's-1', name: 'Reihe', sequence: '1' }],
        genres: ['Krimi'],
        publisher: null,
        publishedYear: '1999',
        language: 'de',
        isbn: null,
        asin: null,
        explicit: false,
        abridged: false,
        duration: 3600,
        chapters: [{ id: 0, start: 0, end: 60, title: 'Kapitel 1' }],
        ...overrides,
    };
}

function writeParams(overrides: Partial<AudiobookWriteParams> = {}): AudiobookWriteParams {
    return {
        sortOrder: null,
        title: 'Ein Buch',
        sortTitle: 'ein buch',
        overview: 'Beschreibung',
        year: 1999,
        runtimeSeconds: 3600,
        hasFiles: true,
        libraryGroupId: TEST_GROUP_ID,
        libraryAddedAt: new Date('2023-10-22T00:00:00Z'),
        metadata: metadata(),
        ...overrides,
    };
}

describe('Audiobook queries', () => {
    let sql: postgres.Sql;

    /** Insert a book plus the external_ids row the list query joins through. */
    async function seed(
        absItemId: string,
        params: AudiobookWriteParams = writeParams(),
    ): Promise<string> {
        const mediaId = await insertAudiobook(sql, params);
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${mediaId}, ${AUDIOBOOKSHELF_PROVIDER}, ${absItemId}, ${AUDIOBOOK_MEDIA_TYPE}, TRUE, ${AUDIOBOOKSHELF_PROVIDER})
        `;
        return mediaId;
    }

    beforeAll(async () => {
        sql = getTestDb();
        await sql`
            INSERT INTO library_groups (id, name) VALUES
                (${TEST_GROUP_ID}, 'Hörbücher Test'),
                (${OTHER_GROUP_ID}, 'Hörbücher Test (Kinder)')
            ON CONFLICT DO NOTHING
        `;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        // external_ids FK-cascades from media_items.
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}`;
    });

    describe('insertAudiobook', () => {
        it('writes a playable, non-local-only row with its metadata payload', async () => {
            const mediaId = await insertAudiobook(sql, writeParams());

            const [row] = await sql<
                Array<{
                    title: string;
                    sort_title: string;
                    overview: string | null;
                    year: number | null;
                    media_type: string;
                    runtime_seconds: number | null;
                    has_files: boolean;
                    is_local_only: boolean;
                    is_dismissed: boolean;
                    status: string;
                    library_group_id: string | null;
                    custom_metadata: Record<string, unknown>;
                }>
            >`SELECT * FROM media_items WHERE id = ${mediaId}`;

            expect(row.media_type).toBe('audiobook');
            expect(row.title).toBe('Ein Buch');
            expect(row.sort_title).toBe('ein buch');
            expect(row.runtime_seconds).toBe(3600);
            // "Playable in this install" — the shared card machinery reads this
            // to decide whether to render the Listen button at all.
            expect(row.has_files).toBe(true);
            expect(row.is_local_only).toBe(false);
            expect(row.is_dismissed).toBe(false);
            expect(row.status).toBe('active');
            expect(row.library_group_id).toBe(TEST_GROUP_ID);
            expect(row.custom_metadata.audiobookshelf).toMatchObject({
                libraryId: ABS_LIBRARY_A,
                updatedAt: 1_700_000_000_000,
                mtimeMs: 1_699_000_000_000,
                chapters: [{ id: 0, start: 0, end: 60, title: 'Kapitel 1' }],
            });
        });

        it('honours has_files=false for an item ABS reports as missing', async () => {
            const mediaId = await insertAudiobook(sql, writeParams({ hasFiles: false }));
            const [row] = await sql<
                { has_files: boolean }[]
            >`SELECT has_files FROM media_items WHERE id = ${mediaId}`;
            expect(row.has_files).toBe(false);
        });
    });

    describe('listAudiobooksForAbsLibrary', () => {
        it('returns rows for the requested ABS library only', async () => {
            await seed('item-a1');
            await seed('item-a2');
            await seed(
                'item-b1',
                writeParams({ metadata: metadata({ libraryId: ABS_LIBRARY_B }) }),
            );

            const rowsA = await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_A);
            const rowsB = await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_B);

            expect(rowsA.map((r) => r.absItemId)).toEqual(['item-a1', 'item-a2']);
            expect(rowsB.map((r) => r.absItemId)).toEqual(['item-b1']);
        });

        it('parses the revision keys back out of jsonb as numbers', async () => {
            await seed('item-a1');

            const [row] = await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_A);

            expect(row.absUpdatedAt).toBe(1_700_000_000_000);
            expect(row.absMtimeMs).toBe(1_699_000_000_000);
            expect(row.status).toBe('active');
            expect(row.hasFiles).toBe(true);
            expect(row.isDismissed).toBe(false);
        });

        it('reports a row whose revision keys are unreadable as null rather than failing', async () => {
            const mediaId = await seed('item-a1');
            await sql`
                UPDATE media_items
                SET custom_metadata = jsonb_set(custom_metadata, '{audiobookshelf,mtimeMs}', '"not-a-number"')
                WHERE id = ${mediaId}
            `;

            const [row] = await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_A);

            // A ::bigint cast would have raised 22P02 and taken every book in
            // the library down with it.
            expect(row.absMtimeMs).toBeNull();
            expect(row.absUpdatedAt).toBe(1_700_000_000_000);
        });

        it('surfaces soft-deleted rows so the sweep does not re-insert them', async () => {
            const mediaId = await seed('item-a1');
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${mediaId}`;

            const rows = await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_A);

            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('deleted');
        });

        it('ignores an audiobook row that has no audiobookshelf external id', async () => {
            await insertAudiobook(sql, writeParams());

            expect(await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_A)).toEqual([]);
        });
    });

    describe('updateAudiobookFromRemote', () => {
        it('rewrites the row, re-imports chapters and clears a dismissal', async () => {
            const mediaId = await seed('item-a1');
            await setAudiobookFlags(sql, [mediaId], { hasFiles: false, isDismissed: true });

            await updateAudiobookFromRemote(
                sql,
                mediaId,
                writeParams({
                    title: 'Neuer Titel',
                    sortTitle: 'neuer titel',
                    metadata: metadata({
                        updatedAt: 1_800_000_000_000,
                        chapters: [
                            { id: 0, start: 0, end: 60, title: 'Kapitel 1' },
                            { id: 1, start: 60, end: 120, title: 'Kapitel 2' },
                        ],
                    }),
                }),
            );

            const [row] = await sql<
                Array<{
                    title: string;
                    has_files: boolean;
                    is_dismissed: boolean;
                    dismissed_at: Date | null;
                    custom_metadata: Record<string, { chapters: unknown[]; updatedAt: number }>;
                }>
            >`SELECT title, has_files, is_dismissed, dismissed_at, custom_metadata FROM media_items WHERE id = ${mediaId}`;

            expect(row.title).toBe('Neuer Titel');
            expect(row.has_files).toBe(true);
            expect(row.is_dismissed).toBe(false);
            expect(row.dismissed_at).toBeNull();
            expect(row.custom_metadata.audiobookshelf.chapters).toHaveLength(2);
            expect(row.custom_metadata.audiobookshelf.updatedAt).toBe(1_800_000_000_000);
        });

        it('preserves a library group an operator moved the book into', async () => {
            // Design doc §6: which library_group an item sits in is
            // ORGANISATION, editable in Lumastra, and must survive reconcile.
            // library_groups carries max_age_rating / is_public / the
            // permission rows, so clobbering it is an access-control
            // regression, not a cosmetic one.
            const mediaId = await seed('item-a1');
            await sql`
                UPDATE media_items SET library_group_id = ${OTHER_GROUP_ID} WHERE id = ${mediaId}
            `;

            await updateAudiobookFromRemote(
                sql,
                mediaId,
                writeParams({ metadata: metadata({ updatedAt: 1_800_000_000_000 }) }),
            );

            const [row] = await sql<Array<{ library_group_id: string }>>`
                SELECT library_group_id FROM media_items WHERE id = ${mediaId}
            `;
            expect(row.library_group_id).toBe(OTHER_GROUP_ID);
        });

        it('backfills the library group when the row has none', async () => {
            const mediaId = await seed('item-a1');
            await sql`UPDATE media_items SET library_group_id = NULL WHERE id = ${mediaId}`;

            await updateAudiobookFromRemote(sql, mediaId, writeParams());

            const [row] = await sql<Array<{ library_group_id: string }>>`
                SELECT library_group_id FROM media_items WHERE id = ${mediaId}
            `;
            expect(row.library_group_id).toBe(TEST_GROUP_ID);
        });

        it('re-homes a book that ABS moved to another library', async () => {
            // `listAudiobooksForAbsLibrary` partitions by
            // custom_metadata.audiobookshelf.libraryId, so the new library sees
            // the item as absent-locally. Rewriting the metadata is what lets
            // the sweep adopt it instead of colliding on the external id.
            const mediaId = await seed('item-a1');
            await setAudiobookFlags(sql, [mediaId], { hasFiles: false, isDismissed: true });

            await updateAudiobookFromRemote(
                sql,
                mediaId,
                writeParams({ metadata: metadata({ libraryId: ABS_LIBRARY_B }) }),
            );

            expect(await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_A)).toHaveLength(0);
            const [moved] = await listAudiobooksForAbsLibrary(sql, ABS_LIBRARY_B);
            expect(moved).toMatchObject({ mediaId, isDismissed: false, hasFiles: true });
        });

        it('merges into custom_metadata instead of replacing keys owned elsewhere', async () => {
            const mediaId = await seed('item-a1');
            await sql`
                UPDATE media_items
                SET custom_metadata = custom_metadata || '{"someOtherSubsystem": {"keep": true}}'::jsonb
                WHERE id = ${mediaId}
            `;

            await updateAudiobookFromRemote(sql, mediaId, writeParams());

            const [row] = await sql<
                { custom_metadata: Record<string, unknown> }[]
            >`SELECT custom_metadata FROM media_items WHERE id = ${mediaId}`;

            expect(row.custom_metadata.someOtherSubsystem).toEqual({ keep: true });
            expect(row.custom_metadata.audiobookshelf).toBeDefined();
        });

        it('cannot touch a row of another media type', async () => {
            const [movie] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type) VALUES ('Ein Film', 'movie') RETURNING id
            `;
            try {
                await updateAudiobookFromRemote(sql, movie.id, writeParams({ title: 'Gekapert' }));

                const [row] = await sql<
                    { title: string }[]
                >`SELECT title FROM media_items WHERE id = ${movie.id}`;
                expect(row.title).toBe('Ein Film');
            } finally {
                await sql`DELETE FROM media_items WHERE id = ${movie.id}`;
            }
        });
    });

    describe('setAudiobookFlags', () => {
        it('dismisses a batch and stamps dismissed_at once', async () => {
            const first = await seed('item-a1');
            const second = await seed('item-a2');

            const affected = await setAudiobookFlags(sql, [first, second], {
                hasFiles: false,
                isDismissed: true,
            });
            expect(affected).toBe(2);

            const before = await sql<
                { id: string; dismissed_at: Date }[]
            >`SELECT id, dismissed_at FROM media_items WHERE id = ANY(${sql.array([first, second])}::uuid[]) ORDER BY id`;
            expect(before.every((r) => r.dismissed_at instanceof Date)).toBe(true);

            // A second sweep must not re-stamp the timestamp, or "how long has
            // this been gone" becomes meaningless.
            await setAudiobookFlags(sql, [first, second], { hasFiles: false, isDismissed: true });
            const after = await sql<
                { id: string; dismissed_at: Date }[]
            >`SELECT id, dismissed_at FROM media_items WHERE id = ANY(${sql.array([first, second])}::uuid[]) ORDER BY id`;
            expect(after.map((r) => r.dismissed_at.toISOString())).toEqual(
                before.map((r) => r.dismissed_at.toISOString()),
            );
        });

        it('never writes status=deleted when dismissing', async () => {
            const mediaId = await seed('item-a1');
            await setAudiobookFlags(sql, [mediaId], { hasFiles: false, isDismissed: true });

            const [row] = await sql<
                { status: string; has_files: boolean; is_dismissed: boolean }[]
            >`SELECT status, has_files, is_dismissed FROM media_items WHERE id = ${mediaId}`;

            // status='deleted' is a purge sentence the 30-day hard-delete sweep
            // acts on; an availability observation may never issue it.
            expect(row.status).toBe('active');
            expect(row.has_files).toBe(false);
            expect(row.is_dismissed).toBe(true);
        });

        it('clears dismissed_at when a book comes back', async () => {
            const mediaId = await seed('item-a1');
            await setAudiobookFlags(sql, [mediaId], { hasFiles: false, isDismissed: true });
            await setAudiobookFlags(sql, [mediaId], { hasFiles: true, isDismissed: false });

            const [row] = await sql<
                { dismissed_at: Date | null; has_files: boolean; is_dismissed: boolean }[]
            >`SELECT dismissed_at, has_files, is_dismissed FROM media_items WHERE id = ${mediaId}`;

            expect(row.dismissed_at).toBeNull();
            expect(row.is_dismissed).toBe(false);
            expect(row.has_files).toBe(true);
        });

        it('refuses to touch rows of another media type even when handed their ids', async () => {
            const [movie] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, has_files) VALUES ('Ein Film', 'movie', TRUE) RETURNING id
            `;
            const book = await seed('item-a1');
            try {
                const affected = await setAudiobookFlags(sql, [book, movie.id], {
                    hasFiles: false,
                    isDismissed: true,
                });

                expect(affected).toBe(1);
                const [row] = await sql<
                    { has_files: boolean }[]
                >`SELECT has_files FROM media_items WHERE id = ${movie.id}`;
                expect(row.has_files).toBe(true);
            } finally {
                await sql`DELETE FROM media_items WHERE id = ${movie.id}`;
            }
        });

        it('is a no-op for an empty id list', async () => {
            expect(await setAudiobookFlags(sql, [], { hasFiles: false, isDismissed: true })).toBe(
                0,
            );
        });
    });

    describe('countAudiobooks', () => {
        it('counts active audiobook rows only', async () => {
            const kept = await seed('item-a1');
            const removed = await seed('item-a2');
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${removed}`;

            expect(await countAudiobooks(sql)).toBe(1);
            expect(kept).toBeDefined();
        });

        it('excludes dismissed books so it agrees with the admin browser stat', async () => {
            // getMediaBrowserStats.audiobooks filters on has_files, which the
            // dismissal clears. Two operator-facing counters over one catalogue
            // disagreeing is the "contradictory counters" bug class.
            await seed('item-a1');
            const gone = await seed('item-a2');
            await setAudiobookFlags(sql, [gone], { hasFiles: false, isDismissed: true });

            expect(await countAudiobooks(sql)).toBe(1);
        });
    });
    // ── The persisted per-file codec ──────────────────────────────────────────
    // AudiobookShelf negotiates direct-play on bare container MIME types, so an
    // E-AC-3 track inside an `.m4b` advertises `audio/mp4`, ABS direct-plays it,
    // and Chromium then throws `EncodingError: Unable to decode audio data`
    // (measured in real Chrome). `audioFiles[].codec` is the only place the codec
    // is recorded, which makes these two reads the whole basis of the decision to
    // remux — and both of them read through jsonb, where a wrong key name yields
    // an empty answer rather than an error.
    describe('persisted per-file codec', () => {
        /**
         * Ids created here, cleaned up regardless of media_type.
         *
         * The file's shared `afterEach` deletes `WHERE media_type = 'audiobook'`,
         * and one case below deliberately flips a row to `'movie'` — which walked
         * straight past that filter and leaked BOTH the row and its
         * `external_ids` entry. `external_ids` is UNIQUE on
         * (provider, external_id, media_type) globally, so the leak then made the
         * next run of this file fail on insert. Cleaning up by id is the fix; the
         * per-case unique ABS id below means a leftover from a crashed run cannot
         * collide either.
         */
        const created: string[] = [];
        let seq = 0;
        const absId = (): string => `item-codec-${process.pid}-${++seq}`;

        async function seedCodecBook(files: AudiobookshelfMetadata['audioFiles']): Promise<string> {
            const mediaId = await seed(
                absId(),
                writeParams({ metadata: metadata({ audioFiles: files }) }),
            );
            created.push(mediaId);
            return mediaId;
        }

        afterEach(async () => {
            if (created.length === 0) return;
            await sql`DELETE FROM media_items WHERE id = ANY(${created}::uuid[])`;
            created.length = 0;
        });

        const EAC3_FILES = [
            { index: 1, ino: '986682', duration: 63.5, mimeType: 'audio/mp4', codec: 'eac3' },
            { index: 2, ino: '985031', duration: 1907, mimeType: 'audio/mp4', codec: 'eac3' },
        ];

        it('resolves the playback target with a codec map keyed by inode', async () => {
            const mediaId = await seedCodecBook(EAC3_FILES);

            const target = await resolveAudiobookPlaybackTarget(sql, mediaId);
            expect(target?.audioFileCodecs).toEqual({ '986682': 'eac3', '985031': 'eac3' });
        });

        it('reads back an empty map for a book with no persisted files', async () => {
            // A book ingested before audioFiles was persisted. Empty means "no
            // persisted codec", which the caller resolves from the live session.
            const mediaId = await seedCodecBook([]);
            const target = await resolveAudiobookPlaybackTarget(sql, mediaId);
            expect(target?.audioFileCodecs).toEqual({});
        });

        it('skips entries with no inode or no codec instead of inventing keys', async () => {
            // Cast because the TYPE requires `ino` and `codec` while the persisted
            // jsonb genuinely does not: rows written before those fields existed,
            // and files AudiobookShelf could not probe. The reader has to survive
            // them, so the fixture has to contain them.
            const mediaId = await seedCodecBook([
                { index: 1, ino: '1', duration: 10, mimeType: 'audio/mp4', codec: 'eac3' },
                { index: 2, duration: 10, mimeType: 'audio/mp4', codec: 'eac3' },
                { index: 3, ino: '3', duration: 10, mimeType: 'audio/mp4' },
            ] as unknown as AudiobookshelfMetadata['audioFiles']);

            const target = await resolveAudiobookPlaybackTarget(sql, mediaId);
            expect(target?.audioFileCodecs).toEqual({ '1': 'eac3' });
        });

        it('looks up one file by inode for the remux job label', async () => {
            const mediaId = await seedCodecBook(EAC3_FILES);

            expect(await getAudiobookFileCodec(sql, mediaId, '985031')).toBe('eac3');
        });

        it('returns null for an inode the sweep has never seen', async () => {
            const mediaId = await seedCodecBook(EAC3_FILES);

            expect(await getAudiobookFileCodec(sql, mediaId, '404404')).toBeNull();
        });

        it('cannot read a file codec across media types', async () => {
            // The lookup is reachable from a byte route, so it is scoped to
            // audiobook rows the same way every other read in this module is.
            const mediaId = await seedCodecBook(EAC3_FILES);
            // Flipping the type takes this row OUT of the file's shared
            // `afterEach` filter, which is why the block tracks its ids and
            // deletes by id.
            await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${mediaId}`;

            expect(await getAudiobookFileCodec(sql, mediaId, '986682')).toBeNull();
        });
    });
});
