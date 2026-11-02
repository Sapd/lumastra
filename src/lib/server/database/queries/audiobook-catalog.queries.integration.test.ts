// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { withTx } from '../with-tx.js';
import {
    insertAudiobook,
    updateAudiobookFromRemote,
    setAudiobookFlags,
    getAudiobookNodeDetail,
    type AudiobookWriteParams,
    type AudiobookshelfMetadata,
} from './audiobooks.queries.js';
import {
    listCatalogBooks,
    listCatalogResources,
    getCatalogResource,
    catalogFacets,
    catalogLetterCounts,
    audiobookPreviewsForAdmittedIds,
    type CatalogOptions,
} from './audiobook-catalog.queries.js';
import {
    cleanupAudiobookCatalog,
    syncAudiobookCatalog,
    normalizeAudiobookName,
} from './audiobook-catalog-maintenance.queries.js';
import { denyAllAccess, restrictedAccess } from './builders/media-access-boundary.js';
const GROUP_BOOKS = '00000000-0000-4000-8000-000000ac1801';
const HIDDEN = '00000000-0000-4000-8000-000000ac1802';
const USER = '00000000-0000-4000-8000-000000ac1803';
const rollback = new Error('rollback');
function metadata(overrides: Partial<AudiobookshelfMetadata> = {}): AudiobookshelfMetadata {
    return {
        derivedSeries: { name: null, sequence: null, source: 'none' },
        audioFiles: [],
        libraryId: 'abs-lib',
        libraryPathId: '00000000-0000-4000-8000-000000ac1804',
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

let db: postgres.Sql;
beforeAll(() => {
    db = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
async function fixture(
    fn: (sql: postgres.Sql, options: CatalogOptions) => Promise<void>,
): Promise<void> {
    await withTx(db, async (sql) => {
        await sql`INSERT INTO library_groups (id, name) VALUES (${GROUP_BOOKS}, 'Catalog test'), (${HIDDEN}, 'Hidden catalog test') ON CONFLICT DO NOTHING`;
        await sql`INSERT INTO users (id, username) VALUES (${USER}, 'pkg18_catalog') ON CONFLICT DO NOTHING`;
        await fn(sql, {
            access: restrictedAccess({
                deniedGroupIds: [HIDDEN],
                maxAgeRating: null,
                allowUnrated: true,
            }),
            viewerId: USER,
            surface: 'v1',
            limit: 60,
            offset: 0,
            groupId: GROUP_BOOKS,
        });
        throw rollback;
    }).catch((error) => {
        if (error !== rollback) throw error;
    });
}
async function book(
    sql: postgres.Sql,
    title: string,
    sequence: number | null = null,
    group = GROUP_BOOKS,
): Promise<string> {
    return insertAudiobook(
        sql,
        writeParams({
            title,
            sortTitle: title.toLowerCase(),
            libraryGroupId: group,
            metadata: metadata({
                authors: ['  Catalog   Writer  ', 'catalog writer'],
                narrators: ['CATALOG WRITER'],
                derivedSeries: { name: 'Catalog Cycle', sequence, source: 'abs-series' },
            }),
        }),
    );
}
describe('audiobook catalog', () => {
    it('serializes new-author sync against cleanup on separate connections and supports reserved flags', async () => {
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        const cleaner = postgres(getTestDatabaseUrl(), { max: 1 });
        const group = '00000000-0000-4000-8000-000000ac1810';
        let id: string | undefined;
        let releaseWriter: () => void = () => {};
        let writing: Promise<void> | undefined;
        let cleaning: Promise<void> | undefined;
        try {
            await db`INSERT INTO library_groups (id, name) VALUES (${group}, 'Catalog concurrency test')`;
            id = await insertAudiobook(db, writeParams({ libraryGroupId: group }));
            let signalReady: () => void = () => {};
            const ready = new Promise<void>((resolve) => {
                signalReady = resolve;
            });
            const release = new Promise<void>((resolve) => {
                releaseWriter = resolve;
            });
            writing = withTx(writer, async (sql) => {
                await syncAudiobookCatalog(
                    sql,
                    id!,
                    metadata({ authors: ['Concurrent new author'] }),
                );
                signalReady();
                await release;
            });
            await Promise.race([ready, writing]);
            const [backend] = await cleaner<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            cleaning = cleanupAudiobookCatalog(cleaner);
            // Observe actual lock contention, so two accidentally sequential calls cannot pass.
            let blocked = false;
            for (let i = 0; i < 100; i++) {
                const [lock] = await db<{ blocked: boolean }[]>`SELECT EXISTS (
                    SELECT 1 FROM pg_locks WHERE pid = ${backend.pid} AND locktype = 'advisory' AND NOT granted
                ) AS blocked`;
                if (lock.blocked) {
                    blocked = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
            releaseWriter();
            await Promise.all([writing, cleaning]);
            const links = await db`SELECT c.id FROM audiobook_contributors c
                JOIN audiobook_book_contributors bc ON bc.contributor_id = c.id
                WHERE bc.media_id = ${id} AND c.normalized_name = 'concurrent new author'`;
            expect(links).toHaveLength(1);
            const reserved = await writer.reserve();
            try {
                expect(
                    await setAudiobookFlags(reserved, [id], { hasFiles: false, isDismissed: true }),
                ).toBe(1);
                expect(
                    await setAudiobookFlags(reserved, [id], { hasFiles: true, isDismissed: false }),
                ).toBe(1);
                const [linked] =
                    await reserved`SELECT contributor_id FROM audiobook_book_contributors WHERE media_id = ${id} AND role = 'author'`;
                expect(linked).toBeDefined();
            } finally {
                reserved.release();
            }
        } finally {
            releaseWriter();
            await Promise.allSettled([writing, cleaning]);
            if (id) await db`DELETE FROM media_items WHERE id = ${id}`;
            await cleanupAudiobookCatalog(db);
            await db`DELETE FROM library_groups WHERE id = ${group}`;
            await Promise.all([writer.end(), cleaner.end()]);
        }
    });
    it('persists shared contributor ids, role order and numeric series positions idempotently', async () =>
        fixture(async (sql, _o) => {
            const id = await book(sql, 'First', 2.5);
            const params = writeParams({
                metadata: metadata({
                    authors: ['Catalog Writer'],
                    narrators: ['catalog writer'],
                    derivedSeries: {
                        name: '  Catalog   Cycle ',
                        sequence: 2.5,
                        source: 'abs-series',
                    },
                }),
            });
            const before = await getAudiobookNodeDetail(sql, id, USER);
            await updateAudiobookFromRemote(sql, id, params);
            await updateAudiobookFromRemote(sql, id, params);
            const after = await getAudiobookNodeDetail(sql, id, USER);
            expect(after?.authors[0].id).toBe(before?.authors[0].id);
            expect(after?.narrators[0].id).toBe(after?.authors[0].id);
            expect(after?.series?.id).toBe(before?.series?.id);
            expect(after?.series?.position).toBe(2.5);
            const [links] = await sql<
                { count: string }[]
            >`SELECT count(*)::text AS count FROM audiobook_book_contributors WHERE media_id = ${id}`;
            expect(Number(links.count)).toBe(2);
            const [normalized] = await sql<
                { value: string }[]
            >`SELECT lower(regexp_replace(btrim(${'  Catalog   Writer  '}::text), '\\s+', ' ', 'g')) AS value`;
            expect(normalized.value).toBe(normalizeAudiobookName('  Catalog   Writer  '));
        }));
    it('resolves only the own cover and changes its descriptor revision with the ABS revision', async () =>
        fixture(async (sql, o) => {
            const params = writeParams({
                metadata: metadata({ coverPath: '/library/cover.jpg', updatedAt: 100 }),
            });
            const id = await insertAudiobook(sql, params);
            const before = (await listCatalogBooks(sql, o)).items.find((book) => book.id === id)!;
            expect(before.images.primary).toMatchObject({ source: 'self' });
            expect(before.images.primary?.href).toContain(
                '/api/v1/media/' + id + '/images/poster?',
            );
            expect(before.images).not.toHaveProperty('poster');
            await updateAudiobookFromRemote(sql, id, {
                ...params,
                metadata: { ...params.metadata, updatedAt: 101 },
            });
            const after = (await listCatalogBooks(sql, o)).items.find((book) => book.id === id)!;
            expect(after.images.primary?.revision).not.toBe(before.images.primary?.revision);
        }));
    it('lists authors/narrators and their books with stable ids and visible durations', async () =>
        fixture(async (sql, o) => {
            const id = await book(sql, 'Visible', 1);
            await book(sql, 'Hidden', 2, HIDDEN);
            const authors = await listCatalogResources(sql, { ...o, resource: 'author' });
            const author = authors.items[0];
            expect(author.bookCount).toBe(1);
            const detail = await getCatalogResource(sql, {
                ...o,
                resource: 'author',
                id: author.id,
            });
            expect(detail?.durationMs).toBe(3600000);
            const books = await listCatalogBooks(sql, { ...o, authorId: author.id });
            expect(books.items.map((b) => b.id)).toEqual([id]);
            const narrators = await listCatalogResources(sql, { ...o, resource: 'narrator' });
            expect(narrators.items[0].id).toBe(author.id);
            expect((await listCatalogBooks(sql, { ...o, narratorId: author.id })).items[0].id).toBe(
                id,
            );
            expect(
                (
                    await listCatalogResources(sql, {
                        ...o,
                        access: denyAllAccess(),
                        resource: 'author',
                    })
                ).items,
            ).toEqual([]);
            expect(
                await getCatalogResource(sql, {
                    ...o,
                    access: denyAllAccess(),
                    resource: 'author',
                    id: author.id,
                }),
            ).toBeNull();
        }));
    it('collapses only explicitly, preserves the first book and counts after collapse for paging', async () =>
        fixture(async (sql, o) => {
            const second = await book(sql, 'B second', 2);
            const first = await book(sql, 'A first', 1);
            expect((await listCatalogBooks(sql, o)).page.total).toBe(2);
            const collapsed = await listCatalogBooks(sql, { ...o, collapse: 'series', limit: 1 });
            expect(collapsed.page).toMatchObject({ total: 1, hasMore: false });
            expect(collapsed.items[0]).toMatchObject({
                id: first,
                title: 'A first',
                audiobook: { series: { bookCount: 2 } },
            });
            expect((await listCatalogBooks(sql, { ...o, offset: 1, limit: 1 })).items[0].id).toBe(
                second,
            );
            const beyond = await listCatalogBooks(sql, { ...o, offset: 9 });
            expect(beyond.items).toEqual([]);
            expect(beyond.page.total).toBe(2);
            expect(
                (await listCatalogBooks(sql, { ...o, q: 'second' })).items.map((b) => b.id),
            ).toEqual([second]);
            expect(
                (await listCatalogBooks(sql, { ...o, letter: 'A' })).items.map((b) => b.id),
            ).toEqual([first]);
        }));
    it('counts and sorts collapsed series over all visible siblings before filtering', async () =>
        fixture(async (sql, o) => {
            const first = await book(sql, 'Alpha match', 1);
            const second = await book(sql, 'Beta sibling', 2);
            const other = await insertAudiobook(
                sql,
                writeParams({
                    title: 'Middle',
                    sortTitle: 'middle',
                    year: 2010,
                    metadata: metadata({
                        derivedSeries: { name: 'The Middle', sequence: 1, source: 'abs-series' },
                    }),
                }),
            );
            await sql`UPDATE media_items SET year = 2025, library_added_at = '2025-01-01' WHERE id = ${second}`;
            await sql`UPDATE media_items SET library_added_at = '2010-01-01' WHERE id = ${other}`;
            await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES (${USER}, ${second}, true)`;
            const filtered = await listCatalogBooks(sql, {
                ...o,
                q: 'Alpha match',
                collapse: 'series',
            });
            expect(filtered.items[0]).toMatchObject({
                id: first,
                audiobook: { series: { bookCount: 2 } },
                progress: { fraction: 0.5, finished: false },
            });
            for (const sort of ['added', 'year'] as const) {
                expect(
                    (await listCatalogBooks(sql, { ...o, collapse: 'series', sort, order: 'desc' }))
                        .items[0].id,
                ).toBe(first);
            }
            await sql`UPDATE user_media_state SET is_watched = false WHERE user_id = ${USER} AND media_id = ${second}`;
            expect(
                (await listCatalogBooks(sql, { ...o, q: 'Alpha', collapse: 'series' })).items[0]
                    .progress?.fraction,
            ).toBe(0);
            await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES (${USER}, ${first}, true)`;
            await sql`UPDATE user_media_state SET is_watched = true WHERE user_id = ${USER}`;
            expect(
                (await listCatalogBooks(sql, { ...o, collapse: 'series', q: 'Alpha' })).items[0]
                    .progress,
            ).toMatchObject({ fraction: 1, finished: true });
            const [series] = await sql<
                { sort_name: string }[]
            >`SELECT sort_name FROM audiobook_series WHERE normalized_name = 'the middle'`;
            expect(series.sort_name).toBe('middle');
        }));
    it('sorts and buckets multi-book series with the shared article/accent/punctuation key', async () =>
        fixture(async (sql, o) => {
            const ids: string[] = [];
            for (const sequence of [1, 2]) {
                ids.push(
                    await insertAudiobook(
                        sql,
                        writeParams({
                            title: `Z volume ${sequence}`,
                            sortTitle: `z volume ${sequence}`,
                            metadata: metadata({
                                derivedSeries: {
                                    name: 'The «Éclair»',
                                    sequence,
                                    source: 'abs-series',
                                },
                            }),
                        }),
                    ),
                );
            }
            await book(sql, 'Other cycle', 1);
            await book(sql, 'Other cycle sequel', 2);
            const page = await listCatalogBooks(sql, { ...o, collapse: 'series', letter: 'E' });
            expect(page.items.map((b) => b.id)).toEqual([ids[0]]);
            expect(page.items[0].audiobook.series?.bookCount).toBe(2);
            expect(await catalogLetterCounts(sql, { ...o, collapse: 'series' })).toEqual([
                { letter: 'C', count: 1 },
                { letter: 'E', count: 1 },
            ]);
        }));
    it('uses one rounded duration for detail, progress and resource sums with runtime/state fallbacks', async () =>
        fixture(async (sql, o) => {
            const params = writeParams({
                runtimeSeconds: 999,
                metadata: metadata({ duration: 1.2346 }),
            });
            const id = await insertAudiobook(sql, params);
            await sql`INSERT INTO user_media_state (user_id, media_id, runtime_ms, resume_position_ms) VALUES (${USER}, ${id}, 888000, 100)`;
            const detail = (await getAudiobookNodeDetail(sql, id, USER))!;
            expect(detail.durationMs).toBe(1235);
            expect(detail.progress?.durationMs).toBe(1235);
            expect((await listCatalogBooks(sql, o)).items[0].progress?.durationMs).toBe(1235);
            expect(
                (
                    await getCatalogResource(sql, {
                        ...o,
                        resource: 'author',
                        id: detail.authors[0].id,
                    })
                )?.durationMs,
            ).toBe(1235);
            await sql`UPDATE media_items SET custom_metadata = jsonb_set(custom_metadata, '{audiobookshelf,duration}', 'null') WHERE id = ${id}`;
            expect((await getAudiobookNodeDetail(sql, id, USER))?.durationMs).toBe(999000);
            await sql`UPDATE media_items SET runtime_seconds = NULL WHERE id = ${id}`;
            expect((await getAudiobookNodeDetail(sql, id, USER))?.durationMs).toBe(888000);
        }));
    it('keeps canonical path text matching and ignores malformed or noncanonical ids', async () =>
        fixture(async (sql, o) => {
            const pathId = '00000000-0000-4000-8000-000000ac1804';
            await sql`INSERT INTO library_paths (id, path, media_type, language, provider, library_group_id, enabled)
                VALUES (${pathId}, 'abs://aurora-path', 'audiobook', 'de', 'audiobookshelf', ${GROUP_BOOKS}, true)`;
            const ids: string[] = [];
            for (const libraryPathId of [
                pathId,
                pathId.toUpperCase(),
                pathId + '\n',
                pathId + ' ',
                'broken-path',
                '',
                '00000000-0000-4000-8000-000000ac1899',
            ]) {
                ids.push(
                    await insertAudiobook(
                        sql,
                        writeParams({
                            title: `Aurora path ${ids.length}`,
                            metadata: metadata({ libraryPathId }),
                        }),
                    ),
                );
            }
            const result = await listCatalogBooks(sql, { ...o, collapse: 'series', lang: 'de' });
            expect(result.items.map((item) => item.id)).toEqual([ids[0]]);
            expect((await catalogFacets(sql, { ...o, collapse: 'series' })).languages).toEqual([
                { language: 'de', bookCount: 1 },
            ]);
            expect((await listCatalogBooks(sql, { ...o, collapse: 'series' })).page.total).toBe(7);
        }));
    it('hydrates the admitted collapsed page with ordered credits, ids and global series progress', async () =>
        fixture(async (sql, o) => {
            const series = { name: 'Aurora voyage', sequence: 1, source: 'abs-series' as const };
            const first = await insertAudiobook(
                sql,
                writeParams({
                    title: 'Aurora departure',
                    metadata: metadata({
                        authors: ['Zora Aurora', 'Ayla Aurora'],
                        narrators: ['Rin Aurora', 'Ari Aurora'],
                        isbn: 'fixture-isbn',
                        asin: 'fixture-asin',
                        derivedSeries: series,
                    }),
                }),
            );
            const second = await insertAudiobook(
                sql,
                writeParams({
                    title: 'Aurora arrival',
                    metadata: metadata({ derivedSeries: { ...series, sequence: 2 } }),
                }),
            );
            await insertAudiobook(sql, writeParams({ title: 'Atlas', sortTitle: 'atlas' }));
            await sql`INSERT INTO user_media_state (user_id, media_id, is_watched)
                VALUES (${USER}, ${second}, true)`;
            const result = await listCatalogBooks(sql, {
                ...o,
                collapse: 'series',
                limit: 1,
                offset: 1,
            });
            expect(result.page).toMatchObject({ total: 2, hasMore: false, offset: 1 });
            expect(result.items[0]).toMatchObject({
                id: first,
                ids: { isbn: 'fixture-isbn', asin: 'fixture-asin' },
                audiobook: { series: { bookCount: 2 } },
                progress: { fraction: 0.5, finished: false },
            });
            expect(result.items[0].audiobook.authors.map((credit) => credit.name)).toEqual([
                'Zora Aurora',
                'Ayla Aurora',
            ]);
            expect(result.items[0].audiobook.narrators.map((credit) => credit.name)).toEqual([
                'Rin Aurora',
                'Ari Aurora',
            ]);
        }));
    it('applies the full filter scope to every facet and rejects dismissed/unavailable admitted ids', async () =>
        fixture(async (sql, o) => {
            await sql`INSERT INTO library_paths (id, path, media_type, language, provider, library_group_id, enabled)
                VALUES ('00000000-0000-4000-8000-000000ac1804', 'abs://pkg18-facets', 'audiobook', 'de', 'audiobookshelf', ${GROUP_BOOKS}, true)`;
            const first = await book(sql, 'Facet match', 1);
            const second = await book(sql, 'Facet other', 2);
            const detail = (await getAudiobookNodeDetail(sql, first, USER))!;
            const scope = {
                ...o,
                authorId: detail.authors[0].id,
                narratorId: detail.narrators[0].id,
                seriesId: detail.series!.id,
                lang: 'de',
                q: 'match',
                collapse: 'series' as const,
            };
            const facets = await catalogFacets(sql, scope);
            expect(facets.shelves).toEqual([
                { id: GROUP_BOOKS, name: 'Catalog test', bookCount: 1 },
            ]);
            expect(facets.languages).toEqual([{ language: 'de', bookCount: 1 }]);
            expect((await catalogFacets(sql, { ...scope, lang: 'en' })).shelves).toEqual([]);
            expect(facets.letterCounts).toEqual([{ letter: 'C', count: 1 }]);
            expect(await catalogFacets(sql, { ...scope, q: 'no match exists' })).toEqual({
                shelves: [],
                languages: [],
                letterCounts: [],
            });
            await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${first}`;
            await sql`UPDATE media_items SET has_files = false WHERE id = ${second}`;
            expect(await audiobookPreviewsForAdmittedIds(sql, [first, second], USER, 'v1')).toEqual(
                [],
            );
        }));
    it('removes only newly unlinked orphans on update and handles unmatched flag ids', async () =>
        fixture(async (sql, o) => {
            const first = await book(sql, 'Relink', 1);
            const second = await book(sql, 'Keep', 2);
            const [orphan] = await sql<
                { id: string }[]
            >`INSERT INTO audiobook_contributors (name, normalized_name) VALUES ('Unrelated orphan', 'unrelated orphan') RETURNING id`;
            await updateAudiobookFromRemote(
                sql,
                first,
                writeParams({ metadata: metadata({ authors: ['Replacement'] }) }),
            );
            expect((await getAudiobookNodeDetail(sql, second, USER))?.authors[0].name).toBe(
                'Catalog Writer',
            );
            expect(
                await sql`SELECT id FROM audiobook_contributors WHERE id = ${orphan.id}`,
            ).toHaveLength(1);
            await updateAudiobookFromRemote(
                sql,
                second,
                writeParams({ metadata: metadata({ authors: ['Replacement'] }) }),
            );
            expect(
                await sql`SELECT id FROM audiobook_contributors WHERE normalized_name = 'catalog writer'`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT id FROM audiobook_series WHERE normalized_name = 'catalog cycle'`,
            ).toHaveLength(0);
            expect(
                await setAudiobookFlags(sql, ['00000000-0000-4000-8000-000000000000'], {
                    hasFiles: false,
                    isDismissed: true,
                }),
            ).toBe(0);
            expect(
                await setAudiobookFlags(sql, ['00000000-0000-4000-8000-000000000000'], {
                    hasFiles: true,
                    isDismissed: false,
                }),
            ).toBe(0);
            await setAudiobookFlags(sql, [first], { hasFiles: false, isDismissed: true });
            await syncAudiobookCatalog(sql, first, metadata({ authors: ['Dismissed sync'] }));
            expect(
                await sql`SELECT id FROM audiobook_contributors WHERE normalized_name = 'dismissed sync'`,
            ).toHaveLength(0);
            expect((await listCatalogBooks(sql, o)).items.map((b) => b.id)).not.toContain(first);
        }));
    it('picks an in-progress unfinished book before the first unplayed one, then null when all finished', async () =>
        fixture(async (sql, o) => {
            const first = await book(sql, 'First', 1);
            const second = await book(sql, 'Second', 2);
            const third = await book(sql, 'Third', null);
            const seriesId = (await getAudiobookNodeDetail(sql, first, USER))!.series!.id;
            expect(
                (await getCatalogResource(sql, { ...o, resource: 'series', id: seriesId }))?.nextUp
                    ?.id,
            ).toBe(first);
            await sql`INSERT INTO user_media_state (user_id, media_id, resume_position_ms, is_watched) VALUES (${USER}, ${second}, 123000, false)`;
            const detail = await getCatalogResource(sql, {
                ...o,
                resource: 'series',
                id: seriesId,
            });
            expect(detail?.nextUp).toMatchObject({
                id: second,
                progress: { positionMs: 123000, finished: false },
            });
            expect(detail?.progress).toEqual({ finishedCount: 0, bookCount: 3 });
            expect(
                (await listCatalogBooks(sql, { ...o, seriesId, sort: 'series' })).items.map(
                    (b) => b.id,
                ),
            ).toEqual([first, second, third]);
            await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES (${USER}, ${first}, true), (${USER}, ${third}, true)`;
            await sql`UPDATE user_media_state SET is_watched = true WHERE user_id = ${USER}`;
            expect(
                (await getCatalogResource(sql, { ...o, resource: 'series', id: seriesId }))?.nextUp,
            ).toBeNull();
            expect(
                (await getCatalogResource(sql, { ...o, resource: 'series', id: seriesId }))
                    ?.progress?.finishedCount,
            ).toBe(3);
        }));
    it('applies library and age access before resource aggregates, collapse and nextUp', async () =>
        fixture(async (sql, o) => {
            const visible = await book(sql, 'Visible volume', 2);
            const adult = await book(sql, 'Adult volume', 1);
            await book(sql, 'Hidden volume', 0, HIDDEN);
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult}`;
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${visible}`;
            const access = restrictedAccess({
                deniedGroupIds: [HIDDEN],
                maxAgeRating: 12,
                allowUnrated: false,
            });
            const scoped = { ...o, groupId: undefined, access };
            const seriesId = (await getAudiobookNodeDetail(sql, visible, USER))!.series!.id;
            const detail = await getCatalogResource(sql, {
                ...scoped,
                resource: 'series',
                id: seriesId,
            });
            expect(detail).toMatchObject({
                bookCount: 1,
                durationMs: 3600000,
                nextUp: { id: visible },
                progress: { bookCount: 1 },
            });
            const collapsed = await listCatalogBooks(sql, { ...scoped, collapse: 'series' });
            expect(collapsed.items[0].audiobook.series?.bookCount).toBeUndefined();
            const authors = await listCatalogResources(sql, { ...scoped, resource: 'author' });
            expect(authors.items[0].bookCount).toBe(1);
            expect(
                (
                    await listCatalogBooks(sql, { ...scoped, authorId: authors.items[0].id })
                ).items.map((b) => b.id),
            ).toEqual([visible]);
        }));
    it('removes orphan resources, restores flags-only revivals and cascades hard deletes', async () =>
        fixture(async (sql, o) => {
            const id = await book(sql, 'Return', 1);
            const person = (await getAudiobookNodeDetail(sql, id, USER))!.authors[0].id;
            await setAudiobookFlags(sql, [id], { hasFiles: false, isDismissed: true });
            expect((await listCatalogResources(sql, { ...o, resource: 'author' })).items).toEqual(
                [],
            );
            expect(
                (await sql`SELECT id FROM audiobook_contributors WHERE id = ${person}`).length,
            ).toBe(0);
            await setAudiobookFlags(sql, [id], { hasFiles: true, isDismissed: false });
            expect((await getAudiobookNodeDetail(sql, id, USER))?.authors).toHaveLength(1);
            await sql`DELETE FROM media_items WHERE id = ${id}`;
            await cleanupAudiobookCatalog(sql);
            expect((await listCatalogResources(sql, { ...o, resource: 'series' })).items).toEqual(
                [],
            );
        }));
});
