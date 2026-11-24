// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getDb } from '$lib/server/database';
import { getProgramById } from '$lib/server/database/queries/livetv-programs.queries';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { hasLiveTvPermission } from '$lib/server/jellyfin-compat/utils';
import { serializeProgram } from '$lib/server/jellyfin-compat/serializers/livetv';
import {
    channelOfSyntheticProgram,
    syntheticLiveProgram,
} from '$lib/server/jellyfin-compat/livetv-query';

const logger = Logger.for('JellyfinCompat:LiveTv:Program');

/**
 * GET /LiveTv/Programs/{programId} — one EPG program as a BaseItemDto.
 *
 * 404 (never 403) for a user without Live TV permission, an unknown id, or a
 * program on a channel that is hidden: the guide never lists those, so this
 * route must not reveal them either. The synthetic per-channel "On Air" ids
 * that Recommended serves without EPG data (`{channelId}-live`) resolve too.
 */
export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { params, locals } = event;
    const programId = params.programId ?? '';

    if (!hasLiveTvPermission(locals.user)) {
        return ApiResponses.notFound('Program not found');
    }

    try {
        const provider = await getLiveTvProvider();
        if (!isUuid(programId) && !programId.endsWith('-live')) {
            return ApiResponses.notFound('Program not found');
        }

        const sql = getDb();
        const row = isUuid(programId) && sql ? await getProgramById(sql, programId) : null;
        if (!row) {
            // Not a persisted programme: it may be a per-channel "On Air" stand-in.
            const synthetic = channelOfSyntheticProgram(
                programId,
                await provider.getChannels(),
                new Date(),
            );
            if (!synthetic) return ApiResponses.notFound('Program not found');
            return json(
                serializeProgram(
                    syntheticLiveProgram(synthetic, new Date()),
                    synthetic.name,
                    true,
                    Boolean(synthetic.images.primary?.href),
                    synthetic.category,
                ),
            );
        }

        // getChannels() is the visible lineup; a program on a hidden channel 404s.
        const channel = (await provider.getChannels()).find((c) => c.id === row.channel_id);
        if (!channel) {
            return ApiResponses.notFound('Program not found');
        }

        return json(
            serializeProgram(
                {
                    id: row.id,
                    channelId: row.channel_id,
                    title: row.title,
                    description: row.description ?? undefined,
                    startTime: row.start_time.toISOString(),
                    endTime: row.end_time.toISOString(),
                    epgId: row.epg_id ?? undefined,
                    genres: row.genres ?? undefined,
                    officialRating: row.official_rating ?? undefined,
                },
                channel.name,
                undefined,
                Boolean(channel.images.primary?.href),
                channel.category,
            ),
        );
    } catch (error) {
        logger.error(`LiveTv/Programs/${programId} GET failed`, error as Error);
        return ApiResponses.error('Failed to fetch live TV program');
    }
});
