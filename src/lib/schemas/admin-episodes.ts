// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ReorderEpisodesRequestSchema = z.object({
    items: z
        .array(
            z.object({
                id: z.string().guid(),
                episodeNumber: z.number().int().min(1).max(100000),
            }),
        )
        .min(1),
});

export type ReorderEpisodesRequest = z.infer<typeof ReorderEpisodesRequestSchema>;
