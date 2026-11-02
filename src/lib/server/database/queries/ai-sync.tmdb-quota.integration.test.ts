// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two candidate queries that decide how many TMDB detail requests the
 * metadata tasks spend per run.
 *
 * On prod (2026-09-26) the discovery sweep re-fetched details for all ~9k
 * catalog items every 12h, and the original_title backfill re-selected ~100k
 * rows every night (87k episodes, plus ~13k movies/series TMDB simply has no
 * English title for), so neither ever converged.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    listFreshDiscoveryDetailKeys,
    listOriginalTitleBackfillCandidates,
    hasRecentDeepDiscoveryListing,
    DISCOVERY_DETAIL_SYNCED_AT_KEY,
} from './ai-sync.queries.js';

interface SeedItem {
    tmdbId: string;
    mediaType: string;
    originalTitle?: string | null;
    englishTitle?: string | null;
    locked?: boolean;
    metadata?: Record<string, unknown>;
}

async function seed(sql: postgres.Sql, item: SeedItem): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, original_title, english_title, metadata_locked)
        VALUES (${id}::uuid, ${'Item ' + item.tmdbId}, ${item.mediaType}, 'active',
                ${item.originalTitle ?? null}, ${item.englishTitle ?? null}, ${item.locked ?? false})
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${id}::uuid, 'tmdb', ${item.tmdbId}, ${item.mediaType}, true)
    `;
    if (item.metadata) {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}::uuid, 'tmdb', ${sql.json(item.metadata as Record<string, never>)})
        `;
    }
    return id;
}

describe('TMDB request-volume candidate queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
    });

    describe('listFreshDiscoveryDetailKeys', () => {
        const DAY = 86_400_000;
        const freshSince = new Date(Date.now() - 7 * DAY);

        it('returns only items whose details were stamped inside the window', async () => {
            await seed(sql, {
                tmdbId: '101',
                mediaType: 'movie',
                metadata: {
                    [DISCOVERY_DETAIL_SYNCED_AT_KEY]: new Date(Date.now() - DAY).toISOString(),
                },
            });
            await seed(sql, {
                tmdbId: '102',
                mediaType: 'movie',
                metadata: {
                    [DISCOVERY_DETAIL_SYNCED_AT_KEY]: new Date(Date.now() - 30 * DAY).toISOString(),
                },
            });
            // Written by some other path, never stamped by the sweep.
            await seed(sql, { tmdbId: '103', mediaType: 'movie', metadata: { overview: 'x' } });
            // No provider_metadata row at all.
            await seed(sql, { tmdbId: '104', mediaType: 'movie' });

            const fresh = await listFreshDiscoveryDetailKeys(
                sql,
                ['101', '102', '103', '104', '105'].map((tmdbId) => ({
                    tmdbId,
                    mediaType: 'movie',
                })),
                freshSince,
            );

            expect([...fresh]).toEqual(['101:movie']);
        });

        it('keys on (tmdbId, mediaType) — a fresh movie does not make the same-id series fresh', async () => {
            await seed(sql, {
                tmdbId: '1429',
                mediaType: 'movie',
                metadata: { [DISCOVERY_DETAIL_SYNCED_AT_KEY]: new Date().toISOString() },
            });
            await seed(sql, { tmdbId: '1429', mediaType: 'tv', metadata: { overview: 'x' } });

            const fresh = await listFreshDiscoveryDetailKeys(
                sql,
                [
                    { tmdbId: '1429', mediaType: 'movie' },
                    { tmdbId: '1429', mediaType: 'tv' },
                ],
                freshSince,
            );

            expect([...fresh]).toEqual(['1429:movie']);
        });

        it('treats a locked row as fresh — the sweep cannot write it, so never stamps it', async () => {
            await seed(sql, { tmdbId: '301', mediaType: 'movie', locked: true });
            await seed(sql, {
                tmdbId: '302',
                mediaType: 'movie',
                locked: true,
                metadata: { overview: 'x' },
            });

            const fresh = await listFreshDiscoveryDetailKeys(
                sql,
                ['301', '302'].map((tmdbId) => ({ tmdbId, mediaType: 'movie' })),
                freshSince,
            );

            expect([...fresh].sort()).toEqual(['301:movie', '302:movie']);
        });

        it('a malformed stamp counts as stale instead of aborting the query', async () => {
            await seed(sql, {
                tmdbId: '401',
                mediaType: 'movie',
                metadata: { [DISCOVERY_DETAIL_SYNCED_AT_KEY]: 'not-a-date' },
            });
            await seed(sql, {
                tmdbId: '402',
                mediaType: 'movie',
                metadata: { [DISCOVERY_DETAIL_SYNCED_AT_KEY]: new Date().toISOString() },
            });

            const fresh = await listFreshDiscoveryDetailKeys(
                sql,
                ['401', '402'].map((tmdbId) => ({ tmdbId, mediaType: 'movie' })),
                freshSince,
            );

            expect([...fresh]).toEqual(['402:movie']);
        });

        it('returns an empty set for no keys without querying', async () => {
            expect((await listFreshDiscoveryDetailKeys(sql, [], freshSince)).size).toBe(0);
        });
    });

    describe('hasRecentDeepDiscoveryListing', () => {
        const DAY = 86_400_000;

        async function run(opts: {
            id: string;
            taskId?: string;
            state?: string;
            ageDays: number;
            listDepth?: string;
        }): Promise<void> {
            const at = new Date(Date.now() - opts.ageDays * DAY);
            const result = {
                success: true,
                result: opts.listDepth ? { listDepth: opts.listDepth } : { message: 'x' },
            };
            await sql`
                INSERT INTO task_history (id, task_id, label, state, input, trigger, actor,
                    processing_version, started_at, completed_at, result)
                VALUES (${opts.id}, ${opts.taskId ?? 'tmdb-metadata-sync'}, 'tmdb', ${opts.state ?? 'completed'},
                    ${sql.json({})}, ${sql.json({ kind: 'scheduled' })}, ${sql.json({ type: 'system' })}, '1',
                    ${at}, ${at}, ${sql.json(result)})
            `;
        }

        beforeEach(async () => {
            await sql`DELETE FROM task_history WHERE id LIKE 'deep-list-%'`;
        });

        const since = (): Date => new Date(Date.now() - 7 * DAY);

        it('true only for a COMPLETED tmdb-metadata-sync run that recorded a deep listing in the window', async () => {
            await run({ id: 'deep-list-shallow', ageDays: 1, listDepth: 'shallow' });
            await run({ id: 'deep-list-old', ageDays: 8, listDepth: 'deep' });
            await run({ id: 'deep-list-failed', ageDays: 1, listDepth: 'deep', state: 'failed' });
            await run({
                id: 'deep-list-other',
                ageDays: 1,
                listDepth: 'deep',
                taskId: 'metadata-sync',
            });
            await run({ id: 'deep-list-legacy', ageDays: 1 });
            expect(await hasRecentDeepDiscoveryListing(sql, since())).toBe(false);

            await run({ id: 'deep-list-recent', ageDays: 3, listDepth: 'deep' });
            expect(await hasRecentDeepDiscoveryListing(sql, since())).toBe(true);
        });
    });

    describe('listOriginalTitleBackfillCandidates', () => {
        it('selects only unlocked movie/tv rows missing original_title', async () => {
            await seed(sql, { tmdbId: '201', mediaType: 'movie', originalTitle: null });
            await seed(sql, { tmdbId: '202', mediaType: 'tv', originalTitle: null });
            // TMDB has no English title for it: must NOT be re-fetched forever.
            await seed(sql, {
                tmdbId: '203',
                mediaType: 'movie',
                originalTitle: 'Le Film',
                englishTitle: null,
            });
            // Episodes were 87k of the nightly re-selected rows on prod.
            await seed(sql, { tmdbId: '204', mediaType: 'episode', originalTitle: null });
            await seed(sql, {
                tmdbId: '205',
                mediaType: 'movie',
                originalTitle: null,
                locked: true,
            });

            const rows = await listOriginalTitleBackfillCandidates(sql);

            expect(rows.map((r) => `${r.external_id}:${r.media_type}`)).toEqual([
                '201:movie',
                '202:tv',
            ]);
        });
    });
});
