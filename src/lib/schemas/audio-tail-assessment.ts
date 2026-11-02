// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { FileHealthIssueSchema } from './api-media-responses.js';

const IntervalSchema = z.object({ start: z.number().finite(), end: z.number().finite() });
export const AudioTailAssessmentSchema = z.object({
    version: z.literal(1),
    ruleVersion: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('File health recheck rule version'),
    measuredAt: z.string(),
    method: z.enum(['ffmpeg-astats-frames-v1', 'ffmpeg-astats-frames-v2']),
    thresholdDbfs: z.literal(-60),
    completeness: z.literal('unverified'),
    scope: z.enum(['measured', 'partial', 'inconclusive']),
    observation: z.enum(['near_silent', 'audible', 'unknown']),
    requested: IntervalSchema.optional(),
    inventorySignature: z.string(),
    inventory: z.array(z.record(z.string(), z.unknown())),
    source: z.object({ generation: z.string(), physical: z.string(), streams: z.string() }),
    limits: z.object({
        seconds: z.literal(180),
        streams: z.literal(8),
        concurrency: z.literal(2),
        budgetMs: z.literal(90000),
    }),
    reviewedIssues: z.array(FileHealthIssueSchema).optional(),
    packetTail: z
        .object({
            success: z.boolean(),
            endedPrematurely: z.boolean(),
            hasAudio: z.boolean(),
            videoEnd: z.number().nonnegative().finite().optional(),
            audioEnd: z.number().nonnegative().finite().optional(),
        })
        .optional()
        .describe(
            'Current selected-file packet-tail probe; clean EOF is not content-completeness proof',
        ),
    reasons: z.array(z.string()),
    streams: z.array(
        z.object({
            index: z.number().int().nonnegative(),
            requested: IntervalSchema,
            /** Successful packet traversal to the physical demux EOF, for new observations only. */
            packetEof: z.boolean().optional(),
            packetInterval: IntervalSchema.optional(),
            packetCount: z.number().int().positive().optional(),
            packetEnd: z.number().finite().optional(),
            noPostVideoPackets: z.boolean().optional(),
            timingToleranceSeconds: z.number().positive().finite().optional(),
            decoded: IntervalSchema.optional(),
            samples: z.number().int().nonnegative(),
            coverageSeconds: z.number().nonnegative(),
            continuous: z.boolean(),
            channels: z.array(
                z.object({
                    channel: z.number().int().positive(),
                    peakDbfs: z.number().finite(),
                    rmsDbfs: z.number().finite(),
                    digitalZero: z.boolean(),
                }),
            ),
            reasons: z.array(z.string()),
        }),
    ),
});
export type AudioTailAssessment = z.infer<typeof AudioTailAssessmentSchema>;
