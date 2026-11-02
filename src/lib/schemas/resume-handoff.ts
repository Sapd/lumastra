// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ResumeHandoffQuerySchema = z
    .object({
        mediaId: z.uuid().meta({ description: 'Item the asking player shows' }),
        positionMs: z.coerce
            .number()
            .int()
            .min(0)
            .max(7 * 24 * 60 * 60_000)
            .meta({
                description: "The asking player's playhead (ms): where the chain starts",
            }),
        deviceId: z.string().min(1).max(128).meta({
            description:
                "The asking player's device id (as sent on play-session start); never followed",
        }),
        idleMs: z.coerce
            .number()
            .int()
            .min(0)
            .max(365 * 24 * 60 * 60_000)
            .meta({
                description:
                    "Milliseconds since the asking player's last own action (play, pause, seek, opening the item). Only playback that started after it counts",
            }),
    })
    .meta({ id: 'ResumeHandoffQuery' });

export const ResumeHandoffTargetSchema = z
    .object({
        mediaId: z.uuid().describe('Item to show: the same item, or a later episode of its series'),
        positionMs: z.number().int().nonnegative().describe('Where to put the playhead (ms)'),
        relation: z
            .enum(['same_media', 'later_episode'])
            .describe('same_media: seek in place; later_episode: open mediaId'),
        sameFileAsFrom: z
            .boolean()
            .describe(
                'The later episode is in the caller’s file (combined multi-episode file): seek, do not reopen',
            ),
        seasonNumber: z
            .number()
            .int()
            .optional()
            .describe('Season of mediaId in the active episode ordering (episodes only)'),
        episodeNumber: z
            .number()
            .int()
            .optional()
            .describe('Episode number of mediaId in the active episode ordering (episodes only)'),
        deviceName: z.string().optional().describe('Device that continued, when known'),
        chainId: z
            .string()
            .describe(
                'Identifies the chain of sessions this answer follows. After the viewer undoes a handoff, ignore later answers with the same chainId',
            ),
        updatedAt: z.string().datetime().describe('When that device last moved the playhead'),
        serverNow: z
            .string()
            .datetime()
            .describe(
                'Server clock at answer time; compare serverNow - updatedAt with the time since your own last action',
            ),
    })
    .meta({ id: 'ResumeHandoffTarget' });

export const ResumeHandoffResponseSchema = z
    .object({
        handoff: ResumeHandoffTargetSchema.optional().describe(
            'Absent when the caller should stay where it is',
        ),
    })
    .meta({ id: 'ResumeHandoffResponse' });

export type ResumeHandoffTarget = z.infer<typeof ResumeHandoffTargetSchema>;
export type ResumeHandoffResponse = z.infer<typeof ResumeHandoffResponseSchema>;
