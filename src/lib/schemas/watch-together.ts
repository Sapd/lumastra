// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for Watch Together API routes
 *
 * Provides validation for watch party operations including session management,
 * playback synchronization, reactions, and effects.
 */

import { z } from 'zod';
import { publicAuthorSchema } from './public-author';
import {
    positionSecondsSchema,
    nonEmptyStringSchema,
    optionalStringSchema,
    nullableOptionalStringSchema,
} from './common';
import { REACTION_EMOJIS, SCREEN_EFFECTS } from '$lib/types/watch-together';
import { ReactionEmojiSchema, ScreenEffectSchema } from './watch-together-core-types';

// ============================================================================
// Media Types for Watch Together
// ============================================================================

/**
 * Media types accepted as INPUT when creating or navigating a watch party.
 *
 * Lenient on purpose: `tv` is still accepted from older clients. It is NOT a
 * response vocabulary — see {@link watchTogetherPublicMediaTypeSchema}.
 */
export const watchTogetherMediaTypeSchema = z
    .enum(['movie', 'episode', 'tv', 'series'])
    .meta({ id: 'watchTogetherMediaType' });
export type WatchTogetherMediaType = z.infer<typeof watchTogetherMediaTypeSchema>;

/**
 * Media types EMITTED on a watch-party session.
 *
 * The session's `mediaType` used to be whatever spelling the creating client
 * happened to send, stored and echoed back verbatim — so the same field could
 * come back as `tv` or `series` depending on which client opened the party,
 * and no consumer could rely on either. `canonicalWatchTogetherMediaType()` now
 * normalises on write, so this narrower enum is what readers actually get.
 */
export const watchTogetherPublicMediaTypeSchema = z
    .enum(['movie', 'episode', 'series'])
    .meta({ id: 'watchTogetherPublicMediaType' });
export type WatchTogetherPublicMediaType = z.infer<typeof watchTogetherPublicMediaTypeSchema>;

/**
 * Normalise an accepted input token to the canonical stored/emitted one.
 *
 * Inline rather than toPublicMediaType(): the input union is closed to
 * movie|episode|tv|series, so the pass-through arm cannot carry a token the
 * public vocabulary has no member for — and `episode` is a legitimate party
 * media type that toPublicMediaType() maps away. See
 * docs/dev/media-type-vocabulary.md, "When a hand-written conversion IS correct".
 */
export function canonicalWatchTogetherMediaType(
    mediaType: WatchTogetherMediaType,
): WatchTogetherPublicMediaType {
    return mediaType === 'tv' ? 'series' : mediaType;
}

// ============================================================================
// Session Management Schemas
// ============================================================================

/**
 * Schema for creating a new watch together session
 * POST /api/watch-together
 */
export const createSessionSchema = z
    .object({
        visibility: z.enum(['unlisted', 'listed']).default('unlisted'),
        itemId: nonEmptyStringSchema,
        mediaType: watchTogetherMediaTypeSchema,
        title: nonEmptyStringSchema,
        // nullable: non-Swift clients may send `null` instead of omitting the key
        posterUrl: nullableOptionalStringSchema,
        currentTime: z
            .number()
            .min(0)
            .optional()
            .describe(
                'File-absolute position in seconds. Omitted starts at the selected episode entry; explicit zero starts at the file beginning.',
            ),
        fileId: nullableOptionalStringSchema,
        clientId: nonEmptyStringSchema,
    })
    .meta({ id: 'createSession' });

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/**
 * Schema for session code path parameter
 * Used across all /api/watch-together/[code]/* routes
 */
export const sessionCodeParamsSchema = z
    .object({
        code: nonEmptyStringSchema,
    })
    .meta({ id: 'sessionCodeParams' });

export type SessionCodeParams = z.infer<typeof sessionCodeParamsSchema>;

// ============================================================================
// Participant Operations Schemas
// ============================================================================

/**
 * Schema for joining a session
 * POST /api/watch-together/[code]/join
 */
export const joinSessionSchema = z
    .object({
        clientId: nonEmptyStringSchema,
    })
    .meta({ id: 'joinSession' });

export type JoinSessionInput = z.infer<typeof joinSessionSchema>;

/**
 * Schema for leaving a session
 * POST /api/watch-together/[code]/leave
 */
export const leaveSessionSchema = z
    .object({
        clientId: nonEmptyStringSchema,
    })
    .meta({ id: 'leaveSession' });

export type LeaveSessionInput = z.infer<typeof leaveSessionSchema>;

// ============================================================================
// Playback Synchronization Schemas
// ============================================================================

/**
 * Schema for seek operation
 * POST /api/watch-together/[code]/seek
 */
export const seekSchema = z
    .object({
        expectedTimelineId: nonEmptyStringSchema.optional(),
        itemId: nonEmptyStringSchema.optional(),
        currentTime: positionSecondsSchema,
        clientId: nonEmptyStringSchema,
        isPlaying: z.boolean(),
    })
    .meta({ id: 'seek' });

export type SeekInput = z.infer<typeof seekSchema>;

/**
 * Schema for syncing playback state
 * POST /api/watch-together/[code]/sync
 */
export const syncStateSchema = z
    .object({
        syncId: z
            .string()
            .uuid()
            .optional()
            .describe('Client request identity for canonical synchronization confirmation'),
        expectedTimelineId: nonEmptyStringSchema.optional(),
        itemId: nonEmptyStringSchema.optional(),
        currentTime: positionSecondsSchema,
        isPlaying: z.boolean(),
        playbackRate: z.number().min(0.25).max(4).optional().default(1),
        clientId: nonEmptyStringSchema,
    })
    .meta({ id: 'syncState' });

export type SyncStateInput = z.infer<typeof syncStateSchema>;

/**
 * Schema for position update (drift detection)
 * POST /api/watch-together/[code]/position
 */
export const positionUpdateSchema = z
    .object({
        position: positionSecondsSchema,
        clientId: nonEmptyStringSchema,
    })
    .meta({ id: 'positionUpdate' });

export type PositionUpdateInput = z.infer<typeof positionUpdateSchema>;

/**
 * Schema for heartbeat (keep session alive)
 * POST /api/watch-together/[code]/heartbeat
 */
export const heartbeatSchema = z
    .object({
        expectedTimelineId: nonEmptyStringSchema.optional(),
        itemId: nonEmptyStringSchema.optional(),
        currentTime: positionSecondsSchema,
        clientId: nonEmptyStringSchema,
        // Host's true play state. Persisted host-only so session.isPlaying
        // self-heals to the host's reality.
        isPlaying: z.boolean(),
    })
    .meta({ id: 'heartbeat' });

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

// ============================================================================
// Buffer/Ready Schemas
// ============================================================================

/**
 * Schema for signaling ready state after buffering
 * POST /api/watch-together/[code]/ready
 */
export const readySchema = z
    .object({
        clientId: nonEmptyStringSchema,
        checkId: nonEmptyStringSchema,
        currentTime: z.number().min(0).optional(),
    })
    .meta({ id: 'ready' });

export type ReadyInput = z.infer<typeof readySchema>;

/**
 * Schema for reporting stall (buffering)
 * POST /api/watch-together/[code]/stall
 */
export const stallSchema = z
    .object({
        clientId: nonEmptyStringSchema,
        stallId: nonEmptyStringSchema,
        expectedTimelineId: nonEmptyStringSchema.optional(),
    })
    .meta({ id: 'stall' });

export type StallInput = z.infer<typeof stallSchema>;

/**
 * Schema for reporting ready after stall
 * POST /api/watch-together/[code]/stall-ready
 */
export const stallReadySchema = z
    .object({
        clientId: nonEmptyStringSchema,
        stallId: nonEmptyStringSchema,
    })
    .meta({ id: 'stallReady' });

export type StallReadyInput = z.infer<typeof stallReadySchema>;

// ============================================================================
// Interactive Features Schemas
// ============================================================================

// Extract valid emoji values from REACTION_EMOJIS constant
// Safe: REACTION_EMOJIS is a compile-time constant with 8+ elements
const reactionEmojiValues = REACTION_EMOJIS as readonly [string, ...string[]];

/**
 * Schema for sending a reaction
 * POST /api/watch-together/[code]/reaction
 */
export const reactionSchema = z
    .object({
        emoji: z.enum(reactionEmojiValues),
    })
    .meta({ id: 'reaction' });

export type ReactionInput = z.infer<typeof reactionSchema>;

// Extract valid effect IDs from SCREEN_EFFECTS constant
// Safe: SCREEN_EFFECTS is a compile-time constant with 10+ elements
const screenEffectIds = SCREEN_EFFECTS.map((e) => e.id) as [string, ...string[]];

/**
 * Schema for sending a screen effect
 * POST /api/watch-together/[code]/effect
 */
export const effectSchema = z
    .object({
        effect: z.enum(screenEffectIds),
    })
    .meta({ id: 'effect' });

export type EffectInput = z.infer<typeof effectSchema>;

// ============================================================================
// Navigation Schemas
// ============================================================================

/**
 * Schema for navigating to new media
 * POST /api/watch-together/[code]/navigate
 */
export const navigateSchema = z
    .object({
        timelineId: z.uuid().optional(),
        expectedTimelineId: z.string().optional(),
        itemId: nonEmptyStringSchema,
        mediaType: watchTogetherMediaTypeSchema,
        title: nonEmptyStringSchema,
        // nullable: tolerate `null` from clients that don't omit absent keys
        posterUrl: nullableOptionalStringSchema,
        clientId: nonEmptyStringSchema,
        fileId: nullableOptionalStringSchema,
    })
    .meta({ id: 'navigate' });

export type NavigateInput = z.infer<typeof navigateSchema>;

/**
 * Schema for version/media source change
 * POST /api/watch-together/[code]/version
 */
export const versionChangeSchema = z
    .object({
        fileId: nonEmptyStringSchema,
        clientId: nonEmptyStringSchema,
    })
    .meta({ id: 'versionChange' });

export type VersionChangeInput = z.infer<typeof versionChangeSchema>;

// ============================================================================
// Session Control Schemas
// ============================================================================

/**
 * Schema for changing session visibility
 * POST /api/watch-together/[code]/visibility
 */
export const visibilityChangeSchema = z
    .object({
        visibility: z.enum(['unlisted', 'listed']),
    })
    .meta({ id: 'visibilityChange' });

export type VisibilityChangeInput = z.infer<typeof visibilityChangeSchema>;

/**
 * Schema for transferring host
 * POST /api/watch-together/[code]/transfer-host
 */
export const transferHostSchema = z
    .object({
        newHostUserId: z.uuid(),
    })
    .meta({ id: 'transferHost' });

export type TransferHostInput = z.infer<typeof transferHostSchema>;

// ============================================================================
// Host Activity Schema
// ============================================================================

/**
 * Valid host activity types
 */
export const hostActivityTypeSchema = z
    .enum(['watching', 'searching', 'browsing'])
    .meta({ id: 'hostActivityType' });

/**
 * Schema for host activity broadcast
 * POST /api/watch-together/[code]/activity
 */
export const hostActivitySchema = z
    .object({
        activity: hostActivityTypeSchema,
        message: optionalStringSchema,
    })
    .meta({ id: 'hostActivity' });

export type HostActivityInput = z.infer<typeof hostActivitySchema>;

// ============================================================================
// Send to Device Schemas
// ============================================================================

/**
 * Schema for sending watch party invite to device
 * POST /api/watch-together/[code]/send-to-device
 */
export const watchTogetherSendToDeviceSchema = z
    .object({
        deviceId: nonEmptyStringSchema,
        position: positionSecondsSchema.optional(),
    })
    .meta({ id: 'watchTogetherSendToDevice' });

export type WatchTogetherSendToDeviceInput = z.infer<typeof watchTogetherSendToDeviceSchema>;

/**
 * Schema for sending watch party invite to device via public API.
 */
export const publicWatchTogetherSendToDeviceSchema = z
    .object({
        deviceSessionId: nonEmptyStringSchema,
    })
    .meta({ id: 'publicWatchTogetherSendToDevice' });

export type PublicWatchTogetherSendToDeviceInput = z.infer<
    typeof publicWatchTogetherSendToDeviceSchema
>;

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Schema for WatchTogetherParticipant objects
 */
export const WatchTogetherParticipantSchema = z
    .object({
        ...publicAuthorSchema.shape,
        joinedAt: z.number().describe('Unix timestamp (milliseconds) when participant joined'),
        clientId: nonEmptyStringSchema.describe(
            'Unique client ID - allows same user to join from multiple devices',
        ),
    })
    .meta({ id: 'WatchTogetherParticipant' });

export type WatchTogetherParticipant = z.infer<typeof WatchTogetherParticipantSchema>;

/**
 * Schema for WatchTogetherState objects
 */
export const WatchTogetherStateSchema = z
    .object({
        currentTime: positionSecondsSchema.describe('Current playback position in seconds'),
        isPlaying: z.boolean().describe('Whether playback is active'),
        playbackRate: z.number().min(0.25).max(4).describe('Playback speed multiplier (0.25-4.0)'),
        timestamp: z.number().describe('Unix timestamp (milliseconds) when state was captured'),
        fileId: optionalStringSchema.describe(
            'Selected file/version ID (synced so all viewers use same version)',
        ),
    })
    .meta({ id: 'WatchTogetherState' });

export type WatchTogetherState = z.infer<typeof WatchTogetherStateSchema>;

/**
 * Schema for WatchTogetherParty objects
 */
export const WatchTogetherPartySchema = z
    .object({
        code: nonEmptyStringSchema.describe('Short shareable code (e.g., "MOVIE-7X3K")'),
        host: publicAuthorSchema,
        hostClientId: z
            .string()
            .optional()
            .describe('Host client ID - identifies specific device/tab that is the host'),
        itemId: nonEmptyStringSchema.describe('Internal media UUID being watched'),
        timelineId: z.string().optional().describe('Current item timeline identity'),
        mediaType: watchTogetherPublicMediaTypeSchema.describe(
            'Media type — canonical `series`, never the internal `tv` (normalised on write)',
        ),
        title: nonEmptyStringSchema.describe('Title of the media being watched'),
        posterUrl: z.string().optional().describe('Poster image URL'),
        fileId: z.string().optional().describe('Selected file/version ID (e.g., 4K vs 1080p)'),
        currentTime: positionSecondsSchema.describe('Current playback position in seconds'),
        isPlaying: z.boolean().describe('Whether playback is active'),
        playbackRate: z.number().min(0.25).max(4).describe('Playback speed multiplier (0.25-4.0)'),
        createdAt: z.number().describe('Unix timestamp (milliseconds) when session was created'),
        lastSync: z.number().describe('Unix timestamp (milliseconds) of last sync event'),
        participants: z
            .array(WatchTogetherParticipantSchema)
            .describe('Session participants (including host)'),
        visibility: z
            .enum(['unlisted', 'listed'])
            .describe('Whether the session is publicly visible on the homepage'),
    })
    .meta({ id: 'WatchTogetherParty' });

export type WatchTogetherParty = z.infer<typeof WatchTogetherPartySchema>;

/**
 * Schema for create session response
 * POST /api/watch-together
 * POST /api/v1/watch-together
 *
 * Bare object — no success wrapper.
 */
export const CreatePartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema.describe('The created watch together session'),
    })
    .meta({ id: 'CreatePartyResponse' });

export type CreatePartyResponse = z.infer<typeof CreatePartyResponseSchema>;

/**
 * Schema for join session response
 * POST /api/watch-together/[code]/join
 *
 * Bare object — no success wrapper.
 */
export const JoinPartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema.describe('The joined watch together session'),
    })
    .meta({ id: 'JoinPartyResponse' });

export type JoinPartyResponse = z.infer<typeof JoinPartyResponseSchema>;

/**
 * Schema for get active session response
 * GET /api/watch-together
 *
 * Bare object — no success wrapper.
 */
export const GetPartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema.nullable().describe(
            'The watch together session, or null if not in any session',
        ),
    })
    .meta({ id: 'GetPartyResponse' });

export type GetPartyResponse = z.infer<typeof GetPartyResponseSchema>;

/**
 * Schema for 204 No Content responses
 * POST /api/watch-together/[code]/sync
 * POST /api/watch-together/[code]/seek
 * POST /api/watch-together/[code]/navigate
 * POST /api/watch-together/[code]/leave
 * POST /api/watch-together/[code]/disband
 * POST /api/watch-together/[code]/transfer-host
 * POST /api/watch-together/[code]/visibility
 * (and all other action endpoints)
 */
export const NoContentResponseSchema = z.null().meta({ id: 'WT_NoContent' });

export type NoContentResponse = z.infer<typeof NoContentResponseSchema>;

// Aliases kept for backward-compat within this module (all map to 204 No Content)
export const SyncResponseSchema = NoContentResponseSchema;
export type SyncResponse = NoContentResponse;

export const SeekResponseSchema = NoContentResponseSchema;
export type SeekResponse = NoContentResponse;

export const NavigateResponseSchema = NoContentResponseSchema;
export type NavigateResponse = NoContentResponse;

export const LeaveSessionResponseSchema = NoContentResponseSchema;
export type LeaveSessionResponse = NoContentResponse;

export const DisbandSessionResponseSchema = NoContentResponseSchema;
export type DisbandSessionResponse = NoContentResponse;

export const TransferHostResponseSchema = NoContentResponseSchema;
export type TransferHostResponse = NoContentResponse;

export const SetVisibilityResponseSchema = NoContentResponseSchema;
export type SetVisibilityResponse = NoContentResponse;

/**
 * Schema for position check response
 * POST /api/watch-together/[code]/position
 *
 * Bare object — no success wrapper.
 */
export const PositionCheckResponseSchema = z
    .object({
        resyncing: z.boolean().describe('True if server detected drift and is triggering a resync'),
    })
    .meta({ id: 'PositionCheckResponse' });

export type PositionCheckResponse = z.infer<typeof PositionCheckResponseSchema>;

/**
 * Schema for a public session item in the sessions listing.
 * Matches PublicWatchTogetherPartySchema from defs/watch-together/parties.ts.
 * Canonical mediaType — 'series' replaces 'tv'/'show'.
 */
export const PublicPartySchema = z
    .object({
        code: nonEmptyStringSchema.describe('Session code'),
        host: publicAuthorSchema,
        title: nonEmptyStringSchema.describe('Media title being watched'),
        mediaType: z
            .enum(['movie', 'episode', 'series'])
            .describe('Canonical media type (series replaces tv/show)'),
        isPlaying: z.boolean().describe('Whether playback is currently active'),
        participantCount: z.number().min(0).describe('Number of participants (connected devices)'),
        createdAt: z.number().describe('Unix timestamp (ms) when session was created'),
        visibility: z
            .enum(['unlisted', 'listed'])
            .describe('Whether the session is publicly listed'),
    })
    .meta({ id: 'PublicParty' });

export type PublicParty = z.infer<typeof PublicPartySchema>;

/**
 * Pagination metadata block.
 */
const PageMetaSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

/**
 * Schema for public sessions list response
 * GET /api/watch-together/parties → paginate({ items: PublicParty[], page })
 */
export const PublicPartiesResponseSchema = z
    .object({
        items: z.array(PublicPartySchema).describe('List of public watch together sessions'),
        page: PageMetaSchema.describe('Pagination metadata'),
    })
    .meta({ id: 'PublicPartiesResponse' });

export type PublicPartiesResponse = z.infer<typeof PublicPartiesResponseSchema>;

// ============================================================================
// Unified Event Channel Schemas
// POST /api/v1/watch-together/{code}/events  {clientId, type, payload}
// GET  /api/v1/watch-together/{code}/events  SSE
// ============================================================================

/**
 * Closed event type enum for the unified event channel.
 *
 * Groups:
 *   (a) broadcasts (any participant): seek, sync, position, reaction, effect
 *   (b) authoritative (host-only):    navigate, version, visibility, transfer-host,
 *                                     disband, activity
 *   (c) barriers (any participant):   join, leave, ready, stall, stall-ready, heartbeat
 */
export const watchTogetherEventTypeSchema = z
    .enum([
        // (a) broadcasts
        'seek',
        'sync',
        'position',
        'reaction',
        'effect',
        // (b) authoritative (host-only set enforced in-handler)
        'navigate',
        'version',
        'visibility',
        'transfer-host',
        'disband',
        'activity',
        // (c) barriers
        'join',
        'leave',
        'ready',
        'stall',
        'stall-ready',
        'heartbeat',
    ])
    .meta({ id: 'watchTogetherEventType' });

export type WatchTogetherEventType = z.infer<typeof watchTogetherEventTypeSchema>;

/** Host-only event types (enforced in-handler, defense-in-depth mirror of service checks). */
export const WATCH_TOGETHER_HOST_ONLY_EVENTS: readonly WatchTogetherEventType[] = [
    'navigate',
    'version',
    'visibility',
    'transfer-host',
    'disband',
    'activity',
] as const;

// Per-type payload schemas (clientId is hoisted to the envelope, not repeated here)

const seekPayloadSchema = z.object({
    expectedTimelineId: nonEmptyStringSchema.optional(),
    itemId: nonEmptyStringSchema.optional(),
    currentTime: positionSecondsSchema,
    // Whether playback should resume after the seek. A seek-while-paused sends false.
    isPlaying: z.boolean(),
});

const syncPayloadSchema = z.object({
    syncId: z
        .string()
        .uuid()
        .optional()
        .describe('Client request identity for canonical synchronization confirmation'),
    expectedTimelineId: nonEmptyStringSchema.optional(),
    itemId: nonEmptyStringSchema.optional(),
    currentTime: positionSecondsSchema,
    isPlaying: z.boolean(),
    playbackRate: z.number().min(0.25).max(4).optional().default(1),
});

const positionPayloadSchema = z.object({
    position: positionSecondsSchema,
});

const reactionPayloadSchema = z.object({
    emoji: z.enum(REACTION_EMOJIS as readonly [string, ...string[]]),
});

const effectPayloadSchema = z.object({
    effect: z.enum(SCREEN_EFFECTS.map((e) => e.id) as [string, ...string[]]),
});

const navigatePayloadSchema = z.object({
    timelineId: z.uuid().optional(),
    expectedTimelineId: z.string().optional(),
    itemId: nonEmptyStringSchema,
    mediaType: watchTogetherMediaTypeSchema,
    title: nonEmptyStringSchema,
    // nullable: tolerate `null` from clients that don't omit absent keys
    posterUrl: nullableOptionalStringSchema,
    fileId: nullableOptionalStringSchema,
});

const versionPayloadSchema = z.object({
    fileId: nonEmptyStringSchema,
});

const visibilityPayloadSchema = z.object({
    visibility: z.enum(['unlisted', 'listed']),
});

const transferHostPayloadSchema = z.object({
    newHostUserId: z.uuid(),
});

const disbandPayloadSchema = z.object({});

const activityPayloadSchema = z.object({
    activity: z.enum(['watching', 'searching', 'browsing']),
    message: z.string().trim().max(200).optional(),
});

const joinPayloadSchema = z.object({});

const leavePayloadSchema = z.object({});

const readyPayloadSchema = z.object({
    checkId: nonEmptyStringSchema,
    currentTime: z.number().min(0).optional(),
});

const stallPayloadSchema = z.object({
    stallId: nonEmptyStringSchema,
    expectedTimelineId: nonEmptyStringSchema.optional(),
});

const stallReadyPayloadSchema = z.object({ stallId: nonEmptyStringSchema });

const heartbeatPayloadSchema = z.object({
    expectedTimelineId: nonEmptyStringSchema.optional(),
    itemId: nonEmptyStringSchema.optional(),
    currentTime: positionSecondsSchema,
    // Host's true play state (persisted host-only).
    isPlaying: z.boolean(),
});

/**
 * Discriminated union for POST /api/v1/watch-together/{code}/events body.
 *
 * `clientId` is hoisted to the envelope. `type` is the discriminator. `payload` carries the per-type
 * data as a nested object so adding fields never changes the envelope shape.
 *
 * Maps 1:1 onto a future WebSocket message with zero schema change.
 */
export const watchTogetherEventInputSchema = z
    .discriminatedUnion('type', [
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('seek'),
                payload: seekPayloadSchema,
            })
            .meta({ id: 'WatchTogetherSeekCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('sync'),
                payload: syncPayloadSchema,
            })
            .meta({ id: 'WatchTogetherSyncCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('position'),
                payload: positionPayloadSchema,
            })
            .meta({ id: 'WatchTogetherPositionCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('reaction'),
                payload: reactionPayloadSchema,
            })
            .meta({ id: 'WatchTogetherReactionCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('effect'),
                payload: effectPayloadSchema,
            })
            .meta({ id: 'WatchTogetherEffectCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('navigate'),
                payload: navigatePayloadSchema,
            })
            .meta({ id: 'WatchTogetherNavigateCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('version'),
                payload: versionPayloadSchema,
            })
            .meta({ id: 'WatchTogetherVersionCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('visibility'),
                payload: visibilityPayloadSchema,
            })
            .meta({ id: 'WatchTogetherVisibilityCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('transfer-host'),
                payload: transferHostPayloadSchema,
            })
            .meta({ id: 'WatchTogetherTransferHostCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('disband'),
                payload: disbandPayloadSchema.optional(),
            })
            .meta({ id: 'WatchTogetherDisbandCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('activity'),
                payload: activityPayloadSchema,
            })
            .meta({ id: 'WatchTogetherActivityCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('join'),
                payload: joinPayloadSchema.optional(),
            })
            .meta({ id: 'WatchTogetherJoinCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('leave'),
                payload: leavePayloadSchema.optional(),
            })
            .meta({ id: 'WatchTogetherLeaveCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('ready'),
                payload: readyPayloadSchema,
            })
            .meta({ id: 'WatchTogetherReadyCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('stall'),
                payload: stallPayloadSchema,
            })
            .meta({ id: 'WatchTogetherStallCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('stall-ready'),
                payload: stallReadyPayloadSchema,
            })
            .meta({ id: 'WatchTogetherStallReadyCommand' }),
        z
            .object({
                clientId: nonEmptyStringSchema,
                type: z.literal('heartbeat'),
                payload: heartbeatPayloadSchema,
            })
            .meta({ id: 'WatchTogetherHeartbeatCommand' }),
    ])
    .meta({ id: 'watchTogetherEventInput' });

export type WatchTogetherEventInput = z.infer<typeof watchTogetherEventInputSchema>;

/**
 * Schema for the SSE GET endpoint query parameters.
 * GET /api/v1/watch-together/{code}/events?clientId=&lastEventId=
 */
export const watchTogetherEventsQuerySchema = z
    .object({
        clientId: nonEmptyStringSchema,
        lastEventId: z.string().optional(),
    })
    .meta({ id: 'watchTogetherEventsQuery' });

export type WatchTogetherEventsQuery = z.infer<typeof watchTogetherEventsQuerySchema>;

/**
 * Response schemas for the events endpoint.
 */

/** POST /events default: 202 Accepted, empty body */
export const EventAcceptedResponseSchema = z
    .object({
        accepted: z.literal(true),
        currentTime: z
            .number()
            .nonnegative()
            .optional()
            .describe('Canonical file position after navigation, in seconds'),
    })
    .meta({ id: 'EventAccepted' });

/** POST /events: position type returns 200 {resyncing} */
export const EventPositionResponseSchema = z
    .object({
        resyncing: z.boolean(),
    })
    .meta({ id: 'EventPositionResponse' });

/** POST /events: join type returns 200 {session} */
export const EventJoinResponseSchema = z
    .object({
        party: WatchTogetherPartySchema,
    })
    .meta({ id: 'EventJoinResponse' });

export type EventAccepted = z.infer<typeof EventAcceptedResponseSchema>;
export type EventPositionResponse = z.infer<typeof EventPositionResponseSchema>;
export type EventJoinResponse = z.infer<typeof EventJoinResponseSchema>;

// Wire payloads for the session SSE stream. Business frames use the default SSE event.
// Use object (unknown wire keys are stripped), not looseObject: index signatures
// otherwise expose obsolete properties as unknown and interfere with union narrowing.
const actor = { author: publicAuthorSchema };

export const WatchTogetherConnectedFrameSchema = z
    .object({
        type: z.literal('connected'),
        party: WatchTogetherPartySchema,
        lastEventId: z.number().int().nonnegative(),
        serverTime: z.number(),
        requestReceivedAt: z.number(),
        bufferCheck: z
            .object({
                checkId: z.string(),
                currentTime: z.number(),
                isPlaying: z.boolean(),
                seekInitiated: z.boolean(),
            })
            .nullable(),
    })
    .meta({ id: 'WatchTogetherConnectedFrame', unusedIO: 'output' });

export const WatchTogetherParticipantJoinedFrameSchema = z
    .object({
        type: z.literal('participant_joined'),
        participant: WatchTogetherParticipantSchema,
    })
    .meta({ id: 'WatchTogetherParticipantJoinedFrame', unusedIO: 'output' });

export const WatchTogetherParticipantLeftFrameSchema = z
    .object({ type: z.literal('participant_left'), ...actor, clientId: z.string().optional() })
    .meta({ id: 'WatchTogetherParticipantLeftFrame', unusedIO: 'output' });

export const WatchTogetherHostChangedFrameSchema = z
    .object({
        type: z.literal('host_changed'),
        newHost: publicAuthorSchema,
        newHostClientId: z.string().optional(),
    })
    .meta({ id: 'WatchTogetherHostChangedFrame', unusedIO: 'output' });

export const WatchTogetherPartyEndedFrameSchema = z
    .object({
        type: z.literal('session_ended'),
        host: publicAuthorSchema,
    })
    .meta({ id: 'WatchTogetherPartyEndedFrame', unusedIO: 'output' });

export const WatchTogetherVisibilityChangedFrameSchema = z
    .object({
        type: z.literal('visibility_changed'),
        visibility: z.enum(['unlisted', 'listed']),
    })
    .meta({ id: 'WatchTogetherVisibilityChangedFrame', unusedIO: 'output' });

export const WatchTogetherSyncFrameSchema = z
    .object({
        type: z.literal('sync'),
        syncId: z
            .string()
            .uuid()
            .optional()
            .describe('Client request identity for canonical synchronization confirmation'),

        timelineId: z.string().optional(),
        state: z.object({
            currentTime: z.number(),
            isPlaying: z.boolean(),
            playbackRate: z.number(),
            timestamp: z.number(),
            fileId: z.string().optional(),
        }),
        ...actor,
        clientId: z.string().optional(),
    })
    .meta({ id: 'WatchTogetherSyncFrame', unusedIO: 'output' });

export const WatchTogetherHostPositionFrameSchema = z
    .object({
        type: z.literal('host_position'),
        timelineId: z.string().optional(),
        position: z.number(),
        timestamp: z.number(),
        isPlaying: z.boolean(),
        playbackRate: z.number(),
    })
    .meta({ id: 'WatchTogetherHostPositionFrame', unusedIO: 'output' });

export const WatchTogetherNavigateFrameSchema = z
    .object({
        type: z.literal('navigate'),
        timelineId: z.string().optional(),
        itemId: z.string(),
        currentTime: z.number().nonnegative().optional(),
        title: z.string(),
        fileId: z.string().optional(),
        ...actor,
        clientId: z.string().optional(),
    })
    .meta({ id: 'WatchTogetherNavigateFrame', unusedIO: 'output' });

export const WatchTogetherVersionChangeFrameSchema = z
    .object({
        type: z.literal('version_change'),
        timelineId: z.string().optional(),
        fileId: z.string(),
        ...actor,
        clientId: z.string().optional(),
    })
    .meta({ id: 'WatchTogetherVersionChangeFrame', unusedIO: 'output' });

export const WatchTogetherReactionFrameSchema = z
    .object({ type: z.literal('reaction'), emoji: ReactionEmojiSchema, ...actor })
    .meta({ id: 'WatchTogetherReactionFrame', unusedIO: 'output' });

export const WatchTogetherScreenEffectFrameSchema = z
    .object({ type: z.literal('screen_effect'), effect: ScreenEffectSchema, ...actor })
    .meta({ id: 'WatchTogetherScreenEffectFrame', unusedIO: 'output' });

export const WatchTogetherHostActivityFrameSchema = z
    .object({
        type: z.literal('host_activity'),
        activity: z.enum(['watching', 'searching', 'browsing']),
        message: z.string().optional(),
    })
    .meta({ id: 'WatchTogetherHostActivityFrame', unusedIO: 'output' });

export const WatchTogetherBufferCheckFrameSchema = z
    .object({
        type: z.literal('buffer_check'),
        timelineId: z.string().optional(),
        checkId: z.string(),
        currentTime: z.number(),
        initiator: z.string(),
        isPlaying: z.boolean(),
        seekInitiated: z.boolean(),
    })
    .meta({ id: 'WatchTogetherBufferCheckFrame', unusedIO: 'output' });

export const WatchTogetherAllReadyFrameSchema = z
    .object({
        type: z.literal('all_ready'),
        timelineId: z.string().optional(),
        checkId: z.string(),
        currentTime: z.number(),
        resumeAt: z.number(),
        isPlaying: z.boolean(),
        serverTime: z.number(),
    })
    .meta({ id: 'WatchTogetherAllReadyFrame', unusedIO: 'output' });

export const WatchTogetherStallFrameSchema = z
    .object({
        type: z.literal('stall'),
        timelineId: z.string().optional(),
        ...actor,
        clientId: z.string().optional(),
    })
    .meta({ id: 'WatchTogetherStallFrame', unusedIO: 'output' });

export const WatchTogetherResumeFrameSchema = z
    .object({ type: z.literal('resume'), timelineId: z.string().optional() })
    .meta({ id: 'WatchTogetherResumeFrame', unusedIO: 'output' });

export const WatchTogetherResyncFrameSchema = z
    .object({
        type: z.literal('resync'),
        reason: z.enum(['gap', 'ahead']),
        lastEventId: z.number().int().nonnegative(),
    })
    .meta({ id: 'WatchTogetherResyncFrame', unusedIO: 'output' });

export const WatchTogetherErrorFrameSchema = z
    .object({ type: z.literal('error'), error: z.string() })
    .meta({ id: 'WatchTogetherErrorFrame', unusedIO: 'output' });

export const WATCH_TOGETHER_FRAME_SCHEMAS = {
    WatchTogetherConnectedFrame: WatchTogetherConnectedFrameSchema,
    WatchTogetherParticipantJoinedFrame: WatchTogetherParticipantJoinedFrameSchema,
    WatchTogetherParticipantLeftFrame: WatchTogetherParticipantLeftFrameSchema,
    WatchTogetherHostChangedFrame: WatchTogetherHostChangedFrameSchema,
    WatchTogetherPartyEndedFrame: WatchTogetherPartyEndedFrameSchema,
    WatchTogetherVisibilityChangedFrame: WatchTogetherVisibilityChangedFrameSchema,
    WatchTogetherSyncFrame: WatchTogetherSyncFrameSchema,
    WatchTogetherHostPositionFrame: WatchTogetherHostPositionFrameSchema,
    WatchTogetherNavigateFrame: WatchTogetherNavigateFrameSchema,
    WatchTogetherVersionChangeFrame: WatchTogetherVersionChangeFrameSchema,
    WatchTogetherReactionFrame: WatchTogetherReactionFrameSchema,
    WatchTogetherScreenEffectFrame: WatchTogetherScreenEffectFrameSchema,
    WatchTogetherHostActivityFrame: WatchTogetherHostActivityFrameSchema,
    WatchTogetherBufferCheckFrame: WatchTogetherBufferCheckFrameSchema,
    WatchTogetherAllReadyFrame: WatchTogetherAllReadyFrameSchema,
    WatchTogetherStallFrame: WatchTogetherStallFrameSchema,
    WatchTogetherResumeFrame: WatchTogetherResumeFrameSchema,
    WatchTogetherResyncFrame: WatchTogetherResyncFrameSchema,
    WatchTogetherErrorFrame: WatchTogetherErrorFrameSchema,
} as const;

export const watchTogetherFrameSchema = z.discriminatedUnion('type', [
    WatchTogetherConnectedFrameSchema,
    WatchTogetherParticipantJoinedFrameSchema,
    WatchTogetherParticipantLeftFrameSchema,
    WatchTogetherHostChangedFrameSchema,
    WatchTogetherPartyEndedFrameSchema,
    WatchTogetherVisibilityChangedFrameSchema,
    WatchTogetherSyncFrameSchema,
    WatchTogetherHostPositionFrameSchema,
    WatchTogetherNavigateFrameSchema,
    WatchTogetherVersionChangeFrameSchema,
    WatchTogetherReactionFrameSchema,
    WatchTogetherScreenEffectFrameSchema,
    WatchTogetherHostActivityFrameSchema,
    WatchTogetherBufferCheckFrameSchema,
    WatchTogetherAllReadyFrameSchema,
    WatchTogetherStallFrameSchema,
    WatchTogetherResumeFrameSchema,
    WatchTogetherResyncFrameSchema,
    WatchTogetherErrorFrameSchema,
]);

/** All emitted SSE frame variants, discriminated by type. */
export type WatchTogetherFrame = z.infer<typeof watchTogetherFrameSchema>;
