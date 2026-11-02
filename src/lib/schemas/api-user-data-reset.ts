// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

export const RESET_ACTIONS = [
    'music-history',
    'music-feedback',
    'music-recs',
    'vod-resume',
    'vod-history',
    'vod-recs',
] as const;

/** Actions that hard-delete history/feedback and require `confirm: true`. */
export const DESTRUCTIVE_ACTIONS = new Set<(typeof RESET_ACTIONS)[number]>([
    'music-history',
    'music-feedback',
    'vod-history',
]);

export const userDataResetBodySchema = z.object({
    action: z.enum(RESET_ACTIONS).describe('Which reset to perform'),
    confirm: z.boolean().optional().describe('Required true for destructive actions'),
});
export type UserDataResetBody = z.infer<typeof userDataResetBodySchema>;

export const UserDataResetResponseSchema = z.object({
    action: z.enum(RESET_ACTIONS),
    cleared: z.record(z.string(), z.number()).describe('Per-store deleted row counts'),
});
export type UserDataResetResponse = z.infer<typeof UserDataResetResponseSchema>;
