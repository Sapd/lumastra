// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `get_active_streams` tool — what is being watched/listened to right now.
 *
 * PERMISSION-SENSITIVE. It does NOT reimplement any visibility logic: it calls
 * the SAME `getVisibleActiveSessions()` helper that powers the `/api/sessions`
 * home-page "Active Streams" widget, so the feature gate, per-user privacy
 * filter (`hide_streams`), preview handling, and device-info redaction are
 * identical. The tool is only registered when the caller may view streams, and
 * still defers entirely to the helper's `visible` flag. (The `streaming-sessions`
 * dashboard-widget enable toggle is a home-page placement control, NOT a
 * permission, so it intentionally does not gate the assistant.) TEXT-ONLY.
 *
 * @module server/proprietary/assistant-tools/get-active-streams.tool
 */

import {
    getActiveStreamsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetActiveStreamsArgs,
} from '../../../schemas/assistant-tools.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { getVisibleActiveSessions } from '../../services/active-sessions-view.service.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const MAX_LISTED = 30;

/** Build a compact, human-meaningful label for what a session is playing. */
function describeNowPlaying(s: {
    mediaType: string;
    title: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    artistName?: string;
    liveTvProgramName?: string;
}): string {
    if (s.liveTvProgramName) {
        return `${s.liveTvProgramName} (on ${s.title})`;
    }
    if (s.mediaType === 'episode' && s.seriesName) {
        const se =
            s.seasonNumber != null && s.episodeNumber != null
                ? ` S${s.seasonNumber}E${s.episodeNumber}`
                : '';
        return `${s.seriesName}${se} — ${s.title}`;
    }
    if ((s.mediaType === 'track' || s.mediaType === 'audio') && s.artistName) {
        return `${s.artistName} — ${s.title}`;
    }
    return s.title;
}

/**
 * Derive remaining-time / finish-time so the model can answer "when does X
 * finish their movie". Returns undefined fields when there is no usable
 * duration/position (e.g. live TV / radio with no fixed runtime).
 */
function describeTiming(s: {
    playItemDuration?: number;
    duration?: number;
    playCurrentTime?: number;
    playIsPlaying?: boolean;
}): {
    remainingMinutes?: number;
    estimatedFinish?: string;
} {
    const totalSec = s.playItemDuration ?? s.duration;
    const posSec = s.playCurrentTime;
    if (!Number.isFinite(totalSec) || !Number.isFinite(posSec) || (totalSec as number) <= 0) {
        return {};
    }
    const remainingSec = Math.max(0, (totalSec as number) - (posSec as number));
    const remainingMinutes = Math.round(remainingSec / 60);
    // Only project a wall-clock finish time while actually playing — a paused
    // stream has no meaningful ETA.
    const estimatedFinish =
        s.playIsPlaying !== false && remainingSec > 0
            ? new Date(Date.now() + remainingSec * 1000).toISOString()
            : undefined;
    return { remainingMinutes, estimatedFinish };
}

export const getActiveStreamsTool: AssistantTool<GetActiveStreamsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_ACTIVE_STREAMS,
    description:
        'Show what is being streamed right now (who is watching/listening, what, and how far in). Use for "who is watching", "what\'s being streamed", "current streams", "is anyone online", and "when will <user> finish their movie/episode" (each stream includes remainingMinutes + an estimated finish time). Respects each user\'s privacy settings.',
    argsSchema: getActiveStreamsArgsSchema,

    async execute(
        _args: GetActiveStreamsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const result = await getVisibleActiveSessions({
            access: searchAccessBoundary(ctx.accessCtx),
            userId: ctx.userId,
            username: ctx.accessCtx.username ?? undefined,
            userGroups: ctx.userGroups ?? [],
            isAdmin: ctx.userIsAdmin,
            hasWatchPermission: ctx.hasWatchPermission ?? false,
            hasLiveTvPermission: ctx.accessCtx.liveTvAllowed,
        });

        if (!result.visible) {
            return {
                summaryForModel: JSON.stringify({
                    available: false,
                    note: 'This user is not permitted to view active streams.',
                }),
            };
        }

        const streams = result.sessions.slice(0, MAX_LISTED).map((s) => ({
            user: s.username,
            nowPlaying: describeNowPlaying(s),
            mediaType: s.mediaType,
            paused: s.playIsPlaying === false ? true : undefined,
            progressPercent: Number.isFinite(s.streamProgress)
                ? Math.round(s.streamProgress as number)
                : undefined,
            ...describeTiming(s),
            device: s.clientApp ?? s.clientname ?? undefined,
        }));

        ctx.logger?.debug('get_active_streams executed', {
            visibleCount: result.sessions.length,
        });

        return {
            summaryForModel: JSON.stringify({
                available: true,
                // A genuine total (every stream visible to this caller) and a
                // page size, told apart by name: `count` beside a capped list
                // is what the model kept relaying as "there are N".
                activeStreamCount: result.sessions.length,
                returnedCount: streams.length,
                streams,
                truncated: result.sessions.length > MAX_LISTED,
                note:
                    result.sessions.length === 0
                        ? 'Nobody is streaming anything right now.'
                        : undefined,
            }),
        };
    },
};
