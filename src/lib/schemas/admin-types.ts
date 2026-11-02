// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin-Related Zod Schemas
 *
 * Combined schemas for admin metrics, AI admin features, and cache statistics.
 * These schemas define the contract for admin API endpoints.
 *
 * Usage:
 * - Server: Validate API responses
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 *
 * Sources:
 * - src/lib/types/admin-metrics.ts
 * - src/lib/types/ai-admin.types.ts
 * - src/lib/types/cache-stats.ts
 */

import { z } from 'zod';
import { ExternalIdsResponseSchema } from './api-responses';

// ============================================================================
// Admin Metrics (from admin-metrics.ts)
// ============================================================================

/**
 * CPU usage metrics
 */
export const CpuUsageSchema = z
    .object({
        /** User mode CPU time percentage */
        user: z.number().describe('User mode CPU time percentage'),
        /** System mode CPU time percentage */
        system: z.number().describe('System mode CPU time percentage'),
        /** Idle CPU time percentage */
        idle: z.number().describe('Idle CPU time percentage'),
        /** Total CPU usage percentage */
        total: z.number().describe('Total CPU usage percentage'),
    })
    .meta({ id: 'CpuUsage', description: 'CPU usage metrics' });

export type CpuUsage = z.infer<typeof CpuUsageSchema>;

/**
 * GPU utilization metrics
 */
export const GpuUtilizationSchema = z
    .object({
        /** GPU busy percentage */
        busy: z.number().describe('GPU busy percentage'),
        /** Current GPU frequency in MHz */
        freqMhz: z.number().describe('Current GPU frequency in MHz'),
        /** Maximum GPU frequency in MHz */
        freqMaxMhz: z.number().describe('Maximum GPU frequency in MHz'),
        /** GPU frequency as percentage of maximum */
        freqPercent: z.number().describe('GPU frequency as percentage of maximum'),
        /** GPU power consumption in watts */
        powerWatts: z.number().optional().describe('GPU power consumption in watts'),
    })
    .meta({ id: 'GpuUtilization', description: 'GPU utilization metrics' });

export type GpuUtilization = z.infer<typeof GpuUtilizationSchema>;

/**
 * GPU acceleration information
 */
export const GpuInfoSchema = z
    .object({
        /** Configured GPU acceleration type */
        configured: z.string().describe('Configured GPU acceleration type'),
        /** Whether GPU was detected */
        detected: z.boolean().describe('Whether GPU was detected'),
        /** Whether GPU is accessible */
        accessible: z.boolean().describe('Whether GPU is accessible'),
        /** GPU name/model */
        name: z.string().optional().describe('GPU name/model'),
        /** GPU driver version */
        driver: z.string().optional().describe('GPU driver version'),
        /** Error message if GPU check failed */
        error: z.string().optional().describe('Error message if GPU check failed'),
        /** Raw test output from GPU probe */
        testOutput: z.string().optional().describe('Raw test output from GPU probe'),
        /** Current GPU utilization metrics */
        utilization: GpuUtilizationSchema.optional().describe('Current GPU utilization metrics'),
        /** VRAM total in MB */
        vramTotalMB: z.number().optional().describe('VRAM total in MB'),
        /** VRAM used in MB */
        vramUsedMB: z.number().optional().describe('VRAM used in MB'),
        /** GPU core utilization % */
        gpuUtilization: z.number().optional().describe('GPU core utilization percentage'),
        /** Encoder utilization % */
        encoderUtilization: z.number().optional().describe('Encoder utilization percentage'),
        /** Decoder utilization % */
        decoderUtilization: z.number().optional().describe('Decoder utilization percentage'),
        /** Active encode sessions */
        encodeSessions: z.number().optional().describe('Active encode sessions'),
        /** Max concurrent encode sessions (0=unlimited) */
        maxEncodeSessions: z.number().optional().describe('Max concurrent encode sessions'),
        /** Average encode FPS */
        encodeFps: z.number().optional().describe('Average encode FPS across sessions'),
        /** Average encode latency in microseconds */
        encodeLatencyUs: z.number().optional().describe('Average encode latency in microseconds'),
        /** GPU temperature in Celsius */
        temperatureC: z.number().optional().describe('GPU temperature in Celsius'),
        /** Current power draw in watts */
        powerDrawW: z.number().optional().describe('Current power draw in watts'),
        /** Power limit in watts */
        powerLimitW: z.number().optional().describe('Power limit in watts'),
        /** Performance state (P0-P12) */
        pstate: z.string().optional().describe('GPU performance state'),
        /** Available transcoding capabilities */
        capabilities: z.array(z.string()).optional().describe('Available transcoding capabilities'),
        /** Advisory when a usable GPU is present but GPU_ACCELERATION=none (CPU-only) */
        advisory: z.string().optional().describe('Operator nudge, e.g. a detected-but-unused GPU'),
    })
    .meta({ id: 'GpuInfo', description: 'GPU acceleration information' });

export type GpuInfo = z.infer<typeof GpuInfoSchema>;

/**
 * Memory usage metrics
 */
export const MemoryInfoSchema = z
    .object({
        /** Total system memory in MB */
        totalMB: z.number().describe('Total system memory in MB'),
        /** Used memory in MB */
        usedMB: z.number().describe('Used memory in MB'),
        /** Free memory in MB */
        freeMB: z.number().describe('Free memory in MB'),
        /** Used memory as percentage */
        usedPercent: z.number().describe('Used memory as percentage'),
    })
    .meta({ id: 'MemoryInfo', description: 'Memory usage metrics' });

export type MemoryInfo = z.infer<typeof MemoryInfoSchema>;

/**
 * Network I/O metrics
 */
export const NetworkInfoSchema = z
    .object({
        /** Received bytes per second */
        rxBytesPerSec: z.number().describe('Received bytes per second'),
        /** Transmitted bytes per second */
        txBytesPerSec: z.number().describe('Transmitted bytes per second'),
        /** Received megabits per second */
        rxMbps: z.number().describe('Received megabits per second'),
        /** Transmitted megabits per second */
        txMbps: z.number().describe('Transmitted megabits per second'),
    })
    .meta({ id: 'NetworkInfo', description: 'Network I/O metrics' });

export type NetworkInfo = z.infer<typeof NetworkInfoSchema>;

/**
 * Media bandwidth history entry
 */
export const MediaBandwidthHistoryEntrySchema = z
    .object({
        timestamp: z.number().describe('Unix timestamp'),
        hlsSegmentsMbps: z.number().describe('HLS transcode/remux bandwidth in Mbps'),
        directPlayMbps: z.number().describe('Direct play bandwidth in Mbps'),
        liveTVMbps: z.number().describe('LiveTV bandwidth in Mbps'),
        proxiedStreamsMbps: z.number().describe('Jellyfin-proxied bandwidth in Mbps'),
        imagesMbps: z.number().describe('Images bandwidth in Mbps'),
        subtitlesMbps: z.number().describe('Subtitles bandwidth in Mbps'),
        trickplayMbps: z.number().describe('Trickplay bandwidth in Mbps'),
        totalMbps: z.number().describe('Total bandwidth in Mbps'),
        hlsSegmentsPeakMbps: z.number().describe('Peak HLS bandwidth in Mbps'),
        directPlayPeakMbps: z.number().describe('Peak direct play bandwidth in Mbps'),
        liveTVPeakMbps: z.number().describe('Peak LiveTV bandwidth in Mbps'),
        proxiedStreamsPeakMbps: z.number().describe('Peak proxied bandwidth in Mbps'),
        imagesPeakMbps: z.number().describe('Peak images bandwidth in Mbps'),
        subtitlesPeakMbps: z.number().describe('Peak subtitles bandwidth in Mbps'),
        trickplayPeakMbps: z.number().describe('Peak trickplay bandwidth in Mbps'),
        totalPeakMbps: z.number().describe('Peak total bandwidth in Mbps'),
    })
    .meta({
        id: 'MediaBandwidthHistoryEntry',
        description: 'Media bandwidth history entry',
    });

export type MediaBandwidthHistoryEntry = z.infer<typeof MediaBandwidthHistoryEntrySchema>;

/**
 * Media bandwidth metrics
 */
export const MediaBandwidthSchema = z
    .object({
        hlsSegmentsBytesPerSec: z.number().describe('HLS transcode/remux bytes per second'),
        directPlayBytesPerSec: z.number().describe('Direct play bytes per second'),
        liveTVBytesPerSec: z.number().describe('LiveTV bytes per second'),
        proxiedStreamsBytesPerSec: z.number().describe('Jellyfin-proxied bytes per second'),
        imagesBytesPerSec: z.number().describe('Images bytes per second'),
        subtitlesBytesPerSec: z.number().describe('Subtitles bytes per second'),
        trickplayBytesPerSec: z.number().describe('Trickplay bytes per second'),
        totalBytesPerSec: z.number().describe('Total bytes per second'),
        hlsSegmentsMbps: z.number().describe('HLS transcode/remux Mbps'),
        directPlayMbps: z.number().describe('Direct play Mbps'),
        liveTVMbps: z.number().describe('LiveTV Mbps'),
        proxiedStreamsMbps: z.number().describe('Jellyfin-proxied Mbps'),
        imagesMbps: z.number().describe('Images Mbps'),
        subtitlesMbps: z.number().describe('Subtitles Mbps'),
        trickplayMbps: z.number().describe('Trickplay Mbps'),
        totalMbps: z.number().describe('Total Mbps'),
        history: z.array(MediaBandwidthHistoryEntrySchema).describe('Historical bandwidth data'),
    })
    .meta({ id: 'MediaBandwidth', description: 'Media bandwidth metrics' });

export type MediaBandwidth = z.infer<typeof MediaBandwidthSchema>;

/**
 * Process-specific metrics
 */
export const ProcessMetricsSchema = z
    .object({
        /** CPU usage percentage for this process */
        cpuPercent: z.number().describe('CPU usage percentage for this process'),
        /** Memory usage in MB for this process */
        memoryMB: z.number().describe('Memory usage in MB for this process'),
        /** Memory usage percentage for this process */
        memoryPercent: z.number().describe('Memory usage percentage for this process'),
        /** Process ID */
        pid: z.number().describe('Process ID'),
    })
    .meta({ id: 'ProcessMetrics', description: 'Process-specific metrics' });

export type ProcessMetrics = z.infer<typeof ProcessMetricsSchema>;

/**
 * Aggregate FFmpeg process metrics
 */
export const FFmpegAggregateMetricsSchema = z
    .object({
        /** Total number of active FFmpeg jobs */
        totalJobs: z.number().describe('Total number of active FFmpeg jobs'),
        /** Total CPU percentage across all FFmpeg processes */
        totalCpuPercent: z.number().describe('Total CPU percentage across all FFmpeg processes'),
        /** Total memory in MB across all FFmpeg processes */
        totalMemoryMB: z.number().describe('Total memory in MB across all FFmpeg processes'),
    })
    .meta({
        id: 'FFmpegAggregateMetrics',
        description: 'Aggregate FFmpeg process metrics',
    });

export type FFmpegAggregateMetrics = z.infer<typeof FFmpegAggregateMetricsSchema>;

/** One GPU device with its live figures (cluster heartbeat, src/shared/gpu-metrics.ts). */
export const ClusterGpuDeviceSchema = z
    .object({
        kind: z.enum(['dri', 'nvidia']).describe('Device family'),
        device: z.string().describe('Device node, e.g. renderD128'),
        driver: z.string().optional().describe('Kernel driver (i915, xe, amdgpu)'),
        name: z.string().optional().describe('GPU model, e.g. Intel Arc A380'),
        busyPercent: z
            .number()
            .optional()
            .describe('NVIDIA utilization.gpu, percent (real load). Absent for Intel/AMD'),
        awakePercent: z
            .number()
            .optional()
            .describe(
                'Intel: share of the interval the GPU was out of its idle state (RC6). Not load: anything that keeps the GPU awake reads 100 %. Engine load is in gpuEngines / process.gpu.engines',
            ),
        freqMhz: z.number().optional().describe('Current GPU clock, MHz'),
        freqMaxMhz: z.number().optional().describe('Maximum GPU clock, MHz'),
        powerWatts: z.number().optional().describe('GPU power draw, watts'),
        encoderPercent: z
            .number()
            .optional()
            .describe('NVIDIA encoder (NVENC) utilisation, percent'),
        decoderPercent: z
            .number()
            .optional()
            .describe('NVIDIA decoder (NVDEC) utilisation, percent'),
        encodeSessions: z
            .number()
            .optional()
            .describe('NVIDIA: NVENC sessions open on the device (whole host)'),
        maxEncodeSessions: z
            .number()
            .optional()
            .describe('NVIDIA: driver cap on NVENC sessions; 0 = no cap'),
        memUsedBytes: z.number().optional().describe('GPU memory in use'),
        memTotalBytes: z.number().optional().describe('GPU memory size'),
        temperatureC: z.number().optional().describe('GPU temperature, °C'),
    })
    .meta({
        id: 'ClusterGpuDevice',
        description: 'A GPU device of a host and its live figures',
    });

/** Percent of each engine class's capacity; video = encode/decode. */
export const ClusterGpuEnginesSchema = z
    .object({
        render: z.number().optional().describe('Render/3D engine, percent'),
        video: z.number().optional().describe('Video engine (encode/decode), percent'),
        videoEnhance: z.number().optional().describe('Video enhance engine (scaling), percent'),
        compute: z.number().optional().describe('Compute engine, percent'),
        copy: z.number().optional().describe('Copy engine, percent'),
    })
    .meta({ id: 'ClusterGpuEngines', description: 'GPU engine use by engine class' });

/**
 * One machine of the cluster with the figures every Lumastra service on it reports
 * in its Valkey heartbeat (refreshed every 10 s, read through the 15 s cluster
 * cache). Host figures are host-wide; GPU engine use is added up over the services.
 */
export const ClusterHostMetricsSchema = z
    .object({
        id: z.string().describe('Stable machine key (see ClusterHostInfo.id)'),
        name: z.string().optional().describe('Kubernetes node name or LUMASTRA_HOST_NAME'),
        cpuPercent: z
            .number()
            .optional()
            .describe('Host CPU busy over the last heartbeat interval, percent of all CPUs'),
        cpuCount: z.number().optional(),
        load1: z.number().optional().describe('Host load average, 1 minute'),
        memTotalBytes: z.number().optional(),
        memAvailableBytes: z.number().optional(),
        gpus: z.array(ClusterGpuDeviceSchema).optional(),
        gpuEngines: ClusterGpuEnginesSchema.optional().describe(
            "Engine use of Lumastra's FFmpeg processes on the host, summed over its services",
        ),
        gpuEncodes: z
            .object({
                inUse: z.number().describe('Open NVENC sessions, else FFmpeg processes on the GPU'),
                max: z.number().optional().describe('NVENC session cap; absent without one'),
            })
            .optional(),
        services: z
            .array(
                z.object({
                    kind: z
                        .enum(['web', 'worker', 'proxy', 'general', 'sonic'])
                        .describe('Service role'),
                    hostname: z.string().optional().describe('Pod or container hostname'),
                    state: z.enum(['healthy', 'degraded', 'stale', 'notConfigured']),
                    cpuPercent: z
                        .number()
                        .optional()
                        .describe('Process CPU, percent of ONE core (200 = two cores)'),
                    rssBytes: z
                        .number()
                        .optional()
                        .describe('Resident memory of the process and its children'),
                }),
            )
            .describe('Lumastra services on this machine'),
    })
    .meta({ id: 'ClusterHostMetrics', description: 'Live figures of one cluster host' });
export type ClusterHostMetrics = z.infer<typeof ClusterHostMetricsSchema>;

/**
 * System metrics response - numerical performance measurements
 *
 * Contains real-time resource utilization data: CPU%, memory usage, GPU stats,
 * network I/O, and process metrics. Used for performance monitoring.
 *
 * Note: Name similarity to SystemStatus is intentional for backward compatibility.
 * SystemMetrics = performance numbers, SystemStatus = health booleans + counts.
 * Do not rename without API versioning.
 *
 * @see SystemStatus for health check data
 */
export const SystemMetricsSchema = z
    .object({
        /** CPU usage metrics */
        cpu: CpuUsageSchema.describe('CPU usage metrics'),
        /** Memory usage metrics */
        memory: MemoryInfoSchema.describe('Memory usage metrics'),
        /** GPU information */
        gpu: GpuInfoSchema.describe('GPU information'),
        /** Network I/O metrics */
        network: NetworkInfoSchema.optional().describe('Network I/O metrics'),
        /** Media bandwidth metrics */
        mediaBandwidth: MediaBandwidthSchema.optional().describe('Media bandwidth metrics'),
        /** Dashboard process metrics */
        dashboard: ProcessMetricsSchema.optional().describe('Dashboard process metrics'),
        /** Aggregate FFmpeg metrics */
        ffmpegAggregate: FFmpegAggregateMetricsSchema.optional().describe(
            'Aggregate FFmpeg metrics',
        ),
        /** Path to FFmpeg binary */
        ffmpegPath: z.string().optional().describe('Path to FFmpeg binary'),
        /** FFmpeg version string */
        ffmpegVersion: z.string().optional().describe('FFmpeg version string'),
        /** Operating system platform */
        platform: z.string().describe('Operating system platform'),
        /** System hostname */
        hostname: z
            .string()
            .describe(
                'Hostname of the replica that answered; every figure except mediaBandwidth and ffmpegAggregate is for this replica only',
            ),
        /** System uptime in seconds */
        uptime: z.number().describe('System uptime in seconds'),
        hosts: z
            .array(ClusterHostMetricsSchema)
            .optional()
            .describe(
                "Every machine of the cluster with CPU, memory and GPU, from the services' heartbeats in Valkey (cluster-wide, unlike cpu/memory/gpu above). Absent when Valkey is unavailable",
            ),
        hostsGeneratedAt: z
            .string()
            .optional()
            .describe('ISO datetime the host figures were read from the heartbeats'),
    })
    .meta({
        id: 'SystemMetrics',
        description:
            'Metrics of the ONE server process that answered the request (see hostname): its CPU, memory, network and GPU probe. In a cluster with several web replicas and a worker this is not the whole system; per-host CPU, memory and GPU of every service are in the admin cluster view. mediaBandwidth and ffmpegAggregate are cluster-wide.',
    });

/** Sessions page: cluster-wide stream throughput, without the per-replica figures. */
export const StreamThroughputSchema = z
    .object({
        mediaBandwidth: MediaBandwidthSchema.optional().describe(
            'Media bandwidth across all replicas, with the last 60 minutes of history',
        ),
        ffmpegAggregate: FFmpegAggregateMetricsSchema.optional().describe(
            'CPU and memory of every running FFmpeg job across replicas',
        ),
    })
    .meta({ id: 'StreamThroughput', description: 'Cluster-wide stream throughput' });
export type StreamThroughput = z.infer<typeof StreamThroughputSchema>;

export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;

/**
 * FFmpeg job information
 * Mirrors FFmpegJobInfo from src/lib/server/services/transcoding/types.ts
 * as a client-accessible Zod schema (avoids server-only import in client code).
 */
export const FFmpegJobInfoSchema = z
    .object({
        jobId: z.string(),
        playSessionId: z.string(),
        itemId: z.string(),
        username: z.string(),
        deviceId: z.string(),
        status: z.string(),
        /**
         * `audiobook-remux` is NOT a video mode: `active_transcode_jobs` is shared,
         * and an audiobook row carries no `transcodeDecision` (no video stream to
         * describe), so without this value it would render as `full` — a full video
         * transcode badge on a book. Kept in step with `TranscodeDisplayType` in
         * `services/transcoding/types.ts`; this schema is what the response is
         * parsed through, so a value missing here is silently dropped.
         */
        mode: z.enum([
            'full',
            'remux',
            'audio-only',
            'audio-drop',
            'tonemapping',
            'audiobook-remux',
            'unknown',
        ]),
        error: z.string().optional(),

        // Timing
        startedAt: z.string(),
        elapsedSeconds: z.number(),
        lastAccessedAt: z.string(),
        lastAccessedSecondsAgo: z.number(),
        lastProgressAt: z.string(),
        lastProgressSecondsAgo: z.number(),

        // Progress
        segmentsReady: z.number(),
        segmentOffset: z.number(),
        totalSegments: z.number(),
        segmentDurationSeconds: z
            .number()
            .optional()
            .describe(
                "This job's HLS segment length in seconds. Copy-mode jobs use 10 s, so segment counts must be converted with this value, not the global segmentDuration.",
            ),
        progressPercent: z.number(),
        masterPlaylistReady: z.boolean(),
        isSeeking: z.boolean(),
        seekCount: z.number(),

        // Video
        videoCodec: z.string().optional(),
        videoOutputCodec: z.string().optional(),
        resolution: z.string().optional(),
        videoRange: z.string().optional(),

        // Audio
        audioTrackCount: z.number(),
        audioTracks: z.array(
            z.object({
                index: z.number().int(),
                language: z.string().optional(),
                codec: z.string().optional(),
                channels: z.number().optional(),
                displayTitle: z.string().optional(),
            }),
        ),

        // Subtitles
        subtitleTrackCount: z.number(),
        subtitles: z.array(
            z.object({
                index: z.number().int(),
                language: z.string().optional(),
                codec: z.string().optional(),
                displayTitle: z.string().optional(),
            }),
        ),

        // Transcode decision
        transcodeDecision: z
            .object({
                videoAction: z.enum(['copy', 'transcode']),
                audioAction: z.enum(['copy', 'transcode']),
                useGpu: z.boolean(),
                gpuEncoder: z.string().optional(),
                gpuDecoder: z.string().optional(),
                needsTonemapping: z.boolean(),
                hdrTonemapMode: z.enum(['hardware', 'software', 'n/a']).optional(),
                tonemappingAlgorithm: z.string().optional(),
            })
            .optional(),

        // Process
        processRunning: z.boolean(),
        processPid: z.number().optional(),

        // Resource usage
        cpuPercent: z.number().optional(),
        memoryMB: z.number().optional(),
        gpuVideoPercent: z.number().optional(),

        // Bitrates
        sourceBitrateMbps: z.number().optional(),
        targetBitrateMbps: z.number().optional(),

        // Transcode type
        transcodeType: z
            .enum([
                'remux',
                'audio-only',
                'audio-drop',
                'full',
                'tonemapping',
                'audiobook-remux',
                'unknown',
            ])
            .optional(),

        // Source file path
        sourceFilePath: z.string().optional(),

        // Output
        outputDir: z.string(),

        // Pod name
        podName: z.string().optional(),

        slowReason: z
            .enum(['gpu_busy', 'cpu_slow'])
            .optional()
            .describe(
                'The encode has run below real time for a while: gpu_busy when the GPU encoder is shared with another app (game streaming, OBS, instant replay), cpu_slow when the CPU cannot keep up with a software encode. Absent when it keeps up.',
            ),
        softwareFallbackFrom: z
            .string()
            .optional()
            .describe(
                'GPU encoder (e.g. hevc_nvenc) this job gave up on because it could not open an encode session; the job now encodes in software.',
            ),
    })
    .meta({ id: 'FFmpegJobInfo', description: 'FFmpeg job details' });

export type FFmpegJobInfo = z.infer<typeof FFmpegJobInfoSchema>;

/**
 * FFmpeg jobs response
 *
 * Note: Field naming has intentional inconsistency (segmentDuration vs *Seconds suffix)
 * to maintain backward compatibility with existing API clients. Units are documented
 * in descriptions. Do not rename fields without API versioning.
 */
export const FFmpegJobsResponseSchema = z
    .object({
        /** Active FFmpeg jobs */
        jobs: z.array(FFmpegJobInfoSchema).describe('Active FFmpeg jobs'),
        /** Total job count */
        count: z.number().int().describe('Total job count'),
        /** FFmpeg configuration */
        config: z
            .object({
                /** Whether transcoding is enabled */
                enabled: z.boolean().describe('Whether transcoding is enabled'),
                /** Transcoding mode */
                transcodingMode: z.string().describe('Transcoding mode'),
                /** GPU acceleration type */
                gpuAcceleration: z.string().describe('GPU acceleration type'),
                /** HLS segment duration in seconds */
                segmentDuration: z.number().describe('HLS segment duration in seconds'),
                /** Maximum concurrent jobs per user */
                maxJobsPerUser: z.number().describe('Maximum concurrent jobs per user'),
                /** Inactivity timeout in seconds */
                inactivityTimeoutSeconds: z.number().describe('Inactivity timeout in seconds'),
                /** Progress timeout in seconds */
                progressTimeoutSeconds: z.number().describe('Progress timeout in seconds'),
                /** Number of segments to keep behind playhead */
                segmentsKeepBehind: z
                    .number()
                    .describe('Number of segments to keep behind playhead'),
                /** Transcoding output directory */
                transcodeDir: z.string().describe('Transcoding output directory'),
            })
            .describe('FFmpeg configuration'),
    })
    .meta({ id: 'FFmpegJobsResponse', description: 'FFmpeg jobs response' });

export type FFmpegJobsResponse = z.infer<typeof FFmpegJobsResponseSchema>;

// ============================================================================
// AI Admin Types (from ai-admin.types.ts)
// ============================================================================

/**
 * System status overview - health checks and aggregate counts
 *
 * Contains boolean health indicators (AI, database, OpenAI) and aggregate
 * statistics (total media items, users, embeddings). Used for system health dashboard.
 *
 * Note: Name similarity to SystemMetrics is intentional for backward compatibility.
 * SystemStatus = health booleans + counts, SystemMetrics = performance numbers.
 * Do not rename without API versioning.
 *
 * @see SystemMetrics for performance monitoring data
 */
export const SystemStatusSchema = z
    .object({
        /** Whether AI system is healthy */
        aiHealthy: z.boolean().describe('Whether AI system is healthy'),
        /** Whether database is healthy */
        databaseHealthy: z.boolean().describe('Whether database is healthy'),
        /** Total media items in catalog */
        totalMediaItems: z.number().describe('Total media items in catalog'),
        /** Items with library embeddings */
        libraryEmbeddings: z.number().describe('Items with library embeddings'),
        /** Items with primary provider embeddings */
        primaryProviderEmbeddings: z.number().describe('Items with primary provider embeddings'),
        /** Items embedded as BOTH a library item and a discovery candidate. Normally ~0: the two sources are mutually exclusive per item (by has_files), so a persistently nonzero value is an invariant anomaly, not coverage. */
        bothEmbeddings: z
            .number()
            .describe(
                'Items embedded as both a library item and a discovery candidate (normally ~0 — the two sources are mutually exclusive by has_files; nonzero indicates an invariant anomaly, not better coverage)',
            ),
        /** Users with a computed AI profile embedding — NOT total registered users (stays 0 until background AI jobs run on watch/rating history). */
        totalUsers: z
            .number()
            .describe(
                'Users with a computed AI profile embedding (NOT total registered users — 0 on a fresh install until background AI jobs run)',
            ),
        /** Total AI suggestions generated */
        totalSuggestions: z.number().describe('Total AI suggestions generated'),
        /** Whether OpenAI API is available */
        openaiAvailable: z.boolean().describe('Whether OpenAI API is available'),
    })
    .meta({ id: 'SystemStatus', description: 'System status overview' });

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

/**
 * Sample media item with embedding
 */
export const EmbeddingSampleSchema = z
    .object({
        /** Unique media item ID */
        id: z.string().describe('Unique media item ID'),
        /** External provider IDs */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media title */
        title: z.string().describe('Media title'),
        /** Media type */
        mediaType: z.string().describe('Media type'),
        /** Genre list */
        genres: z.array(z.number()).nullable().describe('Genre list'),
        /** When embedding was created */
        createdAt: z.string().optional().describe('When embedding was created'),
    })
    .meta({
        id: 'EmbeddingSample',
        description: 'Sample media item with embedding',
    });

export type EmbeddingSample = z.infer<typeof EmbeddingSampleSchema>;

/**
 * Embedding coverage statistics
 */
export const EmbeddingCoverageSchema = z
    .object({
        /** Items with library-based embeddings */
        libraryEmbeddings: z.number().describe('Items with library-based embeddings'),
        /** Items with primary provider-based embeddings */
        primaryProviderEmbeddings: z
            .number()
            .describe('Items with primary provider-based embeddings'),
        /** Items embedded as BOTH a library item and a discovery candidate (normally ~0 — mutually exclusive by has_files). */
        bothEmbeddings: z
            .number()
            .describe(
                'Items embedded as both a library item and a discovery candidate (normally ~0 — mutually exclusive by has_files)',
            ),
        /** Items without any embeddings */
        noEmbeddings: z.number().describe('Items without any embeddings'),
    })
    .meta({
        id: 'EmbeddingCoverage',
        description: 'Embedding coverage statistics',
    });

export type EmbeddingCoverage = z.infer<typeof EmbeddingCoverageSchema>;

/**
 * Data quality metrics
 */
export const DataQualitySchema = z
    .object({
        /** Items with MDBList keywords */
        withMdblistKeywords: z.number().describe('Items with MDBList keywords'),
        /** Items with MDBList score */
        withMdblistScore: z.number().describe('Items with MDBList score'),
        /** Items with streaming service data */
        withStreamingServices: z.number().describe('Items with streaming service data'),
        /** Items missing genre data */
        missingGenres: z.number().describe('Items missing genre data'),
        /** Items missing overview */
        missingOverview: z.number().describe('Items missing overview'),
        /** Items missing actor data */
        missingActors: z.number().describe('Items missing actor data'),
        /** Items missing director data */
        missingDirectors: z.number().describe('Items missing director data'),
        /** Items with very short overview */
        veryShortOverview: z.number().describe('Items with very short overview'),
        /** Average overview length */
        avgOverviewLength: z.number().describe('Average overview length'),
        /** Average actor count per item */
        avgActorCount: z.number().describe('Average actor count per item'),
        /** Average genre count per item */
        avgGenreCount: z.number().describe('Average genre count per item'),
    })
    .meta({ id: 'DataQuality', description: 'Data quality metrics' });

export type DataQuality = z.infer<typeof DataQualitySchema>;

/**
 * Embedding overview stats — dynamic, no hardcoded media types
 */
export const EmbeddingOverviewStatsSchema = z
    .object({
        totalItems: z.number().int().describe('Total active media items'),
        mediaTypeBreakdown: z
            .array(
                z.object({
                    mediaType: z.string().describe('Media type'),
                    count: z.number().int().describe('Count'),
                }),
            )
            .describe('Count per media type'),
        embeddingSourceBreakdown: z
            .array(
                z.object({
                    source: z.string().describe('Embedding source'),
                    count: z.number().int().describe('Distinct media items with this source'),
                }),
            )
            .describe('Count per embedding source'),
        withoutExternalId: z.number().describe('Items without any external provider ID'),
        inLibrary: z.number().describe('Items available in library'),
        requestableOnly: z.number().describe('Items only requestable, not in library'),
    })
    .meta({
        id: 'EmbeddingOverviewStats',
        description: 'Dynamic overview stats for all media types',
    });

export type EmbeddingOverviewStats = z.infer<typeof EmbeddingOverviewStatsSchema>;

/**
 * Video embedding stats — scoped to movie/tv
 */
export const VideoEmbeddingStatsSchema = z
    .object({
        dataQuality: DataQualitySchema.describe('Video data quality metrics'),
        embeddingCoverage: EmbeddingCoverageSchema.describe('Video embedding coverage'),
        recentItems: z.array(EmbeddingSampleSchema).describe('Recently added video items'),
        sample: z.array(EmbeddingSampleSchema).describe('Random sample of video items'),
        noExternalIdItems: z
            .array(EmbeddingSampleSchema)
            .describe('Video items without external ID'),
    })
    .meta({
        id: 'VideoEmbeddingStats',
        description: 'Video domain embedding statistics',
    });

export type VideoEmbeddingStats = z.infer<typeof VideoEmbeddingStatsSchema>;

/**
 * Music embedding sample
 */
export const MusicEmbeddingSampleSchema = z
    .object({
        id: z.string().describe('Media item UUID'),
        title: z.string().describe('Track title'),
        artist: z.string().describe('Artist name'),
        album: z.string().optional().describe('Album name'),
        genres: z.array(z.string()).optional().describe('Genre list'),
        hasEmbedding: z.boolean().describe('Whether track has music embedding'),
    })
    .meta({
        id: 'MusicEmbeddingSample',
        description: 'Music track sample with embedding status',
    });

export type MusicEmbeddingSample = z.infer<typeof MusicEmbeddingSampleSchema>;

/**
 * Music embedding stats — scoped to tracks
 */
export const MusicEmbeddingStatsSchema = z
    .object({
        totalTracks: z.number().describe('Total active tracks'),
        withEmbedding: z.number().describe('Tracks with music embedding'),
        dataQuality: z
            .object({
                missingArtist: z.number().describe('Tracks missing artist'),
                missingAlbum: z.number().describe('Tracks missing album'),
                missingGenre: z.number().describe('Tracks missing genre'),
                missingBpm: z.number().describe('Tracks missing BPM'),
                missingMoodTags: z.number().describe('Tracks missing mood tags'),
                avgGenreCount: z.number().describe('Average genre count per track'),
            })
            .describe('Music data quality metrics'),
        recentTracks: z.array(MusicEmbeddingSampleSchema).describe('Recently added tracks'),
        sample: z.array(MusicEmbeddingSampleSchema).describe('Random sample of tracks'),
    })
    .meta({
        id: 'MusicEmbeddingStats',
        description: 'Music domain embedding statistics',
    });

export type MusicEmbeddingStats = z.infer<typeof MusicEmbeddingStatsSchema>;

/**
 * Embedding preview for a media item
 */
export const EmbeddingPreviewSchema = z
    .object({
        /** Data source */
        source: z.string().describe('Data source'),
        /** Media title */
        title: z.string().describe('Media title'),
        /** Canonical media type discriminator ('series' not 'tv') */
        type: z.enum(['movie', 'series']).describe('Canonical media type'),
        /** Primary external ID if available */
        primaryExternalId: z.string().nullable().describe('Primary external ID'),
        /** Generated embedding text */
        embeddingText: z.string().describe('Generated embedding text'),
        /** Raw source data (arbitrary provider fields at top level; values are JSON primitives) */
        rawData: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .describe('Raw source data'),
    })
    .meta({
        id: 'EmbeddingPreview',
        description: 'Embedding preview for a media item',
    });

export type EmbeddingPreview = z.infer<typeof EmbeddingPreviewSchema>;

/**
 * Embedding previews response
 */
export const EmbeddingPreviewsResponseSchema = z
    .object({
        /** Preview entries */
        previews: z.array(EmbeddingPreviewSchema).describe('Preview entries'),
        /** Metadata about preview generation */
        info: z
            .object({
                /** Whether Jellyfin is connected */
                jellyfinConnected: z.boolean().describe('Whether Jellyfin is connected'),
                /** Whether Jellyseerr is connected */
                jellyseerrConnected: z.boolean().describe('Whether Jellyseerr is connected'),
                /** Informational note */
                note: z.string().describe('Informational note'),
                /** Generation timestamp */
                timestamp: z.string().describe('Generation timestamp'),
            })
            .describe('Metadata about preview generation'),
    })
    .meta({
        id: 'EmbeddingPreviewsResponse',
        description: 'Embedding previews response',
    });

export type EmbeddingPreviewsResponse = z.infer<typeof EmbeddingPreviewsResponseSchema>;

/**
 * Admin user information
 * (Renamed from User to avoid conflict with other User types)
 */
export const AdminUserSchema = z
    .object({
        /** User ID */
        userId: z.string().describe('User ID'),
        /** Whether user has a profile */
        hasProfile: z.boolean().describe('Whether user has a profile'),
        /** Total number of ratings */
        totalRatings: z.number().describe('Total number of ratings'),
        /** Number of active suggestions */
        activeSuggestions: z.number().describe('Number of active suggestions'),
        /** Current ratings count */
        currentRatings: z.number().optional().describe('Current ratings count'),
        /** Last activity timestamp */
        lastActivity: z.string().nullish().describe('Last activity timestamp'),
        /** Whether to hide streams */
        hideStreams: z.boolean().optional().describe('Whether to hide streams'),
        /** User groups */
        groups: z.array(z.string()).nullish().describe('User groups'),
        /** When groups were last updated */
        groupsUpdatedAt: z.string().nullish().describe('When groups were last updated'),
    })
    .meta({ id: 'AdminUser', description: 'Admin user information' });

export type AdminUser = z.infer<typeof AdminUserSchema>;

/**
 * TMDB embedding generation configuration
 * TMDB-specific embedding configuration — intentionally provider-specific
 */
export const TmdbConfigSchema = z
    .object({
        /** Maximum movies to fetch */
        maxMovies: z.number().describe('Maximum movies to fetch'),
        /** Maximum series to fetch */
        maxSeries: z.number().describe('Maximum series to fetch'),
        /** Minimum rating threshold */
        minRating: z.number().describe('Minimum rating threshold'),
        /** Minimum vote count */
        minVotes: z.number().describe('Minimum vote count'),
        /** Minimum popularity score */
        minPopularity: z.number().describe('Minimum popularity score'),
        /** Focus on German content */
        germanFocus: z.boolean().describe('Focus on German content'),
        /** Include animation genre */
        includeAnimation: z.boolean().describe('Include animation genre'),
        /** Include documentaries */
        includeDocumentaries: z.boolean().describe('Include documentaries'),
        /** Use batch processing mode */
        useBatchMode: z.boolean().describe('Use batch processing mode'),
        /** Force rescan of existing items */
        forceRescan: z.boolean().describe('Force rescan of existing items'),
    })
    .meta({
        id: 'TmdbConfig',
        description: 'TMDB embedding generation configuration',
    });

export type TmdbConfig = z.infer<typeof TmdbConfigSchema>;

/**
 * MDBList embedding configuration
 */
export const MDBListEmbedConfigSchema = z
    .object({
        /** Items to fetch per list */
        itemsPerList: z.number().describe('Items to fetch per list'),
        /** Skip items that already have embeddings */
        skipExisting: z.boolean().describe('Skip items that already have embeddings'),
    })
    .meta({
        id: 'MDBListEmbedConfig',
        description: 'MDBList embedding configuration',
    });

export type MDBListEmbedConfig = z.infer<typeof MDBListEmbedConfigSchema>;

/**
 * MDBList list information
 */
export const MDBListInfoSchema = z
    .object({
        /** List ID */
        id: z.string().describe('List ID'),
        /** List name */
        name: z.string().describe('List name'),
        /** List path/URL */
        path: z.string().describe('List path/URL'),
        /** List type */
        type: z.string().describe('List type'),
    })
    .meta({ id: 'MDBListInfo', description: 'MDBList list information' });

export type MDBListInfo = z.infer<typeof MDBListInfoSchema>;

/**
 * Embedding lookup result
 */
export const EmbeddingLookupResultSchema = z
    .object({
        /** External provider IDs */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media title */
        title: z.string().describe('Media title'),
        /** Media type */
        mediaType: z.string().describe('Media type'),
        /** Overview text */
        overview: z.string().nullable().describe('Overview text'),
        /** Genres */
        genres: z.array(z.string()).nullable().describe('Genres'),
        /** Actors */
        actors: z.array(z.string()).nullable().describe('Actors'),
        /** Directors */
        directors: z.array(z.string()).nullable().describe('Directors'),
        /** Whether library embedding exists */
        hasLibraryEmbedding: z.boolean().describe('Whether library embedding exists'),
        /** Whether discovery embedding exists */
        hasDiscoveryEmbedding: z.boolean().describe('Whether discovery embedding exists'),
        /** MDBList score */
        mdblistScore: z.number().nullable().describe('MDBList score'),
        /** Created timestamp */
        createdAt: z.string().describe('Created timestamp'),
        /** Updated timestamp */
        updatedAt: z.string().describe('Updated timestamp'),
    })
    .meta({
        id: 'EmbeddingLookupResult',
        description: 'Embedding lookup result',
    });

export type EmbeddingLookupResult = z.infer<typeof EmbeddingLookupResultSchema>;

// ============================================================================
// Embedding Text Preview
// ============================================================================

export const EmbeddingTextResponseSchema = z
    .object({
        id: z.string().describe('Internal UUID of the media item'),
        title: z.string().describe('Media item title'),
        mediaType: z.string().describe('Media type (movie, tv, track, etc.)'),
        embeddingText: z
            .string()
            .describe('The exact text that would be sent to the embedding API'),
    })
    .meta({
        id: 'EmbeddingTextResponse',
        description: 'Embedding text preview for a media item',
    });

export type EmbeddingTextResponse = z.infer<typeof EmbeddingTextResponseSchema>;

// ============================================================================
// Cache Statistics (from cache-stats.ts)
// ============================================================================

/**
 * L1 cache statistics
 */
export const L1StatsSchema = z
    .object({
        /** Cache hits */
        hits: z.number().describe('Cache hits'),
        /** Cache misses */
        misses: z.number().describe('Cache misses'),
        /** Current cache size */
        size: z.number().describe('Current cache size'),
    })
    .meta({ id: 'L1Stats', description: 'L1 cache statistics' });

export type L1Stats = z.infer<typeof L1StatsSchema>;

/**
 * Cache namespace metrics (L1 memory + L2 Valkey)
 */
export const NamespaceMetricsSchema = z
    .object({
        /** L1 (in-memory) cache statistics */
        l1Stats: L1StatsSchema.describe('L1 cache statistics'),
        /** L2 (Valkey/Redis) cache hits */
        l2Hits: z.number().describe('L2 cache hits'),
    })
    .meta({ id: 'NamespaceMetrics', description: 'Cache namespace metrics' });

export type NamespaceMetrics = z.infer<typeof NamespaceMetricsSchema>;

/**
 * Per-directory file count broken down by output format. Surfaces how much
 * of the cache is WebP vs AVIF after the AVIF rollout — operators can see
 * the format distribution shifting as eager pre-gen warms up.
 */
export const FilesystemCacheFormatBreakdownSchema = z
    .object({
        webp: z.number().describe('.webp file count'),
        avif: z.number().describe('.avif file count'),
        jpg: z.number().describe('.jpg/.jpeg file count'),
        png: z.number().describe('.png file count'),
        other: z.number().describe('Files with other extensions'),
    })
    .meta({
        id: 'FilesystemCacheFormatBreakdown',
        description: 'Per-format file counts in a cache directory',
    });

export type FilesystemCacheFormatBreakdown = z.infer<typeof FilesystemCacheFormatBreakdownSchema>;

/**
 * Filesystem cache (images, etc.)
 */
export const FilesystemCacheSchema = z
    .object({
        /** Cache name */
        name: z.string().describe('Cache name'),
        /** Filesystem path */
        path: z.string().describe('Filesystem path'),
        /** Cache description */
        description: z.string().describe('Cache description'),
        /** Whether directory exists */
        exists: z.boolean().describe('Whether directory exists'),
        /** Number of cached files */
        fileCount: z.number().describe('Number of cached files'),
        /** Total size in bytes */
        totalSizeBytes: z.number().describe('Total size in bytes'),
        /** Formatted total size */
        totalSizeFormatted: z.string().describe('Formatted total size'),
        /** Oldest file timestamp */
        oldestFile: z.string().optional().describe('Oldest file timestamp'),
        /** Newest file timestamp */
        newestFile: z.string().optional().describe('Newest file timestamp'),
        /** Per-format file count breakdown (Tier 3) */
        formatBreakdown: FilesystemCacheFormatBreakdownSchema.optional().describe(
            'File counts broken down by output format',
        ),
    })
    .meta({ id: 'FilesystemCache', description: 'Filesystem cache' });

export type FilesystemCache = z.infer<typeof FilesystemCacheSchema>;

/**
 * Standalone LRU cache metrics
 */
export const StandaloneCacheSchema = z
    .object({
        /** Cache name */
        name: z.string().describe('Cache name'),
        /** Cache description */
        description: z.string().describe('Cache description'),
        /** Cache category */
        category: z.string().describe('Cache category'),
        /** Cache hits */
        hits: z.number().describe('Cache hits'),
        /** Cache misses */
        misses: z.number().describe('Cache misses'),
        /** Cache evictions */
        evictions: z.number().describe('Cache evictions'),
        /** Current cache size */
        size: z.number().describe('Current cache size'),
        /** Maximum cache size */
        maxSize: z.number().describe('Maximum cache size'),
        /** Hit rate percentage */
        hitRate: z.number().describe('Hit rate percentage'),
    })
    .meta({
        id: 'StandaloneCache',
        description: 'Standalone LRU cache metrics',
    });

export type StandaloneCache = z.infer<typeof StandaloneCacheSchema>;

/**
 * Transcoding cache statistics (HLS segments)
 */
export const TranscodingCacheStatsSchema = z
    .object({
        /** Whether transcoding is enabled */
        enabled: z.boolean().describe('Whether transcoding is enabled'),
        /** Cache directory path */
        path: z.string().describe('Cache directory path'),
        /** Whether directory exists */
        exists: z.boolean().describe('Whether directory exists'),
        /** Current cache size in bytes */
        currentSizeBytes: z.number().describe('Current cache size in bytes'),
        /** Formatted current size */
        currentSizeFormatted: z.string().describe('Formatted current size'),
        /** Number of active transcoding jobs */
        activeJobs: z.number().describe('Number of active transcoding jobs'),
        /** Maximum size observed in last 24h (bytes) */
        maxSize24hBytes: z.number().describe('Maximum size in last 24h (bytes)'),
        /** Formatted maximum 24h size */
        maxSize24hFormatted: z.string().describe('Formatted maximum 24h size'),
        /** Timestamp of maximum size */
        maxSize24hTimestamp: z.string().nullable().describe('Timestamp of maximum size'),
        /** Number of size samples collected */
        sampleCount: z.number().describe('Number of size samples collected'),
    })
    .meta({
        id: 'TranscodingCacheStats',
        description: 'Transcoding cache statistics',
    });

export type TranscodingCacheStats = z.infer<typeof TranscodingCacheStatsSchema>;

/**
 * Preview cache statistics (content-addressed hover/scrub preview artifacts).
 * Distinct from TranscodingCacheStats (per-playback HLS segments): this is the
 * shared, refcounted, LRU-budgeted preview artifact store keyed by content hash.
 */
export const PreviewCacheStatsSchema = z
    .object({
        /** Whether the preview cache is enabled (PREVIEW_CACHE_ENABLED) */
        enabled: z.boolean().describe('Whether the preview cache is enabled'),
        /** Total cached artifacts (ready + warming) */
        entries: z.number().describe('Total cached preview artifacts'),
        /** Artifacts fully transcoded and servable */
        ready: z.number().describe('Ready (servable) artifacts'),
        /** Artifacts currently transcoding */
        warming: z.number().describe('Warming (in-progress) artifacts'),
        /** Current on-disk size in bytes */
        totalBytes: z.number().describe('Current cache size in bytes'),
        /** Formatted current size */
        totalBytesFormatted: z.string().describe('Formatted current size'),
        /** Disk budget in bytes (0 = unlimited) */
        maxBytes: z.number().describe('Disk budget in bytes'),
        /** Formatted disk budget */
        maxBytesFormatted: z.string().describe('Formatted disk budget'),
        /** Percent of budget used (0 when unlimited) */
        percentUsed: z.number().describe('Percent of disk budget used'),
        /** Cache hits (reused an existing artifact) */
        hits: z.number().describe('Cache hits'),
        /** Cache misses (had to transcode a new artifact) */
        misses: z.number().describe('Cache misses'),
        /** Hit rate 0..1 (hits / (hits + misses)) */
        hitRate: z.number().describe('Hit rate 0..1'),
        /** Artifacts evicted by the LRU disk-budget sweep */
        evictions: z.number().describe('LRU evictions'),
    })
    .meta({
        id: 'PreviewCacheStats',
        description: 'Preview artifact cache statistics',
    });

export type PreviewCacheStatsResponse = z.infer<typeof PreviewCacheStatsSchema>;

/**
 * Subtitle cache memory stats
 */
export const SubtitleCacheMemorySchema = z
    .object({
        /** Current cache size */
        cacheSize: z.number().describe('Current cache size'),
        /** Cache statistics */
        stats: z
            .object({
                /** Cache hits */
                hits: z.number().describe('Cache hits'),
                /** Cache misses */
                misses: z.number().describe('Cache misses'),
            })
            .describe('Cache statistics'),
    })
    .meta({
        id: 'SubtitleCacheMemory',
        description: 'Subtitle cache memory stats',
    });

export type SubtitleCacheMemory = z.infer<typeof SubtitleCacheMemorySchema>;

/**
 * Subtitle cache file stats
 */
export const SubtitleCacheFileSchema = z
    .object({
        /** Total number of cached files */
        totalFiles: z.number().describe('Total number of cached files'),
        /** Formatted total size */
        totalSizeFormatted: z.string().describe('Formatted total size'),
        /** File cache hits */
        hits: z.number().describe('File cache hits'),
        /** File cache misses */
        misses: z.number().describe('File cache misses'),
        /** File cache hit rate */
        hitRate: z.number().describe('File cache hit rate'),
    })
    .meta({
        id: 'SubtitleCacheFile',
        description: 'Subtitle cache file stats',
    });

export type SubtitleCacheFile = z.infer<typeof SubtitleCacheFileSchema>;

/**
 * Subtitle cache statistics
 */
export const SubtitleCacheStatsSchema = z
    .object({
        /** In-memory cache stats */
        memory: SubtitleCacheMemorySchema.describe('In-memory cache stats'),
        /** File cache stats */
        file: SubtitleCacheFileSchema.describe('File cache stats'),
    })
    .meta({
        id: 'SubtitleCacheStats',
        description: 'Subtitle cache statistics',
    });

export type SubtitleCacheStats = z.infer<typeof SubtitleCacheStatsSchema>;

/**
 * Cache hit rate statistics
 */
export const CacheHitRateSchema = z
    .object({
        /** L1 cache hit rate */
        l1: z.number().describe('L1 cache hit rate'),
        /** L2 cache hit rate */
        l2: z.number().describe('L2 cache hit rate'),
        /** Combined hit rate */
        combined: z.number().describe('Combined hit rate'),
    })
    .meta({ id: 'CacheHitRate', description: 'Cache hit rate statistics' });

export type CacheHitRate = z.infer<typeof CacheHitRateSchema>;

/**
 * Aggregate cache statistics
 */
export const CacheAggregateSchema = z
    .object({
        /** Total L1 cache hits */
        totalL1Hits: z.number().describe('Total L1 cache hits'),
        /** Total L1 cache misses */
        totalL1Misses: z.number().describe('Total L1 cache misses'),
        /** Total L2 cache hits */
        totalL2Hits: z.number().describe('Total L2 cache hits'),
        /** Total L2 cache misses */
        totalL2Misses: z.number().describe('Total L2 cache misses'),
        /** Total L2 errors */
        totalL2Errors: z.number().describe('Total L2 errors'),
        /** Hit rate breakdown */
        hitRate: CacheHitRateSchema.describe('Hit rate breakdown'),
    })
    .meta({ id: 'CacheAggregate', description: 'Aggregate cache statistics' });

export type CacheAggregate = z.infer<typeof CacheAggregateSchema>;

/**
 * Cache health status
 */
export const CacheHealthSchema = z
    .object({
        /** L1 cache health */
        l1: z.boolean().describe('L1 cache health'),
        /** L2 cache health */
        l2: z.boolean().describe('L2 cache health'),
    })
    .meta({ id: 'CacheHealth', description: 'Cache health status' });

export type CacheHealth = z.infer<typeof CacheHealthSchema>;

/**
 * IMAGE_CACHE_MAX_BYTES budget vs current usage.
 * `withinBudget=false` means the next cleanup pass will evict oldest files.
 */
export const FilesystemCacheBudgetSchema = z
    .object({
        budgetBytes: z
            .number()
            .describe('IMAGE_CACHE_MAX_BYTES; 0 = unlimited (budget pass disabled)'),
        usedBytes: z.number().describe('Current total bytes across all image cache dirs'),
        usedFormatted: z.string().describe('Formatted current usage'),
        budgetFormatted: z.string().describe('Formatted budget (or "unlimited")'),
        percentUsed: z.number().describe('Percent of budget used (0-100, or 0 when unlimited)'),
        withinBudget: z.boolean().describe('True when usage <= budget'),
    })
    .meta({
        id: 'FilesystemCacheBudget',
        description: 'Image cache size budget snapshot',
    });

export type FilesystemCacheBudget = z.infer<typeof FilesystemCacheBudgetSchema>;

/**
 * Summary of the last `cleanupImageCaches` run, persisted in Valkey.
 */
export const FilesystemCacheLastCleanupSchema = z
    .object({
        finishedAt: z.string().describe('ISO timestamp of when the last cleanup finished'),
        durationMs: z.number().describe('How long the cleanup took'),
        ttlDeletedFiles: z
            .number()
            .describe('Files deleted by the TTL pass (older than retention)'),
        ttlFreedBytes: z.number().describe('Bytes freed by the TTL pass'),
        budgetDeletedFiles: z.number().describe('Files evicted by the size-budget pass'),
        budgetDeletedBytes: z.number().describe('Bytes evicted by the size-budget pass'),
        finalSizeBytes: z.number().describe('Total cache size after the cleanup'),
        success: z.boolean().describe('True when all directories cleaned without errors'),
    })
    .meta({
        id: 'FilesystemCacheLastCleanup',
        description: 'Last cleanup-run summary',
    });

export type FilesystemCacheLastCleanup = z.infer<typeof FilesystemCacheLastCleanupSchema>;

/**
 * Image format negotiation status pulled from config — useful for operators
 * checking that AVIF is on / which pre-gen mode the server is using.
 */
export const FilesystemCacheImageFormatsSchema = z
    .object({
        webpEnabled: z.boolean().describe('IMAGE_WEBP_ENABLED'),
        avifEnabled: z.boolean().describe('IMAGE_AVIF_ENABLED'),
        avifPregenMode: z.string().describe("IMAGE_AVIF_PREGEN_MODE ('eager' | 'lazy')"),
    })
    .meta({
        id: 'FilesystemCacheImageFormats',
        description: 'Active image format negotiation settings',
    });

export type FilesystemCacheImageFormats = z.infer<typeof FilesystemCacheImageFormatsSchema>;

/**
 * Filesystem cache aggregate
 */
export const FilesystemCacheAggregateSchema = z
    .object({
        /** Total file count across all caches */
        totalFileCount: z.number().describe('Total file count across all caches'),
        /** Formatted total size across all caches */
        totalSizeFormatted: z.string().describe('Formatted total size'),
        /** Individual filesystem caches */
        caches: z.array(FilesystemCacheSchema).describe('Individual filesystem caches'),
        /** Size-budget snapshot (Tier 1) */
        budget: FilesystemCacheBudgetSchema.optional().describe(
            'IMAGE_CACHE_MAX_BYTES budget vs current usage',
        ),
        /** Last cleanup run summary (Tier 2) */
        lastCleanup: FilesystemCacheLastCleanupSchema.nullable()
            .optional()
            .describe('Result of the most recent cleanup run, or null if never run'),
        /** Image format negotiation status (Tier 3) */
        imageFormats: FilesystemCacheImageFormatsSchema.optional().describe(
            'Active image format settings (AVIF, WebP, pre-gen mode)',
        ),
    })
    .meta({
        id: 'FilesystemCacheAggregate',
        description: 'Filesystem cache aggregate',
    });

export type FilesystemCacheAggregate = z.infer<typeof FilesystemCacheAggregateSchema>;

/**
 * Standalone cache aggregate
 */
export const StandaloneCacheAggregateSchema = z
    .object({
        /** Total entries across all caches */
        totalEntries: z.number().describe('Total entries across all caches'),
        /** Total maximum size */
        totalMaxSize: z.number().describe('Total maximum size'),
        /** Overall hit rate */
        overallHitRate: z.number().describe('Overall hit rate'),
    })
    .meta({
        id: 'StandaloneCacheAggregate',
        description: 'Standalone cache aggregate',
    });

export type StandaloneCacheAggregate = z.infer<typeof StandaloneCacheAggregateSchema>;

/**
 * Standalone caches container
 */
export const StandaloneCachesSchema = z
    .object({
        /** Individual standalone caches */
        caches: z.array(StandaloneCacheSchema).describe('Individual standalone caches'),
        /** Aggregate statistics */
        aggregate: StandaloneCacheAggregateSchema.optional().describe('Aggregate statistics'),
    })
    .meta({
        id: 'StandaloneCaches',
        description: 'Standalone caches container',
    });

export type StandaloneCaches = z.infer<typeof StandaloneCachesSchema>;

/**
 * A single entry from the in-memory cache-invalidation log
 * (CacheInvalidationService.getInvalidationLog()).
 */
export const CacheInvalidationEventSchema = z
    .object({
        reason: z
            .enum([
                'user_rating',
                'suggestion_skipped',
                'content_added',
                'manual',
                'milestone_reached',
            ])
            .describe('Why the invalidation ran'),
        userId: z
            .string()
            .optional()
            .describe('User whose caches were invalidated (user-scoped events only)'),
        externalIds: ExternalIdsResponseSchema.optional().describe(
            'External ids of the affected media (media-scoped events only)',
        ),
        timestamp: z.union([z.string(), z.date()]).describe('When the invalidation happened'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Additional event context'),
    })
    .meta({
        id: 'CacheInvalidationEvent',
        description: 'A single cache invalidation event',
    });

export type CacheInvalidationEvent = z.infer<typeof CacheInvalidationEventSchema>;

/**
 * Cache invalidation activity: per-reason counters plus the recent event log.
 */
export const CacheInvalidationsSchema = z
    .object({
        stats: z
            .record(z.string(), z.number())
            .describe('Invalidation counts keyed by reason (only reasons that occurred)'),
        recent: z
            .array(CacheInvalidationEventSchema)
            .describe('Most recent invalidation events (oldest first)'),
    })
    .meta({
        id: 'CacheInvalidations',
        description: 'Cache invalidation activity',
    });

export type CacheInvalidations = z.infer<typeof CacheInvalidationsSchema>;

/**
 * Cache warming progress (CacheWarmingService.getProgress() plus derived
 * percentComplete/isRunning the route computes for UI gauges).
 */
export const CacheStatsWarmingSchema = z
    .object({
        status: z
            .enum(['idle', 'warming', 'completed', 'failed'])
            .describe('Warming lifecycle state'),
        startTime: z
            .union([z.string(), z.date()])
            .nullable()
            .describe('When the current/last warming run started, or null if never run'),
        endTime: z
            .union([z.string(), z.date()])
            .nullable()
            .describe('When the last warming run finished, or null while running/never run'),
        tasksTotal: z.number().describe('Total warming tasks in the current/last run'),
        tasksCompleted: z.number().describe('Warming tasks completed so far'),
        errors: z
            .array(
                z.object({
                    task: z.string().describe('Warming task name'),
                    error: z.string().describe('Failure message'),
                }),
            )
            .describe('Per-task warming failures'),
        duration: z.number().optional().describe('Run duration in milliseconds'),
        percentComplete: z.number().describe('Completion percentage (0-100)'),
        isRunning: z.boolean().describe('True while a warming run is active'),
    })
    .meta({
        id: 'CacheStatsWarming',
        description: 'Cache warming progress',
    });

export type CacheStatsWarming = z.infer<typeof CacheStatsWarmingSchema>;

/**
 * Full cache statistics response
 */
export const CacheStatsResponseSchema = z
    .object({
        /** ISO timestamp when these stats were generated */
        timestamp: z.string().optional().describe('ISO timestamp when these stats were generated'),
        /** Cache health status */
        health: CacheHealthSchema.describe('Cache health status'),
        /** Aggregate statistics */
        aggregate: CacheAggregateSchema.describe('Aggregate statistics'),
        /** Namespace metrics (L1 + L2) */
        namespaces: z.record(z.string(), NamespaceMetricsSchema).describe('Namespace metrics'),
        /** Cache invalidation activity (counters + recent events) */
        invalidations: CacheInvalidationsSchema.optional().describe(
            'Cache invalidation activity (counters + recent events)',
        ),
        /** Cache warming progress */
        warming: CacheStatsWarmingSchema.optional().describe('Cache warming progress'),
        /** Filesystem cache stats */
        filesystem: FilesystemCacheAggregateSchema.optional().describe('Filesystem cache stats'),
        /** Transcoding cache stats */
        transcoding: TranscodingCacheStatsSchema.optional().describe('Transcoding cache stats'),
        /** Preview artifact cache stats */
        previewCache: PreviewCacheStatsSchema.optional().describe('Preview artifact cache stats'),
        /** Standalone cache stats */
        standalone: StandaloneCachesSchema.optional().describe('Standalone cache stats'),
        /** Subtitle cache stats */
        subtitles: SubtitleCacheStatsSchema.optional().describe('Subtitle cache stats'),
    })
    .meta({
        id: 'CacheStatsResponse',
        description: 'Full cache statistics response',
    });

export type CacheStatsResponse = z.infer<typeof CacheStatsResponseSchema>;

// ============================================================================
// Cache Action Response Schemas
// ============================================================================

/**
 * Generic success message response for cache operations
 */
export const CacheClearResponseSchema = z
    .object({
        /** Success message */
        message: z.string().describe('Success message'),
    })
    .meta({ id: 'CacheClearResponse', description: 'Cache clear response' });

export type CacheClearResponse = z.infer<typeof CacheClearResponseSchema>;

/**
 * Response for clearing filesystem cache
 */
export const ClearFilesystemResponseSchema = z
    .object({
        /** Success message */
        message: z.string().describe('Success message'),
        /** Number of files deleted */
        deletedFiles: z.number().describe('Number of files deleted'),
        /** Bytes freed */
        freedBytes: z.number().describe('Bytes freed'),
        /** Human-readable formatted size */
        freedFormatted: z.string().describe('Human-readable formatted size'),
    })
    .meta({
        id: 'ClearFilesystemResponse',
        description: 'Filesystem cache clear response',
    });

export type ClearFilesystemResponse = z.infer<typeof ClearFilesystemResponseSchema>;

/**
 * Response for clearing subtitle file cache
 */
export const ClearFileResponseSchema = z
    .object({
        /** Success message */
        message: z.string().describe('Success message'),
        /** Number of files deleted */
        deletedCount: z.number().describe('Number of files deleted'),
    })
    .meta({
        id: 'ClearFileResponse',
        description: 'Subtitle file cache clear response',
    });

export type ClearFileResponse = z.infer<typeof ClearFileResponseSchema>;

/**
 * Response for cleaning up subtitle file cache
 */
export const CleanupFileResponseSchema = z
    .object({
        /** Success message */
        message: z.string().describe('Success message'),
        /** Number of files deleted */
        deletedCount: z.number().describe('Number of files deleted'),
    })
    .meta({
        id: 'CleanupFileResponse',
        description: 'Subtitle file cache cleanup response',
    });

export type CleanupFileResponse = z.infer<typeof CleanupFileResponseSchema>;

// ============================================================================
// Browser Compatibility Matrix
// ============================================================================

export const CompatibilityMediaInfoSchema = z.object({
    video_codec: z.string(),
    audio_codecs: z.array(z.string()),
    container: z.string(),
    hdr: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    bitrate: z.number().optional(),
    audio_channels: z.number().optional(),
    video_bit_depth: z.number().optional(),
});

export const CompatibilityProfileSchema = z.object({
    path_scoped: z.object({
        directFile: z.object({
            videoCodecs: z.array(z.string()),
            audioCodecs: z.array(z.string()),
            containers: z.array(z.string()),
        }),
        nativeHls: z.object({
            videoCodecs: z.array(z.string()),
            audioCodecs: z.array(z.string()),
        }),
        mseHls: z.object({
            videoCodecs: z.array(z.string()),
            audioCodecs: z.array(z.string()),
        }),
    }),
    hdr_formats: z.array(z.string()),
    audio_switching: z.boolean(),
    max_channels: z.number(),
});

export const CompatibilityCheckSchema = z.object({
    video_compatible: z.boolean(),
    audio_compatible: z.boolean(),
    container_compatible: z.boolean(),
    needs_tonemapping: z.boolean(),
    needs_hls_for_audio: z.boolean(),
    incompatible_audio_codecs: z.array(z.string()),
});

export const BrowserCompatibilitySchema = z.object({
    browser_id: z.string(),
    browser_label: z.string(),
    is_own_browser: z.boolean(),
    method: z.string(),
    delivery_path: z.string(),
    video_action: z.string(),
    audio_action: z.string(),
    target_video_codec: z.string().optional(),
    target_audio_codec: z.string().optional(),
    transcode_reasons: z.array(z.string()),
    profile: CompatibilityProfileSchema,
    compatibility: CompatibilityCheckSchema,
});

export const FileCompatibilitySchema = z.object({
    file_id: z.string(),
    file_path: z.string(),
    label: z.string().nullable(),
    media_info: CompatibilityMediaInfoSchema,
    browsers: z.array(BrowserCompatibilitySchema),
});

export const CompatibilityResponseSchema = z.object({
    files: z.array(FileCompatibilitySchema),
});

export type CompatibilityResponse = z.infer<typeof CompatibilityResponseSchema>;
export type FileCompatibility = z.infer<typeof FileCompatibilitySchema>;
export type BrowserCompatibility = z.infer<typeof BrowserCompatibilitySchema>;
