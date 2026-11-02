// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getDb } from '../database/connection.js';
import type postgres from 'postgres';
import { Logger } from '../utils/logger.js';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';
import { escapeLikePattern } from '$lib/server/database/queries/builders/search-filter.builder.js';

const logger = Logger.for('ActivityFeedService');

export interface ActivityFeedItem {
    id: number;
    user_id: string;
    // Public display name resolved in one batch; login usernames are never exposed.
    display_name?: string | null;
    activity_type:
        'started' | 'finished' | 'abandoned' | 'watchlist_add' | 'watchlist_remove' | 'rating';
    media_id: string | null;
    media_type: string | null;
    rating_value: number | null;
    // External IDs for provider-agnostic lookups
    primary_ext_id: string | null;
    imdb_id: string | null;
    tvdb_id: string | null;
    title: string;
    year: number | null;
    series_name: string | null;
    season_number: number | null;
    episode_number: number | null;
    completion_percentage: number | null;
    watch_time_seconds: number | null;
    source_service: string | null;
    metadata: Record<string, unknown> | null;
    bitrate: number | null;
    device_id: string | null;
    device_name: string | null;
    user_agent: string | null;
    client_name: string | null;
    client_version: string | null;
    ip_address: string | null;
    play_method: string | null;
    transcode_mode: string | null;
    resolution_width: number | null;
    resolution: string | null;
    codec: string | null;
    audio_codec: string | null;
    container: string | null;
    stop_reason: string | null;
    source_play_session_id: string | null;
    source_session_id: string | null;
    plan_mode: string | null;
    plan_reasons: string[] | null;
    subtitle_method: string | null;
    transcode_codec: string | null;
    delivery_path: string | null;
    total_duration_seconds: number | null;
    current_position_seconds: number | null;
    current_progress_percentage: number | null;
    is_paused: boolean;
    is_active: boolean;
    last_update_time: Date | null;
    activity_time: Date;
    created_at: Date;
    occurrence_count?: number; // Number of duplicate events that were grouped together
}

export interface ActivityFeedFilters {
    activityType?: ActivityFeedItem['activity_type'];
    userId?: string;
    search?: string;
    days?: number;
}

/**
 * Service for tracking and querying unified activity feed
 *
 * After migration 3.13.0, viewing activities are stored in watch_history
 * and watchlist activities are stored in watchlist_activities.
 * This service provides a unified view of both.
 */
/** The activity feed's database is not reachable. */
export class ActivityFeedUnavailableError extends Error {
    constructor() {
        super('Activity feed database unavailable');
        this.name = 'ActivityFeedUnavailableError';
    }
}

class ActivityFeedService {
    private sql: postgres.Sql | null = null;

    /**
     * Check if database is available
     */
    private isAvailable(): boolean {
        if (!this.sql) {
            this.ensureSql();
        }
        return this.sql !== null;
    }

    private ensureSql(): void {
        if (this.sql) {
            return;
        }

        this.sql = getDb();
    }

    /**
     * Track a watchlist event (add or remove)
     * Writes to the watchlist_activities table
     *
     * @param userId - User who performed the action
     * @param action - 'add' or 'remove'
     * @param mediaInfo - Media information (media_id preferred, tmdb_id as fallback)
     */
    async trackWatchlistEvent(
        userId: string,
        action: 'add' | 'remove',
        mediaInfo: {
            media_id?: string; // Internal UUID (preferred)
            primary_ext_id?: string; // Primary provider ID string (optional if media_id provided)
            media_type: 'movie' | 'tv' | 'audiobook';
            title: string;
            year?: number;
            series_name?: string;
        },
    ): Promise<void> {
        if (!this.isAvailable()) return;

        try {
            let mediaId: string | null = mediaInfo.media_id ?? null;
            let primaryExtId: string | null = mediaInfo.primary_ext_id ?? null;
            const provider = getPrimaryExternalIdProvider();

            // If we have media_id but no primaryExtId, try to resolve it
            if (mediaId && !primaryExtId) {
                type ExtIdRow = { external_id: string };
                const extIdResult = await this.sql!<ExtIdRow[]>`
					SELECT external_id FROM external_ids
					WHERE media_id = ${mediaId}::uuid
					  AND provider = ${provider}
					LIMIT 1
				`;
                if (extIdResult.length > 0) {
                    primaryExtId = extIdResult[0].external_id;
                }
            }

            // If we have primaryExtId but no media_id, try to resolve it
            if (primaryExtId && !mediaId) {
                type MediaIdRow = { media_id: string };
                const mediaResult = await this.sql!<MediaIdRow[]>`
					SELECT ei.media_id FROM external_ids ei
					JOIN media_items mi ON mi.id = ei.media_id
					WHERE ei.provider = ${provider}
					  AND ei.external_id = ${primaryExtId}
					  AND LOWER(ei.media_type) = LOWER(${mediaInfo.media_type})
					  AND mi.status = 'active'
					LIMIT 1
				`;
                if (mediaResult.length > 0) {
                    mediaId = mediaResult[0].media_id;
                }
            }

            await this.sql!`
				INSERT INTO watchlist_activities (
					user_id,
					activity_type,
					media_id,
					tmdb_id,
					media_type,
					title,
					year,
					series_name,
					activity_time
				) VALUES (
					${userId ?? 'Unknown'},
					${action},
					${mediaId},
					${primaryExtId},
					${mediaInfo.media_type ?? 'movie'},
					${mediaInfo.title ?? 'Unknown Title'},
					${mediaInfo.year ?? null},
					${mediaInfo.series_name ?? null},
					NOW()
				)
			`;
            logger.debug('Watchlist event tracked', {
                userId,
                action,
                title: mediaInfo.title,
                mediaId,
                primaryExtId,
            });
        } catch (error) {
            logger.error('Failed to track watchlist event', error as Error, {
                userId,
                action,
            });
        }
    }

    /**
     * Track a rating event
     * Writes to the watchlist_activities table with activity_type = 'rating'
     */
    async trackRatingEvent(
        userId: string,
        mediaInfo: {
            media_id?: string;
            primary_ext_id?: string;
            media_type: 'movie' | 'tv';
            title: string;
            year?: number;
            rating: number;
        },
    ): Promise<void> {
        if (!this.isAvailable()) return;

        try {
            let mediaId: string | null = mediaInfo.media_id ?? null;
            let primaryExtId: string | null = mediaInfo.primary_ext_id ?? null;
            const provider = getPrimaryExternalIdProvider();

            // If we have media_id but no primaryExtId, try to resolve it
            if (mediaId && !primaryExtId) {
                type ExtIdRow = { external_id: string };
                const extIdResult = await this.sql!<ExtIdRow[]>`
                    SELECT external_id FROM external_ids
                    WHERE media_id = ${mediaId}::uuid
                      AND provider = ${provider}
                    LIMIT 1
                `;
                if (extIdResult.length > 0) {
                    primaryExtId = extIdResult[0].external_id;
                }
            }

            await this.sql!`
                INSERT INTO watchlist_activities (
                    user_id,
                    activity_type,
                    media_id,
                    tmdb_id,
                    media_type,
                    title,
                    year,
                    rating_value,
                    activity_time
                ) VALUES (
                    ${userId ?? 'Unknown'},
                    'rating',
                    ${mediaId},
                    ${primaryExtId},
                    ${mediaInfo.media_type ?? 'movie'},
                    ${mediaInfo.title ?? 'Unknown Title'},
                    ${mediaInfo.year ?? null},
                    ${mediaInfo.rating},
                    NOW()
                )
            `;
            logger.debug('Rating event tracked', {
                userId,
                title: mediaInfo.title,
                rating: mediaInfo.rating,
                mediaId,
                primaryExtId,
            });
        } catch (error) {
            logger.error('Failed to track rating event', error as Error, {
                userId,
            });
        }
    }

    /**
     * Get recent activity feed for all users (admin view)
     *
     * Queries watch_history for viewing activities and watchlist_activities for watchlist events.
     * Deduplicates spam from paused sessions by grouping within time buckets.
     *
     * Note: For efficiency, we fetch (offset + limit) rows from each source, merge,
     * and then apply the final offset/limit. This prevents loading all 30 days of data.
     */
    async getRecentActivity(
        limit = 50,
        offset = 0,
        filters: ActivityFeedFilters = {},
    ): Promise<ActivityFeedItem[]> {
        // Throws instead of answering [] so the endpoint can tell an outage
        // from an empty feed ("No activity recorded yet" during a DB outage).
        if (!this.isAvailable()) throw new ActivityFeedUnavailableError();

        // Fetch enough rows from each source to cover the requested page
        // We need offset + limit from each to ensure we have enough after sorting
        const fetchLimit = offset + limit;
        const provider = getPrimaryExternalIdProvider();
        const activityType = filters.activityType ?? null;
        const userId = filters.userId ?? null;
        const search = filters.search?.trim() ?? '';
        // The admin's % and _ are literal text, not wildcards.
        const searchPattern = `%${escapeLikePattern(search)}%`;
        const days = Math.min(Math.max(filters.days ?? 30, 1), 3650);

        try {
            // Query viewing activities from watch_history
            // Uses scalar subqueries to fetch external IDs via media_id (UUID FK to media_items)
            // without row multiplication. The idx_external_ids_media_provider covering index
            // optimizes the scalar subqueries.
            const viewingActivities = await this.sql!`
				WITH ranked_activities AS (
					SELECT
						vs.id,
						vs.user_id,
						CASE
							WHEN vs.status = 'completed' THEN 'finished'
							WHEN vs.status = 'abandoned' THEN 'abandoned'
							ELSE 'started'
						END as activity_type,
						vs.media_id,
						vs.media_type,
						NULL::numeric as rating_value,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = ${provider} LIMIT 1) as primary_ext_id,
						-- Fetch additional external IDs via scalar subqueries (no row multiplication)
						-- Uses idx_external_ids_media_provider covering index for efficient lookups
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
						vs.title,
						vs.year,
						vs.series_name,
						vs.season_number,
						vs.episode_number,
						vs.completion_percentage,
						vs.actual_watch_time_seconds as watch_time_seconds,
						COALESCE(ps.source, vs.source_service) as source_service,
						NULL::jsonb as metadata,
						vs.bitrate_bps as bitrate,
						ps.device_id,
						COALESCE(
							ud_ref.custom_name,
							ud_ref.reported_name,
							ud_session.custom_name,
							ud_session.reported_name,
							vs.device_name
						) as device_name,
						ps.user_agent,
						COALESCE(vs.client_name, ps.client_name) as client_name,
						ps.client_version,
						ps.ip_address::text as ip_address,
						ps.play_method,
						ps.transcode_mode,
						vs.resolution_width,
						ps.resolution,
						vs.video_codec as codec,
						ps.audio_codec,
						ps.container,
						ps.stop_reason,
						vs.source_play_session_id,
						ps.source_session_id,
						ps.plan_mode,
						ps.plan_reasons,
						ps.subtitle_method,
						ps.transcode_codec,
						ps.delivery_path,
						vs.total_runtime_seconds as total_duration_seconds,
						vs.max_position_seconds as current_position_seconds,
						vs.completion_percentage as current_progress_percentage,
						FALSE as is_paused,
						(vs.session_end_time IS NULL) as is_active,
						vs.session_end_time as last_update_time,
						vs.session_start_time as activity_time,
						vs.created_at,
						ROW_NUMBER() OVER (
							PARTITION BY
								vs.user_id,
								vs.title,
								COALESCE(vs.series_name, ''),
								COALESCE(vs.season_number, 0),
								COALESCE(vs.episode_number, 0),
								CASE WHEN vs.status = 'completed' THEN 'finished' WHEN vs.status = 'abandoned' THEN 'abandoned' ELSE 'started' END,
								(EXTRACT(EPOCH FROM vs.session_start_time) / 86400)::bigint,
								(COALESCE(vs.completion_percentage, 0) / 2)::int
							ORDER BY vs.session_start_time DESC
						) as rn,
						COUNT(*) OVER (
							PARTITION BY
								vs.user_id,
								vs.title,
								COALESCE(vs.series_name, ''),
								COALESCE(vs.season_number, 0),
								COALESCE(vs.episode_number, 0),
								CASE WHEN vs.status = 'completed' THEN 'finished' WHEN vs.status = 'abandoned' THEN 'abandoned' ELSE 'started' END,
								(EXTRACT(EPOCH FROM vs.session_start_time) / 86400)::bigint,
								(COALESCE(vs.completion_percentage, 0) / 2)::int
						) as occurrence_count
					FROM watch_history vs
					LEFT JOIN play_sessions ps ON ps.id = vs.source_play_session_id
					LEFT JOIN user_devices ud_ref ON ud_ref.id = vs.user_device_id
					LEFT JOIN user_devices ud_session
					  ON ud_session.user_id = vs.user_id
					 AND ud_session.device_id = ps.device_id
					LEFT JOIN users u ON u.id = vs.user_id
					WHERE vs.session_start_time > NOW() - (${days} * INTERVAL '1 day')
					  AND (${userId}::uuid IS NULL OR vs.user_id = ${userId}::uuid)
					  AND (
						${activityType}::text IS NULL OR
						CASE
							WHEN vs.status = 'completed' THEN 'finished'
							WHEN vs.status = 'abandoned' THEN 'abandoned'
							ELSE 'started'
						END = ${activityType}::text
					  )
					  AND (
						${search} = '' OR
						vs.title ILIKE ${searchPattern} OR
						COALESCE(vs.series_name, '') ILIKE ${searchPattern} OR
						COALESCE(u.username, '') ILIKE ${searchPattern} OR
						COALESCE(
							ud_ref.custom_name,
							ud_ref.reported_name,
							ud_session.custom_name,
							ud_session.reported_name,
							vs.device_name,
							''
						) ILIKE ${searchPattern} OR
						COALESCE(vs.client_name, ps.client_name, '') ILIKE ${searchPattern}
					  )
				)
				SELECT * FROM ranked_activities
				WHERE rn = 1
				ORDER BY activity_time DESC
				LIMIT ${fetchLimit}
			`;

            // Query watchlist activities with provider-agnostic external IDs
            // Uses scalar subqueries to fetch all external IDs via media_id when available
            const watchlistActivities = await this.sql!`
				SELECT
					wa.id,
					wa.user_id,
					CASE wa.activity_type
						WHEN 'add' THEN 'watchlist_add'
						WHEN 'remove' THEN 'watchlist_remove'
						WHEN 'rating' THEN 'rating'
					END as activity_type,
					wa.media_id,
					wa.media_type,
					wa.rating_value,
					-- Use COALESCE: prefer external_ids lookup, fall back to stored tmdb_id
					COALESCE(
						(SELECT external_id FROM external_ids
						 WHERE media_id = wa.media_id AND provider = ${provider} LIMIT 1),
						wa.tmdb_id::text
					) as primary_ext_id,
					-- Fetch additional external IDs via scalar subqueries
					(SELECT external_id FROM external_ids
					 WHERE media_id = wa.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
					(SELECT external_id FROM external_ids
					 WHERE media_id = wa.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
					wa.title,
					wa.year,
					wa.series_name,
					NULL as season_number,
					NULL as episode_number,
					NULL as completion_percentage,
					NULL as watch_time_seconds,
					NULL as source_service,
					NULL::jsonb as metadata,
					NULL as bitrate,
					NULL as device_id,
					NULL as device_name,
					NULL as user_agent,
					NULL as client_name,
					NULL as client_version,
					NULL as ip_address,
					NULL as play_method,
					NULL as transcode_mode,
					NULL as resolution_width,
					NULL as resolution,
					NULL as codec,
					NULL as audio_codec,
					NULL as container,
					NULL as stop_reason,
					NULL as source_play_session_id,
					NULL as source_session_id,
					NULL as plan_mode,
					NULL as plan_reasons,
					NULL as subtitle_method,
					NULL as transcode_codec,
					NULL as delivery_path,
					NULL as total_duration_seconds,
					NULL as current_position_seconds,
					NULL as current_progress_percentage,
					FALSE as is_paused,
					FALSE as is_active,
					NULL as last_update_time,
					wa.activity_time,
					wa.created_at,
					1 as occurrence_count
				FROM watchlist_activities wa
				LEFT JOIN users u ON u.id = wa.user_id
				WHERE wa.activity_time > NOW() - (${days} * INTERVAL '1 day')
				  AND (${userId}::uuid IS NULL OR wa.user_id = ${userId}::uuid)
				  AND (
					${activityType}::text IS NULL OR
					CASE wa.activity_type
						WHEN 'add' THEN 'watchlist_add'
						WHEN 'remove' THEN 'watchlist_remove'
						WHEN 'rating' THEN 'rating'
					END = ${activityType}::text
				  )
				  AND (
					${search} = '' OR
					wa.title ILIKE ${searchPattern} OR
					COALESCE(wa.series_name, '') ILIKE ${searchPattern} OR
					COALESCE(u.username, '') ILIKE ${searchPattern}
				  )
				ORDER BY wa.activity_time DESC
				LIMIT ${fetchLimit}
			`;

            // Merge and sort by activity_time DESC
            const allActivities = [
                ...viewingActivities,
                ...watchlistActivities,
            ] as ActivityFeedItem[];
            allActivities.sort(
                (a, b) => new Date(b.activity_time).getTime() - new Date(a.activity_time).getTime(),
            );

            // Apply limit and offset
            return this.attachDisplayNames(allActivities.slice(offset, offset + limit));
        } catch (error) {
            logger.error('Failed to get recent activity', error as Error, {
                limit,
                offset,
                filters,
            });
            throw error;
        }
    }

    /**
     * Get activity feed for a specific user
     */
    async getUserActivity(userId: string, limit = 50): Promise<ActivityFeedItem[]> {
        if (!this.isAvailable()) return [];

        try {
            const provider = getPrimaryExternalIdProvider();
            // Query viewing activities from watch_history with external IDs
            const viewingActivities = await this.sql!`
				SELECT
					vs.id,
					vs.user_id,
					CASE
						WHEN vs.status = 'completed' THEN 'finished'
						WHEN vs.status = 'abandoned' THEN 'abandoned'
						ELSE 'started'
					END as activity_type,
					vs.media_id,
					vs.media_type,
					NULL::numeric as rating_value,
					(SELECT external_id FROM external_ids
					 WHERE media_id = vs.media_id AND provider = ${provider} LIMIT 1) as primary_ext_id,
					-- Fetch additional external IDs via scalar subqueries
					(SELECT external_id FROM external_ids
					 WHERE media_id = vs.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
					(SELECT external_id FROM external_ids
					 WHERE media_id = vs.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
					vs.title,
					vs.year,
					vs.series_name,
					vs.season_number,
					vs.episode_number,
					vs.completion_percentage,
					vs.actual_watch_time_seconds as watch_time_seconds,
					vs.source_service,
					NULL::jsonb as metadata,
					vs.bitrate_bps as bitrate,
					vs.device_name,
					vs.resolution_width,
					vs.video_codec as codec,
					vs.total_runtime_seconds as total_duration_seconds,
					vs.max_position_seconds as current_position_seconds,
					vs.completion_percentage as current_progress_percentage,
					FALSE as is_paused,
					(vs.session_end_time IS NULL) as is_active,
					vs.session_end_time as last_update_time,
					vs.session_start_time as activity_time,
					vs.created_at
				FROM watch_history vs
				WHERE vs.user_id = ${userId}
				ORDER BY vs.session_start_time DESC
				LIMIT ${limit}
			`;

            // Query watchlist activities with external IDs
            const watchlistActivities = await this.sql!`
				SELECT
					wa.id,
					wa.user_id,
					CASE wa.activity_type
						WHEN 'add' THEN 'watchlist_add'
						WHEN 'remove' THEN 'watchlist_remove'
						WHEN 'rating' THEN 'rating'
					END as activity_type,
					wa.media_id,
					wa.media_type,
					wa.rating_value,
					COALESCE(
						(SELECT external_id FROM external_ids
						 WHERE media_id = wa.media_id AND provider = ${provider} LIMIT 1),
						wa.tmdb_id::text
					) as primary_ext_id,
					(SELECT external_id FROM external_ids
					 WHERE media_id = wa.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
					(SELECT external_id FROM external_ids
					 WHERE media_id = wa.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
					wa.title,
					wa.year,
					wa.series_name,
					NULL as season_number,
					NULL as episode_number,
					NULL as completion_percentage,
					NULL as watch_time_seconds,
					NULL as source_service,
					NULL::jsonb as metadata,
					NULL as bitrate,
					NULL as device_name,
					NULL as resolution_width,
					NULL as codec,
					NULL as total_duration_seconds,
					NULL as current_position_seconds,
					NULL as current_progress_percentage,
					FALSE as is_paused,
					FALSE as is_active,
					NULL as last_update_time,
					wa.activity_time,
					wa.created_at
				FROM watchlist_activities wa
				WHERE wa.user_id = ${userId}
				ORDER BY wa.activity_time DESC
				LIMIT ${limit}
			`;

            // Merge and sort by activity_time DESC
            const allActivities = [
                ...viewingActivities,
                ...watchlistActivities,
            ] as ActivityFeedItem[];
            allActivities.sort(
                (a, b) => new Date(b.activity_time).getTime() - new Date(a.activity_time).getTime(),
            );

            // Apply limit
            return this.attachDisplayNames(allActivities.slice(0, limit));
        } catch (error) {
            logger.error('Failed to get user activity', error as Error, {
                userId,
                limit,
            });
            return [];
        }
    }

    /**
     * Get activity feed filtered by type
     */
    async getActivityByType(
        activityType: 'started' | 'finished' | 'abandoned' | 'watchlist_add' | 'watchlist_remove',
        limit = 50,
    ): Promise<ActivityFeedItem[]> {
        if (!this.isAvailable()) return [];

        try {
            const provider = getPrimaryExternalIdProvider();
            if (activityType === 'watchlist_add' || activityType === 'watchlist_remove') {
                // Query watchlist_activities with external IDs
                const dbActivityType = activityType === 'watchlist_add' ? 'add' : 'remove';
                return (await this.sql!`
					SELECT
						wa.id,
						wa.user_id,
						${activityType} as activity_type,
						wa.media_id,
						wa.media_type,
						wa.rating_value,
						COALESCE(
							(SELECT external_id FROM external_ids
							 WHERE media_id = wa.media_id AND provider = ${provider} LIMIT 1),
							wa.tmdb_id::text
						) as primary_ext_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = wa.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = wa.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
						wa.title,
						wa.year,
						wa.series_name,
						NULL as season_number,
						NULL as episode_number,
						NULL as completion_percentage,
						NULL as watch_time_seconds,
						NULL as source_service,
						NULL::jsonb as metadata,
						NULL as bitrate,
						NULL as device_name,
						NULL as resolution_width,
						NULL as codec,
						NULL as total_duration_seconds,
						NULL as current_position_seconds,
						NULL as current_progress_percentage,
						FALSE as is_paused,
						FALSE as is_active,
						NULL as last_update_time,
						wa.activity_time,
						wa.created_at
					FROM watchlist_activities wa
					WHERE wa.activity_type = ${dbActivityType}
					ORDER BY wa.activity_time DESC
					LIMIT ${limit}
				`) as ActivityFeedItem[];
            } else if (activityType === 'finished') {
                // Query completed watch_history with external IDs
                return (await this.sql!`
					SELECT
						vs.id,
						vs.user_id,
						'finished' as activity_type,
						vs.media_id,
						vs.media_type,
						NULL::numeric as rating_value,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = ${provider} LIMIT 1) as primary_ext_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
						vs.title,
						vs.year,
						vs.series_name,
						vs.season_number,
						vs.episode_number,
						vs.completion_percentage,
						vs.actual_watch_time_seconds as watch_time_seconds,
						vs.source_service,
						NULL::jsonb as metadata,
						vs.bitrate_bps as bitrate,
						vs.device_name,
						vs.resolution_width,
						vs.video_codec as codec,
						vs.total_runtime_seconds as total_duration_seconds,
						vs.max_position_seconds as current_position_seconds,
						vs.completion_percentage as current_progress_percentage,
						FALSE as is_paused,
						(vs.session_end_time IS NULL) as is_active,
						vs.session_end_time as last_update_time,
						vs.session_start_time as activity_time,
						vs.created_at
					FROM watch_history vs
					WHERE vs.status = 'completed'
					ORDER BY vs.session_start_time DESC
					LIMIT ${limit}
				`) as ActivityFeedItem[];
            } else if (activityType === 'abandoned') {
                // Query abandoned watch_history with external IDs
                return (await this.sql!`
					SELECT
						vs.id,
						vs.user_id,
						'abandoned' as activity_type,
						vs.media_id,
						vs.media_type,
						NULL::numeric as rating_value,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = ${provider} LIMIT 1) as primary_ext_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
						vs.title,
						vs.year,
						vs.series_name,
						vs.season_number,
						vs.episode_number,
						vs.completion_percentage,
						vs.actual_watch_time_seconds as watch_time_seconds,
						vs.source_service,
						NULL::jsonb as metadata,
						vs.bitrate_bps as bitrate,
						vs.device_name,
						vs.resolution_width,
						vs.video_codec as codec,
						vs.total_runtime_seconds as total_duration_seconds,
						vs.max_position_seconds as current_position_seconds,
						vs.completion_percentage as current_progress_percentage,
						FALSE as is_paused,
						(vs.session_end_time IS NULL) as is_active,
						vs.session_end_time as last_update_time,
						vs.session_start_time as activity_time,
						vs.created_at
					FROM watch_history vs
					WHERE vs.status = 'abandoned'
					ORDER BY vs.session_start_time DESC
					LIMIT ${limit}
				`) as ActivityFeedItem[];
            } else {
                // 'started' - active/paused sessions that aren't completed
                return (await this.sql!`
					SELECT
						vs.id,
						vs.user_id,
						'started' as activity_type,
						vs.media_id,
						vs.media_type,
						NULL::numeric as rating_value,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = ${provider} LIMIT 1) as primary_ext_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'imdb' LIMIT 1) as imdb_id,
						(SELECT external_id FROM external_ids
						 WHERE media_id = vs.media_id AND provider = 'tvdb' LIMIT 1) as tvdb_id,
						vs.title,
						vs.year,
						vs.series_name,
						vs.season_number,
						vs.episode_number,
						vs.completion_percentage,
						vs.actual_watch_time_seconds as watch_time_seconds,
						vs.source_service,
						NULL::jsonb as metadata,
						vs.bitrate_bps as bitrate,
						vs.device_name,
						vs.resolution_width,
						vs.video_codec as codec,
						vs.total_runtime_seconds as total_duration_seconds,
						vs.max_position_seconds as current_position_seconds,
						vs.completion_percentage as current_progress_percentage,
						FALSE as is_paused,
						(vs.session_end_time IS NULL) as is_active,
						vs.session_end_time as last_update_time,
						vs.session_start_time as activity_time,
						vs.created_at
					FROM watch_history vs
					WHERE vs.status IN ('active', 'paused')
					ORDER BY vs.session_start_time DESC
					LIMIT ${limit}
				`) as ActivityFeedItem[];
            }
        } catch (error) {
            logger.error('Failed to get activity by type', error as Error, {
                activityType,
                limit,
            });
            return [];
        }
    }

    /**
     * Resolve public display names in one batch. Missing names stay null.
     */
    private async attachDisplayNames(activities: ActivityFeedItem[]): Promise<ActivityFeedItem[]> {
        if (!this.sql || activities.length === 0) return activities;
        const ids = [...new Set(activities.map((a) => a.user_id).filter(Boolean))];
        if (ids.length === 0) return activities;
        try {
            const rows = await this.sql<{ id: string; display_name: string | null }[]>`
                SELECT id, display_name FROM users WHERE id = ANY(${ids}::uuid[])
            `;
            const byId = new Map(rows.map((r) => [r.id, r.display_name]));
            for (const a of activities) {
                a.display_name = byId.get(a.user_id) ?? null;
            }
        } catch {
            // Non-fatal: the public author retains a null display name.
        }
        return activities;
    }

    /**
     * Format activity message for display
     */
    formatActivityMessage(activity: ActivityFeedItem): string {
        const user = activity.display_name ?? '';
        const displayTitle = this.getDisplayTitle(activity);

        switch (activity.activity_type) {
            case 'started':
                return `${user} started watching ${displayTitle}`;

            case 'finished': {
                const minutes = activity.watch_time_seconds
                    ? Math.round(activity.watch_time_seconds / 60)
                    : null;
                return minutes
                    ? `${user} finished ${displayTitle} (${minutes} min)`
                    : `${user} finished ${displayTitle}`;
            }

            case 'abandoned': {
                const percent = activity.completion_percentage
                    ? Math.round(activity.completion_percentage)
                    : null;
                return percent
                    ? `${user} stopped watching ${displayTitle} (${percent}%)`
                    : `${user} stopped watching ${displayTitle}`;
            }

            case 'watchlist_add':
                return `${user} added ${displayTitle} to watchlist`;

            case 'watchlist_remove':
                return `${user} removed ${displayTitle} from watchlist`;

            case 'rating': {
                const ratingVal = activity.rating_value;
                return ratingVal
                    ? `${user} rated ${displayTitle} ${ratingVal}/10`
                    : `${user} rated ${displayTitle}`;
            }

            default:
                return `${user} ${activity.activity_type} ${displayTitle}`;
        }
    }

    /**
     * Get formatted display title for media
     */
    private getDisplayTitle(activity: ActivityFeedItem): string {
        if (activity.series_name && activity.season_number && activity.episode_number) {
            return `${activity.series_name} S${activity.season_number}E${activity.episode_number}`;
        }
        return activity.title;
    }

    /**
     * Get activity icon/emoji for display
     */
    getActivityIcon(activityType: string): string {
        switch (activityType) {
            case 'started':
                return '▶️';
            case 'finished':
                return '✅';
            case 'abandoned':
                return '⏸️';
            case 'watchlist_add':
                return '➕';
            case 'watchlist_remove':
                return '➖';
            case 'rating':
                return '⭐';
            default:
                return '📺';
        }
    }
}

// Singleton instance
export const activityFeedService = new ActivityFeedService();
