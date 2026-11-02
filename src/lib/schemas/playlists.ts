// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for playlist API routes
 *
 * These schemas validate request bodies, query parameters, and path parameters
 * for all playlist-related endpoints.
 */

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import { publicAuthorSchema } from './public-author.js';
import {
    visibilitySchema,
    positiveIntSchema,
    publicExtendedMediaTypeSchema,
    externalIdsSchema,
    partialExternalIdsSchema,
    coerceBooleanSchema,
} from './common';

/**
 * Accepted on REQUESTS. Deliberately excludes 'watchlist': a client creating a
 * second watchlist would hit playlists_one_watchlist_per_user and surface a raw
 * 23505 as a 500, and the watchlist is created by the server, never by a POST.
 */
export const playlistTypeSchema = z.enum(['general', 'music', 'video']).meta({
    description: 'Playlist content type hint',
});
export type PlaylistType = z.infer<typeof playlistTypeSchema>;

/** Returned in RESPONSES — the full set of values the column may hold. */
export const playlistTypeOutputSchema = z.enum(['general', 'music', 'video', 'watchlist']).meta({
    description: 'Playlist content type',
});
export type PlaylistTypeOutput = z.infer<typeof playlistTypeOutputSchema>;

// ============================================================================
// Path Parameters
// ============================================================================

/**
 * Playlist ID path parameter
 * Coerces string to number for typed access
 */
export const playlistIdParamsSchema = z
    .object({
        id: z.coerce.number().int().positive().max(2147483647),
    })
    .meta({ id: 'playlistIdParams' });

export type PlaylistIdParams = z.infer<typeof playlistIdParamsSchema>;

/**
 * Playlist item path parameters.
 *
 * The playlist and entry have separate integer path parameters.
 */
export const playlistItemIdParamsSchema = z
    .object({
        id: z.coerce.number().int().positive().max(2147483647),
        entryId: z.coerce.number().int().positive().max(2147483647),
    })
    .meta({ id: 'playlistItemIdParams' });

export type PlaylistItemIdParams = z.infer<typeof playlistItemIdParamsSchema>;

/**
 * Playlist + Message ID path parameters (for chat)
 */
export const playlistMessageIdParamsSchema = z
    .object({
        id: z.coerce.number().int().positive().max(2147483647),
        messageId: z.coerce.number().int().positive().max(2147483647),
    })
    .meta({ id: 'playlistMessageIdParams' });

export type PlaylistMessageIdParams = z.infer<typeof playlistMessageIdParamsSchema>;

/**
 * Playlist + User-ID path parameters (for /api/v1 member management — Q8: user-id everywhere).
 *
 * On the v1 surface, member sub-resources are keyed by users.id UUID, not username.
 * Username is display-only in the UI; using it as a stable API identifier is fragile
 * (usernames can change). This is the rename-map.md Q8 resolution.
 */
export const playlistMemberByIdParamsSchema = z
    .object({
        id: z.coerce.number().int().positive().max(2147483647),
        userId: z.string().uuid(),
    })
    .meta({ id: 'playlistMemberByIdParams' });

export type PlaylistMemberByIdParams = z.infer<typeof playlistMemberByIdParamsSchema>;

// ============================================================================
// Playlist CRUD
// ============================================================================

/**
 * Create playlist request body
 */
export const createPlaylistSchema = z
    .object({
        name: z
            .string()
            .min(1, 'Playlist name is required')
            .max(255, 'Playlist name must be 255 characters or less')
            .transform((s) => s.trim()),
        description: z
            .string()
            .transform((s) => s.trim() || undefined)
            .optional(),
        visibility: visibilitySchema.optional().default('private'),
        playlistType: playlistTypeSchema.optional().default('general'),
    })
    .meta({ id: 'createPlaylist' });

export type CreatePlaylistInput = z.infer<typeof createPlaylistSchema>;

/**
 * Update playlist request body (all fields optional)
 */
export const updatePlaylistSchema = z
    .object({
        name: z
            .string()
            .min(1, 'Playlist name cannot be empty')
            .max(255, 'Playlist name must be 255 characters or less')
            .transform((s) => s.trim())
            .optional(),
        description: z
            .string()
            .transform((s) => s.trim())
            .optional(),
        visibility: visibilitySchema.optional(),
        playlistType: playlistTypeSchema.optional(),
    })
    .refine(
        (data) =>
            data.name !== undefined ||
            data.description !== undefined ||
            data.visibility !== undefined ||
            data.playlistType !== undefined,
        { message: 'At least one field must be provided' },
    )
    .meta({ id: 'updatePlaylist' });

export type UpdatePlaylistInput = z.infer<typeof updatePlaylistSchema>;

// ============================================================================
// Playlist Items
// ============================================================================

/**
 * Add single item to playlist
 */
export const addPlaylistItemSchema = z
    .object({ mediaIds: z.array(z.string().uuid()).min(1).max(500) })
    .strict()
    .meta({ id: 'addPlaylistItems' });

export type AddPlaylistItemInput = z.infer<typeof addPlaylistItemSchema>;

/**
 * Bulk delete items request body
 */
export const bulkDeleteItemsSchema = z
    .object({
        entryIds: z
            .array(positiveIntSchema.max(2147483647))
            .min(1, 'entryIds must be a non-empty array')
            .max(500, 'Maximum 500 items can be deleted at once'),
    })
    .meta({ id: 'bulkDeleteItems' });

export type BulkDeleteItemsInput = z.infer<typeof bulkDeleteItemsSchema>;

export const reorderItemsSchema = z
    .object({
        expectedRevision: z.number().int().min(0).max(2147483647),
        entryIds: z.array(z.number().int().positive().max(2147483647)).max(5000),
    })
    .strict()
    .meta({ id: 'reorderItems' });
export type ReorderItemsInput = z.infer<typeof reorderItemsSchema>;

/**
 * Update watched status request body
 */
export const updateWatchedStatusSchema = z
    .object({
        watched: z.boolean(),
    })
    .meta({ id: 'updateWatchedStatus' });

export type UpdateWatchedStatusInput = z.infer<typeof updateWatchedStatusSchema>;

// ============================================================================
// Playlist view state (per-user collapsed series/season groups)
// ============================================================================

/**
 * Stable collapsed-group keys for a playlist's grouped (episode) view.
 *
 * Keys are the provider-agnostic series key (an external id or the series name)
 * and `${seriesKey}-S${n}` for seasons — NOT playlist item ids — so the
 * collapsed state survives reorders and item removals.
 */
export const collapsedGroupsSchema = z
    .object({
        series: z
            .array(z.string().max(600))
            .max(5000)
            .meta({ description: 'Collapsed series group keys' }),
        season: z
            .array(z.string().max(600))
            .max(5000)
            .meta({ description: 'Collapsed season group keys' }),
    })
    .meta({ id: 'collapsedGroups' });

export type CollapsedGroups = z.infer<typeof collapsedGroupsSchema>;

/** Request body for PUT /api/playlists/[id]/view-state */
export const saveViewStateSchema = z
    .object({
        collapsedGroups: collapsedGroupsSchema,
    })
    .meta({ id: 'saveViewState' });

export type SaveViewStateInput = z.infer<typeof saveViewStateSchema>;

/** Response for the view-state endpoint — echoes the saved collapsed groups. */
export const viewStateResponseSchema = z
    .object({
        collapsedGroups: collapsedGroupsSchema,
    })
    .meta({ id: 'viewStateResponse' });

export type ViewStateResponse = z.infer<typeof viewStateResponseSchema>;

// ============================================================================
// Playlist Members
// ============================================================================

/**
 * Member role enum
 */
export const memberRoleSchema = z.enum(['editor', 'readonly']).meta({ id: 'memberRole' });
export type MemberRole = z.infer<typeof memberRoleSchema>;

/**
 * Add member (invite) request body — /api/v1 surface (user-id-based, Q8).
 *
 * On the v1 surface callers identify the invitee by their stable users.id UUID,
 * not by their mutable display username. The server accepts either form here and
 * resolves internally; clients on v1 SHOULD always send `userId`.
 */
export const addMemberByIdSchema = z
    .object({
        userId: z.string().guid('userId must be a valid UUID'),
        role: memberRoleSchema,
    })
    .meta({ id: 'addMemberById' });

export type AddMemberByIdInput = z.infer<typeof addMemberByIdSchema>;

/**
 * Update member role request body
 */
export const updateMemberRoleSchema = z
    .object({
        role: memberRoleSchema,
    })
    .meta({ id: 'updateMemberRole' });

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

// ============================================================================
// Playlist Invites
// ============================================================================

/**
 * Invite action enum
 */
export const inviteActionSchema = z.enum(['accept', 'deny']).meta({ id: 'inviteAction' });
export type InviteAction = z.infer<typeof inviteActionSchema>;

/**
 * Process invite request body
 */
export const processInviteSchema = z
    .object({
        action: inviteActionSchema,
    })
    .meta({ id: 'processInvite' });

export type ProcessInviteInput = z.infer<typeof processInviteSchema>;

// ============================================================================
// Playlist Chat
// ============================================================================

/**
 * Chat message request body
 */
export const chatMessageSchema = z
    .object({
        message: z
            .string()
            .min(1, 'Message is required')
            .max(1000, 'Message too long (max 1000 characters)')
            .transform((s) => s.trim())
            .refine((s) => s.length > 0, { message: 'Message cannot be empty' }),
    })
    .meta({ id: 'chatMessage' });

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

/**
 * Chat query parameters
 */
export const chatQuerySchema = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).optional().default(50),
        cursor: z.coerce.number().int().positive().max(2147483647).optional(),
        since: z.coerce.number().int().positive().max(2147483647).optional(),
        check_watched: coerceBooleanSchema.optional().default(true),
    })
    .meta({ id: 'chatQuery' });

export type ChatQueryParams = z.infer<typeof chatQuerySchema>;

// ============================================================================
// Playback Context
// ============================================================================

/**
 * Playback context query parameters
 */
export const playbackContextQuerySchema = z
    .object({
        entryId: z.coerce.number().int().positive().max(2147483647).optional(),
        position: z.coerce.number().int().min(0).optional(),
        mediaId: z.string().uuid().optional(),
    })
    .strict()
    .refine((q) => Object.values(q).filter((v) => v !== undefined).length === 1, {
        message: 'Exactly one of entryId, position or mediaId is required',
    })
    .meta({ id: 'playbackContextQuery' });

export type PlaybackContextQueryParams = z.infer<typeof playbackContextQuerySchema>;

// ============================================================================
// Playlist Mutation Meta (included in all mutation responses)
// ============================================================================

/**
 * Lightweight summary returned after every playlist mutation.
 * Lets the client update item count and updatedAt without a full reload.
 */
export const playlistSummarySchema = z
    .object({
        itemCount: z.number().int().min(0).meta({
            description: 'Current total number of items in the playlist',
        }),
        updatedAt: z.string().meta({ description: 'ISO 8601 timestamp of last playlist update' }),
        revision: z.number().int().min(0),
    })
    .meta({ id: 'playlistSummary' });

export type PlaylistSummary = z.infer<typeof playlistSummarySchema>;

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Cover item for playlist display
 */
export const playlistCoverItemSchema = z
    .object({
        externalIds: externalIdsSchema.meta({
            description: 'External provider IDs (TMDB, IMDB, etc.)',
        }),
        mediaType: z.enum([...publicExtendedMediaTypeSchema.options, 'season']).meta({
            description: 'Type of media content',
        }),
        seriesExternalIds: partialExternalIdsSchema.optional().meta({
            description: 'External IDs for the parent series (for episodes)',
        }),
        position: z.number().int().min(0).meta({ description: 'Position in playlist' }),
    })
    .meta({ id: 'playlistCoverItem' });

export type PlaylistCoverItem = z.infer<typeof playlistCoverItemSchema>;

/**
 * Role in a playlist
 */
export const playlistRoleSchema = z
    .enum(['owner', 'editor', 'readonly'])
    .meta({ id: 'playlistRole' });
export type PlaylistRole = z.infer<typeof playlistRoleSchema>;

/**
 * Member status in a playlist
 */
export const memberStatusSchema = z.enum(['pending', 'accepted']).meta({ id: 'memberStatus' });
export type MemberStatus = z.infer<typeof memberStatusSchema>;

/**
 * Full playlist metadata
 */
export const playlistSchema = z
    .object({
        id: positiveIntSchema.meta({ description: 'Playlist ID' }),
        owner: publicAuthorSchema,
        revision: z.number().int().min(0),
        name: z.string().meta({ description: 'Playlist name' }),
        description: z.string().nullable().meta({ description: 'Playlist description' }),
        visibility: visibilitySchema.meta({
            description: 'Playlist visibility setting',
        }),
        playlistType: playlistTypeOutputSchema.meta({
            description: 'Content type (general, music, video, watchlist)',
        }),
        images: ImageSetSchema,
        createdAt: z.string().meta({ description: 'ISO 8601 creation timestamp' }),
        updatedAt: z.string().meta({ description: 'ISO 8601 last update timestamp' }),
        role: playlistRoleSchema.meta({
            description: "Current user's role in the playlist",
        }),
        itemCount: z.number().int().min(0).meta({ description: 'Total number of items' }),
        memberCount: z.number().int().min(0).meta({ description: 'Number of members with access' }),
        coverItems: z
            .array(playlistCoverItemSchema)
            .optional()
            .meta({ description: 'Items to display as cover collage' }),
        isSystem: z.boolean().meta({
            description:
                'True when the playlist cannot be deleted, renamed, shared or reordered. Clients must hide those controls.',
        }),
    })
    .meta({ id: 'playlist' });

export type Playlist = z.infer<typeof playlistSchema>;

/**
 * Playlist item with full metadata
 */
export const playlistEntrySchema = z
    .object({
        id: positiveIntSchema.meta({ description: 'Playlist item ID' }),
        mediaId: z.string().uuid(),
        mediaType: z.enum([...publicExtendedMediaTypeSchema.options, 'season']).meta({
            description: 'Type of media content',
        }),
        seriesId: z.string().optional().meta({
            description:
                'Internal UUID of the series: the parent series of an episode, the item itself for a series',
        }),
        seasonNumber: z
            .number()
            .int()
            .min(0)
            .optional()
            .meta({ description: 'Season number (for episodes)' }),
        episodeNumber: z
            .number()
            .int()
            .min(0)
            .optional()
            .meta({ description: 'Episode number (for episodes)' }),
        title: z.string().meta({ description: 'Item title' }),
        seriesName: z.string().optional().meta({ description: 'Parent series name' }),
        artist: z.string().optional().meta({ description: 'Artist name (music tracks)' }),
        parentId: z.string().optional().meta({ description: 'Parent album UUID (music tracks)' }),
        artistId: z.string().optional().meta({ description: 'Artist UUID (music tracks)' }),
        overview: z.string().optional().meta({ description: 'Item description/overview' }),
        posterPath: z.string().optional().meta({
            description:
                "Ready-to-use poster URL for this item, generated per surface as `{prefix}/media/{mediaId}/images/poster?size=thumb` (`/api` or `/api/v1`, plus the install's base path). Request it as-is — it is NOT a bare provider path to be concatenated onto an image CDN, and it is not the value that was sent as `posterPath` when the item was added.",
        }),
        position: z.number().int().min(0).meta({ description: 'Position in playlist' }),
        addedAt: z.string().meta({ description: 'ISO 8601 timestamp when item was added' }),
        watched: z.boolean().meta({
            description:
                'Playlist-scoped manual tick, per viewer. Set via PUT /playlists/{id}/items/{itemId}/watched — NOT derived from playback. For real playback state use playbackWatched/positionSeconds.',
        }),
        watchedAt: z
            .string()
            .optional()
            .meta({ description: 'ISO 8601 timestamp when item was ticked watched' }),
        positionSeconds: z.number().int().min(0).optional().meta({
            description:
                "Playback resume position in whole seconds (NOT `position`, which is the playlist slot). Clamped to durationMs. Absent when the viewer has no playback state for this item; 0 once the item auto-completes — read playbackWatched to tell 'finished' from 'never started'.",
        }),
        durationMs: z.number().int().min(0).optional().meta({
            description:
                "Total runtime in milliseconds — item metadata, NOT watch state: emitted for every item that has a runtime, including ones the viewer has never played and on unauthenticated requests, so clients can total a playlist's runtime. Absent only when no runtime is known for the item, which makes such a total a lower bound.",
        }),
        lastPlayedAt: z.string().optional().meta({
            description: 'ISO 8601 timestamp of the last playback activity for this item.',
        }),
        playbackWatched: z.boolean().optional().meta({
            description:
                'Whether the viewer actually finished playback (user_media_state.is_watched), independent of the playlist tick. Absent when the viewer has no playback state for this item.',
        }),
    })
    .meta({ id: 'playlistEntry' });

export type PlaylistEntry = z.infer<typeof playlistEntrySchema>;

export const addPlaylistItemsResponseSchema = z.object({
    results: z.array(
        z.object({
            mediaId: z.string().uuid(),
            status: z.enum(['added', 'duplicate', 'rejected']),
            entries: z.array(playlistEntrySchema),
            expanded: z.boolean(),
            reason: z.string().nullable(),
        }),
    ),
    summary: playlistSummarySchema,
});
export type AddPlaylistItemsResponse = z.infer<typeof addPlaylistItemsResponseSchema>;

/**
 * Playlist member information
 */
export const playlistMemberSchema = z
    .object({
        author: publicAuthorSchema,
        role: memberRoleSchema.meta({ description: 'Member role in playlist' }),
        status: memberStatusSchema.meta({ description: 'Invitation status' }),
        invitedAt: z.string().meta({ description: 'ISO 8601 timestamp when invited' }),
    })
    .meta({ id: 'playlistMember' });

export type PlaylistMember = z.infer<typeof playlistMemberSchema>;

/** Query params for GET /api/playlists */
export const playlistsQuerySchema = z.object({
    type: playlistTypeSchema.optional(),
});

/** Query params for GET /api/playlists/[id] — filter items by media category */
export const playlistItemsQuerySchema = z.object({
    itemType: z.enum(['music', 'video']).optional(),
});

/**
 * Response: List of playlists — paginated bare collection.
 * New contract: { items: Playlist[], page: PageBlock } — no success/owned/shared wrapper.
 */
export const playlistsListResponseSchema = z
    .object({
        items: z
            .array(playlistSchema)
            .meta({ description: 'Playlists (owned + shared, role-discriminated)' }),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                nextCursor: z.string().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .meta({ description: 'Pagination block' }),
    })
    .meta({ id: 'playlistsListResponse' });

export type PlaylistsListResponse = z.infer<typeof playlistsListResponseSchema>;

/**
 * Response: Single playlist — bare object.
 * New contract: Playlist (no success/playlist wrapper).
 */
export const playlistResponseSchema = playlistSchema.meta({ id: 'playlistResponse' });

export type PlaylistResponse = z.infer<typeof playlistResponseSchema>;

/**
 * Response: List of playlist members — paginated.
 * New contract: { items: PlaylistMember[], page: PageBlock }
 */
export const playlistMembersResponseSchema = z
    .object({
        items: z
            .array(playlistMemberSchema)
            .meta({ description: 'Playlist members and their roles' }),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                nextCursor: z.string().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .meta({ description: 'Pagination block' }),
    })
    .meta({ id: 'playlistMembersResponse' });

export type PlaylistMembersResponse = z.infer<typeof playlistMembersResponseSchema>;

/** Response: Single bare member object (no success/member/timestamp wrapper). */
export type PlaylistMemberResponse = PlaylistMember;

/**
 * Response: Toggle watched status — bare object (no success wrapper).
 * New contract: { watched, watchedAt?, playlistSummary? }
 */
export const toggleWatchedResponseSchema = z
    .object({
        watched: z.boolean().meta({ description: 'New watched status' }),
        watchedAt: z
            .string()
            .optional()
            .meta({ description: 'ISO 8601 timestamp when item was watched' }),
        playlistSummary: playlistSummarySchema.optional().meta({
            description: 'Updated playlist summary after mutation',
        }),
    })
    .meta({ id: 'toggleWatchedResponse' });

export type ToggleWatchedResponse = z.infer<typeof toggleWatchedResponseSchema>;

/**
 * Minimal playlist info for invite responses
 */
export const invitePlaylistSchema = z
    .object({
        id: positiveIntSchema.meta({ description: 'Playlist ID' }),
        name: z.string().meta({ description: 'Playlist name' }),
        owner: publicAuthorSchema,
        role: z
            .enum(['editor', 'readonly'])
            .meta({ description: "New member's role in the playlist" }),
    })
    .meta({ id: 'invitePlaylist' });

/**
 * Response: Invite accepted — bare object (no success wrapper).
 * New contract: { message, playlist }
 */
export const inviteAcceptedResponseSchema = z
    .object({
        message: z.string().meta({ description: 'Success message' }),
        playlist: invitePlaylistSchema.meta({
            description: 'Joined playlist details',
        }),
    })
    .meta({ id: 'inviteAcceptedResponse' });

export type InviteAcceptedResponse = z.infer<typeof inviteAcceptedResponseSchema>;

/**
 * Response: Invite denied — bare object (no success wrapper).
 * New contract: { message }
 */
export const inviteDeniedResponseSchema = z
    .object({
        message: z.string().meta({ description: 'Success message' }),
    })
    .meta({ id: 'inviteDeniedResponse' });

export type InviteDeniedResponse = z.infer<typeof inviteDeniedResponseSchema>;

/**
 * User search result
 */
export const userSearchResultSchema = z
    .object({
        username: z.string().meta({ description: 'Username' }),
        id: z.string().meta({ description: 'User ID' }),
    })
    .meta({ id: 'userSearchResult' });

export type UserSearchResult = z.infer<typeof userSearchResultSchema>;

/**
 * Response: User search — paginated bare collection.
 * New contract: { items: UserSearchResult[], page: PageBlock }
 */
export const userSearchResponseSchema = z
    .object({
        items: z.array(userSearchResultSchema).meta({ description: 'Matching users' }),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                nextCursor: z.string().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .meta({ description: 'Pagination block' }),
    })
    .meta({ id: 'userSearchResponse' });

export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>;

// ============================================================================
// Chat Message Responses
// ============================================================================

/**
 * Chat message data
 */
export const chatMessageDataSchema = z
    .object({
        id: positiveIntSchema.meta({ description: 'Message ID' }),
        author: publicAuthorSchema,
        message: z.string().meta({ description: 'Message content' }),
        messageType: z.string().meta({ description: 'Message type (user or system)' }),
        createdAt: z.string().meta({ description: 'ISO 8601 timestamp' }),
    })
    .meta({ id: 'chatMessageData' });

export type ChatMessageData = z.infer<typeof chatMessageDataSchema>;

/**
 * Response: Chat messages list — paginated bare collection.
 * New contract: { items: ChatMessage[], page: { limit, hasMore, nextCursor? } }
 */
export const chatMessagesResponseSchema = z
    .object({
        items: z.array(chatMessageDataSchema).meta({ description: 'Chat messages' }),
        page: z
            .object({
                limit: z.number().int(),
                hasMore: z.boolean(),
                nextCursor: z.string().optional(),
            })
            .meta({ description: 'Pagination block' }),
    })
    .meta({ id: 'chatMessagesResponse' });

export type ChatMessagesResponse = z.infer<typeof chatMessagesResponseSchema>;

/**
 * Response: Single chat message created — bare ChatMessageData (no success wrapper).
 * New contract: ChatMessageData
 */
export const chatMessageCreatedResponseSchema = chatMessageDataSchema.meta({
    id: 'chatMessageCreatedResponse',
});

export type ChatMessageCreatedResponse = z.infer<typeof chatMessageCreatedResponseSchema>;

// ============================================================================
// Bulk Operations Responses
// ============================================================================

/**
 * Response: Bulk add items — bare object (no success wrapper).
 * New contract: { added, skipped, summary, playlistSummary? }
 */
/**
 * Response: Bulk delete items
 */
export const bulkDeleteResponseSchema = playlistSummarySchema;

export type BulkDeleteResponse = z.infer<typeof bulkDeleteResponseSchema>;

// ============================================================================
// Playback Context Response
// ============================================================================

/**
 * Playlist context for playback
 */
export const playlistContextSchema = z
    .object({
        playlistId: positiveIntSchema.meta({ description: 'Playlist ID' }),
        playlistName: z.string().meta({ description: 'Playlist name' }),
        currentPosition: z.number().int().min(0).meta({ description: 'Current position' }),
        totalItems: z.number().int().min(0).meta({ description: 'Total items in playlist' }),
    })
    .meta({ id: 'PlaylistContext' });

export type PlaylistContext = z.infer<typeof playlistContextSchema>;

/**
 * Response: Playback context
 */
export const playbackContextResponseSchema = z
    .object({
        playlist: z.object({
            id: positiveIntSchema,
            name: z.string(),
            totalItems: z.number().int().min(0),
        }),
        current: playlistEntrySchema,
        previous: playlistEntrySchema.nullable(),
        next: playlistEntrySchema.nullable(),
    })
    .meta({ id: 'playbackContextResponse' });

export type PlaybackContextResponse = z.infer<typeof playbackContextResponseSchema>;

// ============================================================================
// Progress Response
// ============================================================================

/**
 * Member progress information
 */
export const memberProgressSchema = z
    .object({
        userId: z.string().uuid(),
        watchedCount: z.number().int().min(0).meta({ description: 'Items watched' }),
        totalCount: z.number().int().min(0).meta({ description: 'Total playlist items' }),
        progressPercent: z
            .number()
            .int()
            .min(0)
            .max(100)
            .meta({ description: 'Progress percentage' }),
        lastWatchedAt: z.string().nullable().meta({ description: 'Last watched timestamp' }),
    })
    .meta({ id: 'memberProgress' });

export type MemberProgress = z.infer<typeof memberProgressSchema>;

/**
 * Item watcher info
 */
export const itemWatcherSchema = z
    .object({
        userId: z.string().uuid(),
    })
    .meta({ id: 'itemWatcher' });

export type ItemWatcher = z.infer<typeof itemWatcherSchema>;

/**
 * Response: Playlist progress
 */
export const playlistProgressResponseSchema = z
    .object({
        playlistId: positiveIntSchema.meta({ description: 'Playlist ID' }),
        totalItems: z.number().int().min(0).meta({ description: 'Total items' }),
        members: z.array(memberProgressSchema).meta({ description: 'Member progress stats' }),
        itemsWatchedBy: z.record(z.string(), z.array(itemWatcherSchema)).meta({
            description: 'Map of item_id to watchers',
        }),
    })
    .meta({ id: 'PlaylistProgressResponse' });

export type PlaylistProgressResponse = z.infer<typeof playlistProgressResponseSchema>;

// ============================================================================
// Simple Message Responses
// ============================================================================

/**
 * Simple message response
 */
export const messageResponseSchema = z
    .object({
        message: z.string().meta({ description: 'Response message' }),
    })
    .meta({ id: 'messageResponse' });

/**
 * Message response with playlist mutation summary.
 * Used by playlist mutation routes (delete item, reorder) that return a message + summary.
 */
export const playlistMessageResponseSchema = playlistSummarySchema;

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Response: Playlist item with metadata
 */
export const playlistItemWithMetadataResponseSchema = playlistSchema;

export type PlaylistItemWithMetadataResponse = z.infer<
    typeof playlistItemWithMetadataResponseSchema
>;

/**
 * Response: Playlist with items (GET /api/playlists/[id])
 */
export const getPlaylistResponseSchema = playlistSchema;

export type GetPlaylistResponse = z.infer<typeof getPlaylistResponseSchema>;

/**
 * Response: Member added — bare member object (no success/member/timestamp wrapper).
 * New contract: { author: PublicAuthor, role, status, invitedAt }
 */
export const memberAddedResponseSchema = playlistMemberSchema;

export type MemberAddedResponse = z.infer<typeof memberAddedResponseSchema>;

/**
 * Response: Members list — paginated.
 * New contract: { items: PlaylistMember[], page: PageBlock }
 */
export const membersListResponseSchema = z
    .object({
        items: z.array(playlistMemberSchema).meta({ description: 'Playlist members' }),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                nextCursor: z.string().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .meta({ description: 'Pagination block' }),
    })
    .meta({ id: 'membersListResponse' });

export type MembersListResponse = z.infer<typeof membersListResponseSchema>;

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * Backward-compatible PascalCase aliases
 * These schemas are now named in camelCase following project conventions,
 * but we maintain PascalCase exports for existing consumers.
 */
export { playlistContextSchema as PlaylistContextSchema };
export { playlistProgressResponseSchema as PlaylistProgressResponseSchema };
