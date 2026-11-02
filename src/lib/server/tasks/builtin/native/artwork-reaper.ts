// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artwork Reaper — deletes `media_artwork` rows whose file is really gone.
 *
 * A dangling row does not merely fail to render: `getLocalArtwork`
 * (media-artwork.queries.ts:162-188) resolves artwork with `ORDER BY depth ASC
 * ... LIMIT 1` up the parent chain, so a depth-0 row pointing at a deleted file
 * SHADOWS the ancestor's good row. A season whose poster file was deleted shows
 * NOTHING instead of inheriting the series poster.
 *
 * Why this is its own task and not part of `image-sync` or `integrity-scanner`:
 * both are `resourceClass: 'ingest'` — the file-fast lane, default budget 2
 * concurrent jobs, documented as "user-visible 'new file just arrived' latency"
 * (config.ts:5127-5136). Mass per-file `stat` over NFS on that lane is this
 * repo's documented wedge hazard, and the retired episode-thumbnail-repair task recorded
 * precisely because routing NFS-rediscovery work through `image-sync` "was wrong
 * twice over". `integrity-scanner` is additionally wrong on capability: it only
 * SURFACES findings and never mutates catalog data.
 *
 * Safety (deletion is irreversible):
 *  - presence is classified by `assessFilePresence`, never a bare `stat`, and
 *    the probe is mount-aware, so an offline share reads as transient;
 *  - a row must be confirmed missing on `missThreshold` CONSECUTIVE runs;
 *  - `deleteLimit` caps how much one run can remove;
 *  - the miss counters live in the namespaced cache, so losing them only ever
 *    delays a deletion, never causes one.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    reapMissingArtwork,
    type ArtworkMissRecord,
    type ArtworkMissStore,
} from '$lib/server/services/artwork-reaper.service.js';

/** Artwork rows probed on disk per cycle when the caller doesn't override it. */
const DEFAULT_INSPECT_LIMIT = 2000;
/** Rows deleted per cycle when the caller doesn't override it. */
const DEFAULT_DELETE_LIMIT = 200;
/** Consecutive confirmed misses required before a row is deleted. */
const DEFAULT_MISS_THRESHOLD = 3;

/**
 * Namespaced-cache key holding the media_item_id the previous cycle finished
 * at — the round-robin sweep cursor. Evictable: losing it restarts the sweep
 * from the beginning, which is harmless (just repeated work).
 */
const CURSOR_CACHE_KEY = 'artwork-reaper-cursor';
/** Comfortably longer than the schedule; self-cleans if the task is disabled. */
const CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const inputSchema = z
    .object({
        /** Max artwork rows probed on disk this cycle. */
        limit: z.number().int().min(1).max(20000).optional(),
        /** Max rows deleted this cycle. */
        deleteLimit: z.number().int().min(1).max(5000).optional(),
        /** Consecutive confirmed misses required before deleting a row. */
        missThreshold: z.number().int().min(1).max(10).optional(),
    })
    .passthrough();

type ArtworkReaperInput = z.infer<typeof inputSchema>;

interface ArtworkReaperResult {
    /** Artwork rows probed on disk this cycle. */
    inspected: number;
    /** Files that are there. */
    present: number;
    /** Files confirmed deleted (mount live, file and/or folder gone). */
    missing: number;
    /** Files unreachable because the mount looks offline — never counted. */
    transient: number;
    /** Rows removed (plus their paired custom_<type>_url). */
    deleted: number;
    /** True when the sweep reached the end of the table and wraps next cycle. */
    wrapped: boolean;
}

export const artworkReaperTask = defineTask<ArtworkReaperInput, ArtworkReaperResult>({
    id: 'artwork-reaper',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Artwork Reaper',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, cache: true },

    schedule: { every: '1h', runOnStartup: false },

    identityFor: () => 'global',
    scope: 'global',
    // maintenance class + maxConcurrent:1 — never contend with the file-fast
    // ingest lane, and never run two sweeps at once (they would race the same
    // rows and the same miss counters).
    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },
    confirmBeforeRun: true,
    destructive: true,
    inputSchema,
    timeout: { hard: '10m', soft: '9m' },

    async execute(ctx) {
        // `ctx.cache` is typed optional (the capability is a runtime grant, not
        // a compile-time narrowing). It IS present because we declare
        // `capabilities: { cache: true }`. The optional-chaining fallback is a
        // safe degrade: with no cache no counter ever reaches the threshold, so
        // the run reports findings and deletes nothing.
        const misses: ArtworkMissStore = {
            get: (key) => ctx.cache?.get<ArtworkMissRecord>(key) ?? Promise.resolve(null),
            set: async (key, value, ttlMs) => {
                await ctx.cache?.set(key, value, ttlMs);
            },
            del: async (key) => {
                await ctx.cache?.del(key);
            },
        };

        const cursor = (await ctx.cache?.get<string>(CURSOR_CACHE_KEY)) ?? null;

        const swept = await reapMissingArtwork(ctx.sql, {
            inspectLimit: ctx.input.limit ?? DEFAULT_INSPECT_LIMIT,
            deleteLimit: ctx.input.deleteLimit ?? DEFAULT_DELETE_LIMIT,
            missThreshold: ctx.input.missThreshold ?? DEFAULT_MISS_THRESHOLD,
            cursor,
            misses,
            signal: ctx.signal,
        });

        if (swept.nextCursor === null) {
            await ctx.cache?.del(CURSOR_CACHE_KEY);
        } else {
            await ctx.cache?.set(CURSOR_CACHE_KEY, swept.nextCursor, CURSOR_TTL_MS);
        }

        const result: ArtworkReaperResult = {
            inspected: swept.inspected,
            present: swept.present,
            missing: swept.missing,
            transient: swept.transient,
            deleted: swept.deleted,
            wrapped: swept.nextCursor === null,
        };

        ctx.logger.info('artwork-reaper cycle complete', { ...result });

        return { success: true, itemsProcessed: result.deleted, result };
    },
});

registry.registerTask(artworkReaperTask);
