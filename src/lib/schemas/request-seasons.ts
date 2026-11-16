// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

export const RequestSeasonsResponseSchema = z.object({
    items: z.array(
        z.object({
            seasonNumber: z.number().int(),
            name: z.string(),
            episodeCount: z.number().int(),
            airDate: z.string().nullable(),
            overview: z.string().nullable(),
            posterPath: z.string().nullable(),
            isAvailable: z.boolean(),
            /** True when Seerr would refuse a request for this season (see `trackedAs`). */
            isPending: z.boolean(),
            trackedAs: z
                .enum(['requested', 'partly_available', 'blocklisted'])
                .optional()
                .describe(
                    'Why the season cannot be requested: already requested, partly available, or blocklisted in Seerr. Absent when it can be requested or is fully available.',
                ),
        }),
    ),
});
