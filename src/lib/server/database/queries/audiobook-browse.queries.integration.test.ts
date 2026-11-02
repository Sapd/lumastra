// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration tests for the `/audiobooks` destination reads.
 *
 * These pin the three things that are only true in real SQL and are each a
 * user-visible failure if wrong:
 *
 * - **Access.** File-less rows slip through the shared `buildLibraryAccessFilter`
 *   unconditionally, so every read here uses the library_group_id-column filter
 *   instead. A regression is a private shelf leaking, which no type checks.
 * - **Series collapse.** `DISTINCT ON` + a window `COUNT(*)` over the same
 *   partition only counts siblings correctly because window functions run
 *   before DISTINCT ON discards them.
 * - **Facet disjointness.** The design doc's §9 asks explicitly for
 *   "language chips × group tabs return disjoint, correct sets".
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { listCatalogBooks } from './audiobook-catalog.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
    insertAudiobook,
    type AudiobookWriteParams,
    type AudiobookshelfMetadata,
} from './audiobooks.queries.js';
import {
    getAudiobookEntries,
    getAudiobookLanguages,
    getAudiobookLetterCounts,
    getAudiobookShelves,
    getAudiobooksInProgress,
    hasVisibleAudiobooks,
} from './audiobook-browse.queries.js';
import {
    restrictedAccess,
    unrestrictedAccess,
    denyAllAccess,
} from './builders/media-access-boundary.js';

const GROUP_BOOKS = '00000000-0000-0000-0000-0000000ac001';
const GROUP_PLAYS = '00000000-0000-0000-0000-0000000ac002';
const PATH_DE = '00000000-0000-0000-0000-0000000ac0d0';
const PATH_EN = '00000000-0000-0000-0000-0000000ac0e0';

function metadata(overrides: Partial<AudiobookshelfMetadata> = {}): AudiobookshelfMetadata {
    return {
        derivedSeries: { name: null, sequence: null, source: 'none' },
        audioFiles: [],
        libraryId: 'abs-lib',
        libraryPathId: PATH_DE,
        updatedAt: 1_700_000_000_000,
        mtimeMs: 1_699_000_000_000,
        addedAt: null,
        relPath: null,
        coverPath: null,
        subtitle: null,
        authors: ['Autorin'],
        narrators: ['Sprecher'],
        series: [],
        genres: [],
        publisher: null,
        publishedYear: null,
        language: null,
        isbn: null,
        asin: null,
        explicit: false,
        abridged: false,
        duration: 3600,
        chapters: [],
        ...overrides,
    };
}

function writeParams(overrides: Partial<AudiobookWriteParams> = {}): AudiobookWriteParams {
    return {
        sortOrder: null,
        title: 'Ein Buch',
        sortTitle: 'ein buch',
        overview: null,
        year: 2001,
        runtimeSeconds: 3600,
        hasFiles: true,
        libraryGroupId: GROUP_BOOKS,
        libraryAddedAt: new Date('2024-01-01T00:00:00Z'),
        metadata: metadata(),
        ...overrides,
    };
}

describe('Audiobook browse queries', () => {
    it('exposes the same access boundary through the new explicit collapse API', async () => {
        await seedSeriesBook('pkg18-one', 'Catalog Cycle', 1);
        await seedSeriesBook('pkg18-two', 'Catalog Cycle', 2);
        const result = await listCatalogBooks(sql, {
            access: unrestrictedAccess(),
            viewerId: null,
            surface: 'v1',
            groupId: GROUP_BOOKS,
            collapse: 'series',
            limit: 60,
            offset: 0,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].audiobook.series?.bookCount).toBe(2);
        expect(result.page.total).toBe(1);
    });

    let sql: postgres.Sql;

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

    /** A book in a derived series at `sequence`, titled the way ABS numbers them. */
    async function seedSeriesBook(
        absItemId: string,
        seriesName: string,
        sequence: number,
        overrides: Partial<AudiobookWriteParams> = {},
    ): Promise<string> {
        return seed(
            absItemId,
            writeParams({
                title: `${sequence} - Folge`,
                sortTitle: `${sequence} - folge`,
                sortOrder: sequence * 1000,
                metadata: metadata({
                    ...(overrides.metadata ?? {}),
                    derivedSeries: { name: seriesName, sequence, source: 'abs-series' },
                }),
                ...overrides,
            }),
        );
    }

    beforeAll(async () => {
        sql = getTestDb();
        await sql`
            INSERT INTO library_groups (id, name, sort_order) VALUES
                (${GROUP_BOOKS}, 'Audiobooks Test', 1),
                (${GROUP_PLAYS}, 'Radioplays Test', 2)
            ON CONFLICT DO NOTHING
        `;
        await sql`
            INSERT INTO library_paths (id, path, media_type, language, provider, library_group_id, enabled)
            VALUES
                (${PATH_DE}, 'abs://lib-de', 'audiobook', 'de', 'audiobookshelf', ${GROUP_BOOKS}, TRUE),
                (${PATH_EN}, 'abs://lib-en', 'audiobook', 'en', 'audiobookshelf', ${GROUP_BOOKS}, TRUE)
            ON CONFLICT DO NOTHING
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM library_paths WHERE id IN (${PATH_DE}, ${PATH_EN})`;
        await closeTestDb();
    });

    // Clean BEFORE as well as after. Cleaning only afterwards makes the FIRST
    // test in this file inherit whatever audiobook rows another test file left
    // behind, and several do. That produced a genuine order-dependent failure:
    // run after audiobook-session.integration.test.ts and the visibility
    // assertion saw 19 foreign titles; run in the other order and it passed.
    //
    // Cleaning before is the robust fix rather than chasing every leaker,
    // because this file's assertions are absolute lists over an UNSCOPED table
    // and therefore cannot distinguish "the visibility filter broke" from
    // "someone else's rows are here" — which would mislead whoever hit it.
    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}`;
    });

    afterEach(async () => {
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}`;
    });

    const list = (options: Parameters<typeof getAudiobookEntries>[1]) =>
        getAudiobookEntries(sql, options);

    const baseList = {
        access: unrestrictedAccess(),
        limit: 50,
        offset: 0,
        sort: 'title_asc' as const,
    };

    describe('visibility', () => {
        it('hides dismissed and unavailable books from every browse read', async () => {
            await seed('visible');
            const dismissed = await seed('gone', writeParams({ title: 'Verschwunden' }));
            await sql`UPDATE media_items SET is_dismissed = TRUE WHERE id = ${dismissed}`;
            await seed('missing', writeParams({ title: 'Fehlend', hasFiles: false }));

            const result = await list(baseList);

            expect(result.entries.map((e) => e.title)).toEqual(['Ein Buch']);
            expect(result.totalCount).toBe(1);
        });

        it('applies the library-group denial that the file-based filter cannot', async () => {
            // The regression this guards: audiobooks have NO media_files rows, so
            // buildLibraryAccessFilter's "no files → visible" branch would return
            // this book to a viewer explicitly denied its group.
            await seed('private', writeParams({ libraryGroupId: GROUP_PLAYS }));
            await seed('public');

            const result = await list({
                ...baseList,
                access: restrictedAccess({
                    deniedGroupIds: [GROUP_PLAYS],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            });

            expect(result.entries).toHaveLength(1);
            expect(result.entries[0].libraryGroupId).toBe(GROUP_BOOKS);
        });

        it('applies the age limit', async () => {
            const adult = await seed('adult');
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult}`;
            await seed('kids', writeParams({ title: 'Kinderbuch' }));

            const result = await list({
                ...baseList,
                access: restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            });

            expect(result.entries.map((e) => e.title)).toEqual(['Kinderbuch']);
        });

        it('returns nothing for a deny-all boundary without touching the database', async () => {
            await seed('any');
            await expect(list({ ...baseList, access: denyAllAccess() })).resolves.toEqual({
                entries: [],
                totalCount: 0,
            });
            await expect(getAudiobookShelves(sql, denyAllAccess())).resolves.toEqual([]);
            await expect(hasVisibleAudiobooks(sql, denyAllAccess())).resolves.toBe(false);
        });
    });

    describe('series collapse', () => {
        it('folds a derived series into one entry carrying its book count', async () => {
            await seedSeriesBook('klmn-1', 'KLMN', 1);
            await seedSeriesBook('klmn-2', 'KLMN', 2);
            await seedSeriesBook('klmn-3', 'KLMN', 3);
            await seed('standalone', writeParams({ title: 'Allein', sortTitle: 'allein' }));

            const result = await list(baseList);

            expect(result.totalCount).toBe(2);
            const series = result.entries.find((e) => e.kind === 'series');
            expect(series).toMatchObject({ title: 'KLMN', bookCount: 3 });
            // Representative = lowest sequence, so the tile shows volume 1's cover.
            expect(series?.seriesSequence).toBe(1);
            expect(result.entries.find((e) => e.kind === 'book')?.title).toBe('Allein');
        });

        it('files a collapsed series under the series name, not its first title', async () => {
            // The books are titled "65 - …" and would otherwise all bucket under '#'.
            await seedSeriesBook('drei-65', 'Die sieben Laternenzeichen', 65);
            await seedSeriesBook('drei-66', 'Die sieben Laternenzeichen', 66);

            const counts = await getAudiobookLetterCounts(sql, { access: unrestrictedAccess() });

            expect(counts).toEqual([{ letter: 'D', count: 1 }]);
        });

        it('lists the books of one series in sequence order when drilled into', async () => {
            await seedSeriesBook('klmn-2', 'KLMN', 2);
            await seedSeriesBook('klmn-1', 'KLMN', 1);
            await seedSeriesBook('klmn-10', 'KLMN', 10);
            await seed('other', writeParams({ title: 'Anderes' }));

            const result = await list({ ...baseList, series: 'KLMN', sort: 'series_sequence' });

            expect(result.totalCount).toBe(3);
            expect(result.entries.map((e) => e.seriesSequence)).toEqual([1, 2, 10]);
            expect(result.entries.every((e) => e.kind === 'book')).toBe(true);
            expect(result.entries.every((e) => e.bookCount === 1)).toBe(true);
        });

        it('treats a one-book series as a book, titled with the book title', async () => {
            await seedSeriesBook('solo-1', 'Einzelreihe', 1);

            const [entry] = (await list(baseList)).entries;

            expect(entry.kind).toBe('book');
            expect(entry.title).toBe('1 - Folge');
            expect(entry.seriesName).toBe('Einzelreihe');
        });

        it('sorts and buckets a one-book series by the book title it shows', async () => {
            // Prod: "Herbst - Stand By Me" in a one-book "Stephen King …" series
            // filed under S and sat between "Stephen King - Omi" and "Winter".
            await seedSeriesBook('solo-herbst', 'Stephen King Hörspiele', 1, {
                title: 'Herbst',
                sortTitle: 'herbst',
            });
            await seed('alpha', writeParams({ title: 'Alpha', sortTitle: 'alpha' }));
            await seed('zebra', writeParams({ title: 'Zebra', sortTitle: 'zebra' }));

            const result = await list({ ...baseList, sort: 'title_asc' });
            expect(result.entries.map((e) => e.title)).toEqual(['Alpha', 'Herbst', 'Zebra']);

            const counts = await getAudiobookLetterCounts(sql, { access: unrestrictedAccess() });
            expect(counts).toEqual([
                { letter: 'A', count: 1 },
                { letter: 'H', count: 1 },
                { letter: 'Z', count: 1 },
            ]);
            const h = await list({ ...baseList, letter: 'H' });
            expect(h.entries.map((e) => e.title)).toEqual(['Herbst']);
        });

        it('suppresses a collapsed series runtime rather than showing book one’s', async () => {
            await seedSeriesBook('klmn-1', 'KLMN', 1);
            await seedSeriesBook('klmn-2', 'KLMN', 2);

            const [entry] = (await list(baseList)).entries;

            expect(entry.kind).toBe('series');
            expect(entry.runtimeSeconds).toBeNull();
        });
    });

    describe('facets', () => {
        it('returns group tabs and language chips as disjoint, correct sets', async () => {
            await seed('de-1');
            await seed('de-2', writeParams({ title: 'Zweites Buch' }));
            await seed(
                'en-1',
                writeParams({
                    title: 'English Book',
                    metadata: metadata({ libraryPathId: PATH_EN }),
                }),
            );
            await seed('play-de', writeParams({ title: 'Hörspiel', libraryGroupId: GROUP_PLAYS }));

            const shelves = await getAudiobookShelves(sql, unrestrictedAccess());
            expect(shelves).toEqual([
                { id: GROUP_BOOKS, name: 'Audiobooks Test', bookCount: 3 },
                { id: GROUP_PLAYS, name: 'Radioplays Test', bookCount: 1 },
            ]);

            // Chips are counted WITHIN the selected shelf.
            const languages = await getAudiobookLanguages(sql, {
                access: unrestrictedAccess(),
                groupId: GROUP_BOOKS,
            });
            expect(languages).toEqual([
                { language: 'de', bookCount: 2 },
                { language: 'en', bookCount: 1 },
            ]);

            const deOnly = await list({ ...baseList, groupId: GROUP_BOOKS, language: 'de' });
            const enOnly = await list({ ...baseList, groupId: GROUP_BOOKS, language: 'en' });
            expect(deOnly.entries.map((e) => e.title).sort()).toEqual(['Ein Buch', 'Zweites Buch']);
            expect(enOnly.entries.map((e) => e.title)).toEqual(['English Book']);
            // Disjoint: no title appears under both chips.
            expect(
                deOnly.entries.filter((d) => enOnly.entries.some((e) => e.mediaId === d.mediaId)),
            ).toEqual([]);
        });

        it('omits shelves a restricted viewer may not see', async () => {
            await seed('private', writeParams({ libraryGroupId: GROUP_PLAYS }));
            await seed('public');

            const shelves = await getAudiobookShelves(
                sql,
                restrictedAccess({
                    deniedGroupIds: [GROUP_PLAYS],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );

            expect(shelves.map((s) => s.id)).toEqual([GROUP_BOOKS]);
        });
    });

    describe('sorting and paging', () => {
        it('sorts by title, year and recency, and pages over collapsed entries', async () => {
            await seed('b', writeParams({ title: 'Bravo', sortTitle: 'bravo', year: 1999 }));
            await seed(
                'a',
                writeParams({
                    title: 'Alpha',
                    sortTitle: 'alpha',
                    year: 2020,
                    libraryAddedAt: new Date('2025-01-01T00:00:00Z'),
                }),
            );
            await seed('c', writeParams({ title: 'Charlie', sortTitle: 'charlie', year: 2010 }));

            const asc = await list(baseList);
            expect(asc.entries.map((e) => e.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);

            const desc = await list({ ...baseList, sort: 'title_desc' });
            expect(desc.entries.map((e) => e.title)).toEqual(['Charlie', 'Bravo', 'Alpha']);

            const newest = await list({ ...baseList, sort: 'added_desc' });
            expect(newest.entries[0].title).toBe('Alpha');

            const byYear = await list({ ...baseList, sort: 'year_desc' });
            expect(byYear.entries.map((e) => e.year)).toEqual([2020, 2010, 1999]);

            const page2 = await list({ ...baseList, limit: 1, offset: 1 });
            expect(page2.entries.map((e) => e.title)).toEqual(['Bravo']);
            expect(page2.totalCount).toBe(3);
        });

        it('buckets non-Latin initials under # and honours a letter filter', async () => {
            await seed('a', writeParams({ title: 'Alpha', sortTitle: 'alpha' }));
            await seed('num', writeParams({ title: '1984', sortTitle: '1984' }));

            const counts = await getAudiobookLetterCounts(sql, { access: unrestrictedAccess() });
            expect(counts).toEqual([
                { letter: '#', count: 1 },
                { letter: 'A', count: 1 },
            ]);

            const hash = await list({ ...baseList, letter: '#' });
            expect(hash.entries.map((e) => e.title)).toEqual(['1984']);
            expect(hash.totalCount).toBe(1);
        });

        it('ignores a stale letter on a non-alphabetical sort', async () => {
            // A letter left in the URL from A-Z mode must not silently narrow a
            // sort whose jump rail is hidden.
            await seed('a', writeParams({ title: 'Alpha', sortTitle: 'alpha' }));
            await seed('z', writeParams({ title: 'Zulu', sortTitle: 'zulu' }));

            const result = await list({ ...baseList, letter: 'A', sort: 'added_desc' });

            expect(result.totalCount).toBe(2);
        });
    });

    describe('search', () => {
        it('matches title, series and author, and collapses the way browse does', async () => {
            await seedSeriesBook('klmn-1', 'KLMN', 1);
            await seedSeriesBook('klmn-2', 'KLMN', 2);
            await seed(
                'king',
                writeParams({
                    title: 'Der Nebel',
                    sortTitle: 'nebel',
                    metadata: metadata({ authors: ['Stephen King'] }),
                }),
            );

            // A term matching one volume yields that BOOK…
            const one = await list({ ...baseList, query: '2 - Folge' });
            expect(one.entries).toHaveLength(1);
            expect(one.entries[0]).toMatchObject({ kind: 'book', seriesSequence: 2 });

            // …while a term matching the whole shelf collapses back to one tile.
            const many = await list({ ...baseList, query: 'klmn' });
            expect(many.entries).toHaveLength(1);
            expect(many.entries[0]).toMatchObject({ kind: 'series', bookCount: 2 });

            // Authors are searchable; they are the second thing anyone types.
            const byAuthor = await list({ ...baseList, query: 'stephen' });
            expect(byAuthor.entries.map((e) => e.title)).toEqual(['Der Nebel']);
        });

        it('treats % and _ as literals instead of matching everything', async () => {
            await seed('plain', writeParams({ title: 'Ein Buch' }));
            await seed('pct', writeParams({ title: '100% Wahrheit', sortTitle: '100% wahrheit' }));

            const wildcard = await list({ ...baseList, query: '%' });
            expect(wildcard.entries.map((e) => e.title)).toEqual(['100% Wahrheit']);
        });

        it('is scoped by the same access boundary as the grid', async () => {
            await seed('private', writeParams({ title: 'Geheim', libraryGroupId: GROUP_PLAYS }));

            const result = await list({
                ...baseList,
                query: 'geheim',
                access: restrictedAccess({
                    deniedGroupIds: [GROUP_PLAYS],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            });

            expect(result.entries).toEqual([]);
            expect(result.totalCount).toBe(0);
        });
    });

    describe('metadata projection', () => {
        it('reads authors and narrators, and degrades on a malformed payload', async () => {
            await seed('ok');
            await seed(
                'bad',
                writeParams({
                    title: 'Kaputt',
                    // A hand-edited / older payload where authors is not an array.
                    metadata: metadata({ authors: 'Nicht Ein Array' as unknown as string[] }),
                }),
            );

            const result = await list(baseList);
            const ok = result.entries.find((e) => e.title === 'Ein Buch');
            const bad = result.entries.find((e) => e.title === 'Kaputt');

            expect(ok?.authors).toEqual(['Autorin']);
            expect(ok?.narrators).toEqual(['Sprecher']);
            expect(bad?.authors).toEqual([]);
        });

        it('keeps a book whose library_paths row was deleted, with no language', async () => {
            await seed(
                'orphan',
                writeParams({
                    metadata: metadata({
                        libraryPathId: '00000000-0000-0000-0000-00000000dead',
                    }),
                }),
            );

            const result = await list(baseList);

            expect(result.entries).toHaveLength(1);
            expect(await getAudiobookLanguages(sql, { access: unrestrictedAccess() })).toEqual([]);
        });

        it('survives a non-uuid libraryPathId instead of failing the whole page', async () => {
            // The `::uuid` cast this query deliberately avoids would raise 22P02
            // for every book, not just this one.
            await seed(
                'garbage',
                writeParams({ metadata: metadata({ libraryPathId: 'not-a-uuid' }) }),
            );

            await expect(list(baseList)).resolves.toMatchObject({ totalCount: 1 });
        });
    });

    describe('resume rail', () => {
        it('returns in-progress books, newest activity first, gated by access', async () => {
            const [{ id: userId }] = await sql<{ id: string }[]>`
                INSERT INTO users (username) VALUES ('audiobook-rail-user')
                ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
                RETURNING id
            `;
            const older = await seed('older');
            const newer = await seed('newer', writeParams({ title: 'Neuer' }));
            const finished = await seed('finished', writeParams({ title: 'Fertig' }));
            const denied = await seed(
                'denied',
                writeParams({ title: 'Privat', libraryGroupId: GROUP_PLAYS }),
            );

            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched, last_event_at)
                VALUES
                    (${userId}, ${older},    60000, 3600000, FALSE, '2026-01-01T00:00:00Z'),
                    (${userId}, ${newer},   120000, 3600000, FALSE, '2026-02-01T00:00:00Z'),
                    (${userId}, ${finished},     0, 3600000, TRUE,  '2026-03-01T00:00:00Z'),
                    (${userId}, ${denied},   30000, 3600000, FALSE, '2026-04-01T00:00:00Z')
            `;

            const rail = await getAudiobooksInProgress(sql, {
                userId,
                access: restrictedAccess({
                    deniedGroupIds: [GROUP_PLAYS],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
                limit: 10,
            });

            expect(rail.map((r) => r.title)).toEqual(['Neuer', 'Ein Buch']);
            expect(rail[0]).toMatchObject({ positionMs: 120000, durationMs: 3600000 });
            expect(rail[0].authors).toEqual(['Autorin']);

            await sql`DELETE FROM user_media_state WHERE user_id = ${userId}`;
            await sql`DELETE FROM users WHERE id = ${userId}`;
        });
    });

    describe('listening state on the grid', () => {
        async function withViewer(): Promise<string> {
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO users (username) VALUES ('audiobook-grid-user')
                ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
                RETURNING id
            `;
            return id;
        }

        afterEach(async () => {
            await sql`DELETE FROM user_media_state`;
            await sql`DELETE FROM users WHERE username = 'audiobook-grid-user'`;
        });

        it('decorates a book entry with the viewer own position and finished flag', async () => {
            const userId = await withViewer();
            const started = await seed('started', writeParams({ title: 'Angefangen' }));
            const done = await seed('done', writeParams({ title: 'Durch' }));
            await seed('untouched', writeParams({ title: 'Unberuehrt' }));

            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched)
                VALUES
                    (${userId}, ${started}, 900000, 3600000, FALSE),
                    (${userId}, ${done},         0, 3600000, TRUE)
            `;

            const page = await list({ ...baseList, viewerId: userId });
            const byTitle = new Map(page.entries.map((e) => [e.title, e]));

            expect(byTitle.get('Angefangen')).toMatchObject({
                resumePositionMs: 900000,
                durationMs: 3600000,
                isFinished: false,
            });
            expect(byTitle.get('Durch')).toMatchObject({ isFinished: true, finishedCount: 1 });
            expect(byTitle.get('Unberuehrt')).toMatchObject({
                resumePositionMs: null,
                isFinished: false,
                finishedCount: 0,
            });
        });

        it('rolls a collapsed series up: finished only when every book is', async () => {
            const userId = await withViewer();
            const one = await seedSeriesBook('s1', 'Die Sieben', 1);
            const two = await seedSeriesBook('s2', 'Die Sieben', 2);
            const three = await seedSeriesBook('s3', 'Die Sieben', 3);

            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched)
                VALUES
                    (${userId}, ${one}, 0, 3600000, TRUE),
                    (${userId}, ${two}, 0, 3600000, TRUE)
            `;

            const partial = await list({ ...baseList, viewerId: userId });
            const series = partial.entries.find((e) => e.kind === 'series');
            expect(series).toMatchObject({ bookCount: 3, finishedCount: 2, isFinished: false });
            // The representative book's own position must not leak onto the tile.
            expect(series?.resumePositionMs).toBeNull();

            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched)
                VALUES (${userId}, ${three}, 0, 3600000, TRUE)
            `;

            const complete = await list({ ...baseList, viewerId: userId });
            expect(complete.entries.find((e) => e.kind === 'series')).toMatchObject({
                finishedCount: 3,
                isFinished: true,
            });
        });

        it('reports no state at all when there is no viewer', async () => {
            const userId = await withViewer();
            const done = await seed('done', writeParams({ title: 'Durch' }));
            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched)
                VALUES (${userId}, ${done}, 0, 3600000, TRUE)
            `;

            const page = await list(baseList);
            expect(page.entries[0]).toMatchObject({
                isFinished: false,
                finishedCount: 0,
                resumePositionMs: null,
            });
        });

        it('leaves another viewer state alone', async () => {
            const mine = await withViewer();
            const [{ id: theirs }] = await sql<{ id: string }[]>`
                INSERT INTO users (username) VALUES ('audiobook-grid-other')
                ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
                RETURNING id
            `;
            const book = await seed('shared', writeParams({ title: 'Geteilt' }));
            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched)
                VALUES (${theirs}, ${book}, 600000, 3600000, TRUE)
            `;

            const page = await list({ ...baseList, viewerId: mine });
            expect(page.entries[0]).toMatchObject({ isFinished: false, resumePositionMs: null });

            await sql`DELETE FROM user_media_state WHERE user_id = ${theirs}`;
            await sql`DELETE FROM users WHERE id = ${theirs}`;
        });
    });

    describe('hasVisibleAudiobooks', () => {
        it('is false with no books and true once one is visible', async () => {
            expect(await hasVisibleAudiobooks(sql, unrestrictedAccess())).toBe(false);
            await seed('one');
            expect(await hasVisibleAudiobooks(sql, unrestrictedAccess())).toBe(true);
        });
    });
});
