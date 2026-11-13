// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_playlists` tool — playlists the user OWNS or has been INVITED to.
 *
 * WHICH playlists are returned is access-correct by construction:
 * `getOwnedPlaylists` is filtered to the caller's own rows, and
 * `getSharedPlaylists` only returns playlists the caller is an explicit member
 * of. It deliberately does NOT enumerate other users' playlists (even public
 * ones), so it can never leak a playlist the user has no relationship to.
 *
 * That construction argument covers the playlist rows only — NOT the cover
 * collage inside them, which those queries filter by a separate
 * `MediaAccessBoundary`. This tool is TEXT-ONLY: it projects name / type /
 * visibility / item_count / role and never reads `cover_items`, so it passes
 * `unrestrictedAccess()` for a column it does not consume.
 *
 * @module server/proprietary/assistant-tools/get-playlists.tool
 */

import {
    getPlaylistsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetPlaylistsArgs,
} from '../../../schemas/assistant-tools.js';
import { getOwnedPlaylists, getSharedPlaylists } from '../../database/queries/playlists.queries.js';
import { unrestrictedAccess } from '../../database/queries/builders/media-access-boundary.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { completeResultCounts } from './result-counts.js';

export const getPlaylistsTool: AssistantTool<GetPlaylistsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_PLAYLISTS,
    description:
        "List the playlists the user owns or has been invited to (shared with them). Returns each playlist's name, type, visibility, item count, and the user's role. Does NOT include other users' playlists.",
    argsSchema: getPlaylistsArgsSchema,

    async execute(
        _args: GetPlaylistsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const [owned, shared] = await Promise.all([
            // Boundary filters cover_items only, which this tool never reads.
            getOwnedPlaylists(ctx.sql, ctx.userId, undefined, unrestrictedAccess()),
            getSharedPlaylists(ctx.sql, ctx.userId, undefined, unrestrictedAccess()),
        ]);

        const all = [...owned, ...shared];
        const summaryForModel = JSON.stringify({
            // No limit is passed to either query, so this genuinely is every
            // playlist the user can see — one of the few counts that IS a total.
            ...completeResultCounts(all.length),
            playlists: all.map((p) => ({
                name: p.name,
                type: p.playlist_type,
                visibility: p.visibility,
                itemCount: Number(p.item_count ?? 0),
                role: p.role,
            })),
        });

        ctx.logger?.debug('get_playlists executed', {
            userId: ctx.userId,
            owned: owned.length,
            shared: shared.length,
        });

        return { summaryForModel };
    },
};
