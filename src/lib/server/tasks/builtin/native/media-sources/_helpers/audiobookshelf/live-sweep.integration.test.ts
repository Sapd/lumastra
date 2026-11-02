// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end sweep against a LIVE AudiobookShelf server.
 *
 * Skipped unless `AUDIOURL` and `AUDIOAPIKEY` are set, so CI and other
 * developers are unaffected. This exists because every other test in this
 * directory feeds the sweep hand-written fixtures, and fixtures encode what we
 * *believe* the payload looks like. Two beliefs have already been wrong:
 * `media.duration` is absent from the expanded payload, and `narrators` /
 * `series` change shape between the minified and expanded endpoints.
 *
 * Point `AUDIOBOOKSHELF_TEST_LIBRARY_ID` at a SMALL library.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import { AudiobookshelfClient } from '$lib/server/audiobookshelf.js';
import { AUDIOBOOK_MEDIA_TYPE } from '$lib/server/database/queries/audiobooks.queries.js';
import { createAudiobookSweepStore } from './sweep-store.js';
import { runAudiobookshelfSweep } from './sweep.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';

const BASE_URL = process.env.AUDIOURL ?? '';
const API_KEY = process.env.AUDIOAPIKEY ?? '';
const ABS_LIBRARY_ID = process.env.AUDIOBOOKSHELF_TEST_LIBRARY_ID ?? '';
/** `absLibId:groupLetter:lang,absLibId:groupLetter:lang` — the real topology. */
const ABS_LIBRARY_MAP = process.env.AUDIOBOOKSHELF_TEST_LIBRARY_MAP ?? '';
const LIVE = Boolean(BASE_URL && API_KEY && (ABS_LIBRARY_ID || ABS_LIBRARY_MAP));

const GROUP_ID = '00000000-0000-0000-0000-0000000ab900';
const GROUP_B_ID = '00000000-0000-0000-0000-0000000ab902';
const PATH_ID = '00000000-0000-0000-0000-0000000ab901';

const GROUP_IDS: Record<string, string> = { A: GROUP_ID, B: GROUP_B_ID };

function parseMap(): { absId: string; group: string; language: string }[] {
    return ABS_LIBRARY_MAP.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
            const [absId, group = 'A', language = 'en'] = entry.split(':');
            return { absId, group, language };
        });
}

const suite = LIVE ? describe : describe.skip;

// Skips when only the multi-library MAP is configured.
const singleSuite = LIVE && ABS_LIBRARY_ID ? describe : describe.skip;

singleSuite('live AudiobookShelf sweep', () => {
    let sql: postgres.Sql;

    const libraryPath: LibraryPathRow = {
        id: PATH_ID,
        path: `abs://${ABS_LIBRARY_ID}`,
        media_type: AUDIOBOOK_MEDIA_TYPE,
        language: 'en',
        provider: 'audiobookshelf',
        provider_path: ABS_LIBRARY_ID,
        enabled: true,
        library_group_id: GROUP_ID,
        edition_label: null,
        scan_chapters: true,
        fallback_providers: [],
        source_prefix: null,
    } as unknown as LibraryPathRow;

    beforeAll(async () => {
        sql = await getTestDb();
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE} AND library_group_id = ${GROUP_ID}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP_ID}`;
        await sql`
            INSERT INTO library_groups (id, name, description)
            VALUES (${GROUP_ID}, 'Live ABS test', 'temporary')
        `;
    });

    afterAll(async () => {
        if (!sql) return;
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE} AND library_group_id = ${GROUP_ID}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP_ID}`;
        await closeTestDb();
    });

    it('ingests a real library and lands complete rows', async () => {
        const client = new AudiobookshelfClient(BASE_URL, API_KEY);
        const store = createAudiobookSweepStore(sql);
        const seen: string[] = [];
        const logger = {
            info: (m: string) => seen.push(m),
            warn: (m: string) => seen.push(`WARN ${m}`),
            error: (m: string) => seen.push(`ERROR ${m}`),
            debug: () => {},
        };

        const first = await runAudiobookshelfSweep({
            source: client,
            store,
            logger,
            libraryPaths: [libraryPath],
        });

        console.log('SWEEP 1:', JSON.stringify(first));
        expect(first.errors).toEqual([]);
        expect(first.added).toBeGreaterThan(0);
        expect(first.removed).toBe(0);

        const rows = await sql<
            {
                title: string;
                runtime_seconds: number | null;
                has_files: boolean;
                sort_order: number | null;
                series: string | null;
                source: string | null;
                chapters: number | null;
                files: number | null;
            }[]
        >`
            SELECT mi.title, mi.runtime_seconds, mi.has_files, mi.sort_order,
                   mi.custom_metadata->'audiobookshelf'->'derivedSeries'->>'name'   AS series,
                   mi.custom_metadata->'audiobookshelf'->'derivedSeries'->>'source' AS source,
                   jsonb_array_length(COALESCE(mi.custom_metadata->'audiobookshelf'->'chapters', '[]'::jsonb)) AS chapters,
                   jsonb_array_length(COALESCE(mi.custom_metadata->'audiobookshelf'->'audioFiles', '[]'::jsonb)) AS files
            FROM media_items mi
            WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
              AND mi.library_group_id = ${GROUP_ID}
            ORDER BY mi.sort_order NULLS LAST, mi.title
        `;
        const badRuntime = rows.filter((r) => r.runtime_seconds === null || r.runtime_seconds <= 0);
        const badFiles = rows.filter((r) => !r.has_files);
        const noSeries = rows.filter((r) => !r.series);
        const noChapters = rows.filter((r) => (r.chapters ?? 0) === 0);
        const noFiles = rows.filter((r) => (r.files ?? 0) === 0);
        console.log(`rows=${rows.length}`);
        console.log(`  runtime null/0 : ${badRuntime.length}`);
        console.log(`  has_files false: ${badFiles.length}`);
        console.log(`  no series      : ${noSeries.length}`);
        console.log(`  no chapters    : ${noChapters.length}`);
        console.log(`  no audioFiles  : ${noFiles.length}`);
        console.log('sample:', JSON.stringify(rows.slice(0, 4), null, 1));
        if (badRuntime.length)
            console.log('BAD RUNTIME:', JSON.stringify(badRuntime.slice(0, 6), null, 1));
        if (badFiles.length)
            console.log('BAD FILES:', JSON.stringify(badFiles.slice(0, 6), null, 1));

        expect(rows.length).toBe(first.added);

        // A second sweep over unchanged upstream data must be a total no-op.
        const second = await runAudiobookshelfSweep({
            source: client,
            store,
            logger,
            libraryPaths: [libraryPath],
        });
        console.log('SWEEP 2 (idempotency):', JSON.stringify(second));
        expect(second.added).toBe(0);
        expect(second.updated).toBe(0);
        expect(second.removed).toBe(0);
    }, 180_000);
});

suite('live sweep — multi-library topology', () => {
    let sql: postgres.Sql;
    const entries = parseMap();
    const runIf = entries.length > 1 ? it : it.skip;

    beforeAll(async () => {
        sql = await getTestDb();
        for (const gid of Object.values(GROUP_IDS)) {
            await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE} AND library_group_id = ${gid}`;
            await sql`DELETE FROM library_groups WHERE id = ${gid}`;
            await sql`INSERT INTO library_groups (id, name) VALUES (${gid}, ${'Live ABS ' + gid.slice(-3)})`;
        }
    });

    afterAll(async () => {
        if (!sql) return;
        for (const gid of Object.values(GROUP_IDS)) {
            await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE} AND library_group_id = ${gid}`;
            await sql`DELETE FROM library_groups WHERE id = ${gid}`;
        }
        await closeTestDb();
    });

    runIf(
        'partitions by ABS library, shares groups, and never cross-dismisses',
        async () => {
            const client = new AudiobookshelfClient(BASE_URL, API_KEY);
            const store = createAudiobookSweepStore(sql);
            const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

            const paths = entries.map(
                (e, i) =>
                    ({
                        id: `00000000-0000-0000-0000-00000000a9${String(i).padStart(2, '0')}`,
                        path: `abs://${e.absId}`,
                        media_type: AUDIOBOOK_MEDIA_TYPE,
                        language: e.language,
                        provider: 'audiobookshelf',
                        provider_path: e.absId,
                        enabled: true,
                        library_group_id: GROUP_IDS[e.group] ?? GROUP_ID,
                        edition_label: null,
                        scan_chapters: true,
                        fallback_providers: [],
                        source_prefix: null,
                    }) as unknown as LibraryPathRow,
            );

            const first = await runAudiobookshelfSweep({
                source: client,
                store,
                logger,
                libraryPaths: paths,
            });
            console.log('MULTI SWEEP 1:', JSON.stringify(first));
            expect(first.errors).toEqual([]);
            expect(first.removed).toBe(0);

            const byLib = await sql<{ lib: string; grp: string; lang: string; n: number }[]>`
                SELECT mi.custom_metadata->'audiobookshelf'->>'libraryId' AS lib,
                       mi.library_group_id::text AS grp,
                       COUNT(*)::int AS n,
                       '' AS lang
                FROM media_items mi
                WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
                  AND mi.library_group_id = ANY(${Object.values(GROUP_IDS)}::uuid[])
                GROUP BY 1, 2 ORDER BY n DESC
            `;
            console.log('PARTITIONS:', JSON.stringify(byLib));
            expect(byLib.length).toBe(entries.length);

            // The critical invariant: a second sweep must not dismiss anything.
            // Two ABS libraries share one library_group, so a sweep that
            // partitioned by group instead of libraryId would see each library
            // as missing the other's books and dismiss them all.
            const second = await runAudiobookshelfSweep({
                source: client,
                store,
                logger,
                libraryPaths: paths,
            });
            console.log('MULTI SWEEP 2:', JSON.stringify(second));
            expect(second.added).toBe(0);
            expect(second.removed).toBe(0);
            expect(second.updated).toBe(0);

            // Same title in two languages must stay two distinct rows.
            const dupes = await sql<{ title: string; n: number; langs: string[] }[]>`
                SELECT mi.title, COUNT(*)::int AS n,
                       array_agg(DISTINCT mi.custom_metadata->'audiobookshelf'->>'libraryId') AS langs
                FROM media_items mi
                WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
                  AND mi.library_group_id = ANY(${Object.values(GROUP_IDS)}::uuid[])
                GROUP BY mi.title HAVING COUNT(*) > 1
                ORDER BY n DESC LIMIT 8
            `;
            console.log(`CROSS-LIBRARY DUPLICATE TITLES: ${dupes.length}`);
            for (const d of dupes) {
                const sameLib = d.langs.length === 1;
                console.log(`  ${sameLib ? 'SAME-LIBRARY' : 'cross-library'} x${d.n}  ${d.title}`);
            }

            // Sort titles — leading-article handling on a German-majority library.
            const sorts = await sql<{ title: string; sort_title: string }[]>`
                SELECT title, sort_title FROM media_items
                WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}
                  AND library_group_id = ANY(${Object.values(GROUP_IDS)}::uuid[])
                  AND (title ILIKE 'Der %' OR title ILIKE 'Die %' OR title ILIKE 'Das %' OR title ILIKE 'The %')
                ORDER BY random() LIMIT 8
            `;
            console.log('SORT TITLES:', JSON.stringify(sorts, null, 1));

            const covers = await sql<{ n: number; with_cover: number }[]>`
                SELECT COUNT(*)::int AS n,
                       COUNT(*) FILTER (WHERE mi.custom_metadata->'audiobookshelf'->>'coverPath' IS NOT NULL)::int AS with_cover
                FROM media_items mi
                WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
                  AND mi.library_group_id = ANY(${Object.values(GROUP_IDS)}::uuid[])
            `;
            console.log('COVERS:', JSON.stringify(covers));
        },
        600_000,
    );
});
