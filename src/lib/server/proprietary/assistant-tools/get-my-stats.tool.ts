// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_my_stats` tool — the user's rich personal viewing-statistics dashboard
 * (the /my-stats page): overview, watch-time, peak hours, completion, top
 * genres + keywords, devices, quality, ratings, taste profile, and fun records.
 *
 * Does NOT reimplement any stat query — it calls the SAME fan-out the
 * `/api/my-stats/all` endpoint uses: `personalStatsService.getAllStats()`,
 * which computes all stat types in parallel, applies the per-type minimum-data
 * gate, and shares the same cache. Only registered when personal stats are
 * enabled (`features.personalStats`); also re-checks defensively. TEXT-ONLY.
 *
 * @module server/proprietary/assistant-tools/get-my-stats.tool
 */

import {
    getMyStatsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetMyStatsArgs,
} from '../../../schemas/assistant-tools.js';
import { personalStatsService } from '../../services/personal-stats.service.js';
import { cacheManager, CACHE_NAMESPACES } from '../../cache/index.js';
import { features } from '../../config.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

/**
 * Rename the overview counters to carry their DENOMINATOR.
 *
 * Every counter here except `uniqueContent` is a `COUNT(*)` over
 * `watch_history` — sessions, not titles — while the public schema describes
 * them as "Completed content count", "Movies watched count" and so on. The
 * model believed the labels and produced, on prod:
 *
 *   "170 verschiedene Titel. 95 davon hast du abgeschlossen, 176 abgebrochen"
 *
 * 95 + 176 = 271, which cannot be "of" 170. Every number was correct; the
 * sentence was not, because nothing in the payload said the two counts measure
 * different things. Rewatching one film thirteen times is thirteen sessions and
 * one title.
 *
 * Renamed HERE rather than in OverviewStatsSchema: that schema is the public
 * `/api/my-stats/all` contract, consumed by the dashboard UI and by generated
 * Swift decoders, so renaming it would be a breaking API change to fix a
 * model-facing wording problem. The assistant payload is ours to shape.
 */
function relabelOverview(overview: unknown): unknown {
    if (!overview || typeof overview !== 'object') return overview;
    const {
        totalSessions,
        uniqueContent,
        completedCount,
        abandonedCount,
        moviesWatched,
        episodesWatched,
        ...rest
    } = overview as Record<string, unknown>;

    return {
        ...rest,
        viewingSessions: totalSessions,
        distinctTitles: uniqueContent,
        completedSessions: completedCount,
        abandonedSessions: abandonedCount,
        movieSessions: moviesWatched,
        episodeSessions: episodesWatched,
        countScopeNote:
            'Counts ending in "Sessions" are PLAYBACK SESSIONS; distinctTitles counts TITLES. They have different denominators and must never be combined in one sentence — completedSessions + abandonedSessions does NOT sum to distinctTitles, because one title can have many sessions. Say "X sessions" or "Y titles", never "Y titles, X of them finished".',
    };
}

export const getMyStatsTool: AssistantTool<GetMyStatsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_MY_STATS,
    description:
        'The user\'s personal viewing-statistics dashboard: total watch time, peak viewing hours, completion rate, top genres & keywords, devices, streaming quality, rating breakdown, taste profile, and fun records. Use for "my stats", "my viewing habits", "what genres do I watch most", "when do I watch", "my taste", "fun facts about my watching". Optionally scope to a period: 7d/30d/90d are rolling windows, year:YYYY is a calendar year (use it for "this year"), all is all-time. For a plain "how many have I watched" count, prefer get_watch_stats.',
    argsSchema: getMyStatsArgsSchema,

    async execute(
        args: GetMyStatsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!features.personalStats) {
            return {
                summaryForModel: JSON.stringify({
                    available: false,
                    note: 'Personal statistics are not enabled on this server.',
                }),
            };
        }

        const period = args.period ?? 'all';
        const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
        // Same fan-out the /api/my-stats/all endpoint calls — parallel per-type
        // computation, min-data gating, shared cache. No query reimplemented.
        // Thread the caller's REAL access boundary. This call previously passed
        // no access argument at all: getAllStats then computed completion,
        // records and top-titles UNFILTERED and — because the fingerprint was
        // empty — wrote them under the same un-fingerprinted key the
        // `/api/my-stats/all` endpoint reads with a fingerprint, in the same
        // 'personalStats' namespace. Entries are namespaced per user, so this
        // was a self-poison rather than a cross-user leak, but a restricted user
        // who invoked the assistant still got restricted titles read back to
        // them and cached for the full TTL. `ctx.accessCtx` is the same
        // SearchAccessContext every other scoped tool query uses.
        const result = await personalStatsService.getAllStats(
            ctx.userId,
            period,
            'personalStats',
            statsCache,
            searchAccessBoundary(ctx.accessCtx),
        );

        ctx.logger?.debug('get_my_stats executed', {
            userId: ctx.userId,
            period,
            sessionCount: result.sessionCount,
        });

        return {
            summaryForModel: JSON.stringify({
                available: true,
                ...result,
                stats: { ...result.stats, overview: relabelOverview(result.stats?.overview) },
            }),
        };
    },
};
