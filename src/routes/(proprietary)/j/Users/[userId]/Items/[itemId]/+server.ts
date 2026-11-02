// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serializeBaseItem,
    mapRowToMediaItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { applyFolderUserData } from '$lib/server/proprietary/jellyfin-compat/folder-user-data';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from '$lib/server/proprietary/jellyfin-compat/music-artists-enrichment';
import { enrichItemsWithRelatedMediaCounts } from '$lib/server/proprietary/jellyfin-compat/related-media';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import {
    ALL_CREDIT_FIELDS,
    enrichItemsWithCredits,
} from '$lib/server/proprietary/jellyfin-compat/people-studios';
import { resolveNameItem } from '$lib/server/proprietary/jellyfin-compat/people-studios-handlers';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder';
import { lastPlayedAtExpression } from '$lib/server/database/queries/builders/last-played.builder';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveEffectiveResume } from '$lib/server/services/effective-playback.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access';
import { serializeChannel } from '$lib/server/proprietary/jellyfin-compat/serializers/livetv';
import { getFavoriteChannelIds } from '$lib/server/database/queries/livetv-channels.queries';

const logger = Logger.for('JellyfinCompat:UserItemDetail');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }

    try {
        if (!(await checkMediaAccess(sql, itemId, locals.user))) {
            // A cast member or studio id (see /Items/{itemId}).
            const nameItem = await resolveNameItem(sql, itemId, locals.user);
            return nameItem ? json(nameItem) : ApiResponses.notFound();
        }

        const rows = await sql`
            SELECT
                mi.id,
                mi.title,
                mi.original_title,
                mi.sort_title,
                mi.media_type,
                mi.year,
                mi.created_at,
                mi.runtime_seconds,
                mi.parent_id,
                mi.season_number,
                mi.episode_number,
                mi.overview as mi_overview,
                mi.premiere_date,
                mi.sort_order,
                (pm.metadata->>'overview')::text as pm_overview,
                (pm.metadata->>'poster_path')::text as poster_path,
                (pm.metadata->>'backdrop_path')::text as backdrop_path,
                (pm.metadata->>'vote_average')::float as vote_average,
                (pm.metadata->>'content_rating')::text as content_rating,
                (pm.metadata->>'tagline')::text as tagline,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT (g->>'name')::text FROM jsonb_array_elements(pm.metadata->'genres') AS g WHERE g->>'name' IS NOT NULL)
                    ELSE NULL
                END as genre_names,
                ws.resume_position_ms,
                CASE WHEN ws.runtime_ms > 0 AND ws.resume_position_ms > 0
                    THEN (ws.resume_position_ms::float / ws.runtime_ms * 100)
                    ELSE 0
                END as played_percentage,
                COALESCE(ws.is_watched, false) as is_watched,
                ${lastPlayedAtExpression(sql, 'ws')} as last_played_at,
                parent_series.id as series_id,
                parent_series.title as series_name,
                parent_season.id as season_id,
                parent_season.title as season_name,
                (SELECT COUNT(*)::int FROM media_items children
                 WHERE children.parent_id = mi.id AND children.status = 'active'
                ) as child_count
            FROM media_items mi
            ${buildMetadataLateralJoinFragment(sql)}
            LEFT JOIN user_media_state ws ON ws.media_id = mi.id AND ws.user_id = ${locals.user.userId}
            LEFT JOIN media_items parent_season ON parent_season.id = mi.parent_id AND mi.media_type = 'episode'
            LEFT JOIN media_items parent_series ON (
                (mi.media_type = 'episode' AND parent_series.id = parent_season.parent_id)
                OR (mi.media_type = 'season' AND parent_series.id = mi.parent_id)
            )
            WHERE mi.id = ${itemId}::uuid
              AND mi.status = 'active'
        `;

        if (rows.length === 0) {
            const nameItem = await resolveNameItem(sql, itemId, locals.user);
            return nameItem ? json(nameItem) : ApiResponses.notFound('Item not found');
        }

        if (rows[0].media_type === 'tvchannel') {
            // Same as /j/Items/{id}: Live TV permission and the lineup gate.
            if (
                !locals.user.hasLiveTvPermission ||
                !(await canStreamLiveTvChannel(locals, itemId))
            ) {
                return ApiResponses.notFound('Item not found');
            }
            const provider = await getLiveTvProvider();
            const [channel, favoriteChannelIds] = await Promise.all([
                provider.getChannel(itemId),
                getFavoriteChannelIds(sql, locals.user.userId),
            ]);
            if (channel) {
                channel.currentProgram = await provider.getCurrentProgram(itemId);
                return json(
                    serializeChannel(channel, undefined, favoriteChannelIds.includes(itemId)),
                );
            }
        }

        const item = mapRowToMediaItem(rows[0]);

        const resume = await resolveEffectiveResume(locals.user.userId, item.id);
        if (resume.source !== 'none') {
            // Recompute played_percentage from the same effective position so
            // PlaybackPositionTicks and PlayedPercentage in the serialized
            // UserData don't disagree (e.g. live session at 30min vs durable
            // at 10min would otherwise emit ticks-from-live + percentage-from-
            // durable, a contradictory pair for Jellyfin clients). When
            // runtime is unknown (0/null), zero BOTH signals — emitting a
            // non-zero position with 0 percentage is the same contradiction
            // class for clients that read either field.
            const runtimeMs = item.runtime_seconds ? item.runtime_seconds * 1000 : 0;
            if (runtimeMs > 0 && resume.positionMs > 0) {
                item.resume_position_ms = resume.positionMs;
                item.played_percentage = Math.min(100, (resume.positionMs / runtimeMs) * 100);
            } else {
                item.resume_position_ms = 0;
                item.played_percentage = 0;
            }
        }

        await applyJellyfinContentLanguage(sql, locals.user.userId, [item]);
        const access = await buildJellyfinAccessContext(sql, locals.user);
        await applyFolderUserData(sql, [item], locals.user.userId, access.boundary);
        const serialized = serializeBaseItem(item);
        await enrichItemsWithProviderIds(sql, [serialized]);
        await enrichItemsWithMusicArtists(sql, [serialized]);
        await enrichItemsWithRelatedMediaCounts(sql, [serialized], locals.user);
        await enrichItemsWithImages(sql, [serialized]);
        await enrichItemsWithCredits(sql, [serialized], ALL_CREDIT_FIELDS);
        return json(serialized);
    } catch (error) {
        logger.error('User item detail query failed', error as Error, {
            itemId,
        });
        return ApiResponses.error('Failed to get item detail');
    }
});
