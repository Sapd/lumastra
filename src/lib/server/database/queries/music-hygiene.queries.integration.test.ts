// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration tests for the music-hygiene findings.
 *
 * The fixture that matters most is the one that must NOT be flagged: Ed
 * Sheeran's albums are literally called `+`, `-` and `=`. Any "junk-looking
 * title" shape test flags his whole discography, and an operator who sees an
 * obviously wrong finding stops trusting every other count on the page. Every
 * assertion below that says `not.toContain` is there to keep a future
 * "improvement" from reintroducing exactly that.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    MUSIC_HYGIENE_VIEW,
} from '$lib/shared/music-hygiene.js';
import { countMusicHygieneFinding, countMusicHygieneFindings } from './music-hygiene.queries.js';
import { countAdminMediaItems, listAdminMediaItems } from './admin-media.queries.js';
import {
    findCollaborationArtists,
    getTrackIdsReferencingArtistId,
    setArtistNoSplit,
} from './artist-merge.queries.js';

/** Ids of every fixture row, so assertions read by name rather than by index. */
interface Fixture {
    edSheeran: string;
    albumPlus: string;
    albumMinus: string;
    albumEquals: string;
    edTracks: string[];
    /**
     * The scanner recorded `title_source = 'filename'`. Its title resembles no
     * derivation of its path, so only the recorded fact can list it.
     */
    recordedFilename: string;
    /**
     * Recorded `'tag'`, but its title IS its basename — a shape the old
     * reconstruction listed. The recorded fact wins, and the backfill must not
     * overwrite it.
     */
    recordedTag: string;
    /** Recorded `'filename'`, but `has_files = false` puts it out of scope. */
    hiddenRecordedFilename: string;
    /*
     * Pre-16.276.0 rows (`title_source` NULL) in each filename shape. The
     * finding ignores them until the backfill migration marks them.
     */
    /** title === basename WITH extension (shape 1). */
    shapeBasename: string;
    /** title === normalizeUnderscoreStem(stem) (shape 2), and shape 3 too. */
    shapeUnderscore: string;
    /**
     * title === normalizeUnderscoreStem(stem) and NOTHING else — the stem keeps
     * its track-number prefix, which every other shape strips. Shape 2 is
     * otherwise indistinguishable from shape 3, so without this row the whole
     * shape-2 branch can be deleted with the suite still green.
     */
    shapeUnderscoreOnly: string;
    /** title === stripTrackNumberPrefix(normalized stem) (shape 3). */
    shapeTrackNumber: string;
    /** title === right half of an `Artist - Title` split (shape 4). */
    shapeArtistTitle: string;
    /** `1999 - Title.mp3` — the split is REJECTED, so this must not be flagged. */
    yearPrefixed: string;
    /** `CD1 - Title.mp3` — the OTHER left-side rejection. Must not be flagged. */
    discPrefixed: string;
    /** Properly tagged track whose title resembles no derivation of its path. */
    wellTagged: string;
    /** Track with no parent at all. */
    orphanTrack: string;
    /** Album with `parent_id IS NULL`. */
    homelessAlbum: string;
    /** Album parented to something that is not an artist. */
    misparentedAlbum: string;
    /** Artist name with a collaboration marker and no `no_split` flag. */
    collabArtist: string;
    /** A compilation track whose per-track credit points at `collabArtist`. */
    compilationTrack: string;
    /** Same shape, but an operator flagged it `no_split = true`. */
    noSplitArtist: string;
    /**
     * `+44` — a real band whose name GLUES the `+` to the digits. Must NOT be
     * flagged: there is no conjunction, only a character that happens to be one
     * of the markers. The predicate used to spell the marker branch with `*` on
     * both sides, which reduces to "contains `&` or `+` anywhere".
     */
    unspacedPlusArtist: string;
    /** `AC&DC` — the same trap on the other marker character. */
    unspacedAmpArtist: string;
    /** Matches the track finding, but `has_files = false` puts it out of scope. */
    hiddenOrphanTrack: string;
    /** Matches the conjunction finding, but the orphan-stub rule excludes it. */
    stubCollabArtist: string;
}

describe('Music hygiene findings', () => {
    let sql: postgres.Sql;
    let fx: Fixture;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    /** Insert one media_items row and return its id. */
    async function item(opts: {
        title: string;
        type: string;
        parent?: string | null;
        customMetadata?: Record<string, unknown>;
        hasFiles?: boolean;
        titleSource?: 'tag' | 'filename';
    }): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id, has_files, custom_metadata, title_source)
            VALUES (
                ${opts.title},
                ${opts.type},
                'active',
                ${opts.parent ?? null},
                ${opts.hasFiles ?? true},
                ${opts.customMetadata ? sql.json(opts.customMetadata as postgres.JSONValue) : sql`'{}'::jsonb`},
                ${opts.titleSource ?? null}
            )
            RETURNING id
        `;
        return row!.id;
    }

    /**
     * Attach a media_files row at `filePath` to an existing item.
     *
     * `is_default` is computed the way `attachFileToItem` does it — the first
     * file for an item is the default, later ones are not. A partial unique
     * index enforces that, so a second attachment with the default flag left at
     * its column default fails outright.
     */
    async function file(mediaItemId: string, filePath: string): Promise<void> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${filePath}) RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (
                ${f!.id}::uuid,
                ${mediaItemId}::uuid,
                NOT EXISTS (
                    SELECT 1 FROM media_file_items
                    WHERE media_item_id = ${mediaItemId}::uuid AND is_default = true
                )
            )
        `;
    }

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);

        // --- Eli Fenwick: the must-NOT-flag fixture -------------------------
        const edSheeran = await item({ title: 'Eli Fenwick', type: 'artist' });
        const albumPlus = await item({ title: '+', type: 'album', parent: edSheeran });
        const albumMinus = await item({ title: '-', type: 'album', parent: edSheeran });
        const albumEquals = await item({ title: '=', type: 'album', parent: edSheeran });
        const edTracks: string[] = [];
        for (const [album, title, path] of [
            [
                albumPlus,
                'The A Team (Live)',
                '/music/Eli Fenwick/+/01 - Eli Fenwick - The A Team.flac',
            ],
            [
                albumMinus,
                'Eyes Closed (Album Version)',
                '/music/Eli Fenwick/-/02 - Eli Fenwick - Eyes Closed.flac',
            ],
            [
                albumEquals,
                'Bad Habits (Radio Edit)',
                '/music/Eli Fenwick/=/03 - Eli Fenwick - Bad Habits.flac',
            ],
        ] as const) {
            const id = await item({ title, type: 'track', parent: album });
            await file(id, path);
            edTracks.push(id);
        }

        // --- Recorded title sources, and the four pre-16.276.0 filename
        //     shapes, each in a sound hierarchy so that the filename finding
        //     is the ONLY one they can trip ---------------------------------
        const ripper = await item({ title: 'Tagless Ripper', type: 'artist' });
        const rips = await item({ title: 'Rips', type: 'album', parent: ripper });

        const recordedFilename = await item({
            title: 'Whatever The Scanner Wrote',
            type: 'track',
            parent: rips,
            titleSource: 'filename',
        });
        await file(recordedFilename, '/music/Tagless Ripper/Rips/track07.mp3');

        const recordedTag = await item({
            title: 'Tagged Song.mp3',
            type: 'track',
            parent: rips,
            titleSource: 'tag',
        });
        await file(recordedTag, '/music/Tagless Ripper/Rips/Tagged Song.mp3');

        const hiddenRecordedFilename = await item({
            title: 'Gone',
            type: 'track',
            parent: rips,
            hasFiles: false,
            titleSource: 'filename',
        });

        const shapeBasename = await item({ title: 'Some Song.mp3', type: 'track', parent: rips });
        await file(shapeBasename, '/music/Tagless Ripper/Rips/Some Song.mp3');

        const shapeUnderscore = await item({
            title: 'another song here',
            type: 'track',
            parent: rips,
        });
        await file(shapeUnderscore, '/music/Tagless Ripper/Rips/another_song_here.mp3');

        // `03_-_only_title` normalises to `03 - only title`, which the INSERT
        // path in audio-processor.ts stores VERBATIM (it calls
        // normalizeUnderscoreStem with no track-number strip). Shape 3 would
        // give `only title` and shape 4 nothing, so only shape 2 can match.
        const shapeUnderscoreOnly = await item({
            title: '03 - only title',
            type: 'track',
            parent: rips,
        });
        await file(shapeUnderscoreOnly, '/music/Tagless Ripper/Rips/03_-_only_title.mp3');

        const shapeTrackNumber = await item({ title: 'Plain Title', type: 'track', parent: rips });
        await file(shapeTrackNumber, '/music/Tagless Ripper/Rips/05 Plain Title.mp3');

        const shapeArtistTitle = await item({ title: 'Real Song', type: 'track', parent: rips });
        await file(shapeArtistTitle, '/music/Tagless Ripper/Rips/01 - Some Artist - Real Song.mp3');

        // `1999` on the left of the split is a YEAR layout, not an artist, so
        // parseArtistTitleFromStem rejects it — the title is a real tag.
        const yearPrefixed = await item({
            title: 'Little Red Lantern',
            type: 'track',
            parent: rips,
        });
        await file(yearPrefixed, '/music/Tagless Ripper/Rips/1999 - Little Red Lantern.mp3');

        // `CD1` on the left of the split is a DISC MARKER, not an artist —
        // parseArtistTitleFromStem rejects it too, and every multi-disc rip in a
        // library uses this layout. Without this row the disc/volume rejection
        // can be deleted outright with the suite still green, and the finding
        // then flags a whole box set that was correctly tagged.
        const discPrefixed = await item({
            title: 'Real Title',
            type: 'track',
            parent: rips,
        });
        await file(discPrefixed, '/music/Tagless Ripper/Rips/CD1 - Real Title.mp3');

        const wellTagged = await item({ title: 'Perfectly Tagged', type: 'track', parent: rips });
        await file(wellTagged, '/music/Tagless Ripper/Rips/tr_07.mp3');

        // --- Broken ancestry ----------------------------------------------
        const orphanTrack = await item({ title: 'Orphan Track', type: 'track', parent: null });
        await file(orphanTrack, '/music/loose/orphan.mp3');

        const homelessAlbum = await item({ title: 'Homeless Album', type: 'album', parent: null });
        const misparentedAlbum = await item({
            title: 'Misparented Album',
            type: 'album',
            parent: wellTagged,
        });

        // --- The conjunction heuristic --------------------------------------
        // Each artist needs a child, otherwise the browser's orphan-stub filter
        // hides it from the list AND from the count, and the test proves nothing.
        const collabArtist = await item({
            title: 'Aria Fenwick & Nora Vale',
            type: 'artist',
            customMetadata: {
                enrichment: { source: 'test', score: 0.97 },
                curator_note: 'keep me',
            },
        });
        await item({ title: 'Shore To Shore', type: 'album', parent: collabArtist });

        // Preserve the non-parent relationship shape too: compilation tracks
        // identify their credited artist through additional_artist_ids.
        const variousArtists = await item({ title: 'Various Artists', type: 'artist' });
        const compilation = await item({
            title: 'Guest Appearances',
            type: 'album',
            parent: variousArtists,
        });
        const compilationTrack = await item({
            title: 'A Different Shore',
            type: 'track',
            parent: compilation,
            customMetadata: { additional_artist_ids: [collabArtist], recording_note: 'retain' },
        });

        const noSplitArtist = await item({
            title: 'Above & Lanterns',
            type: 'artist',
            customMetadata: { no_split: true },
        });
        await item({ title: 'Group Therapy', type: 'album', parent: noSplitArtist });

        // The false positives the `*` quantifier produced. Both need a child
        // for the same reason the two above do — the orphan-stub filter would
        // otherwise hide them and the assertion would prove nothing.
        const unspacedPlusArtist = await item({ title: '+44', type: 'artist' });
        await item({
            title: 'When Your Heart Stops Beating',
            type: 'album',
            parent: unspacedPlusArtist,
        });

        const unspacedAmpArtist = await item({ title: 'AC&DC', type: 'artist' });
        await item({ title: 'Back In Amber', type: 'album', parent: unspacedAmpArtist });

        // --- Rows the PREDICATE matches but the browser's base population
        //     excludes. They exist so the parity assertions have something to
        //     catch: a count that forgets `has_files`, or one that forgets the
        //     orphan-stub rule, reports a number the list cannot produce.
        const hiddenOrphanTrack = await item({
            title: 'Invisible Orphan',
            type: 'track',
            parent: null,
            hasFiles: false,
        });
        const stubCollabArtist = await item({ title: 'Foo & Bar', type: 'artist' });

        fx = {
            edSheeran,
            albumPlus,
            albumMinus,
            albumEquals,
            edTracks,
            recordedFilename,
            recordedTag,
            hiddenRecordedFilename,
            shapeBasename,
            shapeUnderscore,
            shapeUnderscoreOnly,
            shapeTrackNumber,
            shapeArtistTitle,
            yearPrefixed,
            discPrefixed,
            wellTagged,
            orphanTrack,
            homelessAlbum,
            misparentedAlbum,
            collabArtist,
            compilationTrack,
            noSplitArtist,
            unspacedPlusArtist,
            unspacedAmpArtist,
            hiddenOrphanTrack,
            stubCollabArtist,
        };
    });

    /** The ids the media browser lists for a finding's own deep link. */
    async function listFor(finding: (typeof MUSIC_HYGIENE_FINDINGS)[number]): Promise<string[]> {
        const rows = await listAdminMediaItems(sql, {
            types: [MUSIC_HYGIENE_VIEW[finding].type],
            musicHygiene: finding,
            limit: 200,
            offset: 0,
        });
        return rows.map((r) => r.id);
    }

    describe('Eli Fenwick must not be flagged', () => {
        it('leaves the +, - and = albums out of every finding', async () => {
            for (const finding of MUSIC_HYGIENE_FINDINGS) {
                const ids = await listFor(finding);
                expect(ids, `${finding} flagged an Eli Fenwick album`).not.toContain(fx.albumPlus);
                expect(ids, `${finding} flagged an Eli Fenwick album`).not.toContain(fx.albumMinus);
                expect(ids, `${finding} flagged an Eli Fenwick album`).not.toContain(
                    fx.albumEquals,
                );
            }
        });

        it('leaves his artist row and his tracks out of every finding', async () => {
            for (const finding of MUSIC_HYGIENE_FINDINGS) {
                const ids = await listFor(finding);
                expect(ids, `${finding} flagged the Eli Fenwick artist row`).not.toContain(
                    fx.edSheeran,
                );
                for (const trackId of fx.edTracks) {
                    expect(ids, `${finding} flagged an Eli Fenwick track`).not.toContain(trackId);
                }
            }
        });
    });

    describe('track has no artist ancestor', () => {
        it('matches only the parentless track', async () => {
            expect(await listFor(MUSIC_HYGIENE_TRACK_NO_ARTIST)).toEqual([fx.orphanTrack]);
        });

        it('leaves out a matching track the browser cannot list', async () => {
            const ids = await listFor(MUSIC_HYGIENE_TRACK_NO_ARTIST);
            expect(ids).not.toContain(fx.hiddenOrphanTrack);
        });
    });

    describe('album has no artist parent', () => {
        it('matches a parentless album and one parented to a non-artist', async () => {
            const ids = await listFor(MUSIC_HYGIENE_ALBUM_NO_ARTIST);
            expect(ids.sort()).toEqual([fx.homelessAlbum, fx.misparentedAlbum].sort());
        });
    });

    describe('title is filename-derived', () => {
        it('lists exactly the rows the scanner recorded as filename titles', async () => {
            expect(await listFor(MUSIC_HYGIENE_TITLE_FROM_FILENAME)).toEqual([fx.recordedFilename]);
        });

        it('trusts a recorded tag over a title that looks like the file name', async () => {
            expect(await listFor(MUSIC_HYGIENE_TITLE_FROM_FILENAME)).not.toContain(fx.recordedTag);
        });

        it('leaves out a recorded filename track the browser cannot list', async () => {
            const ids = await listFor(MUSIC_HYGIENE_TITLE_FROM_FILENAME);
            expect(ids).not.toContain(fx.hiddenRecordedFilename);
        });
    });

    describe('title_source column', () => {
        it('constrains the column and serves the finding from the partial index', async () => {
            await expect(
                sql`UPDATE media_items SET title_source = 'bogus' WHERE id = ${fx.wellTagged}`,
            ).rejects.toThrow(/media_items_title_source_check/);

            // With seqscans priced out, a plan that can use the index does; a
            // predicate that drifted from the index's WHERE cannot. Fresh stats
            // first: earlier test files in the same database leave media_items
            // statistics that can price another index below this tiny one.
            await sql`ANALYZE media_items`;
            const plan = await sql.begin(async (tx) => {
                await tx`SET LOCAL enable_seqscan = off`;
                return tx<{ 'QUERY PLAN': string }[]>`
                    EXPLAIN SELECT COUNT(*) FROM media_items mi
                    WHERE mi.media_type = 'track' AND mi.title_source = 'filename'
                `;
            });
            const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
            expect(planText, planText).toContain('idx_media_items_track_title_from_filename');
        });
    });

    describe('artist name carries a conjunction (heuristic)', () => {
        it('toggles queue eligibility while preserving artist metadata and media relationships', async () => {
            const findRows = async (): Promise<string[]> =>
                (await findCollaborationArtists(sql)).map((row) => row.id);
            const readArtist = async (): Promise<{
                custom_metadata: Record<string, unknown>;
                parent_id: string | null;
            }> => {
                const [row] = await sql<
                    { custom_metadata: Record<string, unknown>; parent_id: string | null }[]
                >`
                    SELECT custom_metadata, parent_id
                    FROM media_items
                    WHERE id = ${fx.collabArtist} AND media_type = 'artist'
                `;
                return row!;
            };

            expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(1);
            expect(await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT)).toContain(fx.collabArtist);
            expect(await findRows()).toContain(fx.collabArtist);
            expect(await getTrackIdsReferencingArtistId(sql, fx.collabArtist)).toContain(
                fx.compilationTrack,
            );

            expect(await setArtistNoSplit(sql, fx.collabArtist, true)).toBe(true);
            expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(0);
            expect(await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT)).not.toContain(fx.collabArtist);
            expect(await findRows()).not.toContain(fx.collabArtist);

            const marked = await readArtist();
            expect(marked.parent_id).toBeNull();
            expect(marked.custom_metadata).toEqual({
                enrichment: { source: 'test', score: 0.97 },
                curator_note: 'keep me',
                no_split: true,
            });
            expect(
                await sql<{ id: string }[]>`
                    SELECT id FROM media_items
                    WHERE media_type = 'album' AND parent_id = ${fx.collabArtist}
                `,
            ).toHaveLength(1);
            expect(await getTrackIdsReferencingArtistId(sql, fx.collabArtist)).toContain(
                fx.compilationTrack,
            );

            expect(await setArtistNoSplit(sql, fx.collabArtist, false)).toBe(true);
            expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(1);
            expect(await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT)).toContain(fx.collabArtist);
            expect(await findRows()).toContain(fx.collabArtist);

            const restored = await readArtist();
            expect(restored.parent_id).toBeNull();
            expect(restored.custom_metadata).toEqual({
                enrichment: { source: 'test', score: 0.97 },
                curator_note: 'keep me',
            });
            expect(await getTrackIdsReferencingArtistId(sql, fx.collabArtist)).toContain(
                fx.compilationTrack,
            );
            const trackMetadata = await sql<{ custom_metadata: Record<string, unknown> }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${fx.compilationTrack}
            `;
            expect(trackMetadata[0]?.custom_metadata).toEqual({
                additional_artist_ids: [fx.collabArtist],
                recording_note: 'retain',
            });
        });

        it('matches an unflagged collaboration name', async () => {
            expect(await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT)).toEqual([fx.collabArtist]);
        });

        it('is suppressed by custom_metadata.no_split', async () => {
            expect(await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT)).not.toContain(fx.noSplitArtist);
        });

        it('leaves out a matching artist the orphan-stub rule hides', async () => {
            expect(await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT)).not.toContain(fx.stubCollabArtist);
        });

        /**
         * The `+`/`&` branch used to be `[[:space:]]*[&+][[:space:]]*` —
         * zero-or-more on BOTH sides, which reduces to "the name contains an `&`
         * or a `+` anywhere". `+44` is a real band and `AC&DC` is a real
         * stylisation; neither carries a conjunction, and every existing fixture
         * here used a SPACED `&`, so nothing would have caught the regression.
         *
         * This is the finding's founding constraint restated: it must be
         * defensible row by row, in the same catalogue where `+`, `-` and `=`
         * are symbol-only album fixtures.
         *
         * Revert-check (INVERT): put the `*` quantifiers back in
         * `buildArtistUnsplitFragment` and this fails on both names.
         */
        it('does not flag a name that merely CONTAINS & or + unspaced', async () => {
            const listed = await listFor(MUSIC_HYGIENE_ARTIST_UNSPLIT);
            expect(listed).not.toContain(fx.unspacedPlusArtist);
            expect(listed).not.toContain(fx.unspacedAmpArtist);
        });
    });

    describe('count parity', () => {
        it('every finding counts exactly what its own list returns', async () => {
            for (const finding of MUSIC_HYGIENE_FINDINGS) {
                const ids = await listFor(finding);
                const badgeCount = await countMusicHygieneFinding(sql, finding);
                const listTotal = await countAdminMediaItems(sql, {
                    types: [MUSIC_HYGIENE_VIEW[finding].type],
                    musicHygiene: finding,
                });
                expect(badgeCount, `${finding}: badge count vs list length`).toBe(ids.length);
                expect(listTotal, `${finding}: list total vs list length`).toBe(ids.length);
            }
        });

        it('countMusicHygieneFindings returns the same numbers one at a time', async () => {
            const all = await countMusicHygieneFindings(sql);
            expect(all).toEqual({
                [MUSIC_HYGIENE_TRACK_NO_ARTIST]: 1,
                [MUSIC_HYGIENE_ALBUM_NO_ARTIST]: 2,
                [MUSIC_HYGIENE_TITLE_FROM_FILENAME]: 1,
                [MUSIC_HYGIENE_ARTIST_UNSPLIT]: 1,
            });
        });

        it('counts items, not files — a multi-file track is counted once', async () => {
            // The two defects this browser has already shipped and fixed were
            // both a count over `media_files` against a list over `media_items`.
            // A second file on an already-matching track must not move the count.
            await file(fx.recordedFilename, '/music/Tagless Ripper/Rips/track07.mp3.bak');
            const count = await countMusicHygieneFinding(sql, MUSIC_HYGIENE_TITLE_FROM_FILENAME);
            const ids = await listFor(MUSIC_HYGIENE_TITLE_FROM_FILENAME);
            expect(count).toBe(1);
            expect(ids).toHaveLength(1);
        });
    });
});
