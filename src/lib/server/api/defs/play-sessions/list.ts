// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { sessionCarPlayContext } from '$lib/server/database/queries/play-session-client-context.queries.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { paginate, problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getAllActiveSessionsWithMedia } from '$lib/server/database/queries/play-sessions.queries.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { buildPublicAuthor } from '$lib/shared/public-author';
import {
    annotateStreamsWithParties,
    type StreamWatchParty,
} from '$lib/server/services/watch-party-stream-overlay.js';
import { PagedSessionsResponseSchema } from '$lib/schemas/api-playback-responses.js';

const logger = Logger.for('PlaybackSessionList');

/** Hard cap applied by getAllActiveSessionsWithMedia (`LIMIT 1000`); the endpoint takes no limit param. */
const SESSION_LIST_MAX_PAGE_SIZE = 1000;

export const SessionsQuery = z.object({
    scope: z.enum(['mine', 'all']).default('mine'),
    itemId: z.string().uuid().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: SessionsQuery },
    docs: {
        GET: {
            tags: ['Play Sessions'],
            summary: 'List active playback sessions',
            stability: 'stable',
            auth: 'bearer',
            query: SessionsQuery,
            responses: {
                200: {
                    schema: PagedSessionsResponseSchema,
                    description: 'Playback sessions as { items, page }',
                },
                401: 'Authentication required',
                403: 'scope=all requires admin',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const scope = ctx.input!.query.scope;
            const userId = event.locals.user?.userId;
            if (!userId) return problem('unauthorized', { error: 'Authentication required' });
            if (scope === 'all' && event.locals.principal?.isAdmin !== true) {
                return problem('forbidden', { error: 'scope=all requires admin privileges' });
            }
            const sql = getDb();
            if (!sql) return problem('dependency_unavailable', { error: 'Database unavailable' });
            const rows = await getAllActiveSessionsWithMedia(sql, {
                userId: scope === 'mine' ? userId : undefined,
                itemId: ctx.input!.query.itemId,
            });
            const partyRows = rows.map((row) => ({
                row,
                id: row.media_id,
                mediaItemId: row.media_id,
                userId: row.user_id,
            }));
            let annotated: ((typeof partyRows)[number] & { watchParty?: StreamWatchParty })[] =
                partyRows;
            if (features.watchTogether && partyRows.length > 0) {
                try {
                    const [{ getPartyStreamSnapshots }, { isWidgetDisabled }] = await Promise.all([
                        import('$lib/server/services/watch-together.service.js'),
                        import('$lib/server/utils/widget-guard.js'),
                    ]);
                    annotated = annotateStreamsWithParties(
                        partyRows,
                        await getPartyStreamSnapshots(),
                        {
                            userId,
                            // Listing all sessions does not grant access to private parties.
                            isAdmin: false,
                            publicListingEnabled: !isWidgetDisabled('watch-parties'),
                        },
                    );
                } catch (error) {
                    logger.debug('Playback-session watch-party overlay failed; serving ungrouped', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            const avatars = await userImageSets(
                sql,
                ctx.surface,
                [
                    ...rows.map((row) => row.user_id),
                    ...annotated.flatMap((a) => (a.watchParty ? [a.watchParty.host.userId] : [])),
                ],
                { external: false },
            );
            const items = annotated.map(({ row, watchParty }) => {
                const isEpisode = row.media_type === 'episode';
                const deviceName = row.device_name || row.client_name || null;
                return {
                    playbackSessionId: row.id,
                    mediaId: row.media_id,
                    kind:
                        row.media_type === 'audiobook'
                            ? 'audiobook'
                            : ['track', 'audio', 'music', 'radio'].includes(row.media_type ?? '')
                              ? 'music'
                              : row.media_type === 'tvchannel'
                                ? 'live'
                                : 'video',
                    status: row.status,
                    positionMs: Math.max(0, Number(row.position_ms)),
                    durationMs: row.runtime_ms == null ? null : Math.max(0, Number(row.runtime_ms)),
                    title: row.media_title,
                    seriesTitle: isEpisode ? (row.series_title ?? null) : null,
                    seasonNumber: isEpisode ? (row.season_number ?? null) : null,
                    episodeNumber: isEpisode ? (row.episode_number ?? null) : null,
                    mediaType: row.media_type === 'tv' ? 'series' : row.media_type,
                    device: { id: row.device_id, name: deviceName, client: row.client_name },
                    isCarPlay: sessionCarPlayContext(row.external_payload),
                    clientName: row.client_name ?? null,
                    clientVersion: row.client_version ?? null,
                    userAgent: row.user_agent ?? null,
                    user: buildPublicAuthor(
                        row.user_id,
                        row.owner_display_name,
                        ctx.surface,
                        avatars.get(row.user_id),
                    ),
                    ...(watchParty
                        ? {
                              watchParty: {
                                  ...watchParty,
                                  host: buildPublicAuthor(
                                      watchParty.host.userId,
                                      watchParty.host.displayName,
                                      ctx.surface,
                                      avatars.get(watchParty.host.userId),
                                  ),
                              },
                          }
                        : {}),
                };
            });
            return json(
                paginate(items, {
                    limit: SESSION_LIST_MAX_PAGE_SIZE,
                    offset: 0,
                    // At the cap the server truncated the list.
                    hasMore: rows.length >= SESSION_LIST_MAX_PAGE_SIZE,
                }),
                {
                    headers: { 'Cache-Control': 'no-store' },
                },
            );
        },
    },
});
