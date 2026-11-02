// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `add_to_watchlist` tool — save ONE title to the caller's OWN watchlist.
 *
 * Reuses `watchlistManager.addItem`, the same service the `POST /api/v1/watchlist`
 * route calls, so the access gate (`resolveAndGate`), the cache invalidation and
 * the activity-feed write are defined exactly once. The tool adds nothing to
 * that path except turning a title into an id.
 *
 * The title is resolved through {@link resolveTitleForWrite}, i.e. through the
 * ACCESS-SCOPED query — so the id handed to the service can only ever be one
 * this caller may see, and a title they may not see is reported with the same
 * words as one that does not exist.
 *
 * Deliberately returns no `media`: a write tool reports an outcome, and pushing
 * its target into the recommendation rail would render "the thing you just
 * saved" as a suggestion.
 *
 * @module server/proprietary/assistant-tools/add-to-watchlist.tool
 */

import {
    addToWatchlistArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type AddToWatchlistArgs,
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

/** Repeated in every refusal — see the rule in `write-result.ts`. */
const NOTHING_HAPPENED = 'Nothing was saved.';

export const addToWatchlistTool: AssistantTool<AddToWatchlistArgs> = {
    name: ASSISTANT_TOOL_NAMES.ADD_TO_WATCHLIST,
    description:
        "Save ONE movie or TV show to the user's OWN watchlist. Call this only when the user asked for it in their latest message — a recommendation request is NOT permission to save anything. One title per call. Report exactly what the result says: if ok is false, nothing was saved.",
    argsSchema: addToWatchlistArgsSchema,

    async execute(
        args: AddToWatchlistArgs,
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
            const result = await watchlistManager.addItem({
                sql: ctx.sql,
                userId: ctx.userId,
                // `{ internal }` short-circuits resolution. Any provider key here
                // would reach resolveOrCreateMediaId, which creates catalogue rows.
                externalIds: { internal: row.media_id },
                mediaType: row.media_type,
                title: row.title,
                user: ctx.user,
            });

            // The service swallows MediaNotResolvableError into this shape; it
            // must read the same as the access-denied case, never as a success.
            if (!result.mediaId) return refuseNotFound(args, NOTHING_HAPPENED);

            const alreadyOnWatchlist = result.alreadyPresent === true;
            return writeOk({
                action: alreadyOnWatchlist ? 'noop' : 'added',
                alreadyOnWatchlist,
                title: row.title,
                year: mediaYear(row),
                ref: mediaRef(row),
                note: alreadyOnWatchlist
                    ? 'It was already on the watchlist — nothing changed.'
                    : 'Saved to the watchlist.',
            });
        } catch (err) {
            // MediaAccessDeniedError lands here (resolveAndGate also fails CLOSED
            // on a checkMediaAccess error, so a DB blip arrives as "denied").
            // Collapsing it into `not_found` is the existence-leak rule; the
            // logger keeps the real cause.
            ctx.logger?.warn('add_to_watchlist failed', {
                title: args.title,
                error: err instanceof Error ? err.name : String(err),
            });
            if (isAccessOrResolveError(err)) return refuseNotFound(args, NOTHING_HAPPENED);
            return refuseFailed(NOTHING_HAPPENED);
        }
    },
};

/**
 * Both gate errors from `resolveAndGate` collapse to one outcome. Matched by
 * NAME, not by `instanceof`: the services import the error classes through
 * `$lib` aliases and dynamic imports, so a second module instance would make
 * `instanceof` silently false and turn a denial into a "failed".
 */
function isAccessOrResolveError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === 'MediaAccessDeniedError' || err.name === 'MediaNotResolvableError';
}
