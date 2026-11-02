// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/watch-events/repudiate.ts
 *
 * POST /api/admin/watch-events/repudiate
 *
 * Repudiates a window of watch events and rebuilds the user's materialized
 * watch state. Used by the provenance explorer + audit page to "undo" a bad
 * bulk-mark cascade.
 *
 * Sets `repudiated_at` on matching events inside a transaction, then rebuilds
 * the user's materialized watch state.
 *
 * For `source = 'jellyfin-sync'` cascades, `alsoUnmarkOnSource` (default true
 * when source = jellyfin-sync) ALSO calls
 * `DELETE /Users/{jellyfinUserId}/PlayedItems/{itemId}` on Jellyfin for each
 * media item with a repudiated event in the window, so Jellyfin stops showing
 * the cascade as watched. Lumastra's own data does not depend on it: re-pulls
 * dedupe on the event id (`idx_ume_dedup` includes repudiated rows), so the
 * cascade is not re-imported.
 *
 * The unmark covers every media repudiated in the window, not only the rows this
 * call repudiated, so repeating the request retries an unmark that failed
 * (Jellyfin down, no user mapping). Media the user has watched in Lumastra
 * right now are skipped, so a genuine later rewatch is never wiped on Jellyfin.
 *
 * Body:     RepudiateBody
 * Response: { repudiated: number, rebuildCount: number, jellyfinUnmark: JellyfinUnmarkResult | null }
 * 503 dependency_unavailable when DB is down.
 *
 * Auth: admin.  Surface: internal-only.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    repudiateEvents,
    getRepudiatedUnwatchedMediaIds,
} from '$lib/server/database/queries/user-media-events.queries.js';
import { rebuildAllStatesForUser } from '$lib/server/services/watch-state-rebuilder.service.js';
import { resolveJellyfinUserIdByUserId } from '$lib/server/services/jellyfin-user-id-resolver.js';
import { isUserId, toUserId, type UserId } from '$lib/shared/user-id.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
const logger = Logger.for('AdminRepudiateEvents');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const RepudiateBodySchema = z.object({
    userId: z.string().min(1),
    // Restrict to the defined EventSource union so callers can't pass arbitrary
    // strings that would silently never match the DB column.
    source: z.enum([
        'lumastra-player',
        'lumastra-offline',
        'lumastra-user-mark',
        'jellyfin-sync',
        'plex-sync',
        'mal-sync',
        'trakt-sync',
        'audiobookshelf-sync',
        'migration',
        'compaction',
    ]),
    fromTs: z.string().datetime({ offset: true }),
    toTs: z.string().datetime({ offset: true }),
    /**
     * When true and source = 'jellyfin-sync', also call DELETE on Jellyfin's
     * PlayedItems for each affected (user, media) pair so the cleanup is
     * permanent (the next pull won't re-import the cascade).
     * Default: undefined → server treats as `true` for jellyfin-sync,
     * `false` for everything else (no-op for non-Jellyfin sources).
     */
    alsoUnmarkOnSource: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const JellyfinUnmarkResultSchema = z.object({
    attempted: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skippedNoExternalId: z.number().int().nonnegative(),
});

const RepudiateResponseSchema = z.object({
    repudiated: z.number().int().nonnegative(),
    rebuildCount: z.number().int().nonnegative(),
    jellyfinUnmark: JellyfinUnmarkResultSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Jellyfin side-effect helper
// ---------------------------------------------------------------------------

interface JellyfinUnmarkResult {
    attempted: number;
    succeeded: number;
    failed: number;
    skippedNoExternalId: number;
}

/**
 * Best-effort Jellyfin DELETE PlayedItems for each media in the repudiated set.
 * Failures are logged but never bubbled — the Lumastra repudiation itself has
 * already committed and we don't want to roll that back over a transient Jellyfin
 * blip. Operators see the stats in the response; repeating the request retries.
 */
async function unmarkOnJellyfin(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
): Promise<JellyfinUnmarkResult> {
    const result: JellyfinUnmarkResult = {
        attempted: mediaIds.length,
        succeeded: 0,
        failed: 0,
        skippedNoExternalId: 0,
    };
    if (mediaIds.length === 0) return result;

    // By users.id: the username resolver was handed this UUID and never
    // found a mapping, so every unmark failed and the next pull re-imported
    // the cascade.
    const jellyfinUserId = await resolveJellyfinUserIdByUserId(userId);
    if (!jellyfinUserId) {
        logger.warn('No Jellyfin user mapping for repudiation unmark — skipping all', {
            userId,
            mediaCount: mediaIds.length,
        });
        result.failed = mediaIds.length;
        return result;
    }

    // Look up Jellyfin item id per media via external_ids.
    const idRows = await sql<Array<{ media_id: string; external_id: string }>>`
        SELECT media_id, external_id
        FROM external_ids
        WHERE provider = 'jellyfin'
          AND media_id = ANY(${mediaIds}::uuid[])
    `;
    const itemIdByMedia = new Map(idRows.map((r) => [r.media_id, r.external_id]));

    const { jellyfinUserService } = await import('$lib/server/jellyfin/user.service.js');
    const axios = jellyfinUserService.getAxiosInstance();
    const basePath = jellyfinUserService.getBaseUrl();
    const accessToken = jellyfinUserService.getApiToken();
    if (!axios || !basePath || !accessToken) {
        logger.warn('Jellyfin client not available for repudiation unmark', {
            userId,
            mediaCount: mediaIds.length,
        });
        result.failed = mediaIds.length;
        return result;
    }
    const headers = buildJellyfinAuthHeaders({ token: accessToken });

    // Bounded concurrency so we don't hammer the Jellyfin API. The Jellyfin
    // sync plugin uses 5 for resolveIds; mirror that here for consistency.
    const CONCURRENCY = 5;
    for (let i = 0; i < mediaIds.length; i += CONCURRENCY) {
        const batch = mediaIds.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
            batch.map(async (mediaId): Promise<'skipped' | 'unmarked'> => {
                const itemId = itemIdByMedia.get(mediaId);
                if (!itemId) return 'skipped';
                await axios.delete(
                    joinUpstreamUrl(
                        basePath,
                        `/Users/${encodePathSegment(jellyfinUserId)}/PlayedItems/${encodePathSegment(itemId)}`,
                    ),
                    {
                        headers,
                    },
                );
                return 'unmarked';
            }),
        );
        // A skipped item is neither a success nor a failure; counting it as
        // fulfilled reported unmarks that never happened.
        for (const r of settled) {
            if (r.status === 'rejected') result.failed++;
            else if (r.value === 'skipped') result.skippedNoExternalId++;
            else result.succeeded++;
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: RepudiateBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { userId: userIdRaw, source, fromTs, toTs, alsoUnmarkOnSource } = ctx.input!.body;

            // Admin supplies the target user's stable users.id UUID; validate
            // the shape and mint the brand at this request boundary.
            if (!isUserId(userIdRaw)) {
                return problem('validation_failed', {
                    error: 'userId must be a valid user UUID',
                    details: [{ field: 'userId', message: 'Must be a valid UUID' }],
                });
            }
            const userId = toUserId(userIdRaw);
            const adminUser = event.locals.user?.username ?? 'unknown';

            // Timestamp range sanity check: the Zod schema proves each is a
            // valid ISO datetime, but not that fromTs <= toTs. A reversed pair
            // would match zero rows silently — reject explicitly.
            if (Date.parse(fromTs) > Date.parse(toTs)) {
                return problem('validation_failed', {
                    error: 'fromTs must be <= toTs',
                    details: [{ field: 'fromTs', message: 'Must be <= toTs' }],
                });
            }

            let repudiated = 0;
            let affectedMediaCount = 0;
            let rebuildCount = 0;

            await sql.begin(async (txRaw) => {
                const txSql = txRaw as unknown as postgres.Sql;
                const result = await repudiateEvents(txSql, {
                    userId,
                    source,
                    fromTs,
                    toTs,
                });
                repudiated = result.count;
                affectedMediaCount = result.mediaIds.length;
                rebuildCount = await rebuildAllStatesForUser(txSql, userId);
            });

            // Unmark upstream is opt-in but defaults ON for jellyfin-sync,
            // because that's the only source where Lumastra-only repudiation
            // gets silently undone by the next pull cycle. For other sources
            // (lumastra-*, migration, plex-sync) the call is a no-op since
            // Lumastra IS the origin or there's no symmetric unmark API in
            // scope. Caller can force-disable via alsoUnmarkOnSource: false to
            // keep the unmark Lumastra-side only.
            const shouldUnmarkSource = alsoUnmarkOnSource ?? source === 'jellyfin-sync';

            let jellyfinUnmark: JellyfinUnmarkResult | null = null;
            if (shouldUnmarkSource && source === 'jellyfin-sync') {
                // After the rebuild, so media the user watched again are excluded.
                const unmarkMediaIds = await getRepudiatedUnwatchedMediaIds(sql, {
                    userId,
                    source,
                    fromTs,
                    toTs,
                });
                if (unmarkMediaIds.length > 0) {
                    jellyfinUnmark = await unmarkOnJellyfin(sql, userId, unmarkMediaIds);
                }
            }

            auditLog('watch_events.repudiate', userId, auditActor(event), {
                source,
                fromTs,
                toTs,
                repudiated,
                rebuildCount,
                jellyfinUnmark,
            });
            logger.info('Admin repudiated watch events', {
                adminUser,
                userId,
                source,
                fromTs,
                toTs,
                repudiated,
                affectedMediaCount,
                rebuildCount,
                jellyfinUnmark,
            });

            return json(
                RepudiateResponseSchema.parse({ repudiated, rebuildCount, jellyfinUnmark }),
            );
        },
    },
});
