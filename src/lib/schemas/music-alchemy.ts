// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Alchemy Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for the brew API contract:
 *   POST /api/music/alchemy/brew
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ id: '...' }) on all top-level schemas
 * - Export both schema and inferred type
 * - Nullability only where the DB/API genuinely returns null
 *
 * Route gating: the endpoint returns notFound (404) when
 * features.musicAlchemy is false. Do NOT check the raw flag.
 *
 * Shared mood→color palette: see
 *   src/lib/utils/mood-palette.ts  (implemented by Haiku agent)
 */

import { z } from 'zod';
import { MusicTrackSchema } from './music';

// ============================================================================
// Brew Request
// ============================================================================

/**
 * Body for POST /api/music/alchemy/brew
 *
 * All three scalar knobs are in [0, 1] and are OPTIONAL — the implementation
 * uses a neutral centre (0.5) for any omitted knob so the caller can send only
 * the knobs the user has actually moved. This keeps the wire format small for
 * "default brew" calls.
 *
 * Limit is capped server-side at 50; the UI default is 20.
 */
export const BrewRequestSchema = z
    .object({
        /**
         * UUIDs of tracks to use as positive seeds.
         * At least one seed is required.
         * Maximum 20 seed IDs.
         */
        seedIds: z
            .array(z.string().guid())
            .min(1, 'At least one seed track is required')
            .max(20, 'Maximum 20 seed tracks'),

        /**
         * UUIDs of tracks to exclude from the result.
         * Maximum 200 avoid IDs (gracefully capped server-side).
         */
        avoidIds: z.array(z.string().guid()).max(200).optional().default([]),

        /**
         * Target energy level (0 = very calm, 1 = maximum energy).
         * Defaults to 0.5 when omitted (neutral).
         */
        energy: z.number().min(0).max(1).optional(),

        /**
         * Target tempo relative to the seed centroid.
         * 0 = much slower, 0.5 = match seed BPM, 1 = much faster.
         * Defaults to 0.5 when omitted (match seed BPM).
         */
        tempo: z.number().min(0).max(1).optional(),

        /**
         * Obscurity dial (0 = most popular, 1 = deepest cuts).
         * Blends into the candidate ranking via popularity / play-count.
         * Defaults to 0.5 when omitted (neutral).
         */
        obscurity: z.number().min(0).max(1).optional(),

        /**
         * Maximum number of tracks to return (server cap: 50).
         * Default: 20.
         */
        limit: z.number().int().min(1).max(50).optional().default(20),
    })
    .meta({ id: 'BrewRequest' });

export type BrewRequest = z.infer<typeof BrewRequestSchema>;

// ============================================================================
// Mood Island Cluster Anchor
// ============================================================================

/**
 * A stable mood-island cluster anchor for the Canvas2D visualisation.
 *
 * Anchors are derived from the k-means centroids over the candidate pool
 * (capped at ~300–500 tracks). They are STABLE across brews with the same
 * seed set so dots in the UI never teleport — only fade/resize.
 *
 * The 2-D position (x, y) is in normalised device coordinates [0, 1] and is
 * computed from a fixed projection of the first two principal acoustic dims
 * (energy × danceability). The implementation (brew query logic agent) MUST
 * keep the projection deterministic given the same anchor label so positions
 * are stable across page refreshes.
 */
export const MoodIslandAnchorSchema = z
    .object({
        /**
         * Stable anchor identifier — typically the dominant mood tag from the
         * cluster, e.g. "happy", "aggressive", "sad". Unique within a brew
         * response; the UI uses it as a React-style key.
         */
        label: z.string(),

        /**
         * Normalised X position [0, 1] on the Canvas2D mood-island map.
         * Derived from the energy centroid of the cluster.
         */
        x: z.number().min(0).max(1),

        /**
         * Normalised Y position [0, 1] on the Canvas2D mood-island map.
         * Derived from the danceability centroid of the cluster.
         */
        y: z.number().min(0).max(1),

        /**
         * Number of tracks assigned to this cluster in the candidate pool.
         * Used to size the island bubble in the visualisation.
         */
        size: z.number().int().min(1),

        /**
         * Hex color string for the island dot/bubble.
         * Assigned by the shared mood→color palette utility:
         *   import { moodToColor } from '$lib/utils/mood-palette';
         * The server populates this from the same palette so wire color matches
         * the client-rendered color without a client-side lookup per anchor.
         */
        color: z.string(),
    })
    .meta({ id: 'MoodIslandAnchor' });

export type MoodIslandAnchor = z.infer<typeof MoodIslandAnchorSchema>;

// ============================================================================
// Brew Response
// ============================================================================

/**
 * Response from POST /api/music/alchemy/brew
 *
 * Bare-object response — no success/timestamp envelope.
 */
export const BrewResponseSchema = z
    .object({
        /**
         * Ranked track list — ordered by descending brew score.
         * Length ≤ request.limit (server cap: 50).
         */
        tracks: z.array(MusicTrackSchema),

        /**
         * Total duration of the returned tracks in milliseconds.
         * Absent when any track in the list has no duration metadata.
         * Drives the TICKET hero text ("12 tracks, 47 min").
         */
        totalDurationMs: z.number().int().optional().describe('Total track duration in milliseconds.'),

        /**
         * Stable mood-island cluster anchors for the Canvas2D visualisation.
         * Derived from the candidate pool (not only the returned tracks) so
         * the map reflects the full acoustic space the brew explored.
         * May be empty when the candidate pool is too small to cluster.
         */
        moodAnchors: z.array(MoodIslandAnchorSchema),

        /**
         * Brew quality metadata — informational, not rendered in the primary UI.
         */
        meta: z
            .object({
                /** Number of candidates evaluated before ranking. */
                candidatePoolSize: z.number().int(),
                /** Whether acoustic data was available for all returned tracks. */
                acousticDataComplete: z.boolean(),
            })
            .optional(),
    })
    .meta({ id: 'BrewResponse' });

export type BrewResponse = z.infer<typeof BrewResponseSchema>;
