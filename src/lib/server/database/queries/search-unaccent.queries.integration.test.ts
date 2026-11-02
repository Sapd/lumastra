// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accent/diacritic-insensitive search (migration 16.70.0 + query modules).
 *
 * Verifies the end-to-end behaviour the feature targets: typing a plain-ASCII
 * query finds the accented title, AND typing the accented form finds a
 * plain-ASCII title — across both the trigram (fuzzy) and full-text paths.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/database/queries/search-unaccent.queries
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { searchMediaTrigram, searchMediaFulltext } from './search.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

const MARK = 'unaccentfixture';

describe('accent-insensitive search', () => {
    let sql: postgres.Sql;
    const ids: string[] = [];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        if (ids.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
            ids.length = 0;
        }
    });

    async function insertTv(title: string): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, year, status, has_files)
            VALUES (${title}, 'tv', 2024, 'active', true)
            RETURNING id
        `;
        ids.push(row.id);
        return row.id;
    }

    it('immutable_unaccent folds diacritics (function exists)', async () => {
        const [row] = await sql<[{ a: string; b: string; c: string }]>`
            SELECT immutable_unaccent('Shōrai') AS a,
                   immutable_unaccent('Lumémon') AS b,
                   immutable_unaccent('Aurélie') AS c
        `;
        expect(row.a).toBe('Shorai');
        expect(row.b).toBe('Lumemon');
        expect(row.c).toBe('Aurelie');
    });

    it('expression trigram indexes exist on the unaccented title fields', async () => {
        const rows = await sql<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'media_items'
              AND indexname IN (
                'idx_media_items_title_unaccent_trgm',
                'idx_media_items_original_title_unaccent_trgm',
                'idx_media_items_english_title_unaccent_trgm'
              )
        `;
        expect(rows.map((r) => r.indexname).sort()).toEqual([
            'idx_media_items_english_title_unaccent_trgm',
            'idx_media_items_original_title_unaccent_trgm',
            'idx_media_items_title_unaccent_trgm',
        ]);
    });

    it('trigram: plain-ASCII query finds the accented title', async () => {
        const id = await insertTv(`Shōrai ${MARK}`);
        const results = await searchMediaTrigram(sql, `Shorai ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).toContain(id);
    });

    it('trigram: accented query finds the plain-ASCII title (reverse)', async () => {
        const id = await insertTv(`Shorai ${MARK}`);
        const results = await searchMediaTrigram(sql, `Shōrai ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).toContain(id);
    });

    it('full-text: plain-ASCII query finds the accented title', async () => {
        const id = await insertTv(`Lumémon ${MARK}`);
        const results = await searchMediaFulltext(sql, `Lumemon ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).toContain(id);
    });

    it('full-text: accented query finds the plain-ASCII title (reverse)', async () => {
        const id = await insertTv(`Lumemon ${MARK}`);
        const results = await searchMediaFulltext(sql, `Lumémon ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).toContain(id);
    });

    // -- German digraph two-form (ü→ue / ö→oe / ä→ae) -----------------------

    it('german_digraph_fold expands umlauts to digraphs but leaves ASCII alone', async () => {
        const [row] = await sql<
            [{ a: string; b: string; c: string; d: string; e: string; f: string }]
        >`
            SELECT german_digraph_fold('Müller') AS a,
                   german_digraph_fold('König') AS b,
                   german_digraph_fold('Mädchen') AS c,
                   german_digraph_fold('Straße') AS d,
                   german_digraph_fold('poet') AS e,
                   german_digraph_fold('Phoenix') AS f
        `;
        expect(row.a).toBe('mueller');
        expect(row.b).toBe('koenig');
        expect(row.c).toBe('maedchen');
        expect(row.d).toBe('strasse');
        // ASCII digraphs are NOT collapsed — this is what preserves precision.
        expect(row.e).toBe('poet');
        expect(row.f).toBe('phoenix');
    });

    it('digraph expression trigram indexes exist', async () => {
        const rows = await sql<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'media_items'
              AND indexname IN (
                'idx_media_items_title_digraph_trgm',
                'idx_media_items_original_title_digraph_trgm',
                'idx_media_items_english_title_digraph_trgm'
              )
        `;
        expect(rows).toHaveLength(3);
    });

    it('full-text: digraph query finds the umlaut title (Mueller -> Müller)', async () => {
        const id = await insertTv(`Müller ${MARK}`);
        const results = await searchMediaFulltext(sql, `Mueller ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).toContain(id);
    });

    it('full-text: plain AND digraph AND umlaut queries all find the umlaut title', async () => {
        const id = await insertTv(`König ${MARK}`);
        for (const q of [`Konig ${MARK}`, `Koenig ${MARK}`, `König ${MARK}`]) {
            const results = await searchMediaFulltext(sql, q, unrestrictedAccess(), {
                mediaTypes: ['tv'],
            });
            expect(
                results.map((r) => r.internal_id),
                `query "${q}"`,
            ).toContain(id);
        }
    });

    it('trigram: digraph query finds the umlaut title', async () => {
        const id = await insertTv(`Mädchen ${MARK}`);
        const results = await searchMediaTrigram(sql, `Maedchen ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).toContain(id);
    });

    it('precision: an ASCII-digraph word is NOT folded to a false match', async () => {
        // "Poet" must not collapse to "pot" — the two-form approach only expands
        // umlauts, it never collapses ASCII oe/ue/ae.
        const id = await insertTv(`Poet ${MARK}`);
        const results = await searchMediaFulltext(sql, `Pot ${MARK}`, unrestrictedAccess(), {
            mediaTypes: ['tv'],
        });
        expect(results.map((r) => r.internal_id)).not.toContain(id);
    });
});
