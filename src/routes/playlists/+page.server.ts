// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/database/connection';
import { redirect, error, isHttpError, isRedirect } from '@sveltejs/kit';
import { features } from '$lib/server/config';
import * as m from '$lib/paraglide/messages';
import type { Playlist } from '$lib/types/api-playlists';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import {
    getOwnedPlaylists,
    getSharedPlaylists,
    type PlaylistRow,
} from '$lib/server/database/queries/playlists.queries.js';
import { playlistsWithImages } from '$lib/server/utils/playlist-transforms.js';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { appPath } from '$lib/shared/api-urls.js';

/** Pending-invites row: the shared PlaylistRow shape plus the invite timestamp,
 *  which only this inline query (no shared-module equivalent) selects. */
type PendingInviteRow = PlaylistRow & { invited_at?: string | Date };

interface PendingInvite extends Playlist {
    invitedAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
    // Check feature flag
    if (!features.playlists) {
        throw error(404, 'Playlists feature is disabled');
    }

    const user = locals.user;

    if (!user?.username) {
        throw redirect(302, appPath('/'));
    }

    try {
        const sql = getDb();
        if (!sql) {
            throw error(500, 'Database connection unavailable');
        }

        // Build the viewer's access boundary once and thread the SAME value
        // through every query on this page — the list queries and the inline
        // pending-invites collage below. Previously this route hand-built a
        // `{ deniedGroupIds, ageRating }` literal byte-identical to the one in
        // `api/defs/playlists/index.ts`; both now go through
        // `searchAccessBoundary` so the two cannot drift.
        const { buildSearchAccessContext, searchAccessBoundary } =
            await import('$lib/server/utils/search-access-context.js');
        const accessCtx = await buildSearchAccessContext(sql, user);
        const access = searchAccessBoundary(accessCtx);

        // Idempotent; creates the row on a first visit so the pinned Watchlist
        // card is present even for a user who has never watchlisted anything.
        await ensureWatchlistPlaylist(sql, toUserId(user.userId));

        const [ownedResult, sharedResult] = await Promise.all([
            getOwnedPlaylists(sql, toUserId(user.userId), undefined, access),
            getSharedPlaylists(sql, toUserId(user.userId), undefined, access),
        ]);

        // Get pending invites (with cover items)
        const pendingInvitesResult = await sql<PendingInviteRow[]>`
            SELECT
                p.id, p.revision, p.is_system,
                p.user_id,
                (SELECT u.display_name FROM users u WHERE u.id = p.user_id) AS owner_display_name,
                COALESCE((SELECT u.username FROM users u WHERE u.id = p.user_id), p.user_id::text) AS owner_username,
                p.name,
                p.description,
                p.visibility,
                p.cover_image,
                p.playlist_type,
                p.created_at,
                p.updated_at,
                (SELECT COUNT(*)::int FROM playlist_members accepted WHERE accepted.playlist_id = p.id AND accepted.status = 'accepted') AS member_count,
                COUNT(pi.id)::int AS item_count,
                pm.role,
                pm.invited_at,
                (
                    SELECT json_agg(cover_item ORDER BY cover_item.position)
                    FROM (
                        SELECT
                            pi2.media_id::text as internal_id,
                            COALESCE((SELECT external_id FROM external_ids WHERE media_id = pi2.media_id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as primary_ext_id,
                            CASE WHEN pi2.season_number IS NOT NULL AND pi2.episode_number IS NOT NULL THEN 'episode' ELSE mi.media_type END as media_type,
                            COALESCE(
                                mi.custom_poster_url,
                                (SELECT parent.custom_poster_url FROM media_items parent WHERE parent.id = mi.parent_id)
                            ) as poster_url,
                            pi2.position
                        FROM playlist_items pi2
                        JOIN media_items mi ON mi.id = pi2.media_id
                        -- ALIAS CONTRACT: both fragments below reference
                        -- media_items as mi. buildLibraryAccessFilter hardcodes
                        -- mi.id and takes NO alias parameter; buildAgeRatingFilter
                        -- defaults to mi. They are correct here only because the
                        -- JOIN above aliases media_items as mi. Renaming that
                        -- alias silently filters the WRONG row. Do not rename it.
                        WHERE pi2.playlist_id = p.id
                          ${buildLibraryAccessFilter(sql, access.library)}
                          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
                        ORDER BY pi2.position
                        LIMIT 50
                    ) cover_item
                ) as cover_items
            FROM playlists p
            INNER JOIN playlist_members pm ON pm.playlist_id = p.id AND pm.user_id = ${user.userId}::uuid AND pm.status = 'pending'
            LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
            GROUP BY p.id, pm.role, pm.invited_at
            ORDER BY pm.invited_at DESC
        `;

        const sharedStart = ownedResult.length;
        const invitesStart = sharedStart + sharedResult.length;
        const summaries = await playlistsWithImages(
            sql,
            [
                ...ownedResult.map((row) => ({ row, role: 'owner' as const })),
                ...sharedResult.map((row) => ({ row, role: row.role || ('readonly' as const) })),
                ...pendingInvitesResult.map((row) => ({
                    row,
                    role: row.role || ('readonly' as const),
                })),
            ],
            'internal',
        );
        const pendingInvites: PendingInvite[] = summaries
            .slice(invitesStart)
            .map((summary, index) => {
                const invitedAt = pendingInvitesResult[index].invited_at;
                return {
                    ...summary,
                    invitedAt:
                        invitedAt instanceof Date ? invitedAt.toISOString() : invitedAt || '',
                };
            });
        return {
            owned: summaries.slice(0, sharedStart),
            shared: summaries.slice(sharedStart, invitesStart),
            pendingInvites,
            username: user.username,
        };
    } catch (err) {
        // Re-throw SvelteKit HttpErrors (and redirects) rather than folding them
        // into an empty page. This catch previously swallowed the `error(500)`
        // thrown above for a missing DB connection, and would equally swallow a
        // thrown access-boundary defect — turning a security-relevant bug into a
        // silently empty playlists page instead of a visible failure.
        if (isHttpError(err) || isRedirect(err)) throw err;
        console.error('[Playlists] Failed to load playlists:', err);
        return {
            owned: [],
            shared: [],
            pendingInvites: [],
            username: user.username,
            error: m.error_playlists_load_failed(),
        };
    }
};
