// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types for admin metrics and monitoring
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/admin-types'.
 */

export type {
    CpuUsage,
    GpuUtilization,
    GpuInfo,
    MemoryInfo,
    NetworkInfo,
    MediaBandwidth,
    ProcessMetrics,
    FFmpegAggregateMetrics,
    SystemMetrics,
    StreamThroughput,
    FFmpegJobInfo,
    FFmpegJobsResponse,
} from '$lib/schemas/admin-types';
