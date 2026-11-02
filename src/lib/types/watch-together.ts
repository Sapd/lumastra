// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together - Types and Interfaces
 *
 * Enables synchronized playback between multiple users.
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/watch-together-core-types.ts'.
 */

export type {
    WatchTogetherParticipant,
    WatchTogetherParty,
    WatchTogetherState,
    WatchTogetherEvent,
    ReactionEmoji,
    ScreenEffect,
} from '$lib/schemas/watch-together-core-types';

// ============================================================================
// Runtime Constants
// ============================================================================

/** Available reaction emojis */
export const REACTION_EMOJIS = ['😂', '😮', '😢', '😍', '🔥', '👏', '😱', '🤯'] as const;

/** Screen effects that affect the video player */
export const SCREEN_EFFECTS = [
    { id: 'shake', icon: '📳', label: 'Earthquake' },
    { id: 'confetti', icon: '🎉', label: 'Confetti' },
    { id: 'snow', icon: '❄️', label: 'Snow' },
    { id: 'hearts', icon: '💕', label: 'Hearts' },
    { id: 'flash', icon: '⚡', label: 'Flash' },
    { id: 'zoom', icon: '🔍', label: 'Zoom Pulse' },
    { id: 'spin', icon: '🌀', label: 'Spin' },
    { id: 'rage', icon: '😤', label: 'Rage Mode' },
    { id: 'matrix', icon: '💊', label: 'Matrix' },
    { id: 'vhs', icon: '📼', label: 'VHS Glitch' },
] as const;

/** SSE event types sent to clients */
export type { WatchTogetherFrame as SSEEventType } from '$lib/schemas/watch-together';

/** Exclude confusing glyphs (I, O, 0, 1). Exactly 32 characters — see below. */
const SESSION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_CODE_LENGTH = 6;

/**
 * Generate a random session code.
 *
 * **Uses Web Crypto, not `Math.random()`.** The code is the only thing standing
 * between a stranger and a party's existence, and `Math.random()` is a
 * non-cryptographic PRNG whose internal state can be recovered from a modest
 * number of outputs in some engines. Nothing here was known to be exploitable,
 * but "we seed shareable access tokens from Math.random" is not a sentence
 * worth defending in public.
 *
 * `globalThis.crypto` rather than `node:crypto` deliberately: this module is
 * imported by client code (stores, the party page), so a Node-only import would
 * break the browser bundle. Web Crypto is present in both.
 *
 * The alphabet is exactly 32 characters and 256 % 32 === 0, so `byte % 32` is
 * uniform — no modulo bias, and no rejection sampling needed. Keep the alphabet
 * at a power of two, or this comment stops being true.
 *
 * Keyspace: 32^6 = 1,073,741,824.
 */
export function generateSessionCode(): string {
    const bytes = new Uint8Array(SESSION_CODE_LENGTH);
    globalThis.crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
        code += SESSION_CODE_ALPHABET.charAt(bytes[i]! % SESSION_CODE_ALPHABET.length);
    }
    return code;
}

/** Session TTL in seconds (4 hours) */
export const SESSION_TTL = 4 * 60 * 60;

/** Max drift before forcing resync (in seconds) */
export const MAX_DRIFT_SECONDS = 2;

/** Max drift before triggering hard resync with buffer check (in seconds) */
export const HARD_RESYNC_DRIFT_SECONDS = 5;

/** Sync pulse interval (in milliseconds) */
export const SYNC_INTERVAL_MS = 5000;

/** Drift check interval (in milliseconds) - how often to check if participants are in sync */
export const DRIFT_CHECK_INTERVAL_MS = 10000;

// ============================================================================
// Smooth Catch-Up Sync Constants
// ============================================================================

/** Drift threshold to start smooth catch-up (seconds) */
export const CATCHUP_START_DRIFT = 2;

/** Drift threshold for hard seek instead of catch-up (seconds) - too far behind */
export const CATCHUP_MAX_DRIFT = 10;

/** Drift threshold to stop catch-up and return to normal speed (seconds) */
export const CATCHUP_STOP_DRIFT = 0.5;

/** Speed multiplier for small drift (2-5s behind) */
export const CATCHUP_SPEED_SMALL = 1.05;

/** Speed multiplier for larger drift (5-10s behind) */
export const CATCHUP_SPEED_LARGE = 1.1;

/** Speed multiplier when ahead of host */
export const SLOWDOWN_SPEED = 0.95;

/** How often to check drift and adjust speed (ms) */
export const CATCHUP_CHECK_INTERVAL_MS = 2000;
