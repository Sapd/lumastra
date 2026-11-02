// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { playlistWithImages, transformPlaylistItemRow } from '$lib/server/utils/playlist-transforms.js';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/database/connection';
import { error } from '@sveltejs/kit';
import { features, config } from '$lib/server/config';

import { authorOrPlaceholder, loadPublicAuthors } from '$lib/server/utils/public-author.js';
import { getPlaylistKindPolicy } from '$lib/server/services/playlist-kind-policy.js';
import * as m from '$lib/paraglide/messages';
import {
    getPlaylistById,
    getPlaylistItems,
    getPlaylistMembers,
    getEffectiveCollapsedGroups,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { PLAYLIST_DETAIL_DEPENDENCY } from './playlist-detail-transform';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
    depends(PLAYLIST_DETAIL_DEPENDENCY);
    // Check feature flag
    if (!features.playlists) {
        throw error(404, 'Playlists feature is disabled');
    }

    const user = locals.user;
    const playlistId = parseInt(params.id, 10);

    if (Number.isNaN(playlistId)) {
        throw error(400, m.error_playlist_invalid_id());
    }

    try {
        const sql = getDb();
        if (!sql) {
            throw error(500, 'Database connection unavailable');
        }

        const playlist = await getPlaylistById(sql, playlistId);

        if (!playlist) {
            throw error(404, m.error_playlist_not_found());
        }

        // Determine user's role
        let role: 'owner' | 'editor' | 'readonly' | 'public' | null = null;

        if (user?.userId && user.userId === playlist.user_id) {
            role = 'owner';
        } else if (user?.userId) {
            // Check if user is a member (playlist_members.user_id is a users.id UUID, mig 16.46.0).
            // Accepted members only, like getUserRole() on the API: a pending invite
            // grants nothing until the invitee accepts it.
            const memberResult = await sql<{ role: string }[]>`
                SELECT role FROM playlist_members
                WHERE playlist_id = ${playlistId} AND user_id = ${user.userId}::uuid
                  AND status = 'accepted'
            `;

            if (memberResult.length > 0) {
                role = memberResult[0].role as 'editor' | 'readonly' | null;
            } else if (playlist.visibility === 'public') {
                role = 'public';
            }
        } else if (playlist.visibility === 'public') {
            role = 'public';
        }

        // 404, not 403: a private playlist must be indistinguishable from a
        // missing one, or sequential ids enumerate who has playlists.
        if (!role) {
            throw error(404, m.error_playlist_not_found());
        }

        const deniedGroups = await getDeniedLibraryGroups(sql, toLibraryAccessUser(user));
        const access = restrictedAccess({
            deniedGroupIds: deniedGroups ?? [],
            maxAgeRating: user?.maxAgeRating ?? null,
            allowUnrated: config.UNRATED_CONTENT_VISIBLE,
        });
        const itemsResult = await getPlaylistItems(
            sql,
            playlistId,
            user?.userId ?? null,
            undefined,
            access,
            undefined,
            getPlaylistKindPolicy(playlist.playlist_type).sort,
        );

        // Per-user collapsed series/season groups. Falls back to the owner's
        // saved groups when this viewer has none of their own, so a freshly
        // invited member sees everything the owner collapsed (mig 16.81.0).
        const collapsedGroups = await getEffectiveCollapsedGroups(
            sql,
            playlistId,
            user?.userId ?? null,
            playlist.user_id,
        );

        // Get members (only if owner or editor). getPlaylistMembers joins the
        // users table so each row carries the resolved login `username`, not the
        // bare users.id UUID (playlist_members.user_id is a UUID since mig 16.46.0).
        const members =
            role === 'owner' || role === 'editor' ? await getPlaylistMembers(sql, playlistId) : [];

        const authors = await loadPublicAuthors(
            members.map((member) => member.user_id),
            'internal',
        );
        return {
            playlist: await playlistWithImages(
                sql,
                {
                    ...playlist,
                    cover_items: itemsResult.map((item) => ({
                        internal_id: item.media_id,
                        primary_ext_id: item.primary_ext_id,
                        media_type: item.media_type,
                        poster_url: null,
                        position: item.position,
                    })),
                },
                role === 'public' ? 'readonly' : role,
                'internal',
            ),
            items: itemsResult.map((item) => transformPlaylistItemRow(item, 'internal')),
            members: members.map((member) => ({
                userId: member.user_id,
                author: authorOrPlaceholder(authors, member.user_id, 'internal'),
                role: member.role,
                status: member.status,
                invitedAt:
                    member.invited_at instanceof Date
                        ? member.invited_at.toISOString()
                        : member.invited_at,
            })),
            userId: user?.userId ?? null,
            canEdit: role === 'owner' || role === 'editor',
            canManageMembers: role === 'owner',
            featureChatEnabled: features.playlistChat,
            collapsedGroups,
        };
    } catch (e) {
        if (e && typeof e === 'object' && 'status' in e) {
            throw e;
        }
        console.error('[Playlist Detail] Failed to load:', e);
        throw error(500, m.error_playlist_load_failed());
    }
};
