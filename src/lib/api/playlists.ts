// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playlist API domain module
 *
 * Typed functions for all playlist endpoints. Schemas here MUST match the
 * actual server response shapes (bare objects / {items,page} envelopes /
 * problem+json errors). No `success: true` wrapper is expected from the server.
 */

import { z } from 'zod';
import { TrackSchema } from '$lib/schemas/api-music-dto.js';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client.js';
import {
    playlistMemberSchema,
    addPlaylistItemsResponseSchema,
    // Reuse stable schemas that have NOT changed shape
    getPlaylistResponseSchema,
    playlistItemWithMetadataResponseSchema,
    playlistMessageResponseSchema,
    bulkDeleteResponseSchema,
    messageResponseSchema,
    playlistProgressResponseSchema,
    playbackContextResponseSchema,
    viewStateResponseSchema,
    // Individual data schemas (used to build updated collection schemas)
    playlistSchema,
    playlistEntrySchema,
    chatMessageDataSchema,
    playlistSummarySchema,
    invitePlaylistSchema,
} from '$lib/schemas/playlists';
import type { SaveViewStateInput } from '$lib/schemas/playlists';
import type {
    AddToPlaylistItemRequest,
    CreatePlaylistRequest,
    UpdatePlaylistRequest,
    ReorderItemsRequest,
    InviteMemberRequest,
    UpdateMemberRoleRequest,
    ToggleWatchedRequest,
} from '$lib/types/api-playlists';

// ---------------------------------------------------------------------------
// Updated response schemas matching the new contract (no success wrapper)
// ---------------------------------------------------------------------------

/**
 * GET /api/playlists — paginated list of owned + shared playlists.
 * Old shape: { success, owned, shared }
 * New shape: { items: Playlist[], page: PageBlock }
 */
const playlistsPagedResponseSchema = z.object({
    items: z.array(playlistSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int().optional(),
        nextCursor: z.string().optional(),
        hasMore: z.boolean(),
        total: z.number().int().optional(),
    }),
});

/**
 * POST /api/playlists — bare playlist object (no success wrapper).
 * Old shape: { success: true, playlist }
 * New shape: Playlist (bare)
 */
const playlistBareResponseSchema = playlistSchema;

/**
 * POST /api/playlists/{id}/items — item or expanded series (no success wrapper).
 * Old shape: { success: true, item, playlistSummary } | { success: true, expanded, ... }
 * New shape: { item, playlistSummary } | { expanded: true, seriesName, episodesAdded, items, playlistSummary }
 */
const addItemResponseSchema = addPlaylistItemsResponseSchema;

/**
 * PUT /api/playlists/{id}/items/{id}/watched — no success wrapper.
 * Old shape: { success: true, watched, watchedAt?, playlistSummary? }
 * New shape: { watched, watchedAt?, playlistSummary? }
 */
const toggleWatchedResponseSchema = z.object({
    watched: z.boolean(),
    watchedAt: z.string().optional(),
    playlistSummary: playlistSummarySchema.optional(),
});

/**
 * GET /api/playlists/{id}/members — paginated list of members.
 * Old shape: { success, members }
 * New shape: { items: Member[], page: PageBlock }
 */
const membersPagedResponseSchema = z.object({
    items: z.array(playlistMemberSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int().optional(),
        nextCursor: z.string().optional(),
        hasMore: z.boolean(),
        total: z.number().int().optional(),
    }),
});

/**
 * POST /api/playlists/{id}/members — bare member object (no success/timestamp).
 * Old shape: { success: true, member, timestamp }
 * New shape: bare member (userId?, username, role, status, invitedAt)
 */
const memberBareResponseSchema = playlistMemberSchema;

/**
 * POST /api/playlists/{id}/invite — bare outcome (no success wrapper).
 * Old shape: { success: true, message, playlist? } | { success: true, message }
 * New shape: { message, playlist? } | { message }
 */
const inviteResponseSchema = z.union([
    z.object({
        message: z.string(),
        playlist: invitePlaylistSchema,
    }),
    z.object({
        message: z.string(),
    }),
]);

/**
 * GET /api/playlists/{id}/chat — paginated messages.
 * Old shape: { success, messages, has_more, latest_id }
 * New shape: { items: ChatMessage[], page: { limit, hasMore, nextCursor? } }
 */
const chatPagedResponseSchema = z.object({
    items: z.array(chatMessageDataSchema),
    page: z.object({
        limit: z.number().int(),
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
    }),
});

/**
 * POST /api/playlists/{id}/chat — bare message object (no success wrapper).
 * Old shape: { success: true, message: ChatMessage }
 * New shape: ChatMessage (bare)
 */
const chatMessageBareResponseSchema = chatMessageDataSchema;

// Re-export types for convenience
export type {
    PlaylistsListResponse,
    PlaylistResponse,
    PlaylistMembersResponse,
    PlaylistMemberResponse,
    ToggleWatchedResponse,
    InviteActionResponse,
    UserSearchResponse,
} from '$lib/types/api-playlists';

// =========================================================================
// Playlist CRUD
// =========================================================================

export function getPlaylists(type?: 'general' | 'music' | 'video') {
    const params = type ? `?type=${type}` : '';
    return apiGet(`/api/playlists${params}`, playlistsPagedResponseSchema);
}

export function getPlaylist(playlistId: number) {
    return apiGet(`/api/playlists/${playlistId}`, getPlaylistResponseSchema);
}

export function createPlaylist(body: CreatePlaylistRequest) {
    return apiPost('/api/playlists', playlistBareResponseSchema, body);
}

export function updatePlaylist(playlistId: number, body: UpdatePlaylistRequest) {
    return apiPatch(`/api/playlists/${playlistId}`, playlistItemWithMetadataResponseSchema, body);
}

export function deletePlaylist(playlistId: number) {
    return apiDelete(`/api/playlists/${playlistId}`, messageResponseSchema);
}

// =========================================================================
// Playlist Items
// =========================================================================

export function addItem(playlistId: number, item: AddToPlaylistItemRequest) {
    return apiPost(`/api/playlists/${playlistId}/items`, addItemResponseSchema, item);
}

export function removeItem(playlistId: number, itemId: number) {
    return apiDelete(`/api/playlists/${playlistId}/items/${itemId}`, playlistMessageResponseSchema);
}

export function bulkDeleteItems(playlistId: number, itemIds: number[]) {
    return apiPost(`/api/playlists/${playlistId}/items/bulk-delete`, bulkDeleteResponseSchema, {
        entryIds: itemIds,
    });
}

export function reorderItems(playlistId: number, body: ReorderItemsRequest) {
    return apiPut(`/api/playlists/${playlistId}/items/order`, playlistMessageResponseSchema, body);
}

export function toggleItemWatched(playlistId: number, itemId: number, body: ToggleWatchedRequest) {
    return apiPut(
        `/api/playlists/${playlistId}/items/${itemId}/watched`,
        toggleWatchedResponseSchema,
        body,
    );
}

/**
 * Save the current user's collapsed series/season groups for a playlist.
 * Persisted server-side so the collapse survives reloads; a freshly-invited
 * viewer inherits the owner's collapsed groups until they save their own.
 */
export function saveViewState(playlistId: number, body: SaveViewStateInput) {
    return apiPut(`/api/playlists/${playlistId}/view-state`, viewStateResponseSchema, body);
}

// =========================================================================
// Playlist Members
// =========================================================================

export function getMembers(playlistId: number) {
    return apiGet(`/api/playlists/${playlistId}/members`, membersPagedResponseSchema);
}

export function inviteMember(playlistId: number, body: InviteMemberRequest) {
    return apiPost(`/api/playlists/${playlistId}/members`, memberBareResponseSchema, body);
}

export function updateMemberRole(
    playlistId: number,
    userId: string,
    body: UpdateMemberRoleRequest,
) {
    return apiPut(
        `/api/playlists/${playlistId}/members/${encodeURIComponent(userId)}`,
        playlistMemberSchema,
        body,
    );
}

export function removeMember(playlistId: number, userId: string) {
    return apiDelete(
        `/api/playlists/${playlistId}/members/${encodeURIComponent(userId)}`,
        z.void(),
    );
}

// =========================================================================
// Playlist Invites
// =========================================================================

export function respondToInvite(playlistId: number, action: 'accept' | 'deny') {
    return apiPost(`/api/playlists/${playlistId}/invite`, inviteResponseSchema, { action });
}

// =========================================================================
// Playlist Chat
// =========================================================================

export function getChatMessages(
    playlistId: number,
    options?: { since?: number; checkWatched?: boolean },
) {
    const params: Record<string, string | number | boolean | undefined> = {};
    if (options?.since !== undefined) params.since = options.since;
    if (options?.checkWatched !== undefined) params.check_watched = options.checkWatched;
    return apiGet(`/api/playlists/${playlistId}/chat`, chatPagedResponseSchema, { params });
}

export function sendChatMessage(playlistId: number, message: string) {
    return apiPost(`/api/playlists/${playlistId}/chat`, chatMessageBareResponseSchema, {
        message,
    });
}

export function deleteChatMessage(playlistId: number, messageId: number) {
    return apiDelete(`/api/playlists/${playlistId}/chat/${messageId}`, messageResponseSchema);
}

// =========================================================================
// Playlist Progress
// =========================================================================

export function getPlaylistProgress(playlistId: number) {
    return apiGet(`/api/playlists/${playlistId}/progress`, playlistProgressResponseSchema);
}

// =========================================================================
// Playlist Playback Context
// =========================================================================

export function getPlaybackContext(
    playlistId: number,
    selector: { position: number } | { entryId: number } | { mediaId: string },
) {
    return apiGet(`/api/playlists/${playlistId}/playback-context`, playbackContextResponseSchema, {
        params: selector,
    });
}

// =========================================================================
// User Search (for invite autocomplete)
// =========================================================================

import { userSearchResponseSchema } from '$lib/schemas/playlists';

export function searchUsers(query: string) {
    return apiGet('/api/users/search', userSearchResponseSchema, {
        params: { q: query },
    });
}

/** One page of entries; callers that need the whole playlist explicitly follow pages. */
export function getPlaylistItems(
    playlistId: number,
    offset = 0,
    limit = 200,
    itemType?: 'music' | 'video',
    cursor?: string,
) {
    return apiGet(
        `/api/playlists/${playlistId}/items`,
        z.object({
            items: z.array(playlistEntrySchema),
            page: z.object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                nextCursor: z.string().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            }),
        }),
        { params: { offset, limit, itemType, cursor } },
    );
}

export async function getAllPlaylistItems(playlistId: number, itemType?: 'music' | 'video') {
    const items: z.infer<typeof playlistEntrySchema>[] = [];
    let offset = 0;
    let cursor: string | undefined;
    for (;;) {
        const result = await getPlaylistItems(playlistId, offset, 1000, itemType, cursor);
        if (result.error || !result.data) return { ...result, data: null };
        items.push(...result.data.items);
        if (!result.data.page.hasMore) return { ...result, data: { ...result.data, items } };
        if (!result.data.items.length) throw new Error('Playlist pagination did not advance');
        if (result.data.page.nextCursor) {
            if (cursor === result.data.page.nextCursor)
                throw new Error('Playlist cursor did not advance');
            cursor = result.data.page.nextCursor;
        } else {
            offset += result.data.items.length;
        }
    }
}

export function getPlaylistSuggestions(playlistId: number, count = 6) {
    return apiGet(
        `/api/playlists/${playlistId}/suggestions`,
        z.object({
            items: z.array(TrackSchema),
            source: z.enum(['sonic', 'metadata']),
            page: z.object({
                limit: z.number().int(),
                truncated: z.boolean(),
            }),
        }),
        { params: { count } },
    );
}
