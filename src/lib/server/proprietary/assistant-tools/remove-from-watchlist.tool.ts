// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `remove_from_watchlist` tool — drop ONE title from the caller's OWN watchlist.
 *
 * Reuses `watchlistManager.removeItem`, the service behind
 * `DELETE /api/v1/watchlist`. Note the deliberate asymmetry with the add side:
 * `removeItem` does NOT run an access check, because letting someone clear a
 * saved entry they can no longer view is the safer default (documented on
 * `WatchlistRemoveParams`). This tool still resolves through the access-scoped
 * query — that is how a title becomes an id at all, and it keeps the tool's
 * observable behaviour identical to `add_to_watchlist`.
 *
 * Honest about no-ops: `removed` comes from a `DELETE … RETURNING`, so a
 * second call correctly reports that nothing changed.
 *
 * @module server/proprietary/assistant-tools/remove-from-watchlist.tool
 */

import {
    removeFromWatchlistArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type RemoveFromWatchlistArgs,
} from '../../../schemas/assistant-tools.js';
import { watchlistManager } from '$lib/server/services/watchlist-manager.service.js';
import { resolveTitleForWrite } from './resolve-title.js';
import {
    mediaRef,
    mediaYear,
    refuseAmbiguous,
    refuseFailed,
    refuseNotFound,
    refuseWritesDisabled,
    writeOk,
} from './write-result.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const NOTHING_HAPPENED = 'Nothing was removed.';

export const removeFromWatchlistTool: AssistantTool<RemoveFromWatchlistArgs> = {
    name: ASSISTANT_TOOL_NAMES.REMOVE_FROM_WATCHLIST,
    description:
        "Remove ONE movie or TV show from the user's OWN watchlist. Call this only when the user asked for it in their latest message. One title per call. If the result says it was not on the watchlist, say exactly that — do not claim to have removed it.",
    argsSchema: removeFromWatchlistArgsSchema,

    async execute(
        args: RemoveFromWatchlistArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!ctx.writesAllowed) return refuseWritesDisabled(NOTHING_HAPPENED);

        const resolved = await resolveTitleForWrite(ctx, args);
        if (resolved.kind === 'not_found') return refuseNotFound(args, NOTHING_HAPPENED);
        if (resolved.kind === 'ambiguous') {
            return refuseAmbiguous(resolved.candidates, NOTHING_HAPPENED);
        }

        const row = resolved.row;
        try {
            const result = await watchlistManager.removeItem({
                sql: ctx.sql,
                userId: ctx.userId,
                externalIds: { internal: row.media_id },
                mediaType: row.media_type,
            });

            if (!result.mediaId) return refuseNotFound(args, NOTHING_HAPPENED);

            const wasOnWatchlist = result.removed === true;
            return writeOk({
                action: wasOnWatchlist ? 'removed' : 'noop',
                wasOnWatchlist,
                title: row.title,
                year: mediaYear(row),
                ref: mediaRef(row),
                note: wasOnWatchlist
                    ? 'Removed from the watchlist.'
                    : 'It was not on the watchlist — nothing changed. Do not report this as a removal.',
            });
        } catch (err) {
            ctx.logger?.warn('remove_from_watchlist failed', {
                title: args.title,
                error: err instanceof Error ? err.name : String(err),
            });
            return refuseFailed(NOTHING_HAPPENED);
        }
    },
};
