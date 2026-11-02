// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ProviderCallProviderSchema = z
    .enum([
        'tmdb',
        'mdblist',
        'theaudiodb',
        'fanart',
        'musicbrainz',
        'coverartarchive',
        'acoustid',
        'openai',
        'audiobookshelf',
        'jellyfin',
        'voyage',
        'anthropic',
        'lrclib',
        'lastfm',
        'deezer',
        'discogs',
        'anidb',
        'myanimelist',
    ])
    .describe('Stable provider identifier; no URLs, credentials or user identifiers');
export type ProviderCallProvider = z.infer<typeof ProviderCallProviderSchema>;

export const ProviderCallCountsSchema = z
    .object({
        requests: z
            .number()
            .int()
            .nonnegative()
            .describe('HTTP attempts, including retries and redirects'),
        success2xx: z.number().int().nonnegative().describe('HTTP 200–299 responses'),
        client4xx: z
            .number()
            .int()
            .nonnegative()
            .describe('HTTP 400–499 responses, including 404 and 429'),
        rateLimited429: z
            .number()
            .int()
            .nonnegative()
            .describe('HTTP 429 responses; a subset of client4xx'),
        server5xx: z.number().int().nonnegative().describe('HTTP 500–599 responses'),
        networkErrors: z.number().int().nonnegative().describe('Attempts without an HTTP response'),
        retries: z
            .number()
            .int()
            .nonnegative()
            .describe('Additional attempts from an HTTP retry loop; not redirects'),
    })
    .describe('Counts for a provider over one UTC hour or the requested window');
export type ProviderCallCounts = z.infer<typeof ProviderCallCountsSchema>;

export const ProviderCallsQuerySchema = z.object({
    hours: z.coerce
        .number()
        .int()
        .min(1)
        .max(192)
        .default(24)
        .describe('Number of UTC hour buckets, including the current partial hour (1–192)'),
});

export const ProviderCallsResponseSchema = z
    .object({
        hours: z.number().int().min(1).max(192).describe('Number of hourly buckets returned'),
        from: z.string().datetime().describe('Start of the oldest UTC hour, inclusive'),
        to: z.string().datetime().describe('Time of this reading; the current hour is partial'),
        providers: z
            .array(
                z.object({
                    provider: ProviderCallProviderSchema,
                    totals: ProviderCallCountsSchema.describe('Sum of the hourly series'),
                    series: z
                        .array(
                            ProviderCallCountsSchema.extend({
                                hour: z.string().datetime().describe('Start of this UTC hour'),
                            }),
                        )
                        .describe('Oldest first, with zero-filled hours'),
                }),
            )
            .describe('All supported providers, including providers without traffic'),
    })
    .describe(
        'Best-effort provider HTTP counters shared by web and worker processes; retained eight days',
    );
export type ProviderCallsResponse = z.infer<typeof ProviderCallsResponseSchema>;
