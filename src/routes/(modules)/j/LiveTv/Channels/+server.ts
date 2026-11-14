// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '$lib/server/jellyfin-compat/utils';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { serializeChannel } from '$lib/server/jellyfin-compat/serializers/livetv';
import { numberChannelsForLineup } from '$lib/server/services/livetv/channel-numbering';
import { getDb } from '$lib/server/database';
import { getFavoriteChannelIds } from '$lib/server/database/queries/livetv-channels.queries';
import {
    flagFiltersFromQuery,
    matchesFlagFilters,
    parseBool,
} from '$lib/server/jellyfin-compat/livetv-query';

const logger = Logger.for('JellyfinCompat:LiveTv:Channels');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { url, locals } = event;

    // Gate LiveTV metadata on permission
    if (!locals.user?.hasLiveTvPermission) {
        return json({
            Items: [],
            TotalRecordCount: 0,
            StartIndex: 0,
        });
    }

    // jellyfin-androidtv's loadLiveTvChannels() sends neither Limit nor StartIndex —
    // it expects the whole channel list in one response and pages client-side out of
    // TvManager.allChannels. Defaulting to a page size truncated the guide to the
    // first 100 channels with no way for the client to ask for the rest. Return
    // everything when no Limit is given; honour an explicit Limit as sent.
    const limitParam = getParam(url, 'Limit');
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 1) : Number.MAX_SAFE_INTEGER;
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);

    try {
        const provider = await getLiveTvProvider();
        const sql = getDb();
        const [allChannels, categories, favoriteChannelIds] = await Promise.all([
            provider.getChannels(),
            provider.getCategories(),
            sql ? getFavoriteChannelIds(sql, locals.user.userId) : Promise.resolve([]),
        ]);
        const favoriteSet = new Set(favoriteChannelIds);

        // The stored channel numbers (the same ones the apps and the iPhone
        // channel pad use), in number order; that order is what the client
        // renders. Without stored numbers: category-blocked numbers.
        const numbered = numberChannelsForLineup(allChannels, categories);

        const favoriteSorting = parseBool(getParam(url, 'EnableFavoriteSorting')) === true;
        const addCurrentProgram = parseBool(getParam(url, 'AddCurrentProgram')) ?? true;

        // Jellyfin's channel filters. Every channel here is a TV channel, and
        // Lumastra keeps no "liked"/"disliked" channel state, so IsLiked=true and
        // IsDisliked=true match nothing while their false forms match everything.
        // The content flags come from the channel category, the same signal the
        // program DTOs carry (programFlagsForCategory).
        const channelType = getParam(url, 'Type')?.toLowerCase();
        const isFavorite = parseBool(getParam(url, 'IsFavorite'));
        const flagFilters = flagFiltersFromQuery(url);
        const onlyLikedOrDisliked =
            parseBool(getParam(url, 'IsLiked')) === true ||
            parseBool(getParam(url, 'IsDisliked')) === true;
        const filtered = numbered.filter(({ channel }) => {
            if (onlyLikedOrDisliked) return false;
            if (channelType && channelType !== 'tv') return false;
            if (isFavorite !== undefined && favoriteSet.has(channel.id) !== isFavorite)
                return false;
            return matchesFlagFilters(channel.category, flagFilters);
        });

        // SortBy: a Jellyfin channel's SortName IS its number, so SortName (and no
        // SortBy at all) keeps the numbered lineup; Name sorts alphabetically.
        // SortOrder=Descending reverses whichever order applies.
        const sortKeys = (getParam(url, 'SortBy') ?? '')
            .split(',')
            .map((k) => k.trim().toLowerCase());
        const descending = (getParam(url, 'SortOrder') ?? '').toLowerCase() === 'descending';
        let sorted = sortKeys.includes('name')
            ? [...filtered].sort((a, b) => a.channel.name.localeCompare(b.channel.name))
            : filtered;
        if (descending) sorted = [...sorted].reverse();

        // "Favoriten an den Anfang setzen" (jellyfin-androidtv's
        // LiveTvPreferences.favsAtTop) is a SERVER-side sort in Jellyfin: the
        // client forwards it as EnableFavoriteSorting and renders whatever order
        // the response arrives in — it never reorders the guide itself. Ignoring
        // the flag is why the toggle appeared to do nothing with favorites left
        // scattered through the lineup. Sort before the slice, or a favorite past
        // the page boundary stays invisible. Numbers stay attached to their
        // channel: only the row order changes, as on a real Jellyfin server.
        // Array#sort is stable, so each group keeps its number order.
        const ordered = favoriteSorting
            ? [...sorted].sort(
                  (a, b) =>
                      Number(favoriteSet.has(b.channel.id)) - Number(favoriteSet.has(a.channel.id)),
              )
            : sorted;

        const total = ordered.length;
        const page = ordered.slice(startIndex, startIndex + limit);

        logger.debug(`LiveTv/Channels: returning ${page.length} of ${total}`);

        return json({
            Items: page.map(({ channel, number }) => {
                const dto = serializeChannel(channel, number, favoriteSet.has(channel.id));
                if (!addCurrentProgram) delete dto.CurrentProgram;
                return dto;
            }),
            TotalRecordCount: total,
            StartIndex: startIndex,
        });
    } catch (error) {
        logger.error('LiveTv/Channels GET failed', error as Error);
        return ApiResponses.error('Failed to fetch live TV channels');
    }
});
