// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { EpisodeLanguageSummarySchema } from './admin-language-summary.js';
import {
    DeviceSchema,
    DevicesListResponseSchema,
    RevokeAllDevicesResponseSchema as RevokeAllSchema,
} from './devices';
import { AdminPersonalAccessTokenSchema, ServiceTokenSchema } from './credentials';

/**
 * Admin API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for admin API response types.
 * These schemas define the contract for /api/admin/* endpoints.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { AudioTailAssessmentSchema } from './audio-tail-assessment.js';
import { z } from 'zod';
import { AnalyzerReadinessSchema } from './admin-media-analysis.js';
import { ClusterGpuDeviceSchema, ClusterGpuEnginesSchema } from './admin-types';
import { RadioMetadataSourceSchema } from '$lib/schemas/radio.js';
import { PlaybackPlanSchema } from './playback-plan';
import { SessionAdaptiveSchema } from './session-adaptive.js';
import { PageBlockSchema, paginatedEnvelope } from './pagination';
import { MediaChaptersResponseSchema } from './api-media-responses';
import { SpeedTestSummaryListSchema } from './api-network-responses';

// ============================================================================
// Admin Status Response (/api/admin/status)
// ============================================================================

/**
 * Service configuration status (used by admin status endpoint)
 */
export const ServiceConfigStatusSchema = z
    .object({
        /** Whether the service is configured */
        configured: z.boolean().describe('Service is configured'),
        /** Human-readable service label */
        label: z.string().describe('Service label'),
        /** Optional version or connection info */
        version: z.string().optional().describe('Service version or connection info'),
        /**
         * Last reachability probe, for the services the dependency check probes
         * (Sonarr, Radarr, Seerr, Audiobookshelf). Absent = not probed — the
         * UI must not paint "configured" as healthy.
         */
        probe: z
            .object({
                status: z
                    .enum(['pass', 'warn'])
                    .describe('pass = answered 2xx; warn = unreachable'),
            })
            .optional()
            .describe('Last reachability probe (cached, ~60 s); absent when not probed'),
    })
    .meta({
        id: 'ServiceConfigStatus',
        description: 'Service configuration status',
    });

export type ServiceConfigStatus = z.infer<typeof ServiceConfigStatusSchema>;

/**
 * Individual lumastra health check result
 */
export const LumastraCheckItemSchema = z
    .object({
        ok: z.boolean().describe('Check passed'),
        message: z.string().describe('Status message'),
        detail: z.string().optional().describe('Additional detail (e.g. path)'),
    })
    .meta({
        id: 'LumastraCheckItem',
        description: 'Lumastra health check item',
    });

/**
 * Lumastra health checks (always populated)
 */
export const LumastraChecksSchema = z
    .object({
        ffmpeg: LumastraCheckItemSchema.describe('FFmpeg binary accessible'),
        ffprobe: LumastraCheckItemSchema.describe('FFprobe binary accessible'),
        essentia: LumastraCheckItemSchema.optional().describe('Essentia binary accessible'),
        hlsAvailable: z.boolean().describe('HLS transcoding available'),
        fileAccess: z
            .object({
                ok: z.boolean(),
                accessible: z.number().describe('Accessible sampled versions'),
                total: z.number().int().describe('Total sampled versions'),
                message: z.string(),
            })
            .describe('Sampled media file accessibility'),
        watcher: z
            .object({
                active: z.boolean().describe('Watcher leader is running'),
                paths: z.number().describe('Number of watched library paths'),
                lastEventAt: z.string().optional().describe('ISO timestamp of last file event'),
                lastEventFile: z.string().optional().describe('Filename of last file event'),
                leaderElsewhere: z
                    .boolean()
                    .optional()
                    .describe('Lock is held by another replica — not running here is expected'),
                leaderHeartbeatAt: z
                    .string()
                    .optional()
                    .describe(
                        "ISO timestamp of the leader replica's last heartbeat (absent = leader silent)",
                    ),
                leaderError: z
                    .string()
                    .optional()
                    .describe('Last error reported by the watcher leader (e.g. inotify limit)'),
                coverage: z
                    .enum(['full', 'partial'])
                    .optional()
                    .describe('partial = some directories are not watched live'),
                limitations: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'watch_limit, network_shares, network_unreconciled, unreadable_dirs, stalled_probes, stalled_roots, unwatched_dirs',
                    ),
                networkReconcileSecs: z
                    .number()
                    .optional()
                    .describe('Network-root reconcile interval in seconds (0 = disabled)'),
            })
            .optional()
            .describe('File watcher status'),
        inotifyLimit: z
            .object({
                ok: z.boolean().describe('Limit is sufficient'),
                current: z.number().describe('Current max_user_watches'),
                recommended: z.number().describe('Recommended minimum'),
                message: z.string().describe('Human-readable status'),
            })
            .optional()
            .describe('inotify watcher limit (Linux only)'),
        overallHealthy: z.boolean().describe('All lumastra checks pass'),
    })
    .meta({ id: 'LumastraChecks', description: 'Lumastra health checks' });

export type LumastraChecks = z.infer<typeof LumastraChecksSchema>;

/**
 * Setup instructions shown when system is unhealthy
 */
export const SetupInstructionsSchema = z
    .object({
        /** Message when database is not connected */
        databaseNotConnected: z.string().nullish().describe('Database not connected message'),
        /** Message when tables are missing */
        missingTables: z.string().nullish().describe('Missing tables message'),
        /** Example DATABASE_URL */
        exampleDatabaseUrl: z.string().optional().describe('Example database URL'),
    })
    .meta({ id: 'SetupInstructions', description: 'Setup instructions' });

export type SetupInstructions = z.infer<typeof SetupInstructionsSchema>;

/**
 * Admin status response - overall system health
 *
 * Server returns a flat status object via typedJson(z.unknown(), statusData).
 */
export const AdminStatusResponseSchema = z
    .object({
        /** AI database health */
        aiHealthy: z.boolean().describe('AI database healthy'),
        /** Database connection health */
        databaseHealthy: z.boolean().describe('Database healthy'),
        /** Database version string */
        databaseVersion: z.string().describe('Database version'),
        /** Valkey/Redis cache health */
        valkeyHealthy: z.boolean().describe('Valkey healthy'),
        /** Valkey/Redis version string */
        valkeyVersion: z.string().describe('Valkey version'),
        /** Total active media items */
        totalMediaItems: z.number().describe('Total media items'),
        /** Library embedding count */
        libraryEmbeddings: z.number().describe('Library embeddings'),
        /** Primary provider embedding count */
        primaryProviderEmbeddings: z.number().describe('Primary provider embeddings'),
        /** Items with both embeddings */
        bothEmbeddings: z.number().describe('Both embeddings'),
        /** Total users with embeddings */
        totalUsers: z.number().describe('Total users'),
        /** Total active suggestions */
        totalSuggestions: z.number().describe('Total suggestions'),
        /** Service configuration statuses */
        services: z
            .object({
                jellyfin: ServiceConfigStatusSchema,
                tmdb: ServiceConfigStatusSchema,
                mdblist: ServiceConfigStatusSchema,
                jellyseerr: ServiceConfigStatusSchema,
                sonarr: ServiceConfigStatusSchema,
                radarr: ServiceConfigStatusSchema,
                audiobookshelf: ServiceConfigStatusSchema,
                openai: ServiceConfigStatusSchema,
                voyage: ServiceConfigStatusSchema,
                trickplay: ServiceConfigStatusSchema,
            })
            .describe('Service statuses'),
        /** Whether DATABASE_URL env var is set */
        databaseUrlConfigured: z.boolean().describe('DATABASE_URL configured'),
        /** Whether database connection is available */
        databaseConnectionAvailable: z.boolean().describe('Database connection available'),
        /** Whether tables were checked */
        tablesChecked: z.boolean().describe('Tables checked'),
        /** Setup instructions when unhealthy */
        setupInstructions: SetupInstructionsSchema.nullable().describe('Setup instructions'),
        /** Lumastra health checks */
        lumastraChecks: LumastraChecksSchema.optional().describe('Lumastra checks'),
        /** Trickplay generation stats */
        trickplayStats: z
            .object({
                totalFiles: z.number(),
                totalSizeBytes: z.number(),
                fileCount: z.number(),
            })
            .nullable()
            .describe('Trickplay generation stats'),
        /** Worker mode configuration and effective state */
        workerState: z
            .object({
                configured: z.string().describe('WORKER_MODE env value'),
                workersActive: z.boolean().describe('Whether workers are running'),
            })
            .optional()
            .describe('Worker mode state'),
    })
    .meta({ id: 'AdminStatusResponse', description: 'Admin status response' });

export type AdminStatusResponse = z.infer<typeof AdminStatusResponseSchema>;

/**
 * Admin status extras response — lazy-loaded supplementary data
 * (service versions, binary versions, library counts)
 */
export const AdminStatusExtrasResponseSchema = z
    .object({
        /** Versions of configured external services */
        serviceVersions: z
            .record(z.string(), z.string().optional())
            .optional()
            .describe('Service versions keyed by service name'),
        /** Versions of binary tools */
        binaryVersions: z
            .record(z.string(), z.string().optional())
            .optional()
            .describe('Binary tool versions (ffmpeg, ffprobe, essentia)'),
        /** Media library counts (items with files) */
        libraryCounts: z
            .object({
                movies: z.number().describe('Movies with files'),
                series: z.number().describe('Series with files'),
                musicTracks: z.number().describe('Music tracks with files'),
            })
            .optional()
            .describe('Media library counts for items with files'),
    })
    .meta({
        id: 'AdminStatusExtrasResponse',
        description: 'Lazy-loaded admin status extras',
    });

export type AdminStatusExtrasResponse = z.infer<typeof AdminStatusExtrasResponseSchema>;

// ============================================================================
// Sync Status Response (/api/admin/sync-status)
// ============================================================================

/**
 * Sync task status
 */

// ============================================================================
// Cache Warming Response (/api/admin/cache-warming)
// ============================================================================

export const WarmingRunResultSchema = z
    .object({
        /** Run timestamp (ISO string) */
        timestamp: z.string().nullable().describe('Run timestamp'),
        /** Whether run succeeded */
        success: z.boolean().describe('Run success'),
    })
    .meta({ id: 'WarmingRunResult', description: 'Cache warming run result' });

export const CacheWarmingStatusSchema = z
    .object({
        /** Current warming progress */
        progress: z
            .object({
                /** Current progress status */
                status: z
                    .enum(['idle', 'warming', 'completed', 'failed'])
                    .describe('Current progress status'),
                /** When warming started (ISO string) */
                startTime: z.string().nullable().describe('Start time'),
                /** When warming ended (ISO string) */
                endTime: z.string().nullable().describe('End time'),
                /** Total tasks */
                tasksTotal: z.number().describe('Total tasks'),
                /** Completed tasks */
                tasksCompleted: z.number().describe('Completed tasks'),
                /** Task errors */
                errors: z
                    .array(
                        z.object({
                            task: z.string(),
                            error: z.string(),
                        }),
                    )
                    .describe('Task errors'),
                /** Duration in ms */
                duration: z.number().optional().describe('Duration (ms)'),
            })
            .meta({
                id: 'CacheWarmingProgress',
                description: 'Cache warming progress',
            })
            .describe('Progress'),
        /** Whether scheduler is active */
        schedulerActive: z.boolean().describe('Scheduler active'),
        /** Warming schedule */
        schedule: z
            .object({
                frequent: z.object({
                    intervalHours: z.number(),
                    description: z.string(),
                }),
                regular: z.object({
                    intervalHours: z.number(),
                    description: z.string(),
                }),
                nightly: z.object({
                    hour: z.number(),
                    description: z.string(),
                }),
            })
            .describe('Warming schedule'),
        /** Next scheduled runs */
        nextRuns: z
            .object({
                frequent: z.string().nullable(),
                regular: z.string().nullable(),
                nightly: z.string().nullable(),
            })
            .describe('Next runs'),
        /** Last run results */
        lastRuns: z
            .object({
                frequent: WarmingRunResultSchema,
                regular: WarmingRunResultSchema,
                nightly: WarmingRunResultSchema,
            })
            .describe('Last runs'),
        /** Active users stats */
        activeUsers: z
            .object({
                count: z.number().int(),
                limit: z.number().int(),
                lookbackDays: z.number(),
            })
            .describe('Active users'),
    })
    .meta({ id: 'CacheWarmingStatus', description: 'Cache warming status' });

export type CacheWarmingStatus = z.infer<typeof CacheWarmingStatusSchema>;

/**
 * Cache warming response (GET and POST)
 */
export const CacheWarmingResponseSchema = z
    .union([
        CacheWarmingStatusSchema,
        z.object({
            /** Message */
            message: z.string().describe('Status message'),
        }),
    ])
    .meta({
        id: 'CacheWarmingResponse',
        description: 'Cache warming response',
    });

export type CacheWarmingResponse = z.infer<typeof CacheWarmingResponseSchema>;

// ============================================================================
// PAT (Personal Access Token) Responses
// ============================================================================

/**
 * Personal access token info
 */
export const PatInfoSchema = AdminPersonalAccessTokenSchema;

export type PatInfo = z.infer<typeof PatInfoSchema>;

/**
 * PAT list response
 */
export const PatListResponseSchema = paginatedEnvelope(PatInfoSchema).meta({
    id: 'PatListResponse',
    description: 'PAT list response',
});

export type PatListResponse = z.infer<typeof PatListResponseSchema>;

/**
 * PAT create response (includes the actual token value once)
 */
export const PatCreateResponseSchema = z
    .object({
        /** Token ID */
        id: z.number().int().describe('Token ID'),
        /** Token value (only shown once) */
        token: z.string().describe('Token value'),
        /** Message */
        message: z.string().describe('Message'),
    })
    .meta({ id: 'PatCreateResponse', description: 'PAT create response' });

export type PatCreateResponse = z.infer<typeof PatCreateResponseSchema>;

/**
 * PAT delete response
 */
export const PatDeleteResponseSchema = z.null();

export type PatDeleteResponse = z.infer<typeof PatDeleteResponseSchema>;

// ============================================================================
// Service Token Responses
// ============================================================================

/**
 * Service token info
 */
export const ServiceTokenInfoSchema = ServiceTokenSchema;

export type ServiceTokenInfo = z.infer<typeof ServiceTokenInfoSchema>;

/**
 * Service token list response -- new contract: {items, page}
 */
export const ServiceTokenListResponseSchema = z
    .object({
        /** List of tokens */
        items: z.array(ServiceTokenInfoSchema).describe('Tokens'),
        /** Pagination block */
        page: PageBlockSchema,
    })
    .meta({
        id: 'ServiceTokenListResponse',
        description: 'Service token list response',
    });

export type ServiceTokenListResponse = z.infer<typeof ServiceTokenListResponseSchema>;

/**
 * Service token create response
 */
export const ServiceTokenCreateResponseSchema = z
    .object({
        /** Token ID */
        id: z.number().int().describe('Token ID'),
        /** Token value (only shown once) */
        token: z.string().describe('Token value'),
    })
    .meta({
        id: 'ServiceTokenCreateResponse',
        description: 'Service token create response',
    });

export type ServiceTokenCreateResponse = z.infer<typeof ServiceTokenCreateResponseSchema>;

// ============================================================================
// Device Management Responses
// ============================================================================

/**
 * Device info
 */
export const DeviceInfoSchema = DeviceSchema;

export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/**
 * Device list response
 */
export const DeviceListResponseSchema = DevicesListResponseSchema;

export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;

/**
 * Device delete response
 */
export const DeviceDeleteResponseSchema = z.null();

export type DeviceDeleteResponse = z.infer<typeof DeviceDeleteResponseSchema>;

export const AdminDeviceDeleteAllResponseSchema = RevokeAllSchema;

export type AdminDeviceDeleteAllResponse = z.infer<typeof AdminDeviceDeleteAllResponseSchema>;

// ----------------------------------------------------------------------------
// Admin per-user connections (Jellyfin /j password, Subsonic token, PATs).
// Used by the AdminConnectionsModal + the admin connection API client fns.
// ----------------------------------------------------------------------------

export const AdminConnectionSuccessSchema = z.object({ success: z.boolean() });

export const AdminJellyfinPasswordStatusSchema = z.object({ hasPassword: z.boolean() });
export const AdminJellyfinPasswordSchema = z.object({
    /** Formatted plaintext password — shown once for the admin to relay. */
    password: z.string(),
});

export const AdminSubsonicTokenStatusSchema = z.object({ hasToken: z.boolean() });
export const AdminSubsonicTokenSchema = z.object({
    /** Formatted plaintext token — shown once for the admin to relay. */
    token: z.string(),
});

/**
 * A single PAT as listed for admin view. Lenient — mirrors the server's
 * PatListItem and only pins the fields the admin UI renders. `.passthrough()`
 * carries the rest (createdAt/lastUsedAt are Date server-side, ISO strings on
 * the wire, so they're intentionally left untyped here rather than fight the
 * Date-vs-string boundary).
 */
export const AdminUserTokenSchema = z.object({
    id: z.number(),
    name: z.string(),
    tokenPrefix: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    isExpired: z.boolean().optional(),
});
export type AdminUserToken = z.infer<typeof AdminUserTokenSchema>;

// ----------------------------------------------------------------------------
// Schemas referenced by the OpenAPI route docs that lacked a definition.
// Each mirrors the real route handler's response so the generated spec matches.
// ----------------------------------------------------------------------------

/** DELETE /api/admin/ffmpeg-jobs → { stopped, playSessionId }. */
export const FFmpegJobStopResponseSchema = z
    .object({
        stopped: z.boolean().describe('Whether the job was stopped'),
        playSessionId: z.string().describe('Play session whose job was stopped'),
    })
    .meta({
        id: 'FFmpegJobStopResponse',
        description: 'FFmpeg job stop response',
    });

export type FFmpegJobStopResponse = z.infer<typeof FFmpegJobStopResponseSchema>;

/** POST /api/plugins/holidays/reorder → bare { order }. */
export const HolidayReorderResponseSchema = z
    .object({
        /** New holiday id order after reorder */
        order: z.array(z.string()).describe('New holiday id order'),
    })
    .meta({
        id: 'HolidayReorderResponse',
        description: 'Holiday reorder response',
    });

export type HolidayReorderResponse = z.infer<typeof HolidayReorderResponseSchema>;

/** PUT /api/admin/plugins/{pluginId}/settings → bare { updated: true }. */
export const PluginSettingsUpdateResponseSchema = z
    .object({
        updated: z.literal(true).describe('Settings were saved'),
    })
    .meta({
        id: 'PluginSettingsUpdateResponse',
        description: 'Plugin settings update response',
    });

export type PluginSettingsUpdateResponse = z.infer<typeof PluginSettingsUpdateResponseSchema>;

// ============================================================================
// Quick Connect Response
// ============================================================================

/**
 * Quick connect authorization response
 */
export const QuickConnectResponseSchema = z
    .object({
        /** Operation success */
        success: z.boolean().describe('Operation success'),
        /** Message */
        message: z.string().optional().describe('Result message'),
        /** Authorized username */
        username: z.string().optional().describe('Authorized username'),
    })
    .meta({
        id: 'QuickConnectResponse',
        description: 'Quick connect response',
    });

export type QuickConnectResponse = z.infer<typeof QuickConnectResponseSchema>;

// ============================================================================
// Privacy Settings Response
// ============================================================================

/**
 * User privacy settings
 */
export const PrivacySettingsItemSchema = z
    .object({
        /** Username */
        username: z.string().describe('Username'),
        /** Whether to hide from others */
        hideFromOthers: z.boolean().describe('Hide from others'),
    })
    .meta({ id: 'PrivacySettingsItem', description: 'User privacy settings' });

export type PrivacySettingsItem = z.infer<typeof PrivacySettingsItemSchema>;

/**
 * Privacy settings list response
 */
export const PrivacySettingsResponseSchema = z.array(PrivacySettingsItemSchema).meta({
    id: 'PrivacySettingsResponse',
    description: 'Privacy settings response',
});

export type PrivacySettingsResponse = z.infer<typeof PrivacySettingsResponseSchema>;

/**
 * Privacy settings update response
 *
 * Server returns `{ username, hideFromOthers }` directly via typedJson.
 */
export const PrivacySettingsUpdateResponseSchema = PrivacySettingsItemSchema.meta({
    id: 'PrivacySettingsUpdateResponse',
    description: 'Privacy settings update response',
});

export type PrivacySettingsUpdateResponse = z.infer<typeof PrivacySettingsUpdateResponseSchema>;

// ============================================================================
// Playback Quality Response
// ============================================================================

/**
 * Fleet-level latency percentile bucket (p50/p95/p99) (Wave-1 contract).
 *
 * Computed in the analytics query module directly from raw playback_telemetry
 * via percentile_cont — NOT by averaging per-session percentile columns. All
 * fields are optional/nullable: a producer may not have wired a given metric
 * (e.g. startup) yet, and percentiles are null when there is no telemetry in
 * the window. Values are milliseconds.
 */
export const PlaybackLatencyPercentilesSchema = z
    .object({
        p50Ms: z.number().nullable().optional().describe('50th percentile latency (ms)'),
        p95Ms: z.number().nullable().optional().describe('95th percentile latency (ms)'),
        p99Ms: z.number().nullable().optional().describe('99th percentile latency (ms)'),
        /** Number of raw telemetry samples the percentiles were computed from */
        sampleCount: z.number().optional().describe('Sample count behind the percentiles'),
    })
    .meta({
        id: 'PlaybackLatencyPercentiles',
        description: 'Fleet latency percentile bucket (p50/p95/p99) in milliseconds',
    });

export type PlaybackLatencyPercentiles = z.infer<typeof PlaybackLatencyPercentilesSchema>;

/**
 * Per-user "users with issues" table row (L-additive contract).
 *
 * Keeps the raw counts (sessions_with_issues + total_sessions); the UI computes
 * the ratio. `username` is optional because resolution from user_id may fail.
 */
export const PlaybackQualityUserIssueRowSchema = z
    .object({
        userId: z.string().describe('Internal user id (uuid)'),
        username: z.string().optional().describe('Resolved username, if available'),
        sessionsWithIssues: z.number().describe('Sessions that recorded at least one issue'),
        totalSessions: z.number().describe('Total sessions in the window'),
        avgHealthScore: z.number().nullable().optional().describe('Average health score'),
    })
    .meta({
        id: 'PlaybackQualityUserIssueRow',
        description: 'Per-user issue summary row (raw counts; UI derives the rate)',
    });

export type PlaybackQualityUserIssueRow = z.infer<typeof PlaybackQualityUserIssueRowSchema>;

/**
 * Drill-down session-detail row (L18 contract).
 *
 * One row per session, used to expand a per-user/per-device table row into a
 * session list. All optional fields stay optional so a not-yet-wired producer
 * does not break the contract.
 */
export const PlaybackQualitySessionDetailSchema = z
    .object({
        sessionId: z.string().describe('play_sessions.id (uuid) for this session'),
        startedAt: z.string().describe('Session start (ISO 8601)'),
        healthScore: z.number().nullable().optional().describe('Computed health score'),
        playMethod: z.string().optional().describe('Play method (direct/transcode/etc.)'),
        deviceType: z
            .string()
            .optional()
            .describe('Device class the session played on (mobile/tablet/tv/desktop/unknown)'),
        mediaTitle: z
            .string()
            .optional()
            .describe('What was played; an episode reads "Series · S1E2 · Episode"'),
        deviceName: z
            .string()
            .optional()
            .describe("The device's display name (custom name, else the name the client reported)"),
        issues: z.array(z.string()).optional().describe('Health issue tags for the session'),
        rootCause: z.string().optional().describe('Inferred root cause, if classified'),
        scoringModelVersion: z
            .number()
            .optional()
            .describe('Scoring model version that produced healthScore'),
        // ── Client-reported delivery evidence (migration 16.248.0) ──
        // p10 AND p50 are both carried on purpose: a link that is usually ample
        // and periodically collapses shows a low p10 next to a healthy p50,
        // which no average could reveal.
        deliveryP10Bps: z
            .number()
            .nullable()
            .optional()
            .describe('10th-percentile client-measured delivery throughput (bits/s)'),
        deliveryP50Bps: z
            .number()
            .nullable()
            .optional()
            .describe('Median client-measured delivery throughput (bits/s)'),
        deliveryWindows: z
            .number()
            .optional()
            .describe('Number of delivery windows the client reported for this session'),
        deliveryOverdue: z
            .number()
            .optional()
            .describe('Segment downloads the client reported as overdue (native players only)'),
    })
    .meta({
        id: 'PlaybackQualitySessionDetail',
        description: 'Single session row for the per-user/per-device drill-down view',
    });

export type PlaybackQualitySessionDetail = z.infer<typeof PlaybackQualitySessionDetailSchema>;

/**
 * Playback quality response
 */
export const PlaybackQualityResponseSchema = z
    .object({
        /** Summary statistics */
        summary: z
            .object({
                total_sessions: z.number(),
                avg_health_score: z.number().nullable().optional(),
                min_health_score: z.number().nullable().optional(),
                poor_sessions: z
                    .number()
                    .int()
                    .optional()
                    .describe('Sessions with a health score below 70'),
                avg_bandwidth_mbps: z.number().nullable().optional(),
                total_rebuffers: z.number(),
                total_server_errors: z.number(),
                sessions_with_issues: z.number(),
                unique_users: z.number(),
                unique_devices: z.number(),
                mobile_sessions: z.number(),
                desktop_sessions: z.number(),
                live_sessions: z.number(),
                vod_sessions: z.number(),
            })
            .nullable()
            .optional()
            .describe('Overall summary statistics'),
        /** Client type breakdown */
        byClientType: z
            .array(
                z.object({
                    client_type: z.string(),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                }),
            )
            .describe('Client type breakdown'),
        /** Transcoding stats */
        transcodingStats: z
            .array(
                z.object({
                    play_method: z.string(),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    video_transcoding: z.number(),
                    audio_transcoding: z.number(),
                    avg_compression_ratio: z.number().nullable().optional(),
                }),
            )
            .describe('Transcoding stats'),
        /** Device type stats */
        deviceTypeStats: z
            .array(
                z.object({
                    device_type: z
                        .string()
                        .describe('Device class: mobile / tablet / tv / desktop / unknown'),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    avg_bandwidth_mbps: z.number().nullable().optional(),
                }),
            )
            .describe('Device type stats'),
        /** Stream type stats */
        streamTypeStats: z
            .array(
                z.object({
                    stream_type: z.string(),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    avg_bandwidth_mbps: z.number().nullable().optional(),
                }),
            )
            .describe('Stream type stats'),
        /** Daily trends */
        dailyTrends: z
            .array(
                z.object({
                    date: z.string(),
                    sessions: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    avg_bandwidth_mbps: z.number().nullable().optional(),
                }),
            )
            .describe('Daily trends'),
        /** Daily trends by device type */
        dailyByDeviceType: z
            .array(
                z.object({
                    date: z.string(),
                    device_type: z.string(),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                }),
            )
            .describe('Daily trends by device type'),
        /** Transcode reasons */
        transcodeReasons: z
            .array(
                z.object({
                    reason_bucket: z
                        .string()
                        .describe(
                            'Language-agnostic reason bucket (e.g. "container", "audio_codec"); the client localizes it and maps it to a remux/audio/video category',
                        ),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                }),
            )
            .describe('Transcode reasons breakdown, keyed by language-agnostic reason bucket'),
        /** Cross-tab analysis */
        crossTabAnalysis: z
            .array(
                z.object({
                    device_type: z.string(),
                    play_method: z.string(),
                    session_count: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    avg_bandwidth_mbps: z.number().nullable().optional(),
                }),
            )
            .describe('Cross-tab analysis: device type × play method'),
        /** Users with issues */
        usersWithIssues: z
            .array(
                z.object({
                    user_id: z.string(),
                    username: z.string().nullable().optional(),
                    total_sessions: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    sessions_with_issues: z.number(),
                }),
            )
            .describe('Users with playback issues'),
        /** Devices with issues */
        devicesWithIssues: z
            .array(
                z.object({
                    device_id: z.string(),
                    device_name: z.string().nullable().optional(),
                    client_type: z.string().nullable().optional(),
                    user_agent: z.string().nullable().optional(),
                    is_mobile: z.boolean().nullable().optional(),
                    form_factor: z
                        .string()
                        .optional()
                        .describe('Device class: mobile / tablet / tv / desktop / unknown'),
                    total_sessions: z.number(),
                    avg_health_score: z.number().nullable().optional(),
                    rebuffers: z.number(),
                    live_sessions: z.number(),
                    vod_sessions: z.number(),
                }),
            )
            .describe('Devices with playback issues'),
        /** Common issues */
        commonIssues: z
            .array(
                z.object({
                    issue: z.string(),
                    count: z.number().int(),
                }),
            )
            .describe('Common health issues'),
        // ── Wave-1 additive fields (all optional; safe if not yet populated) ──
        /** Fleet segment-delivery latency percentiles (from raw telemetry) */
        deliveryPercentiles: PlaybackLatencyPercentilesSchema.optional().describe(
            'Fleet segment-delivery latency percentiles (p50/p95/p99, ms)',
        ),
        /** Fleet startup/time-to-first-frame latency percentiles */
        startupPercentiles: PlaybackLatencyPercentilesSchema.optional().describe(
            'Fleet startup latency percentiles (p50/p95/p99, ms)',
        ),
        /** Scoring model version that produced the health scores in this window */
        scoringModelVersion: z
            .number()
            .optional()
            .describe('Health-score model version for the rows in this response'),
        /** Structured per-user issue rows (raw counts; UI derives the rate) */
        usersWithIssuesRows: z
            .array(PlaybackQualityUserIssueRowSchema)
            .optional()
            .describe('Structured per-user issue summary rows'),
        transcodesWithoutReason: z
            .number()
            .int()
            .optional()
            .describe(
                'Remuxed or transcoded sessions in the window that carry no recorded reason code',
            ),
    })
    .meta({
        id: 'PlaybackQualityResponse',
        description: 'Playback quality response',
    });
export type PlaybackQualityResponse = z.infer<typeof PlaybackQualityResponseSchema>;

/**
 * Playback quality clear response
 */
export const PlaybackQualityClearResponseSchema = z
    .object({
        /** Result message */
        message: z.string().describe('Result message'),
    })
    .meta({
        id: 'PlaybackQualityClearResponse',
        description: 'Playback quality clear response',
    });

export type PlaybackQualityClearResponse = z.infer<typeof PlaybackQualityClearResponseSchema>;

/**
 * User playback quality statistics
 */
export const UserPlaybackQualityResponseSchema = z
    .object({
        /** Summary statistics */
        summary: z
            .object({
                /** Total sessions */
                totalSessions: z.number().describe('Total sessions'),
                /** Average health score */
                avgHealthScore: z.number().describe('Average health score'),
                /** Total rebuffer events */
                totalRebuffers: z.number().describe('Total rebuffers'),
                /** Average bandwidth in Mbps */
                avgBandwidthMbps: z.number().describe('Average bandwidth Mbps'),
            })
            .describe('Summary statistics'),
        /** Daily breakdown */
        daily: z
            .array(
                z.object({
                    /** Date (YYYY-MM-DD) */
                    date: z.string().describe('Date'),
                    /** Number of sessions */
                    sessions: z.number().describe('Sessions'),
                    /** Average health score */
                    avgHealthScore: z.number().describe('Average health score'),
                    /** Rebuffer events */
                    rebufferEvents: z.number().describe('Rebuffer events'),
                }),
            )
            .describe('Daily breakdown'),
        // ── Wave-1 additive drill-down fields (optional) ──
        /** Per-session detail rows for the drill-down view (L18) */
        sessions: z
            .array(PlaybackQualitySessionDetailSchema)
            .optional()
            .describe('Session-level drill-down rows for this user'),
        /** Fleet/user segment-delivery latency percentiles */
        deliveryPercentiles: PlaybackLatencyPercentilesSchema.optional().describe(
            'Segment-delivery latency percentiles for this user (p50/p95/p99, ms)',
        ),
        /**
         * This user's most recent ACTIVE measurements — a deliberate download the
         * client timed itself, which is the one number that separates "their line"
         * from "our delivery" when the passive windows look bad.
         */
        speedTests: SpeedTestSummaryListSchema.optional().describe(
            "The user's most recent client-run speed tests, newest first",
        ),
    })
    .meta({
        id: 'UserPlaybackQualityResponse',
        description: 'User playback quality statistics',
    });

export type UserPlaybackQualityResponse = z.infer<typeof UserPlaybackQualityResponseSchema>;

/**
 * Device playback quality statistics
 */
export const DevicePlaybackQualityResponseSchema = z
    .object({
        /** Summary statistics */
        summary: z
            .object({
                /** Total sessions */
                totalSessions: z.number().describe('Total sessions'),
                /** Unique users */
                uniqueUsers: z.number().describe('Unique users'),
                /** Average health score */
                avgHealthScore: z.number().describe('Average health score'),
                /** Total rebuffer events */
                totalRebuffers: z.number().describe('Total rebuffers'),
            })
            .describe('Summary statistics'),
        /** Daily breakdown */
        daily: z
            .array(
                z.object({
                    /** Date (YYYY-MM-DD) */
                    date: z.string().describe('Date'),
                    /** Number of sessions */
                    sessions: z.number().describe('Sessions'),
                    /** Average health score */
                    avgHealthScore: z.number().describe('Average health score'),
                    /** Rebuffer events */
                    rebufferEvents: z.number().describe('Rebuffer events'),
                }),
            )
            .describe('Daily breakdown'),
        // ── Wave-1 additive drill-down fields (optional) ──
        /** Per-session detail rows for the drill-down view (L18) */
        sessions: z
            .array(PlaybackQualitySessionDetailSchema)
            .optional()
            .describe('Session-level drill-down rows for this device'),
        /** Segment-delivery latency percentiles for this device */
        deliveryPercentiles: PlaybackLatencyPercentilesSchema.optional().describe(
            'Segment-delivery latency percentiles for this device (p50/p95/p99, ms)',
        ),
    })
    .meta({
        id: 'DevicePlaybackQualityResponse',
        description: 'Device playback quality statistics',
    });

export type DevicePlaybackQualityResponse = z.infer<typeof DevicePlaybackQualityResponseSchema>;

/**
 * Lock contention metrics from Valkey cache
 */
export const LockMetricsResponseSchema = z
    .object({
        /** Lock acquisition attempts */
        acquisitionAttempts: z.number().describe('Acquisition attempts'),
        /** Successful acquisitions */
        acquisitionSuccesses: z.number().describe('Acquisition successes'),
        /** Failed acquisitions */
        acquisitionFailures: z.number().describe('Acquisition failures'),
        /** Release attempts */
        releaseAttempts: z.number().describe('Release attempts'),
        /** Successful releases */
        releaseSuccesses: z.number().describe('Release successes'),
        /** Failed releases */
        releaseFailures: z.number().describe('Release failures'),
        /** Heartbeat attempts */
        heartbeatAttempts: z.number().describe('Heartbeat attempts'),
        /** Failed heartbeats */
        heartbeatFailures: z.number().describe('Heartbeat failures'),
        /** Total hold duration in milliseconds */
        totalHoldDurationMs: z.number().describe('Total hold duration (ms)'),
        /** Number of active locks */
        lockCount: z.number().describe('Active lock count'),
    })
    .meta({
        id: 'LockMetricsResponse',
        description: 'Lock contention metrics',
    });

export type LockMetricsResponse = z.infer<typeof LockMetricsResponseSchema>;

// ============================================================================
// Debug Responses
// ============================================================================

/**
 * Jellyseerr debug response
 */
export const JellyseerrDebugResponseSchema = z
    .object({
        /** TVDB ID */
        tvdbId: z.number().nullable().describe('TVDB ID'),
        /** Sonarr ID (not currently provided) */
        sonarrId: z.number().nullable().describe('Sonarr ID'),
        /** Radarr ID (not currently provided) */
        radarrId: z.number().nullable().describe('Radarr ID'),
    })
    .meta({
        id: 'JellyseerrDebugResponse',
        description: 'Jellyseerr debug response',
    });

export type JellyseerrDebugResponse = z.infer<typeof JellyseerrDebugResponseSchema>;

/**
 * Sonarr lookup response
 */
export const SonarrLookupResponseSchema = z
    .object({
        /** Sonarr series ID */
        seriesId: z.number().nullable().describe('Series ID'),
        /** Sonarr title slug */
        titleSlug: z.string().nullable().describe('Title slug'),
        /** Series title */
        title: z.string().nullable().describe('Title'),
        /** Whether monitored */
        monitored: z.boolean().describe('Monitored'),
    })
    .meta({
        id: 'SonarrLookupResponse',
        description: 'Sonarr lookup response',
    });

export type SonarrLookupResponse = z.infer<typeof SonarrLookupResponseSchema>;

/**
 * Radarr lookup response
 */
export const RadarrLookupResponseSchema = z
    .object({
        /** Radarr movie ID */
        movieId: z.number().nullable().describe('Movie ID'),
        /** Radarr title slug */
        titleSlug: z.string().nullable().describe('Title slug'),
        /** Movie title */
        title: z.string().nullable().describe('Title'),
        /** Whether monitored */
        monitored: z.boolean().describe('Monitored'),
    })
    .meta({
        id: 'RadarrLookupResponse',
        description: 'Radarr lookup response',
    });

export type RadarrLookupResponse = z.infer<typeof RadarrLookupResponseSchema>;

// ============================================================================
// OAuth Response
// ============================================================================

/**
 * OAuth authorization response
 */
export const OAuthResponseSchema = z
    .object({
        /** Operation success */
        success: z.boolean().describe('Operation success'),
        /** Message */
        message: z.string().optional().describe('Result message'),
    })
    .meta({ id: 'OAuthResponse', description: 'OAuth authorization response' });

export type OAuthResponse = z.infer<typeof OAuthResponseSchema>;

// ============================================================================
// Plugin Settings Response
// ============================================================================

/**
 * Plugin settings response — bare object, no success wrapper.
 * Server: defs/admin/plugins/[pluginId]/settings.ts GET handler.
 */
export const PluginSettingsResponseSchema = z
    .object({
        /** Plugin ID */
        pluginId: z.string().describe('Plugin ID'),
        /** Plugin name */
        pluginName: z.string().describe('Plugin name'),
        /** Whether plugin is enabled */
        enabled: z.boolean().describe('Enabled'),
        // Plugin-extensible descriptors: each plugin declares its own settings
        // schema + UI pages, so these stay lenient on the SPA mirror (the SPA
        // renders them dynamically; the server def validates concrete shapes via
        // SettingsConfigSchema/UiPageSchema). Genuinely-heterogeneous — the
        // documented z.unknown exception, not an un-migrated payload.
        /** Settings schema/config (null when plugin declares no settings) */
        settingsConfig: z.unknown().nullable().describe('Settings config'),
        /** Current settings (freeform key->value per plugin) */
        currentSettings: z.record(z.string(), z.unknown()).describe('Current settings'),
        /** Registered UI pages */
        uiPages: z.array(z.unknown()).describe('UI pages'),
    })
    .meta({
        id: 'PluginSettingsResponse',
        description: 'Plugin settings response',
    });

export type PluginSettingsResponse = z.infer<typeof PluginSettingsResponseSchema>;

// ----------------------------------------------------------------------------
// Internal plugin settings (concrete) — single source of truth.
// Mirrors PluginSettingsGetResponseSchema / PluginSettingsPutResponseSchema in
// defs/admin/plugins/[pluginId]/settings.ts EXACTLY (the handler .parse()s with
// these). Imported by that admin def AND by the v1 _openapi.ts at
// routes/api/v1/plugins/internal/[id]/settings. Distinct from the lenient
// PluginSettingsResponseSchema above (the SPA mirror with z.unknown()).
// ----------------------------------------------------------------------------

/** One plugin SettingField descriptor (mirrors the SDK SettingField shape). */
const PluginSettingFieldSchema = z
    .object({
        key: z.string().describe('Field key'),
        label: z.string().describe('Field label'),
        type: z
            .enum([
                'string',
                'number',
                'boolean',
                'secret',
                'select',
                'array',
                'multiline',
                'keyvalue',
            ])
            .describe('Field type'),
        description: z.string().optional().describe('Field description'),
        required: z.boolean().optional().describe('Whether the field is required'),
        default: z.unknown().optional().describe('Default value (heterogeneous per field)'),
        options: z
            .array(z.object({ value: z.string(), label: z.string() }))
            .optional()
            .describe('Options for select fields'),
        validation: z
            .object({
                min: z.number().optional().describe('Minimum (numeric fields)'),
                max: z.number().optional().describe('Maximum (numeric fields)'),
                pattern: z.string().optional().describe('Regex pattern (string fields)'),
            })
            .optional()
            .describe('Per-field validation constraints'),
        dependsOn: z
            .string()
            .optional()
            .describe('Key of a boolean field this one only applies while on'),
        groups: z
            .boolean()
            .optional()
            .describe('Array field whose value is a list of user group names'),
    })
    .meta({ id: 'PluginSettingField', description: 'Plugin setting field definition' });

/** Resolved task.settings block ({ fields, customComponent? }). */
const PluginSettingsConfigSchema = z
    .object({
        fields: z.array(PluginSettingFieldSchema).describe('Setting field descriptors'),
        customComponent: z.string().optional().describe('Custom UI component id'),
    })
    .meta({ id: 'PluginSettingsConfig', description: 'Plugin settings configuration' });

/** UI deep-link page surfaced to the admin modal. */
const PluginUiPageSchema = z
    .object({
        path: z.string().describe('UI page path'),
        title: z.string().describe('UI page title'),
    })
    .meta({ id: 'PluginUiPage', description: 'Plugin UI deep-link page' });

/** GET /api/v1/plugins/internal/{id}/settings response. */
export const PluginSettingsGetResponseSchema = z
    .object({
        pluginId: z.string().describe('Plugin ID'),
        pluginName: z.string().describe('Plugin display name'),
        enabled: z.boolean().describe('Whether the plugin is enabled'),
        settingsConfig: PluginSettingsConfigSchema.nullable().describe(
            'Resolved settings schema (null when the plugin declares none)',
        ),
        currentSettings: z
            .record(z.string(), z.unknown())
            .describe('Stored setting values keyed by field key (secrets shown as a sentinel)'),
        uiPages: z.array(PluginUiPageSchema).describe('UI deep-link pages'),
    })
    .meta({ id: 'PluginSettingsGetResponse', description: 'Plugin settings GET response' });

export type PluginSettingsGetResponse = z.infer<typeof PluginSettingsGetResponseSchema>;

/** PUT /api/v1/plugins/internal/{id}/settings response. */
export const PluginSettingsPutResponseSchema = z
    .object({
        updated: z.literal(true).describe('Settings were saved'),
    })
    .meta({ id: 'PluginSettingsPutResponse', description: 'Plugin settings PUT response' });

export type PluginSettingsPutResponse = z.infer<typeof PluginSettingsPutResponseSchema>;

// ============================================================================
// Holidays Plugin Responses
// ============================================================================

/**
 * Holiday item
 */
export const HolidayItemSchema = z
    .object({
        /** Holiday ID */
        id: z.string().describe('Holiday ID'),
        /** Holiday name */
        name: z.string().describe('Holiday name'),
        /** Localized names */
        localizedNames: z.record(z.string(), z.string()).optional().describe('Localized names'),
        /** Emoji */
        emoji: z.string().describe('Emoji'),
        /** Start month */
        startMonth: z.number().describe('Start month'),
        /** Start day */
        startDay: z.number().describe('Start day'),
        /** End month */
        endMonth: z.number().describe('End month'),
        /** End day */
        endDay: z.number().describe('End day'),
        /** Content sources */
        sources: z
            .array(
                z.discriminatedUnion('type', [
                    z.object({
                        type: z.literal('tmdb'),
                        keywordIds: z.array(z.number()).optional(),
                        keywords: z.array(z.string()).optional(),
                        collectionIds: z.array(z.number()).optional(),
                        genreIds: z.array(z.number()).optional(),
                        featuredMovieIds: z.array(z.number()).optional(),
                        featuredTvIds: z.array(z.number()).optional(),
                        includeNewReleases: z.boolean().optional(),
                        minVoteCount: z.number().optional(),
                        minVoteAverage: z.number().optional(),
                    }),
                    z.object({
                        type: z.literal('mdblist'),
                        listPath: z.string(),
                        limit: z.number().int().optional(),
                        boostFactor: z.number().optional(),
                    }),
                    z.object({
                        type: z.literal('custom'),
                        movieIds: z.array(z.number()).optional(),
                        tvIds: z.array(z.number()).optional(),
                        boostFactor: z.number().optional(),
                    }),
                ]),
            )
            .describe('Sources'),
        /** Background color */
        backgroundColor: z.string().describe('Background color'),
        /** Text color */
        textColor: z.string().describe('Text color'),
        /** Background image */
        backgroundImage: z.string().optional().describe('Background image'),
        /** Pre-holiday config */
        preHoliday: z
            .object({
                name: z.string(),
                localizedNames: z.record(z.string(), z.string()).optional(),
                emoji: z.string(),
                startMonth: z.number(),
                startDay: z.number(),
                endMonth: z.number(),
                endDay: z.number(),
            })
            .optional()
            .describe('Pre-holiday'),
        /** Validation config */
        validation: z
            .object({
                requiredTerms: z.array(z.string()).optional(),
                excludeTerms: z.array(z.string()).optional(),
                skipForFeatured: z.boolean().optional(),
            })
            .optional()
            .describe('Validation'),
        /** Enabled flag */
        enabled: z.boolean().optional().describe('Enabled'),
        /** Priority */
        priority: z.number().optional().describe('Priority'),
    })
    .meta({ id: 'HolidayItem', description: 'Holiday item' });

export type HolidayItem = z.infer<typeof HolidayItemSchema>;

/**
 * Holidays list response — bare object (no success wrapper).
 * GET /api/plugins/holidays
 */
export const HolidaysListResponseSchema = z
    .object({
        /** List of configured holidays */
        holidays: z.array(HolidayItemSchema).describe('Holidays'),
        /** Global plugin settings */
        settings: z
            .object({
                enabled: z.boolean(),
                defaultLimit: z.number(),
                enableAiPersonalization: z.boolean(),
                cacheTtlMinutes: z.number(),
                jellyfinCacheTtlHours: z.number(),
            })
            .describe('Global plugin settings'),
    })
    .meta({
        id: 'HolidaysListResponse',
        description: 'Holidays list response',
    });

export type HolidaysListResponse = z.infer<typeof HolidaysListResponseSchema>;

/**
 * Holiday create/update response — bare object (no success wrapper).
 * POST /api/plugins/holidays, PUT /api/plugins/holidays/[id]
 */
export const HolidayMutationResponseSchema = z
    .object({
        /** The created or updated holiday */
        holiday: HolidayItemSchema.describe('Holiday'),
    })
    .meta({
        id: 'HolidayMutationResponse',
        description: 'Holiday create/update response',
    });

export type HolidayMutationResponse = z.infer<typeof HolidayMutationResponseSchema>;

/**
 * Holiday delete response — bare object (no success wrapper).
 * DELETE /api/plugins/holidays/[id]
 */
export const HolidayDeleteResponseSchema = z
    .object({
        /** Whether the holiday was deleted */
        deleted: z.literal(true).describe('Deleted'),
        /** ID of the deleted holiday */
        id: z.string().describe('Holiday ID'),
    })
    .meta({
        id: 'HolidayDeleteResponse',
        description: 'Holiday delete response',
    });

export type HolidayDeleteResponse = z.infer<typeof HolidayDeleteResponseSchema>;

// ============================================================================
// Watch Stats Response (/api/watch-stats)
// ============================================================================

// Moved to its own dependency-light module (2026-09-25, fix round 1) so
// $lib/api/watch-stats doesn't have to import this whole, much heavier
// schema file — it's reached from every rail page via
// PopularMediaStats.svelte (mounted on /browse). Re-exported here so
// existing importers (including the server-only
// src/lib/server/api/defs/admin/watch-stats.ts) are unaffected.
export {
    MediaStatRowSchema,
    type MediaStatRow,
    TopUserRowSchema,
    type TopUserRow,
    ColdContentRowSchema,
    type ColdContentRow,
    CompletionLeaderboardRowSchema,
    type CompletionLeaderboardRow,
    DormantUserRowSchema,
    type DormantUserRow,
    DeviceMixSegmentSchema,
    type DeviceMixSegment,
    DeviceMixStatsSchema,
    type DeviceMixStats,
    WatchStatsStatsSchema,
    type WatchStatsStats,
    WatchStatsResponseSchema,
    type WatchStatsResponse,
} from './api-watch-stats-response.js';

// ============================================================================
// Holiday Reorder Response
// ============================================================================

// ============================================================================
// Task Lock Clear Response
// ============================================================================

// ============================================================================
// Service Token Delete Response
// ============================================================================

/**
 * Service token delete response
 */
export const ServiceTokenDeleteResponseSchema = z.null();

export type ServiceTokenDeleteResponse = z.infer<typeof ServiceTokenDeleteResponseSchema>;

// ============================================================================
// Admin Device Delete All Response
// ============================================================================

// ============================================================================
// FFmpeg Job Stop Response
// ============================================================================

// ============================================================================
// Plugin Settings Update Response
// ============================================================================

// ============================================================================
// Re-exports from admin-types.ts
// ============================================================================

// These are already defined in admin-types.ts and used directly
export {
    SystemMetricsSchema,
    type SystemMetrics,
    StreamThroughputSchema,
    type StreamThroughput,
} from './admin-types';
export { FFmpegJobsResponseSchema, type FFmpegJobsResponse } from './admin-types';
export { EmbeddingPreviewsResponseSchema, type EmbeddingPreviewsResponse } from './admin-types';
export { EmbeddingLookupResultSchema, type EmbeddingLookupResult } from './admin-types';
export { CacheStatsResponseSchema, type CacheStatsResponse } from './admin-types';
export { AdminUserSchema, type AdminUser } from './admin-types';

// ── Users (unified: auth + AI profile data) ─────────────────────────────────

export const LocalUserSchema = z.object({
    /** Internal UUID (users.id) */
    id: z.string().describe('Internal user UUID'),
    username: z.string(),
    isAdmin: z.boolean(),
    adminPinned: z
        .boolean()
        .describe(
            'Whether admin status is manually pinned (true) or derived from IdP groups (false)',
        ),
    maxAgeRating: z
        .number()
        .nullable()
        .describe('Maximum content age rating (null = unrestricted)'),
    allowLiveTv: z.boolean().optional().describe('Whether the user is allowed to access Live TV'),
    liveTvDefault: z
        .boolean()
        .optional()
        .describe('Whether the user still has the default Live TV setting'),
    ageRatingPinned: z
        .boolean()
        .describe('Whether age rating is manually pinned or derived from IdP groups'),
    displayName: z.string().optional(),
    email: z.string().optional(),
    hideStreams: z.boolean(),
    groups: z.array(z.string()).nullable(),
    groupsUpdatedAt: z.string().optional(),
    createdAt: z.string(),
    lastSeenAt: z.string().optional(),
    disabled: z
        .boolean()
        .describe('Whether the account is suspended (blocks all login paths)')
        .default(false),
    hasNativePassword: z
        .boolean()
        .describe('Whether the user has a built-in (native) password set')
        .default(false),
    // AI profile fields (optional — user may not have rated anything yet)
    hasProfile: z.boolean().optional(),
    totalRatings: z.number().optional(),
    currentRatings: z.number().optional(),
    activeSuggestions: z.number().optional(),
    lastActivity: z.string().optional(),
    /** Distinct identity providers this user has authenticated via (e.g. 'native', 'oidc', 'forward_auth') */
    identityProviders: z
        .array(z.string())
        .optional()
        .describe("Distinct providers from user_identities: 'native' | 'oidc' | 'forward_auth'"),
    // Per-user playback activity, aggregated from play_sessions (listUsers).
    currentlyStreaming: z
        .boolean()
        .optional()
        .describe('Whether the user has an ACTIVE or PAUSED play session right now'),
    lastActivityAt: z
        .string()
        .optional()
        .describe(
            "ISO timestamp of the user's most recent playback activity (GREATEST of started_at and last_heartbeat_at across play_sessions)",
        ),
    lastWatchedTitle: z
        .string()
        .optional()
        .describe("Title of the media from the user's most recent play session"),
    lastActivitySource: z
        .string()
        .optional()
        .describe(
            "play_sessions.source of the most recent session ('lumastra', 'jellyfin', …); 'jellyfin' means it was mirrored from the upstream Jellyfin server",
        ),
    jellyfinLinked: z
        .boolean()
        .optional()
        .describe('Whether the account is linked to a user on the upstream Jellyfin server'),
    apiTokenCount: z
        .number()
        .int()
        .optional()
        .describe('Live personal access tokens plus act-as service tokens for this user'),
});
export type LocalUser = z.infer<typeof LocalUserSchema>;

export const LocalUsersListResponseSchema = z.object({
    items: z.array(LocalUserSchema),
    page: PageBlockSchema,
});
export type LocalUsersListResponse = z.infer<typeof LocalUsersListResponseSchema>;

// ── Federated identities + Jellyfin mapping (admin) ───────────────────────────

export const AdminUserIdentitySchema = z.object({
    provider: z.string(),
    providerLabel: z.string(),
    isOidc: z.boolean(),
    subject: z.string(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
});
export type AdminUserIdentity = z.infer<typeof AdminUserIdentitySchema>;

export const UserIdentitiesResponseSchema = z.object({
    jellyfin: z.object({
        override: z.string().nullable(),
        cachedUserId: z.string().nullable(),
        effectiveName: z.string(),
    }),
    identities: z.array(AdminUserIdentitySchema),
});
export type UserIdentitiesResponse = z.infer<typeof UserIdentitiesResponseSchema>;

export const SetJellyfinMappingResponseSchema = z.object({
    username: z.string(),
    override: z.string().nullable().optional(),
    jellyfinUserId: z.string().nullable().optional(),
});
export type SetJellyfinMappingResponse = z.infer<typeof SetJellyfinMappingResponseSchema>;

export const UnlinkIdentityResponseSchema = z.object({
    username: z.string(),
    unlinked: z.boolean(),
});
export type UnlinkIdentityResponse = z.infer<typeof UnlinkIdentityResponseSchema>;

export const SetIsAdminResponseSchema = z.object({
    username: z.string(),
    isAdmin: z.boolean(),
    adminPinned: z.boolean(),
});
export type SetIsAdminResponse = z.infer<typeof SetIsAdminResponseSchema>;

export const SetAllowLiveTvResponseSchema = z.object({
    username: z.string(),
    allowLiveTv: z.boolean(),
    liveTvDefault: z.boolean(),
});
export type SetAllowLiveTvResponse = z.infer<typeof SetAllowLiveTvResponseSchema>;

export const SetAgeRatingResponseSchema = z.object({
    username: z.string(),
    maxAgeRating: z.number().nullable(),
    ageRatingPinned: z.boolean(),
});
export type SetAgeRatingResponse = z.infer<typeof SetAgeRatingResponseSchema>;

// ============================================================================
// Provider Dashboard (/api/admin/providers)
// ============================================================================

export const OperationModeSchema = z
    .object({
        mode: z
            .enum(['standalone', 'jellyfin-enhanced', 'jellyfin-unreachable', 'degraded'])
            .describe('Current operation mode'),
        jellyfinEnabled: z.boolean().describe('Jellyfin feature is configured'),
        jellyfinAvailable: z.boolean().describe('Jellyfin is reachable right now'),
        canLiveTV: z.boolean().describe('Live TV features available'),
    })
    .meta({ id: 'OperationMode', description: 'System operation mode' });

export type OperationMode = z.infer<typeof OperationModeSchema>;

export const ProviderConfigInfoSchema = z
    .object({
        primaryExternalId: z.string().describe('Primary external ID provider'),
        metadataProviderChain: z.array(z.string()).describe('Ordered metadata aggregation chain'),
        enabledExternalIds: z.array(z.string()).describe('Enabled external ID providers'),
        primaryImageProvider: z.string().describe('Primary image provider'),
        primarySearchProvider: z.string().describe('Primary search provider'),
    })
    .meta({
        id: 'ProviderConfigInfo',
        description: 'Provider configuration summary',
    });

export type ProviderConfigInfo = z.infer<typeof ProviderConfigInfoSchema>;

export const ProviderCategorySchema = z
    .enum(['metadata', 'library', 'integration', 'ai', 'playback'])
    .describe(
        'Provider category: metadata providers, library (media) sources, integrations and watch syncs, AI services, or playback providers (seek-preview/trickplay)',
    );

export type ProviderCategory = z.infer<typeof ProviderCategorySchema>;

export const ProviderItemSchema = z
    .object({
        provider: z.string().describe('Provider identifier'),
        label: z.string().describe('Human-readable label'),
        priority: z.number().describe('Priority (lower = higher)'),
        enabled: z.boolean().describe('Provider is enabled'),
        capabilities: z.record(z.string(), z.boolean()).describe('Capability flags'),
        configured: z.boolean().describe('Required env vars are set'),
        category: ProviderCategorySchema.describe('Provider category'),
        source: z
            .enum(['builtin', 'plugin', 'external'])
            .optional()
            .describe('Registration source'),
        hasSettings: z.boolean().optional().describe('Plugin has configurable settings'),
        version: z.string().optional().describe('Plugin version'),
        healthy: z.boolean().optional().describe('Last known health status'),
        lastCheck: z.string().optional().describe('ISO timestamp of last health check'),
        lastError: z.string().optional().describe('Last error message if unhealthy'),
    })
    .meta({ id: 'ProviderItem', description: 'Provider status information' });

export type ProviderItem = z.infer<typeof ProviderItemSchema>;

export const FieldAuthorityItemSchema = z
    .object({
        fieldName: z.string().describe('Field name'),
        provider: z.string().describe('Authoritative provider'),
        priority: z.number().describe('Priority (lower = higher)'),
        mediaType: z.string().optional().describe('Specific media type or null for all'),
        isAnime: z.boolean().optional().describe('Anime-specific override'),
    })
    .meta({
        id: 'FieldAuthorityItem',
        description: 'Field authority mapping',
    });

export type FieldAuthorityItem = z.infer<typeof FieldAuthorityItemSchema>;

export const ProvidersResponseSchema = z
    .object({
        operationMode: OperationModeSchema,
        providerConfig: ProviderConfigInfoSchema,
        providers: z.array(ProviderItemSchema),
        fieldAuthorities: z.array(FieldAuthorityItemSchema),
        metadataChainOrder: z
            .array(z.string())
            .describe("Metadata chain order (METADATA_PROVIDERS), 'aggregated' excluded"),
    })
    .meta({
        id: 'ProvidersResponse',
        description: 'Provider dashboard data',
    });

export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export const ProviderUpdateResponseSchema = z
    .object({
        provider: z.string().describe('Provider identifier'),
        priority: z.number().describe('Updated priority'),
        enabled: z.boolean().describe('Updated enabled state'),
    })
    .meta({
        id: 'ProviderUpdateResponse',
        description: 'Updated provider state',
    });

export type ProviderUpdateResponse = z.infer<typeof ProviderUpdateResponseSchema>;

export const ProviderHealthResponseSchema = z
    .object({
        provider: z.string().describe('Provider identifier'),
        healthy: z.boolean().describe('Connectivity check passed'),
        checkable: z
            .boolean()
            .optional()
            .describe(
                'Whether a health check exists for this provider. False means health is not applicable (e.g. a media source) — not unhealthy.',
            ),
        latencyMs: z.number().describe('Response time in milliseconds'),
        error: z.string().optional().describe('Error message if unhealthy'),
        rateLimited: z
            .boolean()
            .optional()
            .describe('The service answered but is throttling requests — reachable, not down'),
        serverInfo: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Server metadata if available'),
    })
    .meta({
        id: 'ProviderHealthResponse',
        description: 'Provider health check result',
    });

export type ProviderHealthResponse = z.infer<typeof ProviderHealthResponseSchema>;

export const MetadataChainReorderResponseSchema = z
    .object({
        success: z.boolean().describe('Whether the reorder was successful'),
        chain: z.array(z.string()).describe('New chain order'),
    })
    .meta({
        id: 'MetadataChainReorderResponse',
        description: 'Result of metadata chain reorder operation',
    });

export type MetadataChainReorderResponse = z.infer<typeof MetadataChainReorderResponseSchema>;

// ============================================================================
// Preview admission (/api/admin/previews)
// ============================================================================

/**
 * Why hover/scrub previews are off, when they are.
 *
 * `reason` is the part that matters and the part nothing surfaced: previews
 * turn themselves off under load, so "previews stopped working" has three very
 * different causes — an operator disabled them, the load circuit shed them, or
 * every concurrent slot is taken — and the remedy differs for each.
 */
export const PreviewAdmissionSchema = z.object({
    disabled: z.boolean(),
    reason: z.enum(['admin_disabled', 'load_shed', 'global_budget']).nullable(),
    loadRatio: z.number(),
    loadShedRatio: z.number(),
    activeCount: z.number(),
    maxGlobal: z.number(),
    adminDisabled: z.boolean(),
    autoDisabled: z.boolean(),
    cache: z
        .object({
            entries: z.number(),
            ready: z.number(),
            warming: z.number(),
            totalBytes: z.number(),
            maxBytes: z.number(),
            hits: z.number(),
            misses: z.number(),
            evictions: z.number(),
        })
        .optional(),
});
export type PreviewAdmission = z.infer<typeof PreviewAdmissionSchema>;

/**
 * Preview cache counters, as `PreviewCacheStats` in preview-cache.store.ts.
 *
 * Deliberately NOT `PreviewCacheStatsSchema` from admin-types.ts: that one is the
 * shape of the /admin cache-stats endpoint and adds `enabled` and the
 * `*Formatted` strings, which this payload does not carry. Reusing it would
 * demand fields the store never emits.
 */
const PreviewCacheStatsInlineSchema = z.object({
    entries: z.number(),
    ready: z.number(),
    warming: z.number(),
    totalBytes: z.number(),
    maxBytes: z.number(),
    hits: z.number(),
    misses: z.number(),
    evictions: z.number(),
});

/**
 * GET|POST /api/admin/previews.
 *
 * `cache` is returned at the TOP LEVEL as well as nested under `admission`
 * (the endpoint surfaces it twice on purpose). The client applies `toStrict()`
 * to the top level, so leaving it undeclared made every /admin load log
 * `<root>: Unrecognized keys` — the nested copy was stripped silently, but the
 * top-level one is a reported mismatch.
 */
export const PreviewStatusResponseSchema = z.object({
    admission: PreviewAdmissionSchema,
    cache: PreviewCacheStatsInlineSchema,
});

// ============================================================================
// File scanner run history (/api/admin/library/scanner-runs)
// ============================================================================

/**
 * Sentinel `library_path_id` meaning "runs of global (scope='all') scans",
 * i.e. rows whose `library_path_id IS NULL`. Not a uuid, deliberately: the
 * column is `uuid`, so no real id can ever collide with it.
 */
export const SCANNER_RUN_GLOBAL_SCOPE = 'global';

/** Did the run work — the one thing the table's RESULT column states. */
export const ScannerRunStatusSchema = z.enum(['running', 'abandoned', 'completed']);
export type ScannerRunStatus = z.infer<typeof ScannerRunStatusSchema>;

/**
 * One file-scanner pass over one library path.
 *
 * `status` is authoritative and server-derived. It folds in the 2h staleness
 * rule (an open run past that window is abandoned, not running) and the
 * `errors = -1` abandonment sentinel, so a client renders one field instead
 * of reconstructing a threshold that lives in the writer.
 *
 * `matchRate` is retained but is NOT to be displayed. The generated column is
 * `matched / total_files * 100`, and the writer sets `matched = added +
 * updated`, so it measures CHURN: a fully-matched library that changed
 * nothing scores 0%. Across 10,229 production runs its ≥90% band fired twice
 * while 67% of runs rendered red — every one of them healthy. Use `added` /
 * `updated` for what changed and `status` / `errors` for whether it worked.
 *
 * `unmatched` is likewise retained and not displayed: it has never been
 * non-zero in any recorded run. The writer still populates it.
 */
export const ScannerRunSchema = z.object({
    id: z.string(),
    libraryPathId: z.string().nullable(),
    /**
     * The scanned path, joined at read time. Null either because the run was
     * global (`libraryPathId` also null) or because the path row was deleted
     * after the run — the two are told apart by `libraryPathId`.
     */
    libraryPath: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    totalFiles: z.number(),
    matched: z.number(),
    updated: z.number(),
    /** `matched - updated`, clamped at 0 — items this run newly added. */
    added: z.number(),
    unmatched: z.number(),
    /** Error COUNT. Carries the -1 abandonment sentinel; read `status` first. */
    errors: z.number(),
    /** Bounded sample of the error strings; shorter than `errors` when truncated. */
    errorSamples: z.array(z.string()),
    status: ScannerRunStatusSchema,
    /** `completedAt - startedAt` in ms; null while the run is open. */
    durationMs: z.number().nullable(),
    /** PERCENTAGE 0-100 (generated column). Retained, not displayed — see above. */
    matchRate: z.number(),
    createdAt: z.string().nullable(),
});
export type ScannerRun = z.infer<typeof ScannerRunSchema>;

export const ScannerRunsResponseSchema = z.object({
    items: z.array(ScannerRunSchema),
    page: z.object({ limit: z.number(), offset: z.number(), hasMore: z.boolean() }).optional(),
});

// ============================================================================
// Subtitle acquisition (/api/admin/subtitles)
// ============================================================================

/** One provider-offered subtitle, already ranked host-side. */
export const SubtitleCandidateSchema = z.object({
    id: z.string(),
    providerId: z.string(),
    language: z.string(),
    format: z.string(),
    isForced: z.boolean().optional(),
    isSDH: z.boolean().optional(),
    releaseName: z.string().optional(),
    downloadCount: z.number().optional(),
    rating: z.number().optional(),
    /** Matched the file exactly rather than by title — the sync-vs-drift signal. */
    hashMatch: z.boolean().optional(),
    uploader: z.string().optional(),
    comment: z.string().optional(),
});

/**
 * `providers` is load-bearing, not decoration: zero providers means there was
 * nobody to ask, which is a completely different answer from "asked, found
 * none" and needs different words on screen. The endpoint returns it precisely
 * so a caller can tell them apart.
 */
export const SubtitleSearchResponseSchema = z.object({
    candidates: z.array(SubtitleCandidateSchema),
    providers: z.number(),
});
export type SubtitleSearchResponse = z.infer<typeof SubtitleSearchResponseSchema>;

export const SubtitleInstallResponseSchema = z.object({
    subtitlePath: z.string(),
    language: z.string(),
    format: z.string(),
});

// ============================================================================
// Media Admin — Segments (/api/admin/media/[id]/segments)
// ============================================================================

const SegmentEntrySchema = z.object({
    type: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    fetchedAt: z.string(),
    seasonNumber: z.number().int().optional(),
    episodeNumber: z.number().int().optional(),
    /**
     * Which detector produced this row, reconstructed from the candidate that
     * matches its boundaries. Optional: pre-evidence-model rows, rows from
     * another source, and rows whose candidate was cleared have no origin.
     *
     * Admin-only. The public /api/v1 `MediaSegment` is `additionalProperties:
     * false` and client-validated, so provenance must not appear there.
     */
    method: z.string().optional(),
    confidence: z.number().optional(),
});

/** One detector's answer, kept alongside every other detector's. */
const SegmentCandidateSchema = z.object({
    mediaId: z.string(),
    type: z.string(),
    method: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    confidence: z.number(),
    detectorVersion: z.number(),
    configHash: z.string().nullable(),
    snappedToChapter: z.boolean(),
    notes: z.string().nullable(),
    resolvable: z.boolean(),
    materialized: z.boolean(),
    updatedAt: z.string(),
});

export const SegmentsResponseSchema = z.object({
    undoId: z
        .uuid()
        .optional()
        .describe('Restore the exact preceding marker selection and evidence.'),
    analysisInputs: z.array(AnalyzerReadinessSchema).optional(),
    totalSegments: z.number(),
    providers: z.record(z.string(), z.array(SegmentEntrySchema)),
    // Optional so a client validating against an older server still parses.
    candidates: z.array(SegmentCandidateSchema).optional(),
});

export type SegmentsResponse = z.infer<typeof SegmentsResponseSchema>;

/** POST /segments — enqueue response (single scope or children/deep). */
export const SegmentsGenerateResponseSchema = z.object({
    analysisInputs: z.array(AnalyzerReadinessSchema).optional(),
    runId: z.string(),
    message: z.string(),
    /**
     * True when the request landed on an already-running run instead of
     * enqueueing a new one. Optional so a client validating against an older
     * server still parses — but it MUST be declared here: `apiFetch` parses
     * responses with this schema and Zod objects strip undeclared keys, so an
     * omission silently deletes the flag before any caller sees it.
     */
    deduped: z.boolean().optional(),
});

/** POST /segments with scope=set — manual segment override response. */
export const SegmentsSetResponseSchema = z.object({
    undoId: z
        .uuid()
        .optional()
        .describe('Restore the exact preceding marker selection and evidence.'),
    type: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    durationMs: z.number().int(),
    materialized: z.boolean(),
    withheldRule: z.string().optional(),
    suppressedAtRead: z.boolean().optional(),
    segmentsResolved: z.number().int().nonnegative(),
    message: z.string(),
});

/** DELETE /segments — clear response. */
export const SegmentsDeleteResponseSchema = z.object({
    undoId: z
        .uuid()
        .optional()
        .describe('Restore the exact preceding marker selection and evidence.'),
    deleted: z.number().int().nonnegative(),
    /**
     * Detector candidates cleared alongside the materialized rows. Optional so
     * a client validating against an older server still parses. Manual
     * overrides are never counted here — they are deliberately spared.
     */
    candidatesCleared: z.number().int().nonnegative().optional(),
    message: z.string(),
});

/**
 * SegmentsMutationResponseSchema — union of the two mutation shapes so legacy
 * callers (clearMediaSegments / generateMediaSegments) continue to work with one
 * import.  Consumers should test for the `runId` field (generate) or `deleted`
 * field (clear) to discriminate.
 */
export const SegmentsMutationResponseSchema = z.union([
    SegmentsGenerateResponseSchema,
    SegmentsDeleteResponseSchema,
]);

export type SegmentsMutationResponse = z.infer<typeof SegmentsMutationResponseSchema>;
export type SegmentsGenerateResponse = z.infer<typeof SegmentsGenerateResponseSchema>;
export type SegmentsSetResponse = z.infer<typeof SegmentsSetResponseSchema>;
export type SegmentsDeleteResponse = z.infer<typeof SegmentsDeleteResponseSchema>;

// ============================================================================
// Media Admin — Trickplay (/api/admin/media/[id]/trickplay/generate)
// ============================================================================

export const TrickplayGenerateResponseSchema = z.object({
    runId: z.string(),
    message: z.string(),
    /**
     * True when the request landed on an already-running run instead of
     * enqueueing a new one. Optional so a client validating against an older
     * server still parses — but it MUST be declared here: `apiFetch` parses
     * responses with this schema and Zod objects strip undeclared keys, so an
     * omission silently deletes the flag before any caller sees it.
     */
    deduped: z.boolean().optional(),
});

export type TrickplayGenerateResponse = z.infer<typeof TrickplayGenerateResponseSchema>;

// ============================================================================
// Media Admin — Probe Raw (/api/admin/media/[id]/probe-raw)
// ============================================================================

export const ProbeRawResponseSchema = z.object({
    filePath: z.string(),
    probe: z.record(z.string(), z.unknown()),
});

export type ProbeRawResponse = z.infer<typeof ProbeRawResponseSchema>;

// ============================================================================
// Media Admin — Chapters (/api/admin/media/[id]/chapters)
// ============================================================================

/**
 * Client-side gate for GET /api/admin/media/[id]/chapters.
 *
 * ALIASED, not re-declared. The handler at defs/admin/media/[id]/chapters/index.ts
 * `.parse()`s its body through MediaChaptersResponseSchema, so that schema IS the
 * wire shape; a second hand-written copy here can only ever drift from it, and it
 * had — in three places at once:
 *
 *   - `start_ticks` / `end_ticks` were `z.string()`. They are bigint columns read
 *     straight off the row, and connection.ts registers a bigint (OID 20) parser
 *     that yields a JS NUMBER, so the server both emits and validates numbers here.
 *   - `media_item_id` was non-nullable. getChaptersForFile()'s no-owner branch
 *     LEFT JOINs and can legitimately return null.
 *
 * The client is fail-open (apiFetch logs the mismatch and returns the raw body), so
 * none of that surfaced as a broken tab — just as permanent schema-drift noise and a
 * lying type. Do NOT "fix" the direction by making the SERVER emit strings: that
 * shape is published as MediaChaptersResponse in the v1 OpenAPI spec and a strict
 * Swift decoder is generated from it.
 */
export const AdminChaptersResponseSchema = MediaChaptersResponseSchema;

export type AdminChaptersResponse = z.infer<typeof AdminChaptersResponseSchema>;

// ============================================================================
// Media Admin — Streams (/api/admin/media/[id]/streams)
// ============================================================================

// Moved to its own dependency-light module (2026-09-25, fix round 1) so
// `$lib/api/media-streams` doesn't have to import this whole, much heavier
// schema file — it's reached from every rail page via
// `StandardSection.svelte` → `MediaFileInfoModal.svelte`. Re-exported here so
// existing importers of `$lib/schemas/api-admin-responses` are unaffected.
export { StreamsResponseSchema, type StreamsResponse } from './api-admin-media-streams.js';

// ============================================================================
// Media Admin — Episodes (/api/admin/media/[id]/episodes)
// ============================================================================

const EpisodeChapterInfoSchema = z.object({
    index: z.number().int(),
    name: z.string().nullable(),
    startTicks: z.string(),
});

const EpisodeRowSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    season_number: z.number().nullable(),
    episode_number: z.number().nullable(),
    episode_number_end: z.number().nullable(),
    overview: z.string().nullable(),
    runtime_seconds: z.number().nullable(),
    premiere_date: z.string().nullable(),
    sort_order: z.number().nullable(),
    file_path: z.string().nullable(),
    edition: z.string().nullable(),
    jellyfin_id: z.string().nullable(),
    chapters: z.array(EpisodeChapterInfoSchema),
    language_summary: EpisodeLanguageSummarySchema.optional(),
});

export const AdminEpisodesResponseSchema = z.object({
    episodes: z.array(EpisodeRowSchema),
});

export type AdminEpisodesResponse = z.infer<typeof AdminEpisodesResponseSchema>;

// ============================================================================
// Media Admin — Albums (/api/admin/media/[id]/albums)
// ============================================================================

const AdminAlbumRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    year: z.number().nullable(),
    custom_poster_url: z.string().nullable(),
    track_count: z.number(),
    total_duration_seconds: z.number(),
    album_type: z.string().nullable(),
    sort_order: z.number().nullable(),
});

export const AlbumsResponseSchema = z.array(AdminAlbumRowSchema);

export type AlbumsResponse = z.infer<typeof AlbumsResponseSchema>;

// ============================================================================
// Media Admin — Tracks (/api/admin/media/[id]/tracks)
// ============================================================================

const AdminTrackRowSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    sort_order: z.number().nullable(),
    runtime_seconds: z.number().nullable(),
    custom_metadata: z.record(z.string(), z.unknown()).nullable(),
    has_lyrics: z.boolean(),
    file_path: z.string().nullable(),
});

export const TracksResponseSchema = z.array(AdminTrackRowSchema);

export type TracksResponse = z.infer<typeof TracksResponseSchema>;

// ============================================================================
// Media Admin — Health (/api/admin/media/[id]/health)
// ============================================================================

export const HealthResponseSchema = z.object({
    report: z.record(z.string(), z.unknown()).nullable(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ============================================================================
// Media Admin — Episode Title Reconciliation (/api/admin/media/[id]/health/reconcile)
// ============================================================================

export const ReconciliationProposalSchema = z.object({
    episodeId: z.string(),
    fileId: z.string(),
    seasonNumber: z.number().nullable(),
    episodeNumber: z.number().nullable(),
    currentTitle: z.string().nullable(),
    proposedTitle: z.string().nullable(),
    matchedTmdbEpisodeId: z.string().nullable(),
    confidence: z.number(),
    changed: z.boolean(),
    reason: z.enum([
        'matched',
        'no-usable-chapters',
        'chapter-count-mismatch',
        'below-threshold',
        'duplicate-match',
        'manually-locked',
        'identity-bound',
    ]),
    source: z.enum(['chapters', 'filename']),
});

export type ReconciliationProposal = z.infer<typeof ReconciliationProposalSchema>;

export const ReconciliationPreviewResponseSchema = z.object({
    seriesMediaId: z.string(),
    catalogSize: z.number(),
    proposals: z.array(ReconciliationProposalSchema),
    changedCount: z.number(),
    needsReviewCount: z.number(),
});

export type ReconciliationPreviewResponse = z.infer<typeof ReconciliationPreviewResponseSchema>;

export const ReconciliationApplyResponseSchema = z.object({
    appliedExternalIds: z.number(),
    updatedTitles: z.number(),
});

export type ReconciliationApplyResponse = z.infer<typeof ReconciliationApplyResponseSchema>;

// ============================================================================
// Media Admin — Hierarchy (/api/admin/media/[id]/hierarchy)
// ============================================================================

const HierarchyExternalIdsSchema = z.object({
    jellyfin: z.string().optional(),
});

const HierarchyEpisodeSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    episodeNumber: z.number().nullable(),
    seasonNumber: z.number().nullable(),
    externalIds: HierarchyExternalIdsSchema,
    hasFile: z.boolean(),
    isOrderingSegment: z.boolean(),
});

const HierarchySeasonSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    seasonNumber: z.number(),
    episodeCount: z.number(),
    externalIds: HierarchyExternalIdsSchema,
    episodes: z.array(HierarchyEpisodeSchema),
});

export const HierarchyResponseSchema = z.object({
    series: z.object({
        id: z.string(),
        title: z.string(),
        externalIds: HierarchyExternalIdsSchema,
    }),
    seasons: z.array(HierarchySeasonSchema),
    currentItemId: z.string(),
    resolvedFromChild: z.boolean(),
});

export type HierarchyResponse = z.infer<typeof HierarchyResponseSchema>;

// ============================================================================
// Media Admin — Preview (/api/admin/media/[id]/preview)
// ============================================================================

export const MediaPreviewResponseSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    overview: z.string().nullable(),
    year: z.number().nullable(),
    media_type: z.string(),
    runtime_seconds: z.number().nullable(),
    premiere_date: z.string().nullable(),
    externalIds: z.object({
        tmdb: z.string().optional(),
        imdb: z.string().optional(),
        jellyfin: z.string().optional(),
        tvdb: z.string().optional(),
    }),
    fileCount: z.number(),
    totalFileSize: z.number().nullable(),
    filePaths: z.array(z.string()),
    seasons: z
        .array(
            z.object({
                seasonNumber: z.number(),
                episodeCount: z.number(),
                linkedCount: z.number(),
            }),
        )
        .optional(),
    audioFeatures: z
        .object({
            bpm: z.number().nullable(),
            key: z.string().nullable(),
            energy: z.number().nullable(),
        })
        .optional(),
    parentTitle: z.string().optional(),
    grandparentTitle: z.string().optional(),
    // Inspector-panel additions — kept in sync with AdminPreviewResponseSchema
    // in src/lib/server/api/defs/admin/media/[id]/preview.ts by hand (that def
    // defines its own response schema rather than importing this one). All
    // `.optional()`, never bare `.nullable()` — see that file for why.
    metadataLocked: z.boolean().optional(),
    lockedBy: z.string().optional(),
    lockedAt: z.string().optional(),
    isLocalOnly: z.boolean().optional(),
    filesLostAt: z.string().optional(),
    lastProbedAt: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
    healthStatus: z.string().optional(),
    tailAssessments: z
        .array(z.object({ fileId: z.string(), assessment: AudioTailAssessmentSchema }))
        .optional(),
    healthIssuesOmitted: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Number of additional actionable findings beyond the 20-row preview limit'),
    healthIssues: z
        .array(
            z.object({
                type: z.string(),
                detail: z.string().optional(),
                reviewed: z
                    .boolean()
                    .optional()
                    .describe('Current exact duration warning acceptance'),
                filePath: z.string().optional(),
                expectedDuration: z.number().optional(),
                basis: z.enum(['duration_comparison', 'premature_eof']).optional(),
                actualDuration: z.number().optional(),
            }),
        )
        .optional(),
    videoCodec: z.string().optional(),
    videoWidth: z.number().optional(),
    videoHeight: z.number().optional(),
    videoRange: z.string().optional(),
    audioCodec: z.string().optional(),
    audioChannels: z.number().optional(),
});

export type MediaPreviewResponse = z.infer<typeof MediaPreviewResponseSchema>;

// ============================================================================
// Media Admin — Rescan (/api/admin/media/[id]/rescan)
// ============================================================================

export const RescanResponseSchema = z.object({
    bpm: z.number().nullable(),
    key: z.string().nullable(),
    energy: z.number().nullable(),
    danceability: z.number().nullable(),
    loudness_lufs: z.number().nullable(),
});

export type RescanResponse = z.infer<typeof RescanResponseSchema>;

// ============================================================================
// Admin Play Sessions (/api/admin/play-sessions)
// ============================================================================

export const AdminPlaySessionTranscodeSchema = z.object({
    progressPercent: z.number(),
    segmentsReady: z.number(),
    totalSegments: z.number(),
});

export const AdminSessionAudioTrackSchema = z.object({
    index: z.number().int(),
    language: z.string().optional(),
    codec: z.string().optional(),
    channels: z.number().optional(),
    displayTitle: z.string().optional(),
    isDefault: z.boolean(),
});

export const AdminSessionSubtitleTrackSchema = z.object({
    index: z.number().int(),
    language: z.string().optional(),
    codec: z.string().optional(),
    displayTitle: z.string().optional(),
    isDefault: z.boolean(),
    isForced: z.boolean(),
});

export const AdminPlaySessionSchema = z.object({
    __id: z.string(),
    username: z.string(),
    title: z.string(),
    clientname: z.string(),
    clientVersion: z.string().optional(),
    browsername: z.string(),
    user_agent_raw: z.string().optional(),
    playMethod: z.string().optional(),
    playIsPlaying: z.boolean().optional(),
    playCurrentTime: z.number().optional(),
    playItemDuration: z.number().optional(),
    media_type: z.string().optional(),
    season_number: z.number().optional(),
    episode_number: z.number().optional(),
    season_id: z.string().optional(),
    season_title: z.string().optional(),
    series_id: z.string().optional(),
    series_title: z.string().optional(),
    resolution: z.string().optional(),
    bitrate_kbps: z.number().optional(),
    video_codec: z.string().optional(),
    audio_codec: z.string().optional(),
    audio_language: z.string().optional(),
    subtitle_language: z.string().optional(),
    audio_stream_index: z.number().optional(),
    subtitle_stream_index: z.number().optional(),
    buffer_health_sec: z.number().optional(),
    started_at: z.string().optional(),
    ip_address: z.string().optional(),
    bandwidth_mbps: z.number().optional(),
    transcode: AdminPlaySessionTranscodeSchema.optional(),
    plan_mode: z.string().nullable().optional(),
    plan_reasons: z.array(z.string()).nullable().optional(),
    subtitle_method: z.string().nullable().optional(),
    transcode_codec: z.string().nullable().optional(),
    delivery_path: z.string().nullable().optional(),
    file_path: z.string().nullable().optional(),
    file_id: z.string().nullable().optional(),
    media_id: z.string().optional(),
    audio_tracks: z.array(AdminSessionAudioTrackSchema).optional(),
    subtitle_tracks: z.array(AdminSessionSubtitleTrackSchema).optional(),
    /** Origin of the session row — mirrors the `play_sessions.source` CHECK. */
    source: z
        .enum(['lumastra', 'jellyfin', 'livetv', 'music', 'subsonic', 'audiobookshelf', 'local'])
        .optional(),
    /** Upstream session id from the external source. Null for Lumastra rows. */
    sourceSessionId: z.string().optional(),
    /** ISO timestamp refreshed on every poll (external) or heartbeat (Lumastra). */
    lastSeenAt: z.string().optional(),
    /** Opaque JSON extras from external sources (Jellyfin TranscodingInfo, etc.). */
    externalPayload: z.unknown().optional(),
    /** Explicit session lifecycle status from the database. */
    status: z.enum(['ACTIVE', 'PAUSED', 'CRASHED', 'COMPLETED', 'KILLED']).optional(),
    /** ISO timestamp of when the session entered PAUSED state. */
    pausedAt: z.string().optional(),
    /** ISO timestamp of the most recent heartbeat written to the DB row. */
    lastHeartbeatAt: z.string().optional(),
    /** Container format reported by the client (e.g. "mp4", "mkv"). */
    container: z.string().optional(),
    /** Device ID from the session row. */
    deviceId: z.string().optional(),
    /**
     * UI features the client announced it can RENDER when it started this
     * session — see `$lib/shared/client-features.ts` for the vocabulary.
     *
     * The admin "Send message" button is gated on this containing
     * `admin_message`. Treat absent and empty as the SAME answer — "announces
     * nothing" — which is what every client build shipped before the field
     * existed reports, along with every mirrored session (`/j`, Subsonic,
     * Audiobookshelf) that has no client to ask.
     */
    isCarPlay: z
        .boolean()
        .optional()
        .describe('Client-reported connected CarPlay display; informational only.'),
    clientFeatures: z.array(z.string()).optional(),
    /** HLS plan ID associated with this session. */
    planId: z.string().optional(),
    /**
     * True when the session row exists but no heartbeat has reported a real
     * position yet (client is still buffering before the resume seek lands).
     * Display-only — no business logic should depend on this field.
     */
    isBuffering: z.boolean().optional(),
    /** Artist name — populated when media_type is 'track'. */
    artistName: z.string().optional(),
    /** Album name — populated when media_type is 'track'. */
    albumName: z.string().optional(),
    /** Album UUID — populated when media_type is 'track'. */
    albumId: z.string().optional(),
    /** Radio program / show name — populated when media_type is 'radio'. */
    radioProgram: z.string().optional(),
    /** On-air DJ name — populated when media_type is 'radio'. */
    radioDj: z.string().optional(),
    /** Now-playing track title from broadcast metadata (radio only). */
    nowPlayingTrack: z.string().optional(),
    /** Now-playing artist from broadcast metadata (radio only). */
    nowPlayingArtist: z.string().optional(),
    /** Next track in the client queue — present only for music sessions with a known next track. */
    nextTrack: z
        .object({
            mediaId: z.string(),
            title: z.string(),
            artistName: z.string().optional(),
            albumName: z.string().optional(),
        })
        .optional(),
    /** Crossfade in progress — present only while the client reports one. */
    crossfade: z
        .object({
            role: z.enum(['incoming', 'outgoing']),
            otherTrack: z.object({
                mediaId: z.string(),
                title: z.string(),
                artistName: z.string().optional(),
                albumName: z.string().optional(),
            }),
            /** Fade time left when the server built this response. */
            remainingMs: z.number().int(),
            durationMs: z.number().int(),
        })
        .optional(),
    /**
     * For music audio_transcode sessions: the transcode mode recorded in
     * active_transcode_jobs.config.transcode_mode.
     * Values: 'encode' | 'encode_no_cache' | 'stream_copy_seek' | 'cached'
     */
    music_transcode_mode: z.string().optional(),
    /**
     * For music audio_transcode sessions: whether an ffmpeg process is live
     * (ffmpeg_pid IS NOT NULL). Used together with music_transcode_mode to
     * derive the cache-state badge.
     */
    music_has_ffmpeg_pid: z.boolean().optional(),
    /** Adaptive-bitrate state (Live TV ladder or adaptive VOD): variant now, ladder, switches. */
    adaptive: SessionAdaptiveSchema.optional(),
});

/** A Jellyfin session that is actively playing but could not be ingested into play_sessions. */
export const UntrackedJellyfinSessionSchema = z.object({
    jellyfinSessionId: z.string(),
    username: z.string(),
    title: z.string().optional(),
    mediaType: z.string().optional(),
    clientname: z.string().optional(),
    playIsPlaying: z.boolean(),
    /** Why this session is not reflected in play_sessions. */
    skipReason: z.enum(['no_user_match', 'no_media_match']),
});

export const AdminPlaySessionsResponseSchema = z.object({
    sessions: z.array(AdminPlaySessionSchema),
    /** Jellyfin sessions that are playing but could not be ingested (unresolved user or media). */
    untrackedJellyfinSessions: z.array(UntrackedJellyfinSessionSchema).optional(),
});

export type AdminPlaySession = z.infer<typeof AdminPlaySessionSchema>;
export type UntrackedJellyfinSession = z.infer<typeof UntrackedJellyfinSessionSchema>;
export type AdminPlaySessionsResponse = z.infer<typeof AdminPlaySessionsResponseSchema>;

// ============================================================================
// Admin Playback Plan inspection (/api/admin/playback-plans/[planId])
// ============================================================================

export const AdminPlaybackPlanResponseSchema = z.object({
    /**
     * The plan as stored in Valkey at session-start time. Null when the
     * plan has expired (Valkey TTL elapsed) or the planId never existed —
     * the modal renders an "expired" state in either case.
     */
    plan: PlaybackPlanSchema.nullable(),
    /**
     * Convenience flag for the UI: true when plan === null. Avoids the
     * caller doing the null check itself.
     */
    expired: z.boolean(),
});

export type AdminPlaybackPlanResponse = z.infer<typeof AdminPlaybackPlanResponseSchema>;

// ============================================================================
// Admin per-user watch-state refresh
// (POST /api/admin/users/[username]/refresh-watch-state)
// ============================================================================

export const AdminRefreshUserWatchStateResponseSchema = z.object({
    /**
     * Provider names whose pull-log cursor was cleared for this user.
     * The next scheduled pull cycle (every 5 min by default) does a
     * full re-fetch for the user instead of an incremental one.
     */
    providersCleared: z.array(z.string()),
    /**
     * Human-readable summary for the toast — e.g.
     * "Cleared 1 cursor — next sync within 5 min will refresh from Jellyfin."
     */
    message: z.string(),
});

export type AdminRefreshUserWatchStateResponse = z.infer<
    typeof AdminRefreshUserWatchStateResponseSchema
>;

// ============================================================================
// Series progress setter (POST /api/watched/series/[seriesId]/set-progress)
// Lives here to keep all watch-state response schemas in one place; this
// endpoint isn't admin-only but follows the same shape conventions.
// ============================================================================

/**
 * "Set my progress" accepts two shapes:
 *  - through-episode: linear "I'm at S3:E5" — server marks <= as watched
 *    and > as unwatched in effective custom-order
 *  - per-episode: explicit `{ watchedIds, unwatchedIds }` for
 *    non-linear viewing (anthologies, filler-skipping). Each list is the
 *    set of episodes the user TOUCHED in that direction; episodes not in
 *    either list keep their current state. Server still computes a delta
 *    against current state to avoid lwa-bumps on no-op toggles.
 *
 * Per-mode arrays are bounded at 5000 each — well past any real series
 * length, but enough to keep an unbounded payload from spinning the
 * tx loop into a connection-timeout DoS.
 */
const SET_PROGRESS_MAX_IDS = 5000;
export const SetSeriesProgressRequestSchema = z.union([
    z
        .object({
            throughEpisodeId: z.string().guid(),
        })
        .strict(),
    z
        .object({
            watchedIds: z.array(z.string().guid()).max(SET_PROGRESS_MAX_IDS),
            unwatchedIds: z.array(z.string().guid()).max(SET_PROGRESS_MAX_IDS),
        })
        .strict()
        .refine((b) => b.watchedIds.length + b.unwatchedIds.length > 0, {
            message: 'At least one episode must be specified',
        })
        .refine(
            (b) => {
                const set = new Set(b.watchedIds);
                return !b.unwatchedIds.some((id) => set.has(id));
            },
            {
                message: 'An episode cannot appear in both watchedIds and unwatchedIds',
            },
        ),
]);

// The response schema now lives in its own dependency-light module
// (2026-09-25, fix round 1) so `$lib/api/user` doesn't have to import this
// whole, much heavier schema file. Re-exported here so existing importers of
// `$lib/schemas/api-admin-responses` are unaffected.
export {
    SetSeriesProgressResponseSchema,
    type SetSeriesProgressResponse,
} from './api-series-progress-response.js';

export type SetSeriesProgressRequest = z.infer<typeof SetSeriesProgressRequestSchema>;

// ============================================================================
// Admin Nav Pins (/api/admin/nav-pins)
// ============================================================================

export const AdminNavPinActionResponseSchema = z.object({
    message: z.string(),
    href: z.string(),
});

export type AdminNavPinActionResponse = z.infer<typeof AdminNavPinActionResponseSchema>;

// The list-response schema (and its single item schema) now live in their own
// dependency-light module (2026-09-25) so `$lib/api/nav-pins` doesn't have to
// import this whole, much heavier schema file. Re-exported here so existing
// importers of `$lib/schemas/api-admin-responses` are unaffected.
export {
    AdminNavPinSchema,
    type AdminNavPin,
    AdminNavPinListResponseSchema,
    type AdminNavPinListResponse,
} from './api-admin-nav-pins.js';

// ============================================================================
// Admin Library Paths (/api/admin/library-paths)
// ============================================================================

export const AdminLibraryPathSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
    })
    .passthrough();

// ============================================================================
// System Health Response (/api/health?detail=true)
// ============================================================================

export const SystemHealthResponseSchema = z
    .object({
        status: z.string(),
        healthy: z.boolean(),
        degraded: z.boolean(),
        setupMode: z.boolean(),
        services: z.object({
            jellyfin: z.string(),
            postgres: z.string(),
            valkey: z.string(),
        }),
        timestamp: z.string(),
        uptime: z.number(),
        detail: z.unknown().optional(),
    })
    .meta({ id: 'SystemHealthResponse' });

export type SystemHealthResponse = z.infer<typeof SystemHealthResponseSchema>;

// ============================================================================
// Cluster Status Response (/api/admin/cluster)
// ============================================================================

// ClusterNodeSchema — live node from Valkey TTL heartbeat key.
// uptimeSeconds is computed server-side from startedAt so clients need not parse dates.
// ClusterNodeEventSchema — one row per online/offline transition in cluster_node_events.
// role/version/hostname are optional because they come from heartbeat payload at detection
// time; offline events from crashed nodes may lack this data.
// ClusterStatusResponseSchema — totalRegistered = instances whose last DB event was 'online'
// (the expected-online set). This survives node crashes so partial outages show degraded.
// Host + process figures every service publishes (src/shared/host-metrics.ts; the Rust
// proxy and the sonic sidecar write the same JSON). Services with the same host.id run on
// one machine, so the cluster view shows host memory once per host.
export const ClusterHostInfoSchema = z
    .object({
        id: z
            .string()
            .describe(
                'Stable machine key: k8s:<node>, boot:<hash of the kernel boot id>, machine:<hash of /etc/machine-id> or name:<hostname>. Equal for every service on one machine.',
            ),
        name: z.string().optional().describe('Kubernetes node name or LUMASTRA_HOST_NAME'),
        memTotalBytes: z.number().optional().describe('Host memory (/proc/meminfo MemTotal)'),
        memAvailableBytes: z
            .number()
            .optional()
            .describe('Host memory available for new work (/proc/meminfo MemAvailable)'),
        cpuCount: z.number().optional().describe('CPUs visible to the service'),
        cpuPercent: z
            .number()
            .optional()
            .describe(
                'Host-wide CPU busy since the previous heartbeat, percent of ALL CPUs (/proc/stat); absent on the first beat and on older builds',
            ),
        load1: z.number().optional().describe('Host load average, 1 minute'),
        load5: z.number().optional().describe('Host load average, 5 minutes'),
        load15: z.number().optional().describe('Host load average, 15 minutes'),
        disks: z
            .array(
                z.object({
                    role: z.enum(['cache', 'transcode', 'data']).describe('What the volume holds'),
                    path: z.string().describe('Directory that was measured'),
                    freeBytes: z.number().describe('Bytes available to the service'),
                    totalBytes: z.number().describe('Volume size in bytes'),
                }),
            )
            .optional()
            .describe('Free space on the volumes this service writes to (at most 4)'),
        gpus: z
            .array(ClusterGpuDeviceSchema)
            .optional()
            .describe('GPU devices visible to the service (at most 4)'),
    })
    .meta({ id: 'ClusterHostInfo', description: 'The machine a cluster service runs on' });

export const ClusterProcessInfoSchema = z
    .object({
        rssBytes: z.number().describe('Resident memory of the service process'),
        cpuPercent: z
            .number()
            .optional()
            .describe('CPU over the last interval, percent of one core (200 = two cores)'),
        childRssBytes: z
            .number()
            .optional()
            .describe(
                "Resident memory of direct child processes (the worker's Rust watcher, FFmpeg)",
            ),
        childRssPeakBytes: z
            .number()
            .optional()
            .describe('Largest sampled direct-child RSS in the last minute, bytes'),
        childCount: z.number().optional().describe('Number of direct child processes'),
        gpu: z
            .object({
                clients: z
                    .number()
                    .describe('Child processes holding a GPU device open (FFmpeg on the GPU)'),
                engines: ClusterGpuEnginesSchema.optional().describe(
                    "The children's engine use since the previous heartbeat, percent of each engine class's capacity (video = encode/decode). From DRM fdinfo (Intel i915/xe); absent on the first beat",
                ),
            })
            .optional()
            .describe('GPU use of the service’s child processes; absent when none uses a GPU'),
    })
    .meta({ id: 'ClusterProcessInfo', description: 'Process figures of one cluster service' });

export type ClusterHostInfo = z.infer<typeof ClusterHostInfoSchema>;
export type ClusterProcessInfo = z.infer<typeof ClusterProcessInfoSchema>;

const ClusterImplementationSchema = z
    .enum(['node', 'rust', 'python'])
    .describe('Runtime that runs the service: node (TypeScript), rust or python');

export const ClusterProxyCompatSchema = z
    .object({
        state: z
            .enum(['current', 'update', 'incompatible', 'unchecked'])
            .describe(
                'current: same proxy code as this server. update: the proxy code changed since the proxy image, the proxy predates build checks, or the proxy is newer than this server. incompatible: the proxy is too old to work with this server (protocol below the minimum). unchecked: this server has no proxy build id to compare with (running from source).',
            ),
        reason: z
            .enum(['protocol_too_old', 'protocol_too_new', 'build_differs', 'build_unknown'])
            .optional()
            .describe('Why the state is update or incompatible.'),
        proxyProtocol: z
            .number()
            .describe('Protocol the proxy reports; 0 for proxies that predate the field.'),
        serverProtocol: z.number().describe('Protocol this server speaks.'),
        serverVersion: z.string().describe('Version of this server; the proxy image to update to.'),
    })
    .meta({
        id: 'ClusterProxyCompat',
        description:
            'Live TV proxy nodes only: whether the proxy, which runs on its own pinned image, needs an update to match this server.',
    });

export const ClusterNodeSchema = z
    .object({
        instanceId: z.string().describe('Unique instance identifier'),
        role: z.enum(['web', 'worker', 'proxy', 'general']).describe('Node role'),
        version: z.string().describe('Application version'),
        hostname: z.string().describe('Host machine name'),
        startedAt: z.string().describe('ISO datetime when the instance started'),
        uptimeSeconds: z.number().describe('Seconds since instance started'),
        keyFingerprint: z
            .string()
            .optional()
            .describe(
                "Non-secret HMAC fingerprint of this node's master key. Nodes that disagree cannot decrypt each other's stored secrets or validate each other's sessions. Absent on nodes running a build that predates the field, or with no key configured — never compare an absent value.",
            ),
        placement: z
            .object({
                nodeName: z.string().optional().describe('Kubernetes node the pod is scheduled on'),
                podIp: z.string().optional().describe('Pod IP address'),
                namespace: z.string().optional().describe('Kubernetes namespace'),
            })
            .optional()
            .describe(
                'Where the pod runs, from the Kubernetes Downward API env the Helm chart sets. Absent outside Kubernetes.',
            ),
        resources: z
            .object({
                memoryAnonBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat anon in bytes; v1 uses total counters when available',
                    ),
                memoryFileBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat file in bytes; v1 uses total counters when available',
                    ),
                memoryActiveFileBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat active_file in bytes; v1 uses total counters when available',
                    ),
                memoryInactiveFileBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat inactive_file in bytes; v1 uses total counters when available',
                    ),
                memoryShmemBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat shmem in bytes; v1 uses total counters when available',
                    ),
                memorySlabBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat slab in bytes; v1 uses total counters when available',
                    ),
                memoryFileDirtyBytes: z
                    .number()
                    .optional()
                    .describe(
                        'cgroup memory.stat file_dirty in bytes; v1 uses total counters when available',
                    ),
                memoryUsedBytes: z
                    .number()
                    .describe('Memory working set (usage minus inactive page cache), bytes'),
                memoryLimitBytes: z
                    .number()
                    .optional()
                    .describe('cgroup memory limit in bytes; absent when unlimited'),
                memoryPeakBytes: z
                    .number()
                    .optional()
                    .describe(
                        'Highest memory working set in the last 24 hours (since start when younger), bytes. Sampled each heartbeat; not cgroup memory.peak, which counts page cache',
                    ),
                memoryOomKills: z
                    .number()
                    .optional()
                    .describe(
                        "Processes the kernel OOM-killed inside this service's cgroup since it was created (memory.events oom_kill)",
                    ),
                memoryRequestBytes: z
                    .number()
                    .optional()
                    .describe('Kubernetes memory request in bytes; absent when unset'),
                cpuUsedCores: z
                    .number()
                    .optional()
                    .describe('CPU used over the last heartbeat interval, in cores'),
                cpuLimitCores: z
                    .number()
                    .optional()
                    .describe('cgroup CPU quota in cores; absent when unlimited'),
                cpuRequestCores: z
                    .number()
                    .optional()
                    .describe('Kubernetes CPU request in cores; absent when unset'),
            })
            .optional()
            .describe(
                "CPU and memory against limits, read from the node's own cgroup. Absent when no cgroup is readable (bare host, macOS).",
            ),
        restarts24h: z
            .number()
            .optional()
            .describe(
                'Restarts of this instance in the last 24 hours, deploys included. Only meaningful with a stable INSTANCE_ID; absent when the database is unavailable.',
            ),
        uncleanExits24h: z
            .number()
            .optional()
            .describe(
                'The subset of restarts24h that ended without a graceful shutdown (crash, OOM kill, node loss).',
            ),
        lastSeenAt: z
            .string()
            .optional()
            .describe(
                'ISO datetime the node wrote its latest heartbeat. Absent on builds that predate the field.',
            ),
        heartbeatAgeMs: z
            .number()
            .optional()
            .describe(
                "Age of the latest heartbeat at generatedAt, from the key's Valkey TTL (whole seconds, one clock for every host). Prefer this over lastSeenAt.",
            ),
        implementation: ClusterImplementationSchema.optional(),
        host: ClusterHostInfoSchema.optional(),
        process: ClusterProcessInfoSchema.optional(),
        gpuAccess: z
            .object({
                configured: z.string().describe('GPU_ACCELERATION of this service (qsv, nvenc, …)'),
                accessible: z.boolean().describe('The last test encode on this service succeeded'),
                name: z.string().optional().describe('GPU name the probe found'),
                capabilities: z
                    .array(z.string())
                    .optional()
                    .describe('Encode/decode/tonemapping features, e.g. "QSV Encode"'),
                error: z.string().optional().describe('Why the test encode failed'),
            })
            .optional()
            .describe(
                'Hardware encoder probe of this service, refreshed every 30 minutes. Absent with GPU_ACCELERATION=none and on services that do not transcode',
            ),
        runtime: z
            .object({
                upgradeState: z
                    .string()
                    .optional()
                    .describe(
                        'Worker upgrade state (idle, preparing, prepared, postponed, unknown, stopping)',
                    ),
                consumers: z
                    .object({
                        running: z.number().describe('Task consumers taking work'),
                        paused: z.number().describe('Paused task consumers'),
                        lastProgressAt: z
                            .string()
                            .optional()
                            .describe('ISO datetime of the last task progress'),
                    })
                    .optional(),
                watcher: z
                    .object({
                        state: z
                            .string()
                            .describe(
                                'Library watcher state (stopped, starting, ready, degraded, failed)',
                            ),
                        restarts: z.number().describe('Watcher restarts since the worker started'),
                        coverage: z.string().optional().describe('full or partial'),
                    })
                    .optional(),
                lease: z
                    .object({
                        held: z.boolean().describe('Singleton lease held'),
                        lastRenewAt: z
                            .string()
                            .optional()
                            .describe('ISO datetime of the last renewal'),
                    })
                    .optional(),
                lastTickAt: z.string().optional().describe('ISO datetime of the last runtime tick'),
                uncaughtExceptions: z
                    .number()
                    .optional()
                    .describe('Uncaught exceptions since start'),
            })
            .optional()
            .describe('Dedicated-worker runtime state. Absent on web nodes and older builds.'),
        unavailableReasons: z
            .array(z.string())
            .optional()
            .describe(
                'Why this worker cannot take work right now (upgrade_*, consumers_paused, consumers_stopped, singleton_lease_not_held). Absent or empty when available.',
            ),
        proxyCompat: ClusterProxyCompatSchema.optional(),
    })
    .meta({
        id: 'ClusterNode',
        description: 'Live cluster node from Valkey heartbeat',
    });

export type ClusterNode = z.infer<typeof ClusterNodeSchema>;

export const ClusterNodeEventSchema = z
    .object({
        id: z.string().describe('Event UUID'),
        instanceId: z.string().describe('Instance identifier'),
        eventType: z.enum(['online', 'offline']).describe('Transition type'),
        role: z.string().optional().describe('Node role at time of event'),
        version: z.string().optional().describe('Application version at time of event'),
        hostname: z.string().optional().describe('Hostname at time of event'),
        createdAt: z.string().describe('ISO datetime of event'),
    })
    .meta({
        id: 'ClusterNodeEvent',
        description: 'Node online/offline transition event',
    });

export type ClusterNodeEvent = z.infer<typeof ClusterNodeEventSchema>;

export const ClusterSidecarSchema = z
    .object({
        kind: z.enum(['sonic']).describe('Which sidecar (sonic = lumastra-sonic-embedder)'),
        state: z
            .enum(['healthy', 'degraded', 'down', 'notConfigured'])
            .describe(
                'healthy = answered ready; degraded = answered but not ready (model loading, error status); down = no answer; notConfigured = no URL set',
            ),
        checkedAt: z.string().describe('ISO datetime of the probe'),
        status: z.enum(['ready', 'loading']).optional().describe('Status the sidecar reported'),
        httpStatus: z.number().optional().describe('HTTP status of its health endpoint'),
        implementation: ClusterImplementationSchema.optional(),
        version: z.string().optional().describe('Sidecar version, when it reports one'),
        hostname: z.string().optional().describe('Hostname (container id under Docker)'),
        startedAt: z.string().optional().describe('ISO datetime the sidecar started'),
        uptimeSeconds: z.number().optional().describe('Seconds since the sidecar started'),
        host: ClusterHostInfoSchema.optional(),
        process: ClusterProcessInfoSchema.optional(),
        memoryLimitBytes: z
            .number()
            .optional()
            .describe('Memory budget the sidecar admits jobs against'),
    })
    .meta({
        id: 'ClusterSidecar',
        description: 'A service without a heartbeat, read through its health endpoint',
    });

export type ClusterSidecar = z.infer<typeof ClusterSidecarSchema>;

export const ClusterStatusResponseSchema = z
    .object({
        nodes: z.array(ClusterNodeSchema).describe('Currently live nodes'),
        sidecars: z
            .array(ClusterSidecarSchema)
            .optional()
            .describe('Services read through a health endpoint instead of a heartbeat'),
        expected: z
            .object({
                proxy: z
                    .boolean()
                    .describe('A Live TV stream proxy is configured (STREAM_PROXY_URL)'),
            })
            .optional()
            .describe('Which optional services this install is configured to run'),
        generatedAt: z
            .string()
            .optional()
            .describe(
                'ISO datetime the server read the heartbeats (the payload is cached for a few seconds). Compare lastSeenAt against this, not the client clock.',
            ),
        events: z.array(ClusterNodeEventSchema).describe('Recent transition events'),
        totalOnline: z.number().describe('Number of currently live nodes'),
        totalRegistered: z.number().describe('Nodes expected online (from DB transition history)'),
        selfInstanceId: z.string().describe('Instance ID of the node serving this request'),
    })
    .meta({
        id: 'ClusterStatusResponse',
        description: 'Cluster node status overview',
    });

export type ClusterStatusResponse = z.infer<typeof ClusterStatusResponseSchema>;

// ============================================================================
// Admin Messaging & Maintenance Notice
// ============================================================================

/**
 * Per-session or broadcast admin message request body.
 *
 * Used by:
 *   - POST /api/admin/sessions/[id]/message
 *   - POST /api/admin/sessions/broadcast
 */
// Strip zero-width joiners/spaces and BOM, then trim. Whitespace-only or
// invisible-only payloads would produce an empty banner/toast, so reject
// those at the validation layer rather than letting them through.
const ZERO_WIDTH_REGEX = /[\u200B-\u200D\uFEFF]/g;

export const AdminMessageRequestSchema = z
    .object({
        message: z
            .string()
            .max(500)
            .transform((s) => s.replace(ZERO_WIDTH_REGEX, '').trim())
            .refine((s) => s.length >= 1, {
                message: 'Message cannot be empty',
            })
            .describe('Toast message body (max 500 chars, trimmed)'),
        severity: z
            .enum(['info', 'warning', 'error'])
            .default('info')
            .describe('Toast severity level'),
        durationMs: z
            .number()
            .int()
            .min(1000)
            .max(60_000)
            .optional()
            .describe('Toast display duration in milliseconds (1s–60s). Omit for client default.'),
    })
    .meta({
        id: 'AdminMessageRequest',
        description: 'Admin toast message request body',
    });

export type AdminMessageRequest = z.infer<typeof AdminMessageRequestSchema>;

/**
 * Maintenance notice request body.
 *
 * Used by: POST /api/admin/maintenance
 * `minutes` is converted to an absolute `endsAt` server-side so clocks stay
 * synchronized even if the admin client has clock drift.
 */
export const MaintenanceNoticeRequestSchema = z
    .object({
        message: z
            .string()
            .max(500)
            .transform((s) => s.replace(ZERO_WIDTH_REGEX, '').trim())
            .refine((s) => s.length >= 1, {
                message: 'Message cannot be empty',
            })
            .describe('Notice message (max 500 chars, trimmed)'),
        minutes: z
            .number()
            .int()
            .min(1)
            .max(24 * 60)
            .describe('Duration in minutes from now (1 minute – 24 hours)'),
    })
    .meta({
        id: 'MaintenanceNoticeRequest',
        description: 'Maintenance notice creation request body',
    });

export type MaintenanceNoticeRequest = z.infer<typeof MaintenanceNoticeRequestSchema>;

/**
 * Maintenance notice payload (what the server stores and returns).
 * `remainingMs` is computed at delivery time (not publish time) so each
 * receiving client gets an accurate value regardless of clock skew or
 * pub/sub latency.
 */
export const MaintenanceNoticeSchema = z
    .object({
        id: z.string().describe('Notice UUID'),
        message: z.string().describe('Notice message'),
        endsAt: z.number().describe('Epoch milliseconds when the notice expires'),
        endsAtIso: z
            .string()
            .optional()
            .describe('The same instant as endsAt, ISO-8601. endsAt stays canonical.'),
        createdBy: z.string().describe('Username of the admin who created it'),
        createdAt: z.number().describe('Epoch milliseconds when the notice was created'),
        remainingMs: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
                'Milliseconds remaining at delivery time; clients use this to anchor countdown to their own clock',
            ),
    })
    .meta({
        id: 'MaintenanceNotice',
        description: 'Active maintenance notice',
    });

export type MaintenanceNotice = z.infer<typeof MaintenanceNoticeSchema>;

/**
 * GET /api/admin/maintenance response.
 * `notice` is null when no notice is currently active.
 */
/**
 * How much of the currently-streaming audience will actually SEE a maintenance
 * banner.
 *
 * The maintenance button is deliberately NOT gated on client capability the
 * way the per-session "Send message" button is: a maintenance notice is a
 * global broadcast with no single target session, and withholding the button
 * because one incompatible web client happens to be connected would be wrong.
 * A client that does not understand the frame ignores it, which is the correct
 * failure mode. So the operator gets a COUNT instead of a disabled button.
 *
 * Counted over active/paused play sessions — the same set the Active Sessions
 * table shows — because that is the population the server can actually
 * enumerate. It is not "every connected SSE stream": nothing tracks those
 * cluster-wide, and a per-pod controller count would be a confident-looking
 * wrong number.
 */
export const MaintenanceReachSchema = z
    .object({
        total: z
            .number()
            .int()
            .nonnegative()
            .describe('Active/paused play sessions right now (the denominator).'),
        supporting: z
            .number()
            .int()
            .nonnegative()
            .describe(
                'How many of those announced the `maintenance_notice` client feature. ' +
                    'Sessions that announced nothing — every pre-feature client build, and ' +
                    'every mirrored session with no client to ask — count as not supporting.',
            ),
    })
    .meta({
        id: 'MaintenanceReach',
        description: 'How many currently-streaming clients can render a maintenance banner',
    });

export type MaintenanceReach = z.infer<typeof MaintenanceReachSchema>;

export const MaintenanceNoticeResponseSchema = z
    .object({
        notice: MaintenanceNoticeSchema.nullable().describe(
            'Active maintenance notice, or null if none',
        ),
        reach: MaintenanceReachSchema.optional().describe(
            'Audience estimate for a banner. Absent when the DB is unavailable — the ' +
                'notice surface stays usable without it rather than failing the read.',
        ),
    })
    .meta({
        id: 'MaintenanceNoticeResponse',
        description: 'Active maintenance notice response',
    });

export type MaintenanceNoticeResponse = z.infer<typeof MaintenanceNoticeResponseSchema>;

// ============================================================================
// Jellyfin Re-sync (POST /api/jellyfin-sync/pull)
// ============================================================================

/**
 * Request body for the admin-only Jellyfin re-sync trigger.
 *
 * The underlying engine pulls watch state for **every** Jellyfin user in a
 * single run, so there is no per-user targeting — the body is intentionally
 * empty. Callers should POST `{}`.
 */
export const JellyfinResyncRequestSchema = z.object({}).meta({
    id: 'JellyfinResyncRequest',
    description: 'Trigger a global Jellyfin watch-state re-sync (admin-only)',
});

export type JellyfinResyncRequest = z.infer<typeof JellyfinResyncRequestSchema>;

/**
 * Successful Jellyfin re-sync response. Aggregates totals across all
 * watch-sync plugins invoked during the pull (currently only Jellyfin).
 */
export const JellyfinResyncResponseSchema = z
    .object({
        /**
         * False when any provider surfaced soft errors during pull or push.
         * The admin UI keys its toast off this flag — the run can still
         * partially succeed when `success === false` (synced/pushed counts
         * may be non-zero), but the operator needs to see the failure.
         */
        success: z
            .boolean()
            .describe('Whether pull and push completed without provider-level errors'),
        /** Number of watch-state rows upserted across all users scanned. */
        synced: z.number().int().nonnegative().describe('Rows upserted into Lumastra'),
        /** Total items returned by the provider before filtering/resolution. */
        fromProvider: z.number().int().nonnegative().describe('Items returned by the provider'),
        /** Items that could not be resolved to a Lumastra media row. */
        skipped: z
            .number()
            .int()
            .nonnegative()
            .describe('Items skipped because no matching Lumastra media was found'),
        /**
         * Number of (user, media) pairs whose Lumastra-originated changes
         * were successfully pushed back to Jellyfin during the same run.
         * 0 when nothing was dirty or push fields aren't surfaced.
         */
        pushed: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Items pushed from Lumastra back to Jellyfin'),
        /** End-to-end duration of the combined pull + push in milliseconds. */
        durationMs: z.number().int().nonnegative().describe('Run duration in ms'),
        /**
         * Soft errors surfaced by individual providers during pull or push.
         * Defaults to an empty array — admin UI can rely on the field
         * always being present (no `undefined` checks needed).
         */
        errors: z.array(z.string()).default([]).describe('Non-fatal errors reported by providers'),
    })
    .meta({
        id: 'JellyfinResyncResponse',
        description: 'Jellyfin re-sync aggregate result (pull + push)',
    });

export type JellyfinResyncResponse = z.infer<typeof JellyfinResyncResponseSchema>;

// ============================================================================
// Integrity Violations Responses (/api/admin/integrity)
// ============================================================================

export const IntegrityViolationSchema = z
    .object({
        id: z.string().describe('Violation UUID'),
        rule: z.string().describe('Rule ID (kebab-case)'),
        severity: z.enum(['low', 'medium', 'high', 'critical']).describe('Severity'),
        mediaId: z.string().nullable().optional().describe('Affected media UUID'),
        details: z.record(z.string(), z.unknown()).describe('Finding details'),
        detectedAt: z.union([z.string(), z.date()]).describe('Detection timestamp'),
        resolvedAt: z
            .union([z.string(), z.date()])
            .nullable()
            .optional()
            .describe('Resolution timestamp'),
        resolution: z.string().nullable().optional().describe('Resolution note'),
    })
    .meta({
        id: 'IntegrityViolation',
        description: 'Single integrity violation row',
    });

export type IntegrityViolation = z.infer<typeof IntegrityViolationSchema>;

export const IntegrityViolationsResponseSchema = z
    .object({
        violations: z.array(IntegrityViolationSchema).describe('Open violations'),
        counts: z.record(z.string(), z.number()).describe('Open count per rule'),
    })
    .meta({
        id: 'IntegrityViolationsResponse',
        description: 'Integrity violations list response',
    });

export type IntegrityViolationsResponse = z.infer<typeof IntegrityViolationsResponseSchema>;

export const IntegrityResolveResponseSchema = z
    .object({
        resolved: z.boolean().describe('Whether the violation was resolved'),
        id: z.string().describe('Violation UUID'),
    })
    .meta({
        id: 'IntegrityResolveResponse',
        description: 'Integrity violation resolve response',
    });

export type IntegrityResolveResponse = z.infer<typeof IntegrityResolveResponseSchema>;

// ============================================================================
// Sync Quarantine Responses (/api/admin/quarantine)
// ============================================================================

export const QuarantineEntrySchema = z
    .object({
        id: z.string().describe('Quarantine entry UUID'),
        provider: z.string().describe('Provider name (e.g. jellyfin)'),
        externalId: z.string().describe('Provider-assigned external ID'),
        mediaType: z.string().describe('Media type'),
        parentTmdbId: z.string().nullable().optional().describe('Parent TMDB ID'),
        expectedSeriesId: z
            .string()
            .nullable()
            .optional()
            .describe('Expected series UUID in Lumastra'),
        payload: z.record(z.string(), z.unknown()).describe('Original quarantined payload'),
        reason: z.string().describe('Why this entry was quarantined'),
        source: z.string().describe('Code path that quarantined it'),
        createdAt: z.union([z.string(), z.date()]).describe('Quarantine timestamp'),
        resolvedAt: z
            .union([z.string(), z.date()])
            .nullable()
            .optional()
            .describe('Resolution timestamp'),
        resolvedBy: z.string().nullable().optional().describe('Admin who resolved it'),
        resolution: z
            .enum(['reattached', 'dismissed', 'recreated'])
            .nullable()
            .optional()
            .describe('Resolution verb'),
    })
    .meta({
        id: 'QuarantineEntry',
        description: 'Single sync quarantine entry',
    });

export type QuarantineEntry = z.infer<typeof QuarantineEntrySchema>;

export const QuarantineResponseSchema = z
    .object({
        items: z.array(QuarantineEntrySchema).describe('Unresolved quarantine entries'),
        /** Pagination block */
        page: PageBlockSchema,
        counts: z
            .object({
                unresolved: z.number().describe('Total unresolved count'),
            })
            .describe('Summary counts'),
    })
    .meta({
        id: 'QuarantineResponse',
        description: 'Quarantine entries list response',
    });

export type QuarantineResponse = z.infer<typeof QuarantineResponseSchema>;

/** Internal admin inspection only. Raw history never travels on public events. */
export const QuarantineInspectionEntrySchema = z.object({
    id: z.string().uuid().describe('Warning UUID'),
    fingerprint: z.string().describe('Opaque revision of the warning and inspected current state'),
    provider: z.string(),
    externalId: z.string(),
    mediaType: z.string(),
    reason: z.string(),
    createdAt: z.string(),
    expectedSeriesId: z.string().nullable(),
    parentTmdbId: z.string().nullable(),
    historicalSeriesId: z.string().nullable(),
    proposedTitle: z.string().nullable(),
    proposedTmdbEpisodeId: z.string().nullable(),
    payload: z.unknown().describe('Historical payload, including malformed historical JSON'),
    subjectState: z.enum(['current', 'moved', 'unavailable']),
    current: z
        .object({
            id: z.string().uuid(),
            title: z.string(),
            mediaType: z.string(),
            status: z.string(),
            seasonNumber: z.number().nullable(),
            episodeNumber: z.number().nullable(),
            seriesId: z.string().nullable(),
            seriesTitle: z.string().nullable(),
            fileCount: z.number().int(),
            detailAvailable: z.boolean(),
        })
        .nullable(),
});
export type QuarantineInspectionEntry = z.infer<typeof QuarantineInspectionEntrySchema>;
export const QuarantineInspectionResponseSchema = z.object({
    items: z.array(QuarantineInspectionEntrySchema),
    total: z.number().int(),
    continuation: z.string().optional(),
});
export type QuarantineInspectionResponse = z.infer<typeof QuarantineInspectionResponseSchema>;

export const QuarantineResolveResponseSchema = z
    .object({
        resolved: z.boolean().describe('Whether the entry was resolved'),
        id: z.string().describe('Entry UUID'),
        resolution: z.enum(['reattached', 'dismissed', 'recreated']).describe('Resolution verb'),
        resolvedBy: z.string().describe('Admin who resolved it'),
    })
    .meta({
        id: 'QuarantineResolveResponse',
        description: 'Quarantine entry resolve response',
    });

export type QuarantineResolveResponse = z.infer<typeof QuarantineResolveResponseSchema>;

// ============================================================================
// Config Health (config doctor over HTTP)
// ============================================================================

export const ConfigHealthIssueSchema = z
    .object({
        category: z.string().describe('Check category, e.g. "embedding"'),
        severity: z.enum(['error', 'warning']),
        code: z.string().describe('Stable issue code, e.g. "embedding.dimension-mismatch"'),
        message: z.string(),
        remediation: z.string().optional(),
    })
    .meta({ id: 'ConfigHealthIssue' });

export type ConfigHealthIssue = z.infer<typeof ConfigHealthIssueSchema>;

export const ConfigHealthResponseSchema = z
    .object({
        ok: z.boolean().describe('True when there are no error-severity issues'),
        errorCount: z.number().int().nonnegative(),
        warningCount: z.number().int().nonnegative(),
        issues: z.array(ConfigHealthIssueSchema),
        embedding: z
            .object({
                provider: z.string(),
                model: z.string(),
                dimensions: z.number().int(),
                modelSource: z.string(),
                dimensionSource: z.string(),
                hasProvider: z.boolean(),
            })
            .describe('Resolved embedding configuration for context'),
    })
    .meta({ id: 'ConfigHealthResponse', description: 'Config doctor report' });

export type ConfigHealthResponse = z.infer<typeof ConfigHealthResponseSchema>;

// ============================================================================
// Admin Radio Responses (/api/admin/radio)
// ============================================================================

/**
 * Individual station item as returned by GET /api/admin/radio.
 * Server-side: defs/admin/radio/index.ts — internal admin surface only.
 * The upstream stream URL is served as-is by the admin BFF (logo served via
 * the /api/image route as a custom_poster_url reference).
 */
export const AdminRadioStationItemSchema = z
    .object({
        id: z.string().guid().describe('Station UUID'),
        name: z.string().describe('Display name'),
        streamUrl: z.string().describe('Icecast / HLS stream URL'),
        genre: z.string().optional().describe('Primary genre'),
        description: z.string().optional().describe('Station description'),
        /** /api/image/custom/{id}/poster when a custom poster has been stored */
        logoUrl: z.string().optional().describe('Logo image URL'),
        nowPlaying: z.string().optional().describe('Last-known now-playing text'),
        metadataSource: RadioMetadataSourceSchema.optional().describe('Metadata source config'),
        lastError: z
            .object({ at: z.string(), message: z.string() })
            .optional()
            .describe('Last metadata fetch error'),
    })
    .meta({ id: 'AdminRadioStationItem', description: 'Admin radio station item' });

export type AdminRadioStationItem = z.infer<typeof AdminRadioStationItemSchema>;

/** GET /api/admin/radio — bare object { stations: [...] } */
export const AdminRadioListResponseSchema = z
    .object({
        stations: z.array(AdminRadioStationItemSchema),
    })
    .meta({ id: 'AdminRadioListResponse', description: 'Admin radio station list' });

export type AdminRadioListResponse = z.infer<typeof AdminRadioListResponseSchema>;

/** POST /api/admin/radio — bare object with the newly-created station's fields */
export const AdminRadioCreateResponseSchema = z
    .object({
        id: z.string().guid(),
        name: z.string(),
        streamUrl: z.string(),
        genre: z.string().optional(),
        description: z.string().optional(),
        logoUrl: z.string().optional(),
    })
    .meta({ id: 'AdminRadioCreateResponse', description: 'Radio station creation response' });

export type AdminRadioCreateResponse = z.infer<typeof AdminRadioCreateResponseSchema>;

/** PATCH /api/admin/radio/[id] — bare object { updated: true, validation? } */
const RadioValidationResultSchema = z.object({
    ok: z.boolean(),
    source: z.enum(['url', 'icy', 'stale']).nullable(),
    matchedFieldCount: z.number().int().nonnegative(),
    error: z.string().optional(),
});

export const AdminRadioPatchResponseSchema = z
    .object({
        updated: z.literal(true),
        validation: RadioValidationResultSchema.optional(),
    })
    .meta({ id: 'AdminRadioPatchResponse', description: 'Radio station update response' });

export type AdminRadioPatchResponse = z.infer<typeof AdminRadioPatchResponseSchema>;

/** DELETE /api/admin/radio/[id] — bare object { deleted: true } */
export const AdminRadioDeleteResponseSchema = z
    .object({ deleted: z.literal(true) })
    .meta({ id: 'AdminRadioDeleteResponse', description: 'Radio station delete response' });

export type AdminRadioDeleteResponse = z.infer<typeof AdminRadioDeleteResponseSchema>;

// ============================================================================
// Plugin Reload Response (/api/admin/plugins/reload)
// ============================================================================

/**
 * POST /api/admin/plugins/reload — hot-load external plugins.
 * Server: defs/admin/plugins/reload.ts
 */
export const PluginReloadResponseSchema = z
    .object({
        newlyLoaded: z.array(z.string()).describe('IDs of newly-loaded plugins'),
        skippedKnown: z.number().int().nonnegative().describe('Already-known plugins skipped'),
        errors: z.array(z.unknown()).describe('Load errors'),
        sdkImportErrors: z.array(z.unknown()).describe('SDK import errors'),
        discovered: z.number().int().nonnegative().describe('Total plugins discovered on disk'),
        validationError: z
            .string()
            .nullable()
            .optional()
            .describe(
                'Non-fatal registry validation error surfaced after the reload, or null/absent if the registry validated cleanly',
            ),
    })
    .meta({ id: 'PluginReloadResponse', description: 'External plugin reload result' });

export type PluginReloadResponse = z.infer<typeof PluginReloadResponseSchema>;

// ============================================================================
// User CRUD Responses (/api/admin/users)
// ============================================================================

/**
 * POST /api/admin/users → { user: { username, isAdmin } }
 * Server: defs/users/index.ts handler POST
 */
export const CreateLocalUserResponseSchema = z
    .object({
        user: z.object({
            username: z.string(),
            isAdmin: z.boolean(),
        }),
        warnings: z.array(z.enum(['native_login_disabled'])).optional(),
    })
    .meta({ id: 'CreateLocalUserResponse', description: 'Admin create-user response' });

export type CreateLocalUserResponse = z.infer<typeof CreateLocalUserResponseSchema>;

/**
 * POST /api/admin/users/:username/password → { username, passwordChanged }
 * Server: defs/admin/users/[username]/password.ts
 */
export const SetUserPasswordResponseSchema = z
    .object({
        username: z.string(),
        passwordChanged: z.boolean(),
    })
    .meta({ id: 'SetUserPasswordResponse', description: 'Admin set-password response' });

export type SetUserPasswordResponse = z.infer<typeof SetUserPasswordResponseSchema>;

/**
 * PATCH /api/admin/users/:username { disabled } → { username, disabled }
 * Server: defs/admin/users/[username]/index.ts — disabled branch
 */
export const SetUserDisabledResponseSchema = z
    .object({
        username: z.string(),
        disabled: z.boolean(),
    })
    .meta({ id: 'SetUserDisabledResponse', description: 'Admin disable/enable user response' });

export type SetUserDisabledResponse = z.infer<typeof SetUserDisabledResponseSchema>;

/**
 * DELETE /api/admin/users/:username → { username, deleted, erasure }
 * Server: defs/admin/users/[username]/index.ts — DELETE handler
 */
const ErasureTableSchema = z.object({
    table: z.string(),
    strategy: z.string(),
    deleted: z.number(),
    anonymized: z.number(),
});

export const DeleteLocalUserResponseSchema = z
    .object({
        username: z.string(),
        deleted: z.boolean(),
        erasure: z
            .object({
                totalDeleted: z.number(),
                totalAnonymized: z.number(),
                tables: z.array(ErasureTableSchema),
            })
            .optional(),
    })
    .meta({ id: 'DeleteLocalUserResponse', description: 'Admin GDPR erasure response' });

export type DeleteLocalUserResponse = z.infer<typeof DeleteLocalUserResponseSchema>;

// ============================================================================
// Onboarding Checklist Responses (GET /api/v1/setup/onboarding)
// ============================================================================

/**
 * A single onboarding step row as returned by the onboarding_state table.
 * Mirrors the server-side `OnboardingStep` interface in
 * `$lib/server/database/queries/onboarding.queries.ts`.
 */
export const OnboardingStepResponseSchema = z
    .object({
        step_key: z.string(),
        completed: z.boolean(),
        dismissed: z.boolean(),
        dismissed_by: z.string().nullable(),
        dismissed_at: z.string().nullable(),
        completed_at: z.string().nullable(),
    })
    .meta({ id: 'OnboardingStepResponse', description: 'Onboarding step state' });

export type OnboardingStepResponse = z.infer<typeof OnboardingStepResponseSchema>;

/**
 * GET /api/v1/setup/onboarding → { steps, allDismissed }
 * Server: routes/api/v1/setup/onboarding/+server.ts (GET handler)
 */
export const OnboardingStateResponseSchema = z
    .object({
        steps: z.array(OnboardingStepResponseSchema),
        allDismissed: z.boolean(),
    })
    .meta({ id: 'OnboardingStateResponse', description: 'Instance onboarding checklist state' });

export type OnboardingStateResponse = z.infer<typeof OnboardingStateResponseSchema>;

/**
 * Admin per-user UI preferences (admin IA redesign, spec §4).
 * GET/PATCH /api/admin/ui-prefs → { navStyle }
 * Server: routes/api/admin/ui-prefs/+server.ts
 */
export const AdminNavStyleSchema = z
    .enum(['sidebar', 'mega'])
    .describe('Admin navigation renderer: flat sidebar or Browse mega-menu');
export type AdminNavStyleValue = z.infer<typeof AdminNavStyleSchema>;

export const AdminUiPrefsResponseSchema = z
    .object({
        navStyle: AdminNavStyleSchema,
    })
    .meta({ id: 'AdminUiPrefsResponse', description: 'Per-admin-user UI preferences' });
export type AdminUiPrefsResponse = z.infer<typeof AdminUiPrefsResponseSchema>;

export const AdminUiPrefsPatchBodySchema = z
    .object({
        navStyle: AdminNavStyleSchema,
    })
    .meta({ id: 'AdminUiPrefsPatchBody', description: 'Update admin UI preferences' });
export type AdminUiPrefsPatchBody = z.infer<typeof AdminUiPrefsPatchBodySchema>;
