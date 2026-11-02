// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration tests for `getAudiobookNodeDetail` — the detail modal's read.
 *
 * The whole point of this query is the jsonb path extraction, which no unit test
 * can check: `custom_metadata` is written by the connector with no schema behind
 * it, so every `#>>` path, every `jsonb_typeof` guard and every text-then-parse
 * step here exists because the alternative (a `::float` / `::boolean` cast) raises
 * `22P02` for the WHOLE statement the first time one row holds something
 * unexpected — taking the detail modal down for that book rather than degrading.
 *
 * Regression this read exists for: the generic detail query sources `overview`
 * from `provider_metadata.metadata->>'overview'`, and an AudiobookShelf book has
 * no provider_metadata row at all — so the modal reported no description for a
 * book whose description sits in `media_items.overview`, and knew nothing about
 * its authors, narrators or chapters.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { withTx } from '../with-tx.js';
import { syncAudiobookCatalog } from './audiobook-catalog-maintenance.queries.js';
import type { AudiobookshelfMetadata } from './audiobooks.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    AUDIOBOOK_MEDIA_TYPE,
    AUDIOBOOKSHELF_METADATA_KEY,
    getAudiobookNodeDetail,
} from './audiobooks.queries.js';

const GROUP = '00000000-0000-0000-0000-0000000ab201';

interface InsertOpts {
    overview?: string | null;
    year?: number | null;
    runtimeSeconds?: number | null;
    status?: string;
    metadata?: Record<string, unknown> | null;
}

describe('getAudiobookNodeDetail', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`
            INSERT INTO library_groups (id, name) VALUES (${GROUP}, 'Node Detail Test')
            ON CONFLICT DO NOTHING
        `;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}`;
    });

    const VIEWER = '7a000000-0000-4000-8000-0000000000v1'.replace('v', 'a');
    const OTHER = '7a000000-0000-4000-8000-0000000000b1';

    /**
     * The modal offered "Listen" on a book the viewer was twenty hours into,
     * because this read carried no progress at all.
     */
    describe('viewer progress', () => {
        beforeAll(async () => {
            await sql`
                INSERT INTO users (id, username) VALUES
                    (${VIEWER}, 'node_detail_viewer'),
                    (${OTHER}, 'node_detail_other')
                ON CONFLICT (id) DO NOTHING
            `;
        });

        afterAll(async () => {
            await sql`DELETE FROM users WHERE id IN (${VIEWER}, ${OTHER})`;
        });

        it('returns the viewer own resume position and finished flag', async () => {
            const id = await insertBook();
            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, is_watched)
                VALUES (${VIEWER}, ${id}::uuid, 320000, true)
            `;

            expect(await getAudiobookNodeDetail(sql, id, VIEWER)).toMatchObject({
                progress: { positionMs: 320000, finished: true },
            });
        });

        it('never reports someone else progress', async () => {
            const id = await insertBook();
            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, is_watched)
                VALUES (${OTHER}, ${id}::uuid, 999000, true)
            `;

            expect((await getAudiobookNodeDetail(sql, id, VIEWER))?.progress).toBeUndefined();
        });

        /**
         * Anonymous requests still get the book's identity — chapters and
         * authors are not user-scoped, and gating the whole read on a user
         * would blank the modal for them.
         */
        it('returns metadata with no progress for an anonymous read', async () => {
            const id = await insertBook({ metadata: { authors: ['Ursula K. Le Guin'] } });

            expect(await getAudiobookNodeDetail(sql, id, null)).toMatchObject({
                authors: [expect.objectContaining({ name: 'Ursula K. Le Guin' })],
            });
        });
    });

    async function insertBook(opts: InsertOpts = {}): Promise<string> {
        const metadata =
            opts.metadata === null
                ? null
                : // `InsertOpts.metadata` is deliberately `Record<string, unknown>` so these
                  // tests can push the WRONG type into every jsonb slot; `unknown` is not
                  // assignable to `JSONValue`, so the cast is what keeps that looseness.
                  // Same cast the production writers use (see task-settings.queries.ts).
                  sql.json({
                      [AUDIOBOOKSHELF_METADATA_KEY]: opts.metadata ?? {},
                  } as unknown as postgres.JSONValue);
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (
                title, sort_title, overview, year, media_type, runtime_seconds,
                has_files, is_local_only, library_group_id, status, custom_metadata
            ) VALUES (
                'Ein Buch', 'ein buch',
                ${opts.overview ?? null},
                ${opts.year ?? null},
                ${AUDIOBOOK_MEDIA_TYPE},
                ${opts.runtimeSeconds ?? null},
                TRUE, FALSE, ${GROUP},
                ${opts.status ?? 'active'},
                ${metadata}
            )
            RETURNING id
        `;
        await withTx(sql, (tx) =>
            syncAudiobookCatalog(tx, row.id, (opts.metadata ?? {}) as AudiobookshelfMetadata),
        );
        return row.id;
    }

    it('reads the full block off custom_metadata.audiobookshelf', async () => {
        const id = await insertBook({
            overview: 'Felix Vale liest Band 1 von Milo Farrow.',
            year: 2016,
            runtimeSeconds: 30_000,
            metadata: {
                authors: ['M.K. Fenwick'],
                narrators: ['Felix Vale'],
                publisher: 'Der Hörverlag',
                derivedSeries: { name: 'Milo Farrow', sequence: 1, source: 'abs-series' },
                abridged: false,
                duration: 30_600,
                chapters: [
                    { id: 0, start: 0, end: 120, title: 'Der Junge, der überlebte' },
                    { id: 1, start: 120, end: 400, title: 'Das verschwundene Glas' },
                ],
            },
        });

        expect(await getAudiobookNodeDetail(sql, id, null)).toEqual({
            ids: {},
            overview: 'Felix Vale liest Band 1 von Milo Farrow.',
            year: 2016,
            runtimeSeconds: 30_000,
            authors: [expect.objectContaining({ name: 'M.K. Fenwick' })],
            narrators: [expect.objectContaining({ name: 'Felix Vale' })],
            publisher: 'Der Hörverlag',
            series: expect.objectContaining({ name: 'Milo Farrow', position: 1 }),
            abridged: false,
            durationMs: 30_600_000,
            chapters: [
                {
                    index: 0,
                    startMs: 0,
                    endMs: 120000,
                    name: 'Der Junge, der überlebte',
                },
                {
                    index: 1,
                    startMs: 120000,
                    endMs: 400000,
                    name: 'Das verschwundene Glas',
                },
                // The stored chapter list stops at 400s but `duration` says the
                // book runs to 30_600s — 8h20m of unlabelled audio. `toChapters`
                // now normalises through the SAME `buildChapterSpans` helper the
                // player uses (see its doc comment), which gives that stretch its
                // own `synthetic` span rather than silently dropping it (the
                // "211 vs 212 chapters" Starhaven bug this refactor exists to fix).
                // This expectation predates that refactor (commits 2f01b6b52,
                // 4c7e56e49) and never got updated for it.
                {
                    index: 2,
                    startMs: 400000,
                    endMs: 30600000,
                    name: '',
                    synthetic: true,
                },
            ],
        });
    });

    it('keeps a decimal series sequence (ABS allows "2.5")', async () => {
        const id = await insertBook({
            metadata: { derivedSeries: { name: 'Reihe', sequence: 2.5, source: 'abs-series' } },
        });
        const detail = await getAudiobookNodeDetail(sql, id, null);
        expect(detail?.series?.position).toBe(2.5);
    });

    it('degrades every optional jsonb field instead of raising', async () => {
        // Every value here is the WRONG type for its slot — the exact shape a
        // `::float` / `::boolean` cast would 22P02 on.
        const id = await insertBook({
            metadata: {
                authors: 'M.K. Fenwick',
                narrators: null,
                publisher: 42,
                derivedSeries: { name: '', sequence: 'zwei', source: 'folder' },
                abridged: 'yes',
                duration: 'lang',
                chapters: { nope: true },
            },
        });

        const detail = await getAudiobookNodeDetail(sql, id, null);
        expect(detail).not.toBeNull();
        expect(detail?.authors).toEqual([]);
        expect(detail?.narrators).toEqual([]);
        // An empty derivedSeries.name is NULLIF'd away rather than surfacing as ''.
        expect(detail?.series).toBeNull();
        expect(detail?.abridged).toBeNull();
        expect(detail?.durationMs).toBeNull();
        expect(detail?.chapters).toEqual([]);
    });

    it('drops chapter entries with no numeric start rather than placing them at 0:00', async () => {
        const id = await insertBook({
            metadata: {
                chapters: [
                    { id: 0, start: 0, end: 60, title: 'Echt' },
                    { id: 1, end: 120, title: 'Kein Start' },
                    'nicht einmal ein Objekt',
                    { start: 200, end: 260 },
                ],
            },
        });

        const detail = await getAudiobookNodeDetail(sql, id, null);
        // `toChapters` normalises through `buildChapterSpans` (see its doc
        // comment on `audiobooks.queries.ts`), which changed two things this
        // expectation predates (commit 2f01b6b52, "normalise chapters
        // server-side so every client agrees"):
        //   - `id` is the position in the OUTPUT list, not the original array
        //     index — dropped entries are never counted (see `toChapters`'s own
        //     "id is the position in the normalised list" comment).
        //   - Each span runs to the NEXT span's start rather than trusting its
        //     own `end` (so `findChapterAt` never lands in a gap) — the first
        //     chapter's `end` is pulled from 60 to 200, the second span's start.
        //   - A missing title falls back to the 1-based ordinal ("2"), same as
        //     the player's scrubber — `''` is reserved for the untagged tail
        //     span specifically (see `toChapters`'s "Empty rather than the
        //     ordinal" comment), which this case is not.
        expect(detail?.chapters).toEqual([
            { index: 0, startMs: 0, endMs: 200000, name: 'Echt' },
            { index: 1, startMs: 200000, endMs: 260000, name: '2' },
        ]);
    });

    it('survives a row with no custom_metadata at all', async () => {
        const id = await insertBook({ metadata: null, overview: 'Nur eine Beschreibung' });
        expect(await getAudiobookNodeDetail(sql, id, null)).toMatchObject({
            overview: 'Nur eine Beschreibung',
            authors: [],
            narrators: [],
            chapters: [],
        });
    });

    it('returns null for a non-audiobook row', async () => {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, sort_title, media_type, library_group_id)
            VALUES ('Ein Film', 'ein film', 'movie', ${GROUP})
            RETURNING id
        `;
        try {
            expect(await getAudiobookNodeDetail(sql, row.id, null)).toBeNull();
        } finally {
            await sql`DELETE FROM media_items WHERE id = ${row.id}`;
        }
    });

    it('returns null for a soft-deleted book', async () => {
        const id = await insertBook({ status: 'deleted' });
        expect(await getAudiobookNodeDetail(sql, id, null)).toBeNull();
    });
});
