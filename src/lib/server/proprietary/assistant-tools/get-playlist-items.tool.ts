// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `get_playlist_items` tool — the CONTENTS of one playlist the caller can see.
 *
 * `get_playlists` projects name / type / visibility / count / role and nothing
 * else, and there was no second tool. So "was ist auf meiner Roadtrip-Playlist
 * drauf?" gave the model a name, "42 items", and a question about the 42 — the
 * single highest confabulation risk on the tool surface, because a plausible
 * track list is exactly the kind of thing a model can produce fluently and a
 * user cannot easily check.
 *
 * Access: the playlist is resolved ONLY from the caller's own owned/shared
 * lists (never a name lookup across all playlists, which would confirm the
 * existence of other people's), then re-gated through `getUserRole` — the same
 * gate every playlist route uses. The ITEM rows are then filtered by the
 * CALLER's boundary, not the owner's: a shared playlist can hold titles the
 * viewer is not allowed to see.
 *
 * @module server/proprietary/assistant-tools/get-playlist-items.tool
 */

import {
    getPlaylistItemsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetPlaylistItemsArgs,
} from '../../../schemas/assistant-tools.js';
import {
    getOwnedPlaylists,
    getSharedPlaylists,
    getPlaylistItems,
} from '../../database/queries/playlists.queries.js';
import { getUserRole } from '../../utils/playlist-utils.js';
import { unrestrictedAccess } from '../../database/queries/builders/media-access-boundary.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const DEFAULT_LIMIT = 25;

export const getPlaylistItemsTool: AssistantTool<GetPlaylistItemsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_PLAYLIST_ITEMS,
    description:
        "List what is ON a playlist — the actual titles/tracks, not just its name. Use whenever the user asks what a playlist contains, how long it is, or whether something is on it. get_playlists gives names and counts only; NEVER describe a playlist's contents without calling this first.",
    argsSchema: getPlaylistItemsArgsSchema,

    async execute(
        args: GetPlaylistItemsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        // Boundary filters cover_items only on these two, which we do not read.
        const [owned, shared] = await Promise.all([
            getOwnedPlaylists(ctx.sql, ctx.userId, undefined, unrestrictedAccess()),
            getSharedPlaylists(ctx.sql, ctx.userId, undefined, unrestrictedAccess()),
        ]);
        const visible = [...owned, ...shared];
        const wanted = args.name.trim().toLowerCase();
        const exact = visible.find((p) => p.name?.trim().toLowerCase() === wanted);

        // An exact name is unambiguous by definition. A SUBSTRING is not: with
        // "Chill", "Chill Evening" and "Chill Hard", `.find()` returned
        // whichever came first and the model described its contents as the
        // requested playlist — confidently, with nothing in the payload to
        // suggest it had picked. Name them all and let the model ask instead.
        const partial = exact
            ? []
            : visible.filter((p) => p.name?.trim().toLowerCase().includes(wanted));
        if (!exact && partial.length > 1) {
            return {
                summaryForModel: JSON.stringify({
                    found: false,
                    note: `More than one of the user's playlists matches "${args.name}" — ask which one.`,
                    candidatePlaylists: partial.map((p) => p.name),
                }),
            };
        }

        const playlist = exact ?? partial[0];

        if (!playlist) {
            // Name what the caller DOES have rather than a bare miss, so the
            // model can offer the real options instead of guessing at one.
            return {
                summaryForModel: JSON.stringify({
                    found: false,
                    note: `No playlist of the user's matching "${args.name}".`,
                    availablePlaylists: visible.map((p) => p.name),
                }),
            };
        }

        // Re-gate through the shared role check even though the row came from
        // the caller's own lists: membership can have been revoked between the
        // two reads, and this is the gate every playlist route funnels through.
        const { role } = await getUserRole(
            ctx.sql,
            playlist.id,
            ctx.accessCtx.username,
            ctx.userId,
        );
        if (!role) {
            return {
                summaryForModel: JSON.stringify({
                    found: false,
                    note: `No playlist of the user's matching "${args.name}".`,
                    availablePlaylists: visible.map((p) => p.name),
                }),
            };
        }

        const limit = args.limit ?? DEFAULT_LIMIT;
        // `offset` mode takes no limit — it returns the playlist in position
        // order — so the cap is applied here. Playlists are bounded by
        // construction, and the access filter has to run over all rows anyway
        // for `visible` below to mean anything.
        const allRows = await getPlaylistItems(
            ctx.sql,
            playlist.id,
            ctx.userId,
            undefined,
            // The VIEWER's boundary — a shared playlist may hold titles this
            // caller cannot see, and those rows must not be read out to them.
            searchAccessBoundary(ctx.accessCtx),
            { mode: 'offset' },
        );
        const rows = allRows.slice(0, limit);

        const declared = Number(playlist.item_count ?? 0);
        // Two different reasons a row is missing, and the model must not
        // conflate them with "the playlist is short".
        const notVisible = Math.max(0, declared - allRows.length);
        const beyondLimit = Math.max(0, allRows.length - rows.length);

        ctx.logger?.debug('get_playlist_items executed', {
            playlist: playlist.name,
            returned: rows.length,
        });

        return {
            summaryForModel: JSON.stringify({
                found: true,
                playlist: playlist.name,
                type: playlist.playlist_type,
                itemCount: declared,
                // `returnedCount` everywhere, so the model never has to guess
                // which of two numbers beside a list is the total.
                returnedCount: rows.length,
                // A count that exceeds what came back means rows were withheld
                // by access or the limit. Say which, so the model does not
                // present a partial list as the whole playlist.
                note:
                    notVisible > 0 || beyondLimit > 0
                        ? `Showing ${rows.length} of ${declared} items` +
                          (beyondLimit > 0
                              ? `; ${beyondLimit} more beyond the requested limit`
                              : '') +
                          (notVisible > 0
                              ? `; ${notVisible} are not visible to this user (library or age restrictions)`
                              : '') +
                          '. Do not describe this as the complete playlist.'
                        : undefined,
                items: rows.map((r) => ({
                    title: r.title,
                    mediaType: r.media_type,
                    artist: r.artist ?? undefined,
                    seriesName: r.series_name ?? undefined,
                    position: r.position,
                })),
            }),
        };
    },
};
