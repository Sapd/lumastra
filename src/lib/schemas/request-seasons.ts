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
            isPending: z.boolean(),
        }),
    ),
});
