// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_audiobook_progress` tool — the books the caller is part-way through.
 *
 * Closes a hole rather than adding a nicety: nothing on the tool surface could
 * read a listening position. `search_audiobooks` searches, and
 * `analyze_viewing_history` reads `watch_history`, which is video only. So "wo
 * bin ich stehen geblieben?" reached a model with no data and no instruction to
 * say so — and a resume position is precisely the sort of concrete number that
 * gets invented.
 *
 * Reads the LOCAL mirror (`user_media_state`) via `getAudiobooksInProgress`,
 * never AudiobookShelf directly, so it degrades to stale rather than broken
 * while ABS is unreachable — which is also why an empty result is reported as
 * ambiguous instead of "you have not started anything".
 *
 * @module server/assistant/assistant-tools/get-audiobook-progress.tool
 */

import {
    getAudiobookProgressArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetAudiobookProgressArgs,
} from '../../../schemas/assistant-tools.js';
import { getAudiobooksInProgress } from '../../database/queries/audiobook-browse.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

const DEFAULT_LIMIT = 10;

/** "1h 0m" / "12m" — a duration the model can read out without doing arithmetic. */
function humanDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export const getAudiobookProgressTool: AssistantTool<GetAudiobookProgressArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_AUDIOBOOK_PROGRESS,
    description:
        'Where the user left off in the audiobooks they have started: resume position, time remaining, and percent complete. Use for "wo bin ich stehen geblieben", "where did I leave off", "which audiobooks am I in the middle of", "how much is left of X". This is the ONLY source of listening positions — never state one without calling it.',
    argsSchema: getAudiobookProgressArgsSchema,

    async execute(
        args: GetAudiobookProgressArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;
        const books = await getAudiobooksInProgress(ctx.sql, {
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
            limit,
        });

        ctx.logger?.debug('get_audiobook_progress executed', { returned: books.length });

        return {
            summaryForModel: JSON.stringify({
                ...resultCounts(books.length, limit),
                note:
                    books.length === 0
                        ? 'No in-progress audiobooks are recorded for this user. Progress is mirrored from the audiobook server, so this can also mean the sync has not written any yet. Say you have no recorded progress; do not assert that the user has not started any books.'
                        : undefined,
                books: books.map((b) => {
                    // A missing/zero duration must not become a divide-by-zero
                    // percentage or a negative "remaining" — report null and let
                    // the model say the length is unknown.
                    const hasDuration = typeof b.durationMs === 'number' && b.durationMs > 0;
                    const remainingMs = hasDuration
                        ? Math.max(0, (b.durationMs as number) - b.positionMs)
                        : null;
                    return {
                        title: b.title,
                        seriesName: b.seriesName ?? undefined,
                        authors: b.authors?.length ? b.authors : undefined,
                        positionHuman: humanDuration(b.positionMs),
                        remainingHuman: remainingMs === null ? null : humanDuration(remainingMs),
                        percentComplete: hasDuration
                            ? Math.round((b.positionMs / (b.durationMs as number)) * 100)
                            : null,
                        lastListenedAt: b.lastEventAt ?? undefined,
                    };
                }),
            }),
        };
    },
};
