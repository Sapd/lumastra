// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * activity-feed/ — admin activity feed.
 *
 * GET /api/admin/activity?limit=&offset=&activityType=&userId=&search=&days=
 *
 * Auth: {kind:'admin'} — admin-only.
 * Visibility: internal (Admin CP page; not a /api/v1 endpoint).
 *
 * Response contract: bare { items: ActivityFeedEntry[], page }
 * Errors: problem+json (incl. 503 dependency_unavailable).
 *
 * This is a dedicated Admin CP surface and is independent of homepage widgets.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    activityFeedService,
    ActivityFeedUnavailableError,
    type ActivityFeedItem,
} from '$lib/server/services/activity-feed.service.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { ActivityTypeSchema, type ActivityFeedEntry } from '$lib/schemas/activity-feed.js';

import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { getDb } from '$lib/server/database/connection.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { buildPublicAuthor } from '$lib/shared/public-author';
import type { ApiSurface } from '$lib/shared/api-urls';

const logger = Logger.for('ActivityFeedDef');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/** Deepest page the feed serves (offset + limit rows are fetched per source). */
const MAX_OFFSET = 10_000;

const ActivityFeedQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
    activityType: ActivityTypeSchema.optional(),
    userId: z.string().uuid().optional(),
    search: z.string().trim().max(200).optional(),
    days: z.coerce.number().int().min(1).max(3650).optional().default(30),
});

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function numberOrNull(value: unknown): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function transformActivity(
    activity: ActivityFeedItem,
    surface: ApiSurface,
    avatars: Map<string, ImageSet>,
): ActivityFeedEntry {
    const externalIds: ExternalIds = createExternalIds({
        internal: activity.media_id,
        [getPrimaryExternalIdProvider()]: activity.primary_ext_id,
        imdb: activity.imdb_id,
        tvdb: activity.tvdb_id,
    });

    return {
        id: activity.id,
        author: buildPublicAuthor(
            activity.user_id,
            activity.display_name ?? null,
            surface,
            avatars.get(activity.user_id),
        ),
        activityType: activity.activity_type,
        mediaId: activity.media_id,
        // Canonical public discriminator. This value is rendered verbatim in
        // the activity feed row's subtitle, so the stored `tv` was literally on
        // screen next to `series` elsewhere in the admin UI. Passthrough for
        // every other type — the activity feed carries the full storage
        // vocabulary (episode, audiobook, track, …), which a converter would
        // map to null and drop.
        mediaType: activity.media_type === 'tv' ? 'series' : activity.media_type,
        ratingValue: numberOrNull(activity.rating_value),
        externalIds: externalIds as Record<string, string | number | null>,
        title: activity.title,
        year: activity.year,
        seriesName: activity.series_name,
        seasonNumber: activity.season_number,
        episodeNumber: activity.episode_number,
        completionPercentage: numberOrNull(activity.completion_percentage),
        watchTimeSeconds: numberOrNull(activity.watch_time_seconds),
        sourceService: activity.source_service,
        metadata: activity.metadata,
        bitrate: numberOrNull(activity.bitrate),
        deviceId: activity.device_id,
        deviceName: activity.device_name,
        userAgent: activity.user_agent,
        clientName: activity.client_name,
        clientVersion: activity.client_version,
        ipAddress: activity.ip_address,
        playMethod: activity.play_method,
        transcodeMode: activity.transcode_mode,
        resolutionWidth: numberOrNull(activity.resolution_width),
        resolution: activity.resolution,
        videoCodec: activity.codec,
        audioCodec: activity.audio_codec,
        container: activity.container,
        stopReason: activity.stop_reason,
        sourcePlaySessionId: activity.source_play_session_id,
        sourceSessionId: activity.source_session_id,
        planMode: activity.plan_mode,
        planReasons: activity.plan_reasons,
        subtitleMethod: activity.subtitle_method,
        transcodeCodec: activity.transcode_codec,
        deliveryPath: activity.delivery_path,
        totalDurationSeconds: numberOrNull(activity.total_duration_seconds),
        currentPositionSeconds: numberOrNull(activity.current_position_seconds),
        currentProgressPercentage: numberOrNull(activity.current_progress_percentage),
        isPaused: activity.is_paused,
        isActive: activity.is_active,
        lastUpdateTime: activity.last_update_time?.toISOString() ?? null,
        activityTime: activity.activity_time.toISOString(),
        createdAt: activity.created_at.toISOString(),
        occurrenceCount: activity.occurrence_count,
    };
}

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: ActivityFeedQuery,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const limit = ctx.input?.query?.limit ?? 50;
            const offset = ctx.input?.query?.offset ?? 0;
            // Each source query fetches offset + limit rows through two window
            // CTEs, so an unbounded offset is an expensive full scan.
            if (offset > MAX_OFFSET) {
                return ApiProblem.validationFailed([
                    { field: 'offset', message: `Must be at most ${MAX_OFFSET}` },
                ]);
            }

            try {
                // One extra row tells whether another page exists; `length ===
                // limit` showed "Load more" in front of an empty page whenever
                // the remainder was exactly one page.
                const fetched = await activityFeedService.getRecentActivity(limit + 1, offset, {
                    activityType: ctx.input?.query?.activityType,
                    userId: ctx.input?.query?.userId,
                    search: ctx.input?.query?.search,
                    days: ctx.input?.query?.days,
                });
                const page = fetched.slice(0, limit);
                const sql = getDb();
                const avatars = sql
                    ? await userImageSets(
                          sql,
                          ctx.surface,
                          page.map((activity) => activity.user_id),
                          { external: false },
                      )
                    : new Map<string, ImageSet>();
                const items = page.map((activity) =>
                    transformActivity(activity, ctx.surface, avatars),
                );

                logger.debug(`Activity feed: ${items.length} items (offset=${offset})`);

                return json(
                    paginate(items, {
                        limit,
                        offset,
                        hasMore: fetched.length > limit,
                    }),
                );
            } catch (err) {
                if (err instanceof ActivityFeedUnavailableError) {
                    return ApiProblem.dependencyUnavailable('Database unavailable');
                }
                logger.error('Failed to fetch activity feed', err as Error);
                return ApiProblem.internalError('Failed to fetch activity feed');
            }
        },
    },
});
