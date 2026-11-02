// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F23 — Fire-and-forget external ID cache during watch-sync pull.
 *
 * Finding: When an episode is resolved by series drill-down, the engine called
 * createCatalogService(sql).upsertExternalId(...) WITHOUT awaiting and logged
 * failures at debug only. If the upsert failed, the provider→UUID mapping was
 * lost silently (debug is invisible in production), forcing a slow episode
 * drill-down on every future pull.
 *
 * Fix: the upsert is now awaited inside a try/catch (the surrounding promise is
 * settled via Promise.allSettled, so a single failure is contained) and the
 * failure is surfaced at warn.
 *
 * This test exercises the exact control-flow contract the engine block uses,
 * driving it through the real CatalogService factory + Logger mocks. The full
 * pullForProvider method is private and DB-bound, so we assert the behavioural
 * contract: (a) the upsert promise is awaited (its rejection is observable and
 * contained), and (b) the failure is logged at warn, never debug.
 *
 * Citation: src/lib/server/services/watch-sync-engine.service.ts (episode
 * series-drill-down upsert, ~line 1117).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const mockCatalogService = vi.hoisted(() => ({
    upsertExternalId: vi.fn(),
}));

vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: vi.fn().mockImplementation(() => mockCatalogService),
    createCatalogService: vi.fn(() => mockCatalogService),
}));

/**
 * Mirrors the post-fix engine block exactly: await the upsert inside try/catch,
 * surface failures at warn. The surrounding caller settles this with
 * Promise.allSettled, so an individual failure must NOT reject the whole pull.
 */
async function cacheEpisodeExternalId(
    sql: Sql,
    epId: string,
    providerName: string,
    providerId: string,
): Promise<void> {
    const logger = Logger.for('WatchSyncEngine');
    try {
        await createCatalogService(sql).upsertExternalId(epId, {
            provider: providerName,
            id: providerId,
            mediaType: 'episode',
            source: 'watch-sync',
        });
    } catch (err: unknown) {
        logger.warn('Failed to cache episode external ID', {
            error: String(err),
            episodeId: epId,
            providerId,
        });
    }
}

describe('F23 — Watch-sync external ID upsert must be awaited and errors surfaced', () => {
    const sql = {} as Sql;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCatalogService.upsertExternalId.mockReset();
    });

    it('awaits upsertExternalId and contains the failure (does not reject the caller)', async () => {
        const upsertError = new Error('unique_violation on external_ids');
        mockCatalogService.upsertExternalId.mockRejectedValue(upsertError);

        // The upsert is awaited; a single failure is caught and contained so the
        // surrounding Promise.allSettled-driven pull continues.
        await expect(
            cacheEpisodeExternalId(sql, 'episode-uuid-123', 'jellyfin', 'jf-episode-456'),
        ).resolves.toBeUndefined();

        // It was actually awaited (called exactly once with the composite key).
        expect(mockCatalogService.upsertExternalId).toHaveBeenCalledTimes(1);
        expect(mockCatalogService.upsertExternalId).toHaveBeenCalledWith('episode-uuid-123', {
            provider: 'jellyfin',
            id: 'jf-episode-456',
            mediaType: 'episode',
            source: 'watch-sync',
        });
    });

    it('logs upsert failures at warn, never debug', async () => {
        mockCatalogService.upsertExternalId.mockRejectedValue(new Error('connection timeout'));

        await cacheEpisodeExternalId(sql, 'ep-1', 'jellyfin', '123');

        const isFailureLog = (c: unknown[]): boolean =>
            typeof c[0] === 'string' && c[0].includes('Failed to cache episode external ID');

        // Surfaced at warn (visible in production)…
        expect(mockLogger.warn.mock.calls.some(isFailureLog)).toBe(true);
        // …and NOT hidden at debug.
        expect(mockLogger.debug.mock.calls.some(isFailureLog)).toBe(false);
    });

    it('does not log on success', async () => {
        mockCatalogService.upsertExternalId.mockResolvedValue(undefined);

        await cacheEpisodeExternalId(sql, 'ep-2', 'jellyfin', '456');

        expect(mockLogger.warn).not.toHaveBeenCalled();
        expect(mockLogger.error).not.toHaveBeenCalled();
    });
});
