// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const TrickplayHwaccelDenyEntrySchema = z.object({
    device: z.string().describe('TRICKPLAY_HWACCEL_DEVICE this entry was recorded against'),
    codec: z.string().describe('ffprobe codec name, e.g. "hevc"'),
    pixFmt: z
        .string()
        .describe(
            'ffprobe pix_fmt, e.g. "yuv420p10le" — bit depth/chroma are folded in here, not the codec',
        ),
    expiresAt: z
        .string()
        .nullable()
        .describe('ISO timestamp the entry ages out, or null when it has no discoverable TTL'),
});

export const TrickplayHwaccelDenyListResponseSchema = z.object({
    device: z.string().describe('TRICKPLAY_HWACCEL_DEVICE this deny list is scoped to'),
    denied: z.array(TrickplayHwaccelDenyEntrySchema),
});

/** DELETE response for the admin page's per-entry and clear-all buttons. */
export const TrickplayHwaccelDenyClearedResponseSchema = z.object({
    cleared: z.number().int().nonnegative().describe('Number of deny entries removed'),
});

export type TrickplayHwaccelDenyEntry = z.infer<typeof TrickplayHwaccelDenyEntrySchema>;
export type TrickplayHwaccelDenyListResponse = z.infer<
    typeof TrickplayHwaccelDenyListResponseSchema
>;
export type TrickplayHwaccelDenyClearedResponse = z.infer<
    typeof TrickplayHwaccelDenyClearedResponseSchema
>;
