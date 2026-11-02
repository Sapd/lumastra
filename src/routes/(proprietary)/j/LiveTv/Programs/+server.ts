// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { readBoundedJson, isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';

// 10k+ channel ids as JSON is well under 1 MiB; 4 MiB is generous.
const MAX_PROGRAMS_BODY_BYTES = 4 * 1024 * 1024;
import { json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { serializeProgram } from '$lib/server/proprietary/jellyfin-compat/serializers/livetv';
import {
    channelInfoMap,
    filterPrograms,
    pageResult,
    programQueryFromBody,
    programQueryFromUrl,
    programWindow,
    sortPrograms,
    usableChannelIds,
    type ProgramEntry,
    type ProgramQuery,
} from '$lib/server/proprietary/jellyfin-compat/livetv-query';

import {
    parseDtoOptions,
    parseDtoOptionsFromBody,
    shapeItemsResponse,
    type DtoOptions,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:LiveTv:Programs');

async function handlePrograms(
    event: RequestEvent,
    query: ProgramQuery,
    dto: DtoOptions,
): Promise<Response> {
    const { locals } = event;

    // Gate LiveTV metadata on permission
    if (!locals.user?.hasLiveTvPermission) {
        return json({
            Items: [],
            TotalRecordCount: 0,
            StartIndex: 0,
        });
    }

    const now = new Date();
    const window = programWindow(query, now);

    try {
        const provider = await getLiveTvProvider();

        const [allChannels, programsByChannel] = await Promise.all([
            provider.getChannels(),
            provider.getGuidePrograms(window.start, window.end),
        ]);

        const channelInfo = channelInfoMap(allChannels);

        // jellyfin-androidtv's TvManager.fillChannelIds() allocates channelIds[] and
        // then returns early when the device has no last-played Live TV channel, so
        // the array stays full of nulls and the guide asks for
        // `channelIds=null&channelIds=null&...`. Taking that literally filters every
        // program out and the EPG renders empty until the user happens to play a
        // channel. Drop placeholder tokens, and when nothing usable is left fall back
        // to an unfiltered guide — the client keys its own dictionary by ChannelId.
        const usable = usableChannelIds(query.channelIdSources);
        if (query.channelIdSources.length > 0 && usable.length === 0) {
            logger.warn(
                `LiveTv/Programs: client sent ${query.channelIdSources.length} placeholder ChannelIds — serving unfiltered guide`,
            );
        }
        const requestedChannelIds = usable.length > 0 ? new Set(usable) : null;

        const entries: ProgramEntry[] = [];

        // When a client constrains by ChannelIds (every guide query does), iterate
        // only those — programsByChannel may hold 1.3k channels' worth of data.
        const collectFor = (channelId: string): void => {
            const channelPrograms = programsByChannel[channelId];
            if (!channelPrograms) return;
            const info = channelInfo.get(channelId);
            const channelName = info?.name ?? '';
            const hasLogo = info?.hasLogo ?? false;
            const category = info?.category;
            for (const program of channelPrograms) {
                entries.push({ program, channelName, hasLogo, category });
            }
        };
        if (requestedChannelIds) {
            for (const channelId of requestedChannelIds) collectFor(channelId);
        } else {
            for (const channelId of Object.keys(programsByChannel)) {
                collectFor(channelId);
            }
        }

        const programs = sortPrograms(filterPrograms(entries, query, now), query);
        const { page, total } = pageResult(
            programs,
            query.startIndex,
            query.limit,
            query.enableTotalRecordCount,
        );

        logger.debug(`LiveTv/Programs: returning ${page.length} of ${total}`);

        return json(
            shapeItemsResponse(
                {
                    Items: page.map(({ program, channelName, hasLogo, category }) =>
                        serializeProgram(program, channelName, undefined, hasLogo, category),
                    ),
                    TotalRecordCount: total,
                    StartIndex: query.startIndex,
                },
                dto,
            ),
        );
    } catch (error) {
        logger.error('LiveTv/Programs failed', error as Error);
        return ApiResponses.error('Failed to fetch live TV programs');
    }
}

export const GET: RequestHandler = withJellyfinAuth(async (event) =>
    handlePrograms(event, programQueryFromUrl(event.url), parseDtoOptions(event.url)),
);

// Large ChannelIds lists (e.g. Moonfin above ~1800 joined chars) arrive as a POST
// with a JSON body instead of a query string — see programQueryFromBody(). This
// doesn't mutate anything (still just a guide fetch), but withJellyfinAuth's
// read/write gate keys off HTTP method, so a POST export must declare mode: 'write'
// or every request gets rejected before the handler runs — see the option's doc comment.
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        let body: unknown;
        try {
            body = await readBoundedJson(event.request, MAX_PROGRAMS_BODY_BYTES);
        } catch (err) {
            // A truncated ChannelIds list would silently turn into "all channels".
            if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
            body = {};
        }
        return handlePrograms(event, programQueryFromBody(body), parseDtoOptionsFromBody(body));
    },
    { mode: 'write' },
);
