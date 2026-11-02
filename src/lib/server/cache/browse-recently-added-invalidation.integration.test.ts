// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test, real Postgres + Valkey: a fileless catalog title gains its first
 * file in the BACKGROUND WORKER process; the WEB process's in-memory L1 must
 * drop its cached "Recently added" so the next browse call includes the title.
 *
 * Two module graphs stand in for the two processes. Each has its own
 * CacheManager singleton and therefore its own L1; they share only Valkey (L2
 * and the pub/sub bus). The web graph is built first, then vi.resetModules()
 * builds the worker graph, whose lazy `import('$lib/server/cache/index.js')`
 * inside the recency refresh must resolve to the worker's own instance.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

type CacheIndex = typeof import('./index.js');
type ValkeyMod = typeof import('./valkey.js');
type BusMod = typeof import('./namespace-clear-bus.js');
type BrowseQueries = typeof import('../database/queries/browse.queries.js');
type AccessBuilder = typeof import('../database/queries/builders/media-access-boundary.js');

const HAS_VALKEY = Boolean(process.env.CACHE_URL && process.env.TASK_CACHE_URL);
const CACHE_KEY = 'titles-v1:all';

describe.skipIf(!HAS_VALKEY)('first file on a fileless title reaches the web process L1', () => {
    let sql: postgres.Sql;
    let webCache: CacheIndex;
    let webValkey: ValkeyMod;
    let webBus: BusMod;
    let workerValkey: ValkeyMod;
    let workerBus: BusMod;
    let queries: BrowseQueries;
    let access: AccessBuilder;

    beforeAll(async () => {
        sql = getTestDb();
        await truncateTables(sql, TEST_TABLES.media);

        // "Web process" graph.
        vi.resetModules();
        webValkey = await import('./valkey.js');
        webCache = await import('./index.js');
        webBus = await import('./namespace-clear-bus.js');
        expect(await webValkey.connectValkey()).toBe(true);
        expect(await webBus.startNamespaceClearSubscriber()).toBe(true);

        // "Worker process" graph. Its cache index is loaded now so the lazy
        // import inside the recency refresh finds it in the registry.
        vi.resetModules();
        workerValkey = await import('./valkey.js');
        await import('./index.js');
        workerBus = await import('./namespace-clear-bus.js');
        queries = await import('../database/queries/browse.queries.js');
        access = await import('../database/queries/builders/media-access-boundary.js');
        expect(await workerValkey.connectValkey()).toBe(true);
    });

    afterAll(async () => {
        workerBus?._resetNamespaceClearBusForTests();
        webBus?._resetNamespaceClearBusForTests();
        await workerValkey?.closeAllSubscriptions().catch(() => undefined);
        await webValkey?.closeAllSubscriptions().catch(() => undefined);
        await closeTestDb();
    });

    /** The web process's cache-aside read of the "Recently added" row (browse-index.service). */
    async function webBrowse(): Promise<string[]> {
        const cache = webCache.cacheManager.for(webCache.CACHE_NAMESPACES.browseRecentlyAdded);
        const cached = await cache.get<{ id: string }[]>(CACHE_KEY);
        if (cached) return cached.map((r) => r.id);
        const rows = await queries.getFilteredRecentlyAddedMedia(sql, {
            mediaType: 'all',
            limit: 20,
            access: access.unrestrictedAccess(),
            newness: 'titles',
        });
        await cache.set(
            CACHE_KEY,
            rows.map((r) => ({ id: r.id })),
        );
        return rows.map((r) => r.id);
    }

    it('drops the web L1 entry so the next browse call includes the title', async () => {
        const [title] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Fileless Until Now', 'active', false) RETURNING id`;

        // The web process browses while the title has no file, and caches that.
        expect(await webBrowse()).not.toContain(title.id);

        // The worker ingests the first file (has_files false -> true) ...
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/itest/fileless-until-now.mkv')
            RETURNING id`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}, ${title.id}, true)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${title.id}`;
        // ... and refreshes the recency, which is where the invalidation starts.
        const changed = await queries.refreshRecentlyAddedRecencyForItems(sql, [title.id]);
        expect(changed).toEqual([title.id]);

        // Before the (coalesced) cascade runs, the web L1 still answers stale.
        expect(await webBrowse()).not.toContain(title.id);

        // The cascade clears L2 and publishes; the web process drops its L1.
        await vi.waitFor(async () => expect(await webBrowse()).toContain(title.id), {
            timeout: 25_000,
            interval: 500,
        });
    }, 40_000);
});
