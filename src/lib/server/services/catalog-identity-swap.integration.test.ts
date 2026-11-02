// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for the identity ping-pong that produced ~76k of ~112k weekly
 * TMDB calls on prod (2026-08-27).
 *
 * Two Jellyfin items (the same film in two libraries) resolved to ONE media item.
 * `upsertExternalId` deleted the rival unconditionally, so each sync pass swapped
 * the pair — 1,370 swaps per id on a single film. Every swap is a DELETE plus an
 * INSERT, which fires identity.cleared + identity.assigned (the trigger's
 * IS DISTINCT FROM guard only covers UPDATE), invalidating every identity-sensitive
 * stage and re-running three TMDB tasks several times per second, forever.
 *
 * Asserted at the SEAM that actually broke — row state in Postgres after two
 * competing writers — not at a mocked service boundary.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import { CatalogService } from './catalog.service.js';

describe('CatalogService identity swap guard (integration)', () => {
    let sql: postgres.Sql;
    let service: CatalogService;

    beforeAll(() => {
        sql = getTestDb();
        service = new CatalogService(sql, { skipLifecycleHooks: true });
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    const idsFor = async (mediaId: string) =>
        (
            await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${mediaId}::uuid AND provider = 'jellyfin'
                ORDER BY external_id
            `
        ).map((r) => r.external_id);

    it('converges on one id when two live writers disagree, instead of ping-ponging', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        // Two Jellyfin items claiming the same media item, written back-to-back
        // exactly as the two sync passes did.
        await service.upsertExternalId(item.id, {
            provider: 'jellyfin',
            id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            mediaType: 'movie',
            source: 'sync',
        });
        const [{ created_at: firstWriteAt }] = await sql<{ created_at: Date }[]>`
            SELECT created_at FROM external_ids
            WHERE media_id = ${item.id}::uuid AND provider = 'jellyfin'
        `;

        for (let round = 0; round < 3; round++) {
            await service.upsertExternalId(item.id, {
                provider: 'jellyfin',
                id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                mediaType: 'movie',
                source: 'sync',
            });
            await service.upsertExternalId(item.id, {
                provider: 'jellyfin',
                id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                mediaType: 'movie',
                source: 'sync',
            });
        }

        // idx_external_ids_one_per_provider is UNIQUE on (media_id, provider,
        // media_type), so only one id can survive — the point is that it must be
        // the SAME one every round. Before the fix it alternated, destroying and
        // recreating a row (and firing two pipeline events) on every single pass.
        expect(await idsFor(item.id)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

        // And the surviving row must be the ORIGINAL, never re-created: a stable
        // created_at is what proves no delete/insert churn happened underneath.
        const [row] = await sql<{ created_at: Date }[]>`
            SELECT created_at FROM external_ids
            WHERE media_id = ${item.id}::uuid AND provider = 'jellyfin'
        `;
        expect(row.created_at.getTime()).toBe(firstWriteAt.getTime());
    });

    it('batch path converges too, and never trades the swap for a unique violation', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'jellyfin',
                    id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                    mediaType: 'movie',
                    source: 'sync',
                },
            },
        ]);
        const [{ created_at: firstWriteAt }] = await sql<{ created_at: Date }[]>`
            SELECT created_at FROM external_ids
            WHERE media_id = ${item.id}::uuid AND provider = 'jellyfin'
        `;

        // The rival batch must neither swap the row nor blow up on
        // idx_external_ids_one_per_provider.
        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'jellyfin',
                    id: 'ffffffffffffffffffffffffffffffff',
                    mediaType: 'movie',
                    source: 'sync',
                },
            },
        ]);

        expect(await idsFor(item.id)).toEqual(['eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);
        const [row] = await sql<{ created_at: Date }[]>`
            SELECT created_at FROM external_ids
            WHERE media_id = ${item.id}::uuid AND provider = 'jellyfin'
        `;
        expect(row.created_at.getTime()).toBe(firstWriteAt.getTime());
    });

    it('never skips an operator correction, even inside the window', async () => {
        // The guard's whole purpose is stopping two AUTOMATED writers alternating.
        // An admin fixing a wrong id typically does it seconds after the scan that
        // wrote it — squarely inside the window — and upsertExternalId returns void,
        // so a silent skip surfaced to the admin as `{updated: true}`.
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await service.upsertExternalId(item.id, {
            provider: 'jellyfin',
            id: '11111111111111111111111111111111',
            mediaType: 'movie',
            source: 'sync',
        });

        // Same instant, so the sync-written row is maximally "fresh".
        await service.upsertExternalId(item.id, {
            provider: 'jellyfin',
            id: '22222222222222222222222222222222',
            mediaType: 'movie',
            source: 'manual',
        });

        expect(await idsFor(item.id)).toEqual(['22222222222222222222222222222222']);
    });

    it('still cleans up a genuinely stale id from a provider rescan', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await service.upsertExternalId(item.id, {
            provider: 'jellyfin',
            id: 'cccccccccccccccccccccccccccccccc',
            mediaType: 'movie',
            source: 'sync',
        });
        // Age it past the guard: this is the rescan case the delete exists for.
        await sql`
            UPDATE external_ids SET created_at = now() - interval '2 hours'
            WHERE media_id = ${item.id}::uuid AND provider = 'jellyfin'
        `;

        await service.upsertExternalId(item.id, {
            provider: 'jellyfin',
            id: 'dddddddddddddddddddddddddddddddd',
            mediaType: 'movie',
            source: 'sync',
        });

        expect(await idsFor(item.id)).toEqual(['dddddddddddddddddddddddddddddddd']);
    });
});
