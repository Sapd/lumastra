// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radio station schemas — internet radio entries stored as media_items
 * rows with media_type='radio'. Stream URL, genre/description, the optional
 * metadata-source config, and last-known now-playing live in custom_metadata.
 */

import { z } from 'zod';

const httpUrl = z
    .string()
    .url()
    .refine(
        (value) => {
            try {
                const { protocol } = new URL(value);
                return protocol === 'http:' || protocol === 'https:';
            } catch {
                return false;
            }
        },
        { message: 'URL must use http or https scheme' },
    );

/**
 * Flat canonical field IDs. Used everywhere mappings/matches are referenced:
 * jsonPaths keys, regex named groups, detector output. The public
 * RadioNowPlaying response is the ONLY place they get nested under
 * track/show/dj/upNext.
 */
export const CANONICAL_FIELD_IDS = [
    'title',
    'artist',
    'trackDurationSeconds',
    'trackElapsedSeconds',
    'djName',
    'djImageUrl',
    'showName',
    'showDescription',
    'showImageUrl',
    'showStartsAt',
    'showEndsAt',
    'upNextTitle',
    'upNextArtist',
    'upNextImageUrl',
] as const;

export type CanonicalFieldId = (typeof CANONICAL_FIELD_IDS)[number];

const JsonPathsSchema = z
    .object(
        Object.fromEntries(CANONICAL_FIELD_IDS.map((id) => [id, z.string().optional()])) as Record<
            CanonicalFieldId,
            z.ZodOptional<z.ZodString>
        >,
    )
    .meta({ id: 'RadioMetadataJsonPaths' });

export const RadioMetadataSourceSchema = z
    .object({
        url: httpUrl,
        format: z.enum(['json', 'regex']),
        jsonPaths: JsonPathsSchema.optional(),
        regexPattern: z.string().max(4000).optional(),
        timeoutMs: z.number().int().min(500).max(15000).optional(),
        userAgent: z.string().max(200).optional(),
    })
    .meta({ id: 'RadioMetadataSource' });

export type RadioMetadataSource = z.infer<typeof RadioMetadataSourceSchema>;

/**
 * Body of POST /api/admin/radio/metadata/preview. Station-less so the create
 * form can preview a mapping before the station exists; `streamUrl` feeds the
 * ICY fallback the preview reports when the metadata URL yields nothing.
 */
export const RadioMetadataPreviewRequestSchema = z
    .object({
        streamUrl: httpUrl.optional(),
        metadataSource: RadioMetadataSourceSchema,
    })
    .meta({ id: 'RadioMetadataPreviewRequest' });

/** What a stream announces about itself in its `icy-*` response headers. */
export const RadioStreamInfoSchema = z
    .object({
        /** False when the stream could not be reached; the other fields are then absent. */
        reachable: z.boolean(),
        name: z.string().optional(),
        genre: z.string().optional(),
        description: z.string().optional(),
        websiteUrl: z.string().optional(),
        contentType: z.string().optional(),
    })
    .meta({ id: 'RadioStreamInfo' });

export const RadioStreamInfoRequestSchema = z
    .object({ streamUrl: httpUrl })
    .meta({ id: 'RadioStreamInfoRequest' });

export type RadioStreamInfo = z.infer<typeof RadioStreamInfoSchema>;

export const RadioNowPlayingSchema = z
    .object({
        stationId: z.string().guid(),
        fetchedAt: z.string(),
        source: z.enum(['url', 'icy', 'stale']).nullable(),
        track: z
            .object({
                title: z.string().optional(),
                artist: z.string().optional(),
                /** Resolved internal artist UUID when the live artist name
                 *  matches a media_items row of media_type='artist'. Optional —
                 *  absent when no match. UI uses this to render the artist as
                 *  a clickable artist-modal link. */
                artistId: z.string().guid().optional(),
                durationMs: z.number().int().nonnegative().optional().describe('Duration in milliseconds.'),
                elapsedMs: z.number().int().nonnegative().optional().describe('Elapsed time in milliseconds.'),
            })
            .default({}),
        show: z
            .object({
                name: z.string().optional(),
                description: z.string().optional(),
                imageUrl: z.string().optional(),
                startsAt: z.string().optional(),
                endsAt: z.string().optional(),
            })
            .default({}),
        dj: z
            .object({
                name: z.string().optional(),
                imageUrl: z.string().optional(),
            })
            .default({}),
        upNext: z
            .object({
                title: z.string().optional(),
                artist: z.string().optional(),
                imageUrl: z.string().optional(),
            })
            .default({}),
    })
    .meta({ id: 'RadioNowPlaying' });

export type RadioNowPlaying = z.infer<typeof RadioNowPlayingSchema>;

export const RadioStationSchema = z
    .object({
        id: z.string().guid(),
        name: z.string(),
        streamUrl: httpUrl,
        genre: z.string().optional(),
        description: z.string().optional(),
        logoUrl: z.string().optional(),
        nowPlaying: z.string().optional(),
        metadataSource: RadioMetadataSourceSchema.optional(),
        lastError: z
            .object({
                at: z.string(),
                message: z.string(),
            })
            .optional(),
    })
    .meta({ id: 'RadioStation' });

export type RadioStation = z.infer<typeof RadioStationSchema>;

// ============================================================================
// API response item shape for GET /api/music/radio (and /api/v1/music/radio/stations)
//
// The server returns { items, page } via paginate(). Each item carries:
//   - type: 'radio' — canonical discriminator (replaces the old mediaType field)
//   - name           — display name (replaces the old title/name ambiguity)
//   - images{}       — self-describing image href map (replaces flat logoUrl)
//   - genre/nowPlaying — optional metadata from custom_metadata JSONB
//
// The upstream stream URL is intentionally absent — clients play via
// /api/music/radio/{id}/stream so they never connect to the Icecast origin.
// ============================================================================

const RadioStationImagePosterSchema = z.object({
    href: z.string(),
    thumb: z.string(),
    card: z.string(),
    full: z.string(),
});

const RadioStationImageBackdropSchema = z.object({
    href: z.string(),
    card: z.string(),
    wide: z.string(),
    full: z.string(),
});

export const RadioStationApiItemSchema = z
    .object({
        /** Station UUID */
        id: z.string().guid(),
        /** Canonical type discriminator */
        type: z.literal('radio'),
        /** Display name */
        name: z.string(),
        /** Primary genre */
        genre: z.string().optional(),
        /** Last-known now-playing text from custom_metadata */
        nowPlaying: z.string().optional(),
        /**
         * Self-describing image href map. Present only when the station has a
         * custom_poster_url set; absent means the UI should show a placeholder.
         */
        images: z
            .object({
                poster: RadioStationImagePosterSchema,
                backdrop: RadioStationImageBackdropSchema,
            })
            .optional(),
    })
    .meta({ id: 'RadioStationApiItem' });

export type RadioStationApiItem = z.infer<typeof RadioStationApiItemSchema>;

export const CreateRadioStationSchema = z
    .object({
        name: z.string().min(1).max(200),
        streamUrl: httpUrl,
        genre: z.string().max(100).optional(),
        description: z.string().max(2000).optional(),
        logoUrl: httpUrl.optional(),
        metadataSource: RadioMetadataSourceSchema.optional(),
    })
    .meta({ id: 'CreateRadioStationRequest' });

export type CreateRadioStationRequest = z.infer<typeof CreateRadioStationSchema>;

export const UpdateRadioStationSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        streamUrl: httpUrl.optional(),
        genre: z.string().max(100).optional().nullable(),
        description: z.string().max(2000).optional().nullable(),
        metadataSource: RadioMetadataSourceSchema.optional().nullable(),
    })
    .meta({ id: 'UpdateRadioStationRequest' });

export type UpdateRadioStationRequest = z.infer<typeof UpdateRadioStationSchema>;
