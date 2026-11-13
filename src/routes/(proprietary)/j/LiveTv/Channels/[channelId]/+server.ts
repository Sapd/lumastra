// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access';
import { serializeChannel } from '$lib/server/proprietary/jellyfin-compat/serializers/livetv';
import { numberChannelsForLineup } from '$lib/server/services/livetv/channel-numbering';
import { getDb } from '$lib/server/database';
import { getFavoriteChannelIds } from '$lib/server/database/queries/livetv-channels.queries';
import { isUuid } from '$lib/server/utils/media-key-parser';

const logger = Logger.for('JellyfinCompat:LiveTv:Channel');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { params, locals } = event;
    const { channelId } = params;

    // Gate LiveTV metadata on permission
    if (!locals.user?.hasLiveTvPermission) {
        return ApiResponses.notFound('Channel not found');
    }

    if (!channelId) {
        return ApiResponses.badRequest('Channel ID is required');
    }
    // Jellyfin binds channelId as a Guid; anything else is no channel at all
    // (and must not reach the uuid-typed query as a 500).
    if (!isUuid(channelId)) {
        return ApiResponses.notFound('Channel not found');
    }
    // The lineup gate the stream routes use: no hidden feed or hidden category.
    if (!(await canStreamLiveTvChannel(locals, channelId))) {
        return ApiResponses.notFound('Channel not found');
    }

    try {
        const provider = await getLiveTvProvider();
        const channel = await provider.getChannel(channelId);

        if (!channel) {
            return ApiResponses.notFound('Channel not found');
        }

        logger.debug(`LiveTv/Channels/${channelId}: found channel "${channel.name}"`);

        // Number must agree with the list response (the stored channel numbers).
        // getChannels() and getCategories() are the same cached lists it uses.
        const sql = getDb();
        const [allChannels, categories, favoriteChannelIds] = await Promise.all([
            provider.getChannels(),
            provider.getCategories(),
            sql ? getFavoriteChannelIds(sql, locals.user.userId) : Promise.resolve([]),
        ]);
        const numbered = numberChannelsForLineup(allChannels, categories);
        const match = numbered.find((entry) => entry.channel.id === channel.id);
        // getChannel() reads one row without the guide; the cached lineup already
        // carries what is on now, which Jellyfin's channel DTO includes.
        channel.currentProgram ??= match?.channel.currentProgram;

        return json(
            serializeChannel(channel, match?.number, favoriteChannelIds.includes(channel.id)),
        );
    } catch (error) {
        logger.error(`LiveTv/Channels/${channelId} GET failed`, error as Error);
        return ApiResponses.error('Failed to fetch live TV channel');
    }
});
