// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Core Types - Zod Schemas
 *
 * Schemas for synchronized watch-together session data structures.
 * SSE wire schemas are defined in watch-together.ts.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { publicAuthorSchema } from './public-author';
import { coerceLegacyTvToSeries } from './common';

// ============================================================================
// Reaction Emoji
// ============================================================================

/**
 * Available reaction emojis for watch-together sessions
 */
export const ReactionEmojiSchema = z
    .enum(['😂', '😮', '😢', '😍', '🔥', '👏', '😱', '🤯'])
    .describe('Reaction emoji');

export type ReactionEmoji = z.infer<typeof ReactionEmojiSchema>;

// ============================================================================
// Screen Effect
// ============================================================================

/**
 * Available screen effects for watch-together sessions
 */
export const ScreenEffectSchema = z
    .enum(['shake', 'confetti', 'snow', 'hearts', 'flash', 'zoom', 'spin', 'rage', 'matrix', 'vhs'])
    .describe('Screen effect');

export type ScreenEffect = z.infer<typeof ScreenEffectSchema>;

// ============================================================================
// Watch Together Participant
// ============================================================================

/**
 * Participant in a watch-together session
 */
export const WatchTogetherParticipantSchema = z
    .object({
        ...publicAuthorSchema.shape,
        /** Timestamp when participant joined (Unix ms) */
        joinedAt: z.number().describe('Join timestamp'),
        /** Unique client ID - allows same user to join from multiple devices */
        clientId: z.string().describe('Client ID'),
    })
    .meta({ description: 'Watch-together participant' });

export type WatchTogetherParticipant = z.infer<typeof WatchTogetherParticipantSchema>;

// ============================================================================
// Watch Together Session
// ============================================================================

/**
 * Watch-together session state
 */
export const WatchTogetherPartySchema = z
    .object({
        /** Short shareable code (e.g., "MOVIE-7X3K") */
        code: z.string().describe('Session code'),
        host: publicAuthorSchema,
        /** Host client ID - identifies specific device/tab */
        hostClientId: z.string().optional().describe('Host client ID'),
        /** Media item ID being watched */
        itemId: z.string().describe('Media item ID'),
        timelineId: z.string().optional().describe('Current item timeline identity'),
        /** Media type */
        mediaType: z
            .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'episode', 'series']))
            .describe('Media type'),
        /** Media title */
        title: z.string().describe('Media title'),
        /** Poster image URL */
        posterUrl: z.string().optional().describe('Poster URL'),
        /** Selected file/version ID (e.g., 4K vs 1080p) */
        fileId: z.string().optional().describe('File ID'),
        /** Current playback position (seconds) */
        currentTime: z.number().describe('Current time (seconds)'),
        /** Whether playback is active */
        isPlaying: z.boolean().describe('Is playing'),
        /** Playback speed multiplier */
        playbackRate: z.number().describe('Playback rate'),
        /** Session creation timestamp (Unix ms) */
        createdAt: z.number().describe('Creation timestamp'),
        /** Last sync timestamp (Unix ms) */
        lastSync: z.number().describe('Last sync timestamp'),
        /** Session participants (including host) */
        participants: z.array(WatchTogetherParticipantSchema).describe('Participants'),
        /** Whether session is publicly visible on homepage */
        visibility: z.enum(['unlisted', 'listed']).describe('Is public'),
    })
    .meta({ description: 'Watch-together session' });

export type WatchTogetherParty = z.infer<typeof WatchTogetherPartySchema>;

// ============================================================================
// Watch Together State
// ============================================================================

/**
 * Playback state for watch-together sessions
 */
export const WatchTogetherStateSchema = z
    .object({
        /** Current playback position (seconds) */
        currentTime: z.number().describe('Current time (seconds)'),
        /** Whether playback is active */
        isPlaying: z.boolean().describe('Is playing'),
        /** Playback speed multiplier */
        playbackRate: z.number().describe('Playback rate'),
        /** State timestamp (Unix ms) */
        timestamp: z.number().describe('State timestamp'),
        /** Selected file/version ID (synced so all viewers use same version) */
        fileId: z.string().optional().describe('File ID'),
    })
    .meta({ description: 'Watch-together playback state' });

export type WatchTogetherState = z.infer<typeof WatchTogetherStateSchema>;

// ============================================================================
// Watch Together Event
// ============================================================================

/**
 * Watch-together event (for WebSocket/SSE communication)
 * Note: This is a simplified schema. The actual SSEEventType in watch-together.ts
 * contains more detailed discriminated union types.
 */
export const WatchTogetherEventSchema = z
    .object({
        /** Event type */
        type: z.enum(['sync', 'join', 'leave', 'end', 'chat']).describe('Event type'),
        /** Session code */
        sessionCode: z.string().describe('Session code'),
        /** Event timestamp (Unix ms) */
        timestamp: z.number().describe('Event timestamp'),
        /** Event data (state, participant, or message) */
        data: z
            .union([
                WatchTogetherStateSchema,
                WatchTogetherParticipantSchema,
                z.object({ message: z.string() }),
            ])
            .describe('Event data'),
    })
    .meta({ description: 'Watch-together event (simplified)' });

export type WatchTogetherEvent = z.infer<typeof WatchTogetherEventSchema>;
