// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API domain module
 *
 * Typed functions for all watch-together session endpoints including
 * session management, playback sync, social features, and host controls.
 *
 * All responses are validated with Zod schemas for type safety.
 */

import { apiGet, apiPost, apiDelete } from './client.js';
import { sendDeviceCommand } from './device-commands.js';
import {
    CreatePartyResponseSchema,
    JoinPartyResponseSchema,
    GetPartyResponseSchema,
    NoContentResponseSchema,
    EventAcceptedResponseSchema,
    PositionCheckResponseSchema,
    PublicPartiesResponseSchema,
} from '$lib/schemas/watch-together';
import type {
    CreateSessionRequest,
    JoinSessionRequest,
    SyncRequest,
    SeekRequest,
    NavigateRequest,
    VersionChangeRequest,
    PositionRequest,
    ReadyRequest,
    StallRequest,
    StallReadyRequest,
    ActivityRequest,
    ReactionRequest,
    EffectRequest,
    TransferHostRequest,
    SetVisibilityRequest,
    LeaveRequest,
    HeartbeatRequest,
} from '$lib/types/api-watch-together';

// Re-export types for convenience
export type {
    CreatePartyResponse,
    JoinPartyResponse,
    GetPartyResponse,
    PublicPartiesResponse,
    PublicParty,
    PositionCheckResponse,
} from '$lib/schemas/watch-together';

// =========================================================================
// Session Management
// =========================================================================

export function getCurrentSession() {
    return apiGet('/api/watch-together', GetPartyResponseSchema);
}

export function getSession(code: string) {
    return apiGet(
        `/api/watch-together/${encodeURIComponent(code.toUpperCase())}`,
        GetPartyResponseSchema,
    );
}

export function createSession(body: CreateSessionRequest) {
    return apiPost('/api/watch-together/parties', CreatePartyResponseSchema, body);
}

export function joinSession(code: string, body: JoinSessionRequest) {
    return apiPost(`/api/watch-together/${code.toUpperCase()}/join`, JoinPartyResponseSchema, body);
}

export function leaveSession(code: string, body: LeaveRequest) {
    return apiPost(`/api/watch-together/${code}/leave`, NoContentResponseSchema, body);
}

export function disbandSession(code: string) {
    return apiPost(`/api/watch-together/${code}/disband`, NoContentResponseSchema);
}

/** DELETE method for disbanding from WatchParties component */
export function deleteSession(code: string) {
    return apiDelete(`/api/watch-together/${code}`, NoContentResponseSchema);
}

// =========================================================================
// Public Sessions
// =========================================================================

export function getPublicParties() {
    return apiGet('/api/watch-together/parties', PublicPartiesResponseSchema);
}

// =========================================================================
// Playback Sync
// =========================================================================

export function syncPlayback(code: string, body: SyncRequest) {
    return apiPost(`/api/watch-together/${code}/sync`, NoContentResponseSchema, body);
}

export function broadcastSeek(code: string, body: SeekRequest) {
    return apiPost(`/api/watch-together/${code}/seek`, NoContentResponseSchema, body);
}

export function broadcastNavigate(code: string, body: NavigateRequest) {
    const { clientId, ...payload } = body;
    return apiPost(`/api/watch-together/${code}/events`, EventAcceptedResponseSchema, {
        clientId,
        type: 'navigate',
        payload,
    });
}

export function broadcastVersionChange(code: string, body: VersionChangeRequest) {
    return apiPost(`/api/watch-together/${code}/version`, NoContentResponseSchema, body);
}

export function reportPosition(code: string, body: PositionRequest) {
    return apiPost(`/api/watch-together/${code}/position`, PositionCheckResponseSchema, body);
}

// =========================================================================
// Heartbeat & Ready State
// =========================================================================

export function sendHeartbeat(code: string, body: HeartbeatRequest) {
    return apiPost(`/api/watch-together/${code}/heartbeat`, NoContentResponseSchema, body);
}

export function signalReady(code: string, body: ReadyRequest) {
    return apiPost(`/api/watch-together/${code}/ready`, NoContentResponseSchema, body);
}

export function reportStall(code: string, body: StallRequest) {
    return apiPost(`/api/watch-together/${code}/stall`, NoContentResponseSchema, body);
}

export function reportStallReady(code: string, body: StallReadyRequest) {
    return apiPost(`/api/watch-together/${code}/stall-ready`, NoContentResponseSchema, body);
}

// =========================================================================
// Social Features
// =========================================================================

export function broadcastActivity(code: string, body: ActivityRequest) {
    return apiPost(`/api/watch-together/${code}/activity`, NoContentResponseSchema, body);
}

export function sendReaction(code: string, body: ReactionRequest) {
    return apiPost(`/api/watch-together/${code}/reaction`, NoContentResponseSchema, body);
}

export function sendScreenEffect(code: string, body: EffectRequest) {
    return apiPost(`/api/watch-together/${code}/effect`, NoContentResponseSchema, body);
}

// =========================================================================
// Host Controls
// =========================================================================

export function transferHost(code: string, body: TransferHostRequest) {
    return apiPost(`/api/watch-together/${code}/transfer-host`, NoContentResponseSchema, body);
}

export function setVisibility(code: string, body: SetVisibilityRequest) {
    return apiPost(`/api/watch-together/${code}/visibility`, NoContentResponseSchema, body);
}

// =========================================================================
// Send to Device
// =========================================================================

/**
 * Invite one of the user's devices to the party with a `party.join` command.
 * The device must announce `party.join` in its capabilities.
 */
export function sendToDevice(code: string, deviceSessionId: string) {
    return sendDeviceCommand(deviceSessionId, { type: 'party.join', args: { code } });
}
