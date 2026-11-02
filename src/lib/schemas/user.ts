// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for user-related API routes
 *
 * Covers user preferences, settings, and user search endpoints
 */

import { z } from 'zod';
import { nonEmptyStringSchema, coerceBooleanSchema } from './common';
import { patScopeSchema } from './admin';

// ============================================================================
// User Preferences
// ============================================================================

/**
 * Search preference - whether to use fulltext search
 */
export const searchPreferenceSchema = z.object({
    fulltextSearch: z.boolean(),
});

export type SearchPreference = z.infer<typeof searchPreferenceSchema>;

/**
 * Stream privacy setting - whether to hide from others
 */
export const streamPrivacySchema = z.object({
    hideFromOthers: z.boolean(),
});

export type StreamPrivacy = z.infer<typeof streamPrivacySchema>;

// ============================================================================
// User Search
// ============================================================================

/**
 * Query params for user search endpoint
 */
export const userSearchQuerySchema = z.object({
    q: nonEmptyStringSchema.optional(),
});

export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;

// ============================================================================
// Generic Boolean Preference
// ============================================================================

/**
 * Generic boolean preference body - used by the preference factory
 * The field name is dynamic based on the endpoint configuration
 */
export const booleanPreferenceBodySchema = z.record(z.string(), z.boolean());

export type BooleanPreferenceBody = z.infer<typeof booleanPreferenceBodySchema>;

// ============================================================================
// User Device Sessions
// ============================================================================

/**
 * Query params for listing devices (admin)
 */
export const deviceListQuerySchema = z.object({
    username: nonEmptyStringSchema,
});

export type DeviceListQuery = z.infer<typeof deviceListQuerySchema>;

/**
 * Query params for revoking a device (admin)
 */
export const deviceRevokeQuerySchema = z.object({
    username: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
});

export type DeviceRevokeQuery = z.infer<typeof deviceRevokeQuerySchema>;

/**
 * Query params for user device list endpoint
 *
 * Used by /api/user/devices and /api/v1/devices
 * to filter devices by online status and Watch Together support.
 */
export const userDeviceListQuerySchema = z.object({
    onlineOnly: coerceBooleanSchema.default(false),
    watchTogether: coerceBooleanSchema.default(false),
});

export type UserDeviceListQuery = z.infer<typeof userDeviceListQuerySchema>;

/**
 * Query params for revoking a user device session
 */
export const userDeviceRevokeQuerySchema = z.object({
    id: nonEmptyStringSchema,
});

export type UserDeviceRevokeQuery = z.infer<typeof userDeviceRevokeQuerySchema>;

// ============================================================================
// Playback Preferences
// ============================================================================

/**
 * Subtitle style settings
 */
/**
 * Subtitle `fontSize` is a relative scale factor, NOT points/pixels: 1.0 = 100%
 * of the renderer's reference size (see subtitle-renderer.ts). The UI slider
 * offers 0.5–2.5; these wider bounds match what the client-side sanitizer
 * (`normalizeSubtitleStyle`) can emit for a stored style, so anything that
 * survives the client always validates here.
 *
 * These were `.min(8).max(200)` — a px/pt range that NO value the client can
 * produce satisfies, so every subtitleStyle write 422'd. The failed flush left
 * the key dirty, so it replayed on every page load, forever. Keep the two in
 * lockstep by importing these constants rather than re-typing the numbers.
 */
export const SUBTITLE_FONT_SIZE_MIN = 0.1;
export const SUBTITLE_FONT_SIZE_MAX = 5;

export const subtitleStyleSchema = z.object({
    preset: z.enum(['default', 'outlined', 'background', 'shadow', 'none']),
    fontSize: z.number().min(SUBTITLE_FONT_SIZE_MIN).max(SUBTITLE_FONT_SIZE_MAX),
    fontFamily: z.enum(['system', 'serif', 'mono']),
    textColor: z.string().max(50),
    backgroundColor: z.string().max(50),
    outlineColor: z.string().max(50),
    outlineWidth: z.number().min(0).max(20),
    shadowBlur: z.number().min(0).max(50),
    positionY: z.number().min(0).max(100),
});

export type SubtitleStyleSettings = z.infer<typeof subtitleStyleSchema>;

/**
 * Advisory hint for restoring the exact subtitle track when multiple tracks
 * share the same language (forced vs regular, SRT vs PGS).
 */
export const subtitleTrackHintSchema = z.object({
    language: z.string(),
    isForced: z.boolean(),
    codec: z.string().nullable(),
    title: z.string().optional().describe('Subtitle edition title, including SDH or CC qualifiers'),
    fileId: z.string().optional().describe('File scope for the stable subtitle identity'),
    trackId: z.string().optional().describe('Stable subtitle identity within the scoped file'),
});

export type SubtitleTrackHint = z.infer<typeof subtitleTrackHintSchema>;

/**
 * Playback preferences update body (partial update supported).
 * .optional() + .nullable() on nullable fields is deliberate: the route
 * distinguishes "omitted" (do not touch column) from "explicit null" (clear column).
 */
const playbackPreferenceFieldsSchema = z
    .object({
        // varchar(20) in Postgres — without .max() a longer paste is a 22001.
        audioLanguage: z.string().max(20).nullable().optional(),
        // Learned audio language (player remembers the last picked track).
        // Ranks below the explicit audioLanguage but above the file's own default.
        lastAudioLanguage: z.string().nullable().optional(),
        // Tier-0: prefer the title's own production language over audioLanguage.
        preferOriginalAudio: z.boolean().optional(),
        subtitleLanguage: z.string().max(20).nullable().optional(),
        subtitlesEnabled: z.boolean().optional(),
        forcedSubtitlesEnabled: z.boolean().optional(),
        subtitleStyle: subtitleStyleSchema.nullable().optional(),
        subtitleTrackHint: subtitleTrackHintSchema.nullable().optional(),
        qualityMode: z.enum(['original', 'auto', 'fixed']).optional(),
        maxBitrateBps: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
        preferredResolution: z.string().nullable().optional(),
        autoplayNextEpisode: z.boolean().optional(),
        skipIntroAutomatically: z.boolean().optional(),
        skipCreditsAutomatically: z.boolean().optional(),
        showEpisodeLanguages: z
            .boolean()
            .optional()
            .describe('Show audio and subtitle language badges in episode lists'),
        showAnnotationMarkers: z.boolean().optional(),
        autoShowAnnotations: z.boolean().optional(),
        musicCrossfadeEnabled: z.boolean().optional(),
        musicCrossfadeBeats: z.number().int().min(4).max(128).nullable().optional(),
        musicAutoplayEnabled: z.boolean().optional(),
        /** Show per-track integrated loudness in music detail modals. */
        musicShowLoudnessDb: z.boolean().optional(),
        /** Show BPM in music detail modals and the queue. */
        musicShowBpm: z.boolean().optional(),
        /** Pulse only the music playhead on beats during playback. */
        musicAlwaysShowBeatPulse: z.boolean().optional(),
        /** Apply per-track LUFS gain during music playback. */
        musicLoudnessNormalizationEnabled: z.boolean().optional(),
        nextEpisodeCountdownSeconds: z.number().int().min(3).max(60).nullable().optional(),
        // Next-episode (outro) popup controls.
        showNextEpisodePopup: z.boolean().optional(),
        // Lead relative to the outro start: positive = before credits, negative = after.
        nextEpisodePromptLeadSeconds: z.number().int().min(-60).max(120).nullable().optional(),
        // For episodes with no detected outro: how many seconds before the end the
        // popup appears. 0 disables the no-outro fallback popup.
        noOutroFallbackSeconds: z.number().int().min(0).max(120).nullable().optional(),
        // Jump distance of the skip/seek controls.
        seekStepSeconds: z.number().int().min(1).max(300).nullable().optional(),
        autoDismissNextEpisodePopup: z.boolean().optional(),
        /** Ask "are you still watching?" after two unattended auto-played episodes. */
        stillWatchingEnabled: z.boolean().optional(),
        metadataLanguage: z
            .string()
            .min(2)
            .max(6)
            .nullable()
            .optional()
            .describe(
                'Preferred language for media descriptions/taglines (BCP-47). Null = follow app language.',
            ),
        metadataTitleLanguage: z
            .string()
            .min(2)
            .max(6)
            .nullable()
            .optional()
            .describe('Preferred language for media titles (BCP-47). Null = follow app language.'),
    })
    .strict();

export const preferenceFieldOrderSchema = z
    .object({
        clock: z
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .describe('Monotonic logical edit order within this browser account generation.'),
        operationId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9_-]+$/)
            .describe('Immutable edit identity; ASCII lexical order breaks equal-clock ties.'),
    })
    .strict();

/** Optional browser ordering metadata; authenticated user identity comes from the request. */
export const playbackPreferenceWriteOrderSchema = z
    .object({
        deviceId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9_-]+$/)
            .describe(
                'Stable browser identity, preserved across account cleanup; independent devices order their edits separately.',
            ),
        epochGeneration: z
            .number()
            .int()
            .min(1)
            .max(Number.MAX_SAFE_INTEGER)
            .describe(
                'Monotonic browser account generation, advanced on account cleanup so retired keepalive writes are ignored.',
            ),
        epochId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9_-]+$/)
            .describe(
                'Account context identity for this generation; conflicting identities at the same generation are rejected.',
            ),
        fields: z
            .record(
                z
                    .string()
                    .refine(
                        (key) => Object.hasOwn(playbackPreferenceFieldsSchema.shape, key),
                        'Unknown preference field',
                    ),
                preferenceFieldOrderSchema,
            )
            .describe(
                'One ordering token for each supplied preference key; omitted preference keys must have no token.',
            ),
    })
    .strict()
    .describe(
        'Browser edit ordering. All supplied preference fields require a token; older edits and retired browser account generations are ignored atomically. Omit for legacy last-write-wins behavior.',
    );
export type PlaybackPreferenceWriteOrder = z.infer<typeof playbackPreferenceWriteOrderSchema>;

export const playbackPreferencesSchema = playbackPreferenceFieldsSchema
    .extend({
        writeOrder: playbackPreferenceWriteOrderSchema.optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        const fields = Object.keys(data).filter(
            (key) => key !== 'writeOrder' && data[key as keyof typeof data] !== undefined,
        );
        if (fields.length === 0)
            ctx.addIssue({
                code: 'custom',
                message: 'At least one preference field must be provided',
            });
        if (!data.writeOrder) return;
        for (const field of fields)
            if (!Object.hasOwn(data.writeOrder.fields, field))
                ctx.addIssue({
                    code: 'custom',
                    path: ['writeOrder', 'fields', field],
                    message: 'An ordering token is required for each supplied preference',
                });
        for (const field of Object.keys(data.writeOrder.fields))
            if (!fields.includes(field))
                ctx.addIssue({
                    code: 'custom',
                    path: ['writeOrder', 'fields', field],
                    message: 'Ordering tokens must refer to supplied preferences',
                });
    });

export type PlaybackPreferencesInput = z.infer<typeof playbackPreferencesSchema>;

// ============================================================================
// Quick Connect
// ============================================================================

/**
 * Quick connect body
 */
export const quickConnectSchema = z.object({
    code: nonEmptyStringSchema,
});

export type QuickConnectInput = z.infer<typeof quickConnectSchema>;

// ============================================================================
// Widget Order
// ============================================================================

/**
 * Widget order update body
 */
export const widgetOrderSchema = z.object({
    widgetOrder: z.array(z.string()).optional(),
    hiddenWidgets: z.array(z.string()).optional(),
});

export type WidgetOrderInput = z.infer<typeof widgetOrderSchema>;

// ============================================================================
// For You Feed Preferences
// ============================================================================

/**
 * Feed display mode: 'full' (everything, default), 'minimal' (essentials only),
 * or 'custom' (use the per-kind hide list).
 */
export const feedModeSchema = z.enum(['full', 'minimal', 'custom']);

export type FeedModeInput = z.infer<typeof feedModeSchema>;

/**
 * For You feed preferences update body. Partial: either field may be present.
 *
 * `hiddenSectionKinds` is `z.array(z.string())` (NOT the kind enum) so an older
 * or newer client posting an unknown kind doesn't 400 — the server sanitises the
 * list to known, non-essential kinds before persisting.
 */
export const feedPreferencesSchema = z
    .object({
        feedMode: feedModeSchema.optional(),
        hiddenSectionKinds: z.array(z.string()).optional(),
    })
    .refine((d) => d.feedMode !== undefined || d.hiddenSectionKinds !== undefined, {
        message: 'At least one of feedMode or hiddenSectionKinds is required',
    });

export type FeedPreferencesInput = z.infer<typeof feedPreferencesSchema>;

// ============================================================================
// Personal Access Tokens
// ============================================================================

/**
 * Create PAT body
 */
/**
 * Longest lifetime a minted token may ask for (10 years). Without a cap,
 * `Date.now() + days * 86_400_000` overflows the Date range and the insert 500s.
 */
export const MAX_TOKEN_LIFETIME_DAYS = 3650;

export const createTokenSchema = z.object({
    name: z
        .string()
        .min(1)
        .max(255)
        .transform((s) => s.trim()),
    description: z
        .string()
        .max(1000)
        .transform((s) => s.trim())
        .optional(),
    scopes: z
        .array(z.string())
        .min(1)
        .transform((arr) =>
            arr.map((s) => s.trim().toLowerCase() as z.infer<typeof patScopeSchema>),
        )
        .pipe(z.array(patScopeSchema))
        .superRefine((arr, ctx) => {
            if (arr.includes('jellyfin_compat') && arr.length !== 1) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "'jellyfin_compat' is exclusive — must be the only scope",
                });
            }
            if (arr.includes('jellyfin_compat_read') && arr.length !== 1) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "'jellyfin_compat_read' is exclusive — must be the only scope",
                });
            }
        })
        .optional(),
    expiresInDays: z.number().int().min(1).max(MAX_TOKEN_LIFETIME_DAYS).nullish(),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;

/**
 * List PATs query params
 */
export const listTokenQuerySchema = z.object({
    scope: patScopeSchema.optional(),
});

export type ListTokenQuery = z.infer<typeof listTokenQuerySchema>;
