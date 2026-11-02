// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for C3 fix-round-2 (2026-09-25 security review), Minor 2:
 * `CatalogService.storeProviderMetadata`'s INSERT/UPDATE had no lock guard
 * of its own. It relied entirely on its sole caller
 * (metadata-sync-single.service.ts) computing `canWrite` from an earlier
 * SELECT and gating the call on it — a lock landing AFTER that `canWrite`
 * read but before this write got silently overwritten (a TOCTOU gap; the
 * doc comment also incorrectly claimed the method "only ever runs when
 * writing is allowed").
 *
 * These tests exercise the guard directly against a real database, bypassing
 * any caller-side `canWrite` check entirely — the function itself must be
 * the source of truth.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { createCatalogService } from './catalog.service.js';

async function insertMovie(sql: postgres.Sql, id: string, title: string): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${title}, 'movie', 'active', true)
    `;
}

async function tmdbRow(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Record<string, unknown> | undefined> {
    const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
        SELECT metadata FROM provider_metadata WHERE media_id = ${mediaId}::uuid AND provider = 'tmdb'
    `;
    return row?.metadata;
}

describe('CatalogService.storeProviderMetadata respects metadata_locked (C3 fix-round-2, integration)', () => {
    let sql: postgres.Sql;
    const service = () => createCatalogService(sql, { skipLifecycleHooks: true });

    const MOVIE_ID = '20000000-0000-4000-a000-000000000001';

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await insertMovie(sql, MOVIE_ID, 'Storable Movie');
    });

    it('a lock set after canWrite leaves the tmdb row unchanged', async () => {
        // Seed a baseline row, as if an earlier (unlocked) sync wrote it.
        await service().storeProviderMetadata(MOVIE_ID, 'tmdb', { overview: 'Original overview' });
        expect((await tmdbRow(sql, MOVIE_ID))?.overview).toBe('Original overview');

        // Simulate a lock landing between the caller's earlier `canWrite`
        // read and this write — the function itself must still refuse.
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${MOVIE_ID}::uuid`;
        await service().storeProviderMetadata(MOVIE_ID, 'tmdb', {
            overview: 'Sweep tried to overwrite this',
        });

        expect((await tmdbRow(sql, MOVIE_ID))?.overview).toBe('Original overview');
    });

    it('control: force:true still writes to a locked item (the admin-override shape)', async () => {
        await service().storeProviderMetadata(MOVIE_ID, 'tmdb', { overview: 'Original overview' });
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${MOVIE_ID}::uuid`;

        await service().storeProviderMetadata(
            MOVIE_ID,
            'tmdb',
            { overview: 'Admin forced refresh' },
            undefined,
            undefined,
            { force: true },
        );

        expect((await tmdbRow(sql, MOVIE_ID))?.overview).toBe('Admin forced refresh');
    });

    it('control: an unlocked item writes normally', async () => {
        await service().storeProviderMetadata(MOVIE_ID, 'tmdb', { overview: 'Normal write' });

        expect((await tmdbRow(sql, MOVIE_ID))?.overview).toBe('Normal write');
    });

    // C3 fix-round-3 (2026-09-25 security review): the three tests above all
    // exercise the ON CONFLICT DO UPDATE arm (a `tmdb` row already exists).
    // The INSERT source's own guard (`FROM media_items mi WHERE mi.id =
    // ${mediaId} AND (${force} OR NOT mi.metadata_locked)`, catalog.service.ts
    // around :1344) never ran under any of them — reverting ONLY that
    // guard (back to an unconditional `FROM media_items mi WHERE mi.id =
    // ${mediaId}`) left every existing test in this file green. These two
    // target the INSERT arm directly: a locked item with NO prior `tmdb`
    // provider_metadata row at all.
    it('a locked item with no prior tmdb row gets no row created without force', async () => {
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${MOVIE_ID}::uuid`;

        await service().storeProviderMetadata(MOVIE_ID, 'tmdb', {
            overview: 'Should never be inserted',
        });

        expect(await tmdbRow(sql, MOVIE_ID)).toBeUndefined();
    });

    it('control: force:true creates the row for a locked item with no prior tmdb row', async () => {
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${MOVIE_ID}::uuid`;

        await service().storeProviderMetadata(
            MOVIE_ID,
            'tmdb',
            { overview: 'Created via force' },
            undefined,
            undefined,
            { force: true },
        );

        expect((await tmdbRow(sql, MOVIE_ID))?.overview).toBe('Created via force');
    });
});
