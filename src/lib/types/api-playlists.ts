// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared API types for playlist endpoints.
 *
 * Response types are re-exported from Zod schemas in '$lib/schemas/playlists'.
 * Request types remain defined here for input validation.
 *
 * These types are used by BOTH the server (to build responses) and client (to consume them).
 * This ensures TypeScript catches property name mismatches at compile time.
 *
 * Convention:
 * - All property names use camelCase
 * - Database columns (snake_case) are transformed at the server boundary
 */

import type { Visibility } from './api-common';
import type { PlaylistType } from '$lib/schemas/playlists';

// =============================================================================
// Response Types (Re-exported from Schemas)
// =============================================================================

export type {
    PlaylistCoverItem,
    PlaylistSummary,
    Playlist,
    PlaylistEntry,
    PlaylistMember,
    PlaylistsListResponse,
    PlaylistResponse,
    GetPlaylistResponse,
    PlaylistMembersResponse,
    PlaylistMemberResponse,
    ToggleWatchedResponse,
    InviteAcceptedResponse,
    InviteDeniedResponse,
    UserSearchResult,
    UserSearchResponse,
} from '$lib/schemas/playlists';

// =============================================================================
// Request Types
// =============================================================================

export interface AddToPlaylistItemRequest {
    mediaIds: string[];
}

export interface CreatePlaylistRequest {
    name: string;
    description?: string;
    visibility?: Visibility;
    playlistType?: PlaylistType;
}

export interface UpdatePlaylistRequest {
    name?: string;
    description?: string;
    visibility?: Visibility;
    playlistType?: PlaylistType;
}

export interface ReorderItemsRequest {
    expectedRevision: number;
    entryIds: number[];
}

export interface InviteMemberRequest {
    /** Stable user UUID — used on the /api/playlists internal surface (POST /members). */
    userId: string;
    role: 'editor' | 'readonly';
}

export interface UpdateMemberRoleRequest {
    role: 'editor' | 'readonly';
}

export interface ToggleWatchedRequest {
    watched: boolean;
}

// =============================================================================
// Derived Types
// =============================================================================

// Import for the union type
import type {
    InviteAcceptedResponse as AcceptedResponse,
    InviteDeniedResponse as DeniedResponse,
} from '$lib/schemas/playlists';

/** Type alias for invite action responses */
export type InviteActionResponse = AcceptedResponse | DeniedResponse;
