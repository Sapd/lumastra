// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `mark_watched` tool — mark ONE title watched or unwatched.
 *
 * One tool for both directions: a separate `mark_unwatched` would double the
 * tool surface the model has to choose between for the sake of one boolean.
 *
 * Reuses `watched-state-ops`, the shared implementation behind both
 * `PUT /api/v1/watch-state/{id}` and the legacy cookie route. It is the one
 * mutation path that already takes an INTERNAL UUID, which is exactly what the
 * access-scoped title resolution produces. It returns `{kind:'denied'}` rather
 * than throwing, and that maps to the same `not_found` payload as a title that
 * isn't there.
 *
 * SERIES GRANULARITY: `searchMediaByTitle` only ever resolves `movie`/`tv`, so
 * there is no per-episode path here at all. Marking a series fans out through
 * `watchManager.markWatched` to every season and episode — the result says so
 * explicitly, because the user needs to know that is what happened.
 *
 * @module server/proprietary/assistant-tools/mark-watched.tool
 */

import {
    markWatchedArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type MarkWatchedArgs,
} from '../../../schemas/assistant-tools.js';
import { markWatchedOp, markUnwatchedOp } from '$lib/server/services/watched-state-ops.js';
import { resolveTitleForWrite } from './resolve-title.js';
import {
    mediaRef,
    mediaYear,
    refuseAmbiguous,
    refuseFailed,
    refuseNotFound,
    publicMediaType,
    refuseWritesDisabled,
    writeOk,
} from './write-result.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const NOTHING_HAPPENED = 'Nothing was marked.';

export const markWatchedTool: AssistantTool<MarkWatchedArgs> = {
    name: ASSISTANT_TOOL_NAMES.MARK_WATCHED,
    description:
        "Mark ONE movie or TV show as watched, or as unwatched, in the user's OWN watch state. Call this only when the user asked for it in their latest message. For a SERIES it applies to the whole show, every season and episode — there is no way to mark a single episode here, so say so if that is what was asked. One title per call.",
    argsSchema: markWatchedArgsSchema,

    async execute(
        args: MarkWatchedArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!ctx.writesAllowed) return refuseWritesDisabled(NOTHING_HAPPENED);

        const resolved = await resolveTitleForWrite(ctx, args);
        if (resolved.kind === 'not_found') return refuseNotFound(args, NOTHING_HAPPENED);
        if (resolved.kind === 'ambiguous') {
            return refuseAmbiguous(resolved.candidates, NOTHING_HAPPENED);
        }

        const row = resolved.row;
        const isSeries = row.media_type === 'tv';
        try {
            const result = args.watched
                ? await markWatchedOp(ctx.userId, row.media_id, ctx.user)
                : await markUnwatchedOp(ctx.userId, row.media_id, ctx.user);

            // `denied` is the access gate. It must read exactly like "no such
            // title" — never "you are not allowed to touch that".
            if (result.kind === 'denied') return refuseNotFound(args, NOTHING_HAPPENED);

            return writeOk({
                action: args.watched ? 'marked_watched' : 'marked_unwatched',
                title: row.title,
                year: mediaYear(row),
                ref: mediaRef(row),
                mediaType: publicMediaType(row),
                fannedOutToWholeSeries: isSeries,
                note: isSeries
                    ? `The WHOLE series — every season and episode — is now marked as ${args.watched ? 'watched' : 'unwatched'}. Tell the user it applied to the entire show.`
                    : `Marked as ${args.watched ? 'watched' : 'unwatched'}.`,
            });
        } catch (err) {
            ctx.logger?.warn('mark_watched failed', {
                title: args.title,
                error: err instanceof Error ? err.name : String(err),
            });
            return refuseFailed(NOTHING_HAPPENED);
        }
    },
};
