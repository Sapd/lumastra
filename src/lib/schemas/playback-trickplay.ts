// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const TrickplayManifestResponseSchema = z.object({
    fileId: z.uuid(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    tileColumns: z.number().int().positive(),
    tileRows: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
    thumbnailCount: z.number().int().nonnegative(),
    sheets: z.array(z.object({
        index: z.number().int().nonnegative(),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        href: z.string(),
    })),
});

export type TrickplayManifestResponse = z.infer<typeof TrickplayManifestResponseSchema>;
