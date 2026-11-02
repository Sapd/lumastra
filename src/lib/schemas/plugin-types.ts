// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Status Types - Zod Schemas
 *
 * Schemas for plugin status monitoring and background task results.
 * These types are safe to import on both server and client.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';

// ============================================================================
// Plugin Progress
// ============================================================================

/**
 * Progress info for a running plugin task
 */
export const PluginProgressSchema = z
    .object({
        /** Number of items processed so far */
        processed: z.number().int().describe('Items processed'),
        /** Total number of items to process */
        total: z.number().int().describe('Total items'),
    })
    .meta({ description: 'Plugin task progress' });

export type PluginProgress = z.infer<typeof PluginProgressSchema>;

// ============================================================================
// Sync Task Result (Serialized)
// ============================================================================

/**
 * Serialized sync task result for JSON API responses.
 * Dates are converted to ISO strings during serialization.
 */
export const SyncTaskResultSerializedSchema = z
    .object({
        /** Whether the sync completed successfully */
        success: z.boolean().optional().describe('Sync succeeded'),
        /** When the sync completed (ISO string) */
        timestamp: z.string().optional().describe('Completion timestamp'),
        /** Human-readable result message */
        message: z.string().optional().describe('Result message'),
        /** Error message if failed */
        error: z.string().optional().describe('Error message'),
        /** Number of items processed */
        itemsProcessed: z.number().int().optional().describe('Items processed'),
        /** Duration in milliseconds */
        duration: z.number().int().optional().describe('Duration (ms)'),
    })
    .catchall(z.unknown()) // Allow additional task-specific data
    .meta({ description: 'Sync task result (serialized for JSON)' });

export type SyncTaskResultSerialized = z.infer<typeof SyncTaskResultSerializedSchema>;

// ============================================================================
// Plugin Status (Serialized)
// ============================================================================

/**
 * Serialized plugin status for client-side consumption.
 * All dates are ISO strings after JSON serialization.
 */
export const PluginStatusSerializedSchema = z
    .object({
        /** Unique plugin identifier */
        pluginId: z.string().describe('Plugin ID'),
        /** Human-readable plugin name */
        name: z.string().describe('Plugin name'),
        /** Plugin description */
        description: z.string().describe('Plugin description'),
        /** Whether plugin is enabled */
        enabled: z.boolean().describe('Plugin enabled'),
        /** Whether plugin task is currently running */
        isRunning: z.boolean().describe('Task is running'),
        /** When the current run started (ISO string, null if not running) */
        startedAt: z.string().nullable().describe('Current run start time'),
        /** When the last run completed (ISO string, null if never run) */
        lastRunTime: z.string().nullable().describe('Last run completion time'),
        /** Result of last run (null if never run) */
        lastResult: SyncTaskResultSerializedSchema.nullable().describe('Last run result'),
        /** Scheduled next run time (ISO string, null if not scheduled) */
        nextRunTime: z.string().nullable().describe('Next scheduled run'),
        /** Sync interval in hours */
        intervalHours: z.number().describe('Sync interval (hours)'),
        /** Current progress (null if not running) */
        progress: PluginProgressSchema.nullable().describe('Current progress'),
    })
    .meta({ description: 'Plugin status (serialized for client)' });

export type PluginStatusSerialized = z.infer<typeof PluginStatusSerializedSchema>;

/**
 * Shared PluginInfo shape used by PluginCard.svelte and admin plugins page.
 * All fields from both components' local interfaces are merged here.
 */
export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    type: string;
    enabled: boolean;
    status: string;
    source?: 'builtin' | 'external';
    lastError?: string;
    registeredAt?: string;
    hasSettings: boolean;
}
