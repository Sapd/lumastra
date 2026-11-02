// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { serializeProgram } from '$lib/server/proprietary/jellyfin-compat/serializers/livetv';
import {
    channelInfoMap,
    filterPrograms,
    matchesFlagFilters,
    pageResult,
    programQueryFromUrl,
    programWindow,
    sortPrograms,
    syntheticLiveProgram,
    type ProgramEntry,
} from '$lib/server/proprietary/jellyfin-compat/livetv-query';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:LiveTv:Programs:Recommended');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * GET /LiveTv/Programs/Recommended.
 *
 * Like Jellyfin's GetRecommendedProgramsAsync: `IsAiring=true` (the "On Now"
 * rows every client shows) returns what is airing now, in channel order;
 * anything else is a plain program query (upcoming movies, sports, …) ordered
 * by start date. Both honour HasAired, the content flags, Genres and paging.
 */
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

    const query = programQueryFromUrl(url);
    const dto = parseDtoOptions(url);
    const limit = query.limitGiven ? Math.min(query.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const now = new Date();

    try {
        const provider = await getLiveTvProvider();
        const airingOnly = query.isAiring === true;
        const window = airingOnly
            ? {
                  start: new Date(now.getTime() - 60 * 1000),
                  end: new Date(now.getTime() + 60 * 1000),
              }
            : programWindow(query, now);

        const [channels, programsByChannel] = await Promise.all([
            provider.getChannels(),
            provider.getGuidePrograms(window.start, window.end),
        ]);

        const channelInfo = channelInfoMap(channels);
        const channelSortOrder = new Map(channels.map((ch) => [ch.id, ch.sortOrder]));

        const entries: ProgramEntry[] = [];
        for (const [channelId, channelPrograms] of Object.entries(programsByChannel)) {
            const info = channelInfo.get(channelId);
            for (const program of channelPrograms) {
                entries.push({
                    program,
                    channelName: info?.name ?? '',
                    hasLogo: info?.hasLogo ?? false,
                    category: info?.category,
                });
            }
        }

        let programs: ProgramEntry[];
        if (airingOnly) {
            programs = filterPrograms(entries, query, now).sort(
                (a, b) =>
                    (channelSortOrder.get(a.program.channelId) ?? 0) -
                    (channelSortOrder.get(b.program.channelId) ?? 0),
            );

            // When no EPG data is available, synthesize one "On Air" entry per channel
            // so the Android TV LiveTV buttons row stays visible (it's hidden when this
            // row is empty due to the sibling-row wiring in HomeRowsFragment).
            const anyAiring = filterPrograms(
                entries,
                {
                    ...query,
                    isMovie: undefined,
                    isSeries: undefined,
                    isNews: undefined,
                    isKids: undefined,
                    isSports: undefined,
                    genres: [],
                },
                now,
            ).length;
            if (anyAiring === 0 && channels.length > 0) {
                const synthetic = channels
                    .filter(
                        (ch) => query.genres.length === 0 && matchesFlagFilters(ch.category, query),
                    )
                    .map((ch) => ({
                        program: syntheticLiveProgram(ch, now),
                        channelName: ch.name,
                        hasLogo: Boolean(ch.images.primary?.href),
                        category: ch.category,
                    }));
                const { page, total } = pageResult(
                    synthetic,
                    query.startIndex,
                    limit,
                    query.enableTotalRecordCount,
                );
                logger.debug(
                    `LiveTv/Programs/Recommended: no EPG — returning ${page.length} synthetic channel entries`,
                );
                return json(
                    shapeItemsResponse(
                        {
                            Items: page.map(({ program, channelName, hasLogo, category }) =>
                                serializeProgram(program, channelName, true, hasLogo, category),
                            ),
                            TotalRecordCount: total,
                            StartIndex: query.startIndex,
                        },
                        dto,
                    ),
                );
            }
        } else {
            programs = sortPrograms(filterPrograms(entries, query, now), {
                ...query,
                sortBy: [],
            });
        }

        const { page, total } = pageResult(
            programs,
            query.startIndex,
            limit,
            query.enableTotalRecordCount,
        );

        logger.debug(`LiveTv/Programs/Recommended: returning ${page.length} of ${total}`);

        return json(
            shapeItemsResponse(
                {
                    Items: page.map(({ program, channelName, hasLogo, category }) =>
                        serializeProgram(
                            program,
                            channelName,
                            airingOnly ? true : undefined,
                            hasLogo,
                            category,
                        ),
                    ),
                    TotalRecordCount: total,
                    StartIndex: query.startIndex,
                },
                dto,
            ),
        );
    } catch (error) {
        logger.error('LiveTv/Programs/Recommended GET failed', error as Error);
        return ApiResponses.error('Failed to fetch recommended programs');
    }
});
