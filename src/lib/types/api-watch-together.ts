// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Response types for Watch Together endpoints.
 *
 * Response types are re-exported from Zod schemas in '$lib/schemas/watch-together'.
 * Request types remain defined here for input validation.
 *
 * Used by BOTH the server (to build responses) and client (to consume them).
 *
 * Convention:
 * - All property names use camelCase
 * - Response types come from schemas (single source of truth)
 * - Request types defined locally (input validation)
 */

// `export type { … } from` below RE-EXPORTS but does not bind locally, so the
// request interfaces need a real import of the one type they reference.
import type { WatchTogetherMediaType } from '$lib/schemas/watch-together';

// =============================================================================
// Re-export Response Types from Schema
// =============================================================================

export type {
    // Core types
    WatchTogetherParty,
    WatchTogetherParticipant,
    WatchTogetherState,
    // Session creation/join
    CreatePartyResponse,
    JoinPartyResponse,
    GetPartyResponse,
    // Session actions
    SyncResponse,
    SeekResponse,
    NavigateResponse,
    LeaveSessionResponse,
    DisbandSessionResponse,
    // Position check
    PositionCheckResponse,
    // Host actions
    TransferHostResponse,
    SetVisibilityResponse,
    // Public sessions
    PublicParty,
    PublicPartiesResponse,
    WatchTogetherMediaType,
} from '$lib/schemas/watch-together';

// =============================================================================
// Request Types
// =============================================================================

export interface CreateSessionRequest {
    visibility?: 'unlisted' | 'listed';
    itemId: string;
    // Was a hand-rolled 3-token copy of watchTogetherMediaTypeSchema, which is
    // ['movie','episode','tv','series'] — so 'series' (what the player actually
    // holds) was rejected here despite being valid on the wire.
    mediaType: WatchTogetherMediaType;
    title: string;
    posterUrl?: string;
    currentTime?: number;
    fileId?: string;
    clientId: string;
}

export interface JoinSessionRequest {
    clientId: string;
}

export interface SyncRequest {
    syncId?: string;
    expectedTimelineId?: string;
    itemId?: string;
    currentTime: number;
    isPlaying: boolean;
    playbackRate: number;
    clientId: string;
}

export interface SeekRequest {
    expectedTimelineId?: string;
    itemId?: string;
    currentTime: number;
    clientId: string;
    /** Whether playback should resume after seek. */
    isPlaying: boolean;
}

export interface NavigateRequest {
    expectedTimelineId?: string;
    timelineId?: string;
    itemId: string;
    title: string;
    mediaType?: 'movie' | 'episode' | 'tv';
    clientId: string;
    fileId?: string;
}

export interface VersionChangeRequest {
    fileId: string;
    clientId: string;
}

export interface PositionRequest {
    clientId: string;
    position: number;
}

export interface ReadyRequest {
    clientId: string;
    checkId: string;
    currentTime: number;
}

export interface StallRequest {
    expectedTimelineId?: string;
    clientId: string;
    stallId: string;
}

export interface ActivityRequest {
    activity: 'watching' | 'searching' | 'browsing';
    message?: string;
}

export interface ReactionRequest {
    emoji: string;
}

export interface EffectRequest {
    effect: string;
}

export interface TransferHostRequest {
    newHostUserId: string;
}

export interface SetVisibilityRequest {
    visibility: 'unlisted' | 'listed';
}

export interface LeaveRequest {
    clientId: string;
}

export interface HeartbeatRequest {
    expectedTimelineId?: string;
    itemId?: string;
    currentTime: number;
    clientId: string;
    /** Host's true play state — persisted host-only so session.isPlaying self-heals. */
    isPlaying: boolean;
}

export interface StallReadyRequest {
    clientId: string;
    stallId: string;
}
