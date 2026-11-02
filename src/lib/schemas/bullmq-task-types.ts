// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BullMQ Task Response Schemas
 *
 * Standardized schemas for BullMQ task endpoints.
 * All AI task endpoints return this format.
 */

import { z } from 'zod';

/**
 * Standard BullMQ task status response
 * Used by all AI task GET endpoints
 */
export const BullMQTaskStatusSchema = z
    .object({
        /** Whether task is currently running */
        isRunning: z.boolean().describe('Is running'),
        /** Current job state */
        jobState: z
            .enum(['active', 'waiting', 'completed', 'failed', 'delayed', 'paused'])
            .nullable()
            .describe('Job state'),
        /** Task progress */
        progress: z
            .object({
                /** Processed items count */
                processedItems: z.number().optional().describe('Processed items'),
                /** Total items count */
                totalItems: z.number().int().optional().describe('Total items'),
                /** Current item being processed */
                currentItem: z.string().optional().describe('Current item'),
                /** Current sub-status */
                currentSubStatus: z.string().optional().describe('Current sub-status'),
                /** Task phase */
                phase: z.string().optional().describe('Task phase'),
                /** Error messages */
                errors: z.array(z.string()).optional().describe('Errors'),
                /** Recent log messages */
                recentLogs: z.array(z.string()).optional().describe('Recent logs'),
                /** Items created */
                created: z.number().optional().describe('Created items'),
                /** Items updated */
                updated: z.number().optional().describe('Updated items'),
                /** Items skipped */
                skipped: z.number().optional().describe('Skipped items'),
                /** Estimated time remaining */
                estimatedTimeRemaining: z.string().optional().describe('Estimated time remaining'),
                /** Alternative property names (for compatibility) */
                processed: z.number().optional().describe('Processed (alt)'),
                total: z.number().int().optional().describe('Total (alt)'),
                current_item: z.string().optional().describe('Current item (alt)'),
                /** Custom task-specific stats */
                episodesSynced: z.number().optional().describe('Episodes synced'),
                moviesSynced: z.number().optional().describe('Movies synced'),
            })
            .passthrough()
            .meta({
                id: 'BullMQTaskProgress',
                description: 'Task progress information',
            })
            .nullable()
            .describe('Progress'),
        /** Last completed run */
        lastRun: z
            .object({
                /** Completion timestamp */
                completedAt: z.string().optional().describe('Completion timestamp'),
                /** Task result data */
                result: z
                    .object({
                        /** Result status */
                        status: z.string().optional().describe('Result status'),
                        /** Duration in milliseconds */
                        duration: z.number().optional().describe('Duration (ms)'),
                        /** Items created */
                        created: z.number().optional().describe('Created'),
                        /** Items updated */
                        updated: z.number().optional().describe('Updated'),
                        /** Items skipped */
                        skipped: z.number().optional().describe('Skipped'),
                        /** Error count */
                        errors: z.number().optional().describe('Errors'),
                        /** Episodes synced */
                        episodesSynced: z.number().optional().describe('Episodes synced'),
                        /** Movies synced */
                        moviesSynced: z.number().optional().describe('Movies synced'),
                    })
                    .passthrough()
                    .optional()
                    .describe('Result data'),
            })
            .nullable()
            .meta({
                id: 'BullMQLastRunResult',
                description: 'Last run result',
            })
            .describe('Last run'),
    })
    .meta({
        id: 'BullMQTaskStatus',
        description: 'BullMQ task status response',
    });

export type BullMQTaskStatus = z.infer<typeof BullMQTaskStatusSchema>;
