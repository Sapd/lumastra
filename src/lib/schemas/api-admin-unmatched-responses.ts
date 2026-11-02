// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ConfirmArtistCreditsSchema } from './music-credit-review.js';
import { z } from 'zod';

/**
 * Personal media item — a media_items row with no external_ids.
 * Matches PersonalMediaRow from media-items.queries.ts.
 */
export const PersonalMediaItemSchema = z.object({
    id: z.string().guid(),
    title: z.string(),
    media_type: z.string(),
    release_year: z.number().int().nullable(),
    overview: z.string().nullable(),
    custom_poster_url: z.string().nullable(),
    custom_backdrop_url: z.string().nullable(),
    custom_logo_url: z.string().nullable(),
    custom_thumb_url: z.string().nullable(),
    metadata_locked: z.boolean(),
    metadata_locked_by: z.string().nullable(),
    metadata_locked_at: z.string().nullable(),
    created_at: z.string(),
    episode_count: z.number().int().optional(),
    season_count: z.number().int().optional(),
    /** Default (or first) file's path — disambiguation context for the Identify modal. */
    file_path: z.string().nullable().optional(),
});
export type PersonalMediaItem = z.infer<typeof PersonalMediaItemSchema>;

export const PersonalMediaPageSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

export const ListPersonalMediaResponseSchema = z.object({
    items: z.array(PersonalMediaItemSchema),
    page: PersonalMediaPageSchema,
    libraryGroups: z
        .array(
            z.object({
                id: z.string().guid(),
                name: z.string(),
            }),
        )
        .optional(),
});
export type ListPersonalMediaResponse = z.infer<typeof ListPersonalMediaResponseSchema>;

export const PersonalEpisodeSchema = z.object({
    id: z.string().guid(),
    episode_number: z.number().int(),
    title: z.string(),
    file_path: z.string().optional(),
    file_size_bytes: z.number().optional(),
    duration_seconds: z.number().optional(),
});
export type PersonalEpisode = z.infer<typeof PersonalEpisodeSchema>;

export const PersonalSeasonSchema = z.object({
    id: z.string().guid(),
    season_number: z.number().int(),
    title: z.string(),
    episodes: z.array(PersonalEpisodeSchema),
});
export type PersonalSeason = z.infer<typeof PersonalSeasonSchema>;

/**
 * A candidate result from a metadata provider search.
 * Provider-agnostic — could be TMDB, AniDB, TVDB, etc.
 */
export const ProviderSearchResultSchema = z.object({
    provider: z.string(),
    externalId: z.string(),
    title: z.string(),
    year: z.number().int().optional(),
    /** Canonical discriminator: 'series' (not 'tv'). */
    type: z.enum(['movie', 'series']),
    overview: z.string().optional(),
    /** Image href map — poster is an external provider URL. */
    images: z.object({ poster: z.string().optional() }).optional(),
});
export type ProviderSearchResult = z.infer<typeof ProviderSearchResultSchema>;

export const ProviderSearchResponseSchema = z.object({
    results: z.array(ProviderSearchResultSchema),
    query: z.string(),
});
export type ProviderSearchResponse = z.infer<typeof ProviderSearchResponseSchema>;

export const IdentifyMatchBodySchema = z.object({
    provider: z.string().min(1),
    externalId: z.string().min(1),
    /** Canonical discriminator: 'series' (not 'tv'). */
    type: z.enum(['movie', 'series']),
});
export type IdentifyMatchBody = z.infer<typeof IdentifyMatchBodySchema>;

/**
 * Request body for PATCH /api/media/[id]/metadata
 * All fields optional — only provided fields are updated.
 */
export const FilenameTitleConfirmationSchema = z.strictObject({
    title: z.string().min(1).describe('Exact displayed title reviewed by the administrator'),
    source: z.literal('filename').describe('Expected title provenance'),
    locked: z.boolean().describe('Expected metadata protection state'),
    lockedBy: z.string().optional().describe('Expected protection actor, when present'),
    lockedAt: z
        .string()
        .min(1)
        .optional()
        .describe('Opaque protection version from the detail snapshot'),
});
export type FilenameTitleConfirmation = z.infer<typeof FilenameTitleConfirmationSchema>;

export const MetadataPatchSchema = z.object({
    title: z.string().min(1).optional(),
    releaseYear: z.number().int().min(1800).max(2200).nullable().optional(),
    overview: z.string().nullable().optional(),
    customPosterUrl: z.string().url().nullable().optional(),
    customBackdropUrl: z.string().url().nullable().optional(),
    customLogoUrl: z.string().url().nullable().optional(),
    customThumbUrl: z.string().url().nullable().optional(),
    /**
     * Freeform JSONB, mirroring the admin twin
     * (`defs/admin/media/[id]/metadata.ts` — "arbitrary custom_metadata fields …
     * No fixed schema is possible").
     *
     * This was a primitives-only record, which was wrong on both sides of the
     * wire: `updateAndLockMediaItem` REPLACES the column
     * (`custom_metadata = ${json}::jsonb`), so the editor has to round-trip the
     * whole object — including nested values like `essentia` — and a `tags`
     * metadata field emits `string[]`. Both were rejected before ever reaching
     * the column that already stores them.
     */
    customMetadata: z.record(z.string(), z.unknown()).optional(),
});
export const ConfirmFilenameTitlePatchSchema = z.strictObject({
    confirmFilenameTitle: FilenameTitleConfirmationSchema,
});

/** Confirmation is exclusive: no stale editable fields may accompany it. */
export const MediaMetadataPatchSchema = z.union([
    z.strictObject({
        undoMusicEdit: z.uuid().describe('Saved music edit to restore if its result is unchanged'),
    }),
    ConfirmFilenameTitlePatchSchema,
    z.strictObject({ confirmArtistCredits: ConfirmArtistCreditsSchema }),
    MetadataPatchSchema.extend({
        confirmFilenameTitle: z.never().optional(),
        confirmArtistCredits: z.never().optional(),
        undoMusicEdit: z.never().optional(),
    }),
]);
export type MetadataPatch = z.infer<typeof MediaMetadataPatchSchema>;

export const PersonalSeriesChildrenResponseSchema = z.object({
    seasons: z.array(PersonalSeasonSchema),
});
export type PersonalSeriesChildrenResponse = z.infer<typeof PersonalSeriesChildrenResponseSchema>;
