// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { LyricsSchema, PopularitySummarySchema } from './music-metadata';
import { ImageSetSchema } from './api-image-descriptor';

export const MusicImagesSchema = ImageSetSchema;

/** An unresolved tag credit has no catalog UUID. Never invent an identity for it. */
export const ArtistRefSchema = z.object({ id: z.string().nullable(), title: z.string() });
export const AlbumRefSchema = z.object({ id: z.string(), title: z.string() });
export const TrackAudioFeaturesSchema = z
    .object({
        bpm: z.number().optional(),
        key: z.string().optional(),
        energy: z.number().optional(),
        danceability: z.number().optional(),
        loudnessLufs: z.number().optional(),
        beatGrid: z.array(z.number()).optional().describe('Beat timestamps in seconds.'),
        downbeats: z.array(z.number()).optional().describe('Downbeat timestamps in seconds.'),
        introEndMs: z.number().int().optional(),
        outroStartMs: z.number().int().optional(),
        energyCurve: z.array(z.number()).optional(),
        moodTags: z.array(z.string()).optional(),
        vocalInstrumental: z.enum(['voice', 'instrumental']).optional(),
        vocalConfidence: z.number().optional(),
        outroSource: z.enum(['downbeat', 'percentage', 'fade', 'dj-outro']).optional(),
        djIntroEndMs: z.number().int().optional(),
        firstVocalStartMs: z.number().int().optional(),
        lastVocalEndMs: z.number().int().optional(),
    })
    .meta({ id: 'TrackAudioFeatures' });
export const TrackChapterSchema = z.object({
    title: z.string(),
    artist: z.string().optional(),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0).optional(),
});
export const ArtistSummarySchema = z
    .object({
        id: z.string(),
        type: z.literal('artist'),
        title: z.string(),
        images: MusicImagesSchema,
        albumCount: z.number().int(),
        trackCount: z.number().int(),
        isVariousArtists: z.boolean(),
    })
    .meta({ id: 'ArtistSummary' });
/** Exact Discogs catalogue pages for the selected fields. Omitted for unknown/overridden sources. */
export const DiscogsAttributionSchema = z
    .object({
        biography: z.string().url().optional(),
        genre: z.string().url().optional(),
        country_code: z.string().url().optional(),
        overview: z.string().url().optional(),
        poster: z.string().url().optional(),
        backdrop: z.string().url().optional(),
        logo: z.string().url().optional(),
    })
    .describe(
        'Exact Discogs artist/release URLs by displayed field. Render Data provided by Discogs ' +
        'adjacent to that field, linking without nofollow.',
    );
export type DiscogsAttribution = z.infer<typeof DiscogsAttributionSchema>;

export const ArtistSchema = ArtistSummarySchema.extend({
    biography: z.string().nullable(),
    genres: z.array(z.string()),
    countryCode: z.string().nullable(),
    discogsAttribution: DiscogsAttributionSchema.optional(),
    popularity: PopularitySummarySchema.optional(),
    addedAt: z.string().nullable(),
}).meta({ id: 'Artist' });
export const AlbumSummarySchema = z
    .object({
        id: z.string(),
        type: z.literal('album'),
        title: z.string(),
        year: z.number().int().nullable(),
        artist: ArtistRefSchema,
        images: MusicImagesSchema,
        trackCount: z.number().int(),
        durationMs: z.number().int().nullable().describe('Duration in milliseconds.'),
    })
    .meta({ id: 'AlbumSummary' });
export const AlbumSchema = AlbumSummarySchema.extend({
    overview: z.string().nullable(),
    genres: z.array(z.string()),
    discogsAttribution: DiscogsAttributionSchema.optional(),
    popularity: PopularitySummarySchema.optional(),
    addedAt: z.string().nullable(),
}).meta({ id: 'Album' });
export const TrackSchema = z
    .object({
        id: z.string(),
        type: z.literal('track'),
        title: z.string(),
        artists: z.array(ArtistRefSchema),
        remixerArtists: z
            .array(ArtistRefSchema)
            .optional()
            .describe('Resolved remix/version credits, separate from performing artists.'),
        albumArtist: ArtistRefSchema.nullable(),
        album: AlbumRefSchema.nullable(),
        trackNumber: z.number().int().nullable(),
        discNumber: z.number().int().nullable(),
        durationMs: z.number().int().nullable().describe('Duration in milliseconds.'),
        genres: z.array(z.string()),
        year: z.number().int().nullable(),
        images: MusicImagesSchema,
        popularity: PopularitySummarySchema.optional(),
        isRadio: z.boolean(),
        audioFeatures: TrackAudioFeaturesSchema.optional(),
        lyrics: LyricsSchema.optional(),
        chapters: z.array(TrackChapterSchema).optional(),
    })
    .meta({ id: 'MusicTrack' });
export type ArtistRef = z.infer<typeof ArtistRefSchema>;
export type AlbumRef = z.infer<typeof AlbumRefSchema>;
export type ArtistSummary = z.infer<typeof ArtistSummarySchema>;
export type Artist = z.infer<typeof ArtistSchema>;
export type AlbumSummary = z.infer<typeof AlbumSummarySchema>;
export type Album = z.infer<typeof AlbumSchema>;
export type Track = z.infer<typeof TrackSchema>;

export type TrackAudioFeatures = z.infer<typeof TrackAudioFeaturesSchema>;
export type TrackChapter = z.infer<typeof TrackChapterSchema>;
