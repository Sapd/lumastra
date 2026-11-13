// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getDb } from '$lib/server/database';
import { getProgramById } from '$lib/server/database/queries/livetv-programs.queries';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { getParam, hasLiveTvPermission } from '$lib/server/proprietary/jellyfin-compat/utils';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';

const logger = Logger.for('JellyfinCompat:LiveTv:TimerDefaults');

/** .NET's default(Guid) / default(DateTime), which Jellyfin emits for unset values. */
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const MIN_DATE = '0001-01-01T00:00:00.0000000Z';

/**
 * GET /LiveTv/Timers/Defaults[?programId=] → SeriesTimerInfoDto.
 *
 * Lumastra has no DVR, but this DTO has no empty form: every SDK-required
 * field must be present. These are the values Jellyfin's built-in service
 * hands out (no padding, record any time, new episodes only, every day), and
 * with a known programId the program's channel, name and times, as Jellyfin
 * fills them. No timer can be created from it: POST /LiveTv/Timers is not served.
 */
export const GET: RequestHandler = withJellyfinAuth(async ({ url, locals }) => {
    if (!hasLiveTvPermission(locals.user)) {
        return ApiResponses.notFound();
    }

    const defaults: Record<string, unknown> = {
        Type: 'SeriesTimer',
        ServerId: JELLYFIN_SERVER_ID,
        ChannelId: EMPTY_GUID,
        StartDate: MIN_DATE,
        EndDate: MIN_DATE,
        Priority: 0,
        PrePaddingSeconds: 0,
        PostPaddingSeconds: 0,
        IsPrePaddingRequired: false,
        IsPostPaddingRequired: false,
        KeepUntil: 'UntilDeleted',
        RecordAnyTime: true,
        SkipEpisodesInLibrary: false,
        RecordAnyChannel: false,
        KeepUpTo: 0,
        RecordNewOnly: true,
        Days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        DayPattern: 'Daily',
        ImageTags: {},
    };

    const programId = getParam(url, 'ProgramId');
    if (!programId || !isUuid(programId)) return json(defaults);

    try {
        const sql = getDb();
        const row = sql ? await getProgramById(sql, programId) : null;
        if (!row) return json(defaults);
        const provider = await getLiveTvProvider();
        // Only programs the guide shows (visible channels) fill the defaults.
        const channel = (await provider.getChannels()).find((c) => c.id === row.channel_id);
        if (!channel) return json(defaults);
        return json({
            ...defaults,
            ChannelId: channel.id,
            ChannelName: channel.name,
            ProgramId: row.id,
            Name: row.title,
            Overview: row.description ?? undefined,
            StartDate: row.start_time.toISOString(),
            EndDate: row.end_time.toISOString(),
        });
    } catch (error) {
        logger.error('LiveTv/Timers/Defaults GET failed', error as Error);
        return ApiResponses.error('Failed to fetch timer defaults');
    }
});
