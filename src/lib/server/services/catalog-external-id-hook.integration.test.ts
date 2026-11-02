// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `upsertExternalId` fires `afterExternalIdChanged` only when the item's mapping
 * actually changes.
 *
 * The scanner re-confirms a series' external ids on every ingest of every episode
 * file. Re-confirming an existing mapping used to fire the hook anyway, so on prod
 * (2026-09-28) SpongeBob logged "External ID changed" and had its caches
 * invalidated every 5 minutes, for an id that had not changed in months.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { createCatalogService } from './catalog.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';

describe('CatalogService.upsertExternalId → afterExternalIdChanged', () => {
    let sql: postgres.Sql;
    let hook: ReturnType<typeof vi.spyOn>;
    const SERIES_ID = '20000000-0000-4000-a000-0000000000a1';

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${SERIES_ID}::uuid, 'Hook Test Series', 'tv', 'active', true)
        `;
        hook = vi
            .spyOn(MediaLifecycleService, 'afterExternalIdChanged')
            .mockResolvedValue(undefined);
    });

    afterEach(() => {
        hook.mockRestore();
    });

    const write = (id: string): Promise<boolean> =>
        createCatalogService(sql).upsertExternalId(SERIES_ID, {
            provider: 'imdb',
            id,
            mediaType: 'tv',
            source: 'scanner',
            confidence: 1.0,
        });

    it('fires for a new mapping', async () => {
        expect(await write('tt0206512')).toBe(true);
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire when the same mapping is re-confirmed, but still reports the write', async () => {
        await write('tt0206512');
        hook.mockClear();

        expect(await write('tt0206512')).toBe(true);

        expect(hook).not.toHaveBeenCalled();
    });

    it('fires when a different id replaces the old one', async () => {
        await write('tt0206512');
        // Age the row past the convergence guard's freshness window, as a real
        // rescan days later would.
        await sql`UPDATE external_ids SET created_at = now() - interval '7 days' WHERE media_id = ${SERIES_ID}::uuid`;
        hook.mockClear();

        await write('tt9999999');

        expect(hook).toHaveBeenCalledTimes(1);
    });
});

describe.each([false, true])(
    'Catalog creation hooks (skipLifecycleHooks=%s)',
    (skipLifecycleHooks) => {
        let sql: postgres.Sql;
        let hook: ReturnType<typeof vi.spyOn>;

        beforeAll(() => {
            sql = getTestDb();
        });

        beforeEach(async () => {
            await truncateTables(sql, TEST_TABLES.media);
            hook = vi.spyOn(MediaLifecycleService, 'afterCreated').mockResolvedValue();
        });

        afterEach(() => {
            hook.mockRestore();
        });

        it.each([
            'getOrCreateByExternalId',
            'getOrCreateMinimalByTmdb',
            'getOrCreateMinimal',
            'createLocalOnlyItem',
        ] as const)('%s honors the opt-out and fires by default', async (method) => {
            const catalog = createCatalogService(sql, { skipLifecycleHooks });
            let id: string;
            if (method === 'createLocalOnlyItem') {
                id = await catalog.createLocalOnlyItem(
                    randomUUID(),
                    'The Lantern Orchard',
                    'movie',
                );
            } else if (method === 'getOrCreateMinimal') {
                ({ id } = await catalog.getOrCreateMinimal(
                    '987003',
                    'tmdb',
                    'movie',
                    'The Lantern Orchard',
                ));
            } else if (method === 'getOrCreateMinimalByTmdb') {
                ({ id } = await catalog.getOrCreateMinimalByTmdb(
                    987003,
                    'movie',
                    'The Lantern Orchard',
                ));
            } else {
                ({ id } = await catalog.getOrCreateByExternalId(
                    { provider: 'tmdb', id: '987003', mediaType: 'movie' },
                    'movie',
                ));
            }

            expect(await sql`SELECT id FROM media_items WHERE id = ${id}`).toHaveLength(1);
            if (skipLifecycleHooks) expect(hook).not.toHaveBeenCalled();
            else expect(hook).toHaveBeenCalledExactlyOnceWith(id, method);
        });
    },
);
