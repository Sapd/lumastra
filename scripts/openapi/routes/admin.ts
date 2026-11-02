// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI route definitions for Admin endpoints.
 *
 * Covers: system status, sync, cache, tasks, PATs, service tokens,
 * devices, quick connect, privacy, playback quality, FFmpeg jobs,
 * system metrics, plugins, debug endpoints, and OAuth authorize.
 */

import {
    FileHealthReviewRequestSchema,
    FileHealthReviewResponseSchema,
} from '../../../src/lib/schemas/file-health-review.js';
import {
    RegenerateBodySchema,
    RegenerateResponseSchema,
    ExtractBodySchema,
    ExtractResponseSchema,
    SharedEpisodeThumbReviewSchema,
} from '../../../src/lib/schemas/admin-image-extraction.js';
import {
    CollaborationRequestSchema,
    CollaborationResponseSchema,
} from '../../../src/lib/schemas/collaboration-review.js';
import {
    EpisodeTmdbExchangeConfirmSchema,
    EpisodeTmdbExchangePreviewSchema,
} from '../../../src/lib/schemas/episode-tmdb-exchange.js';
import {
    quarantineGroupResolveBodySchema,
    QuarantineSeriesGroupsResponseSchema,
    QuarantineGroupResolveResponseSchema,
} from '../../../src/lib/schemas/api-admin-library-responses.js';
import { z } from 'zod';
import {
    UploadAttachmentTargetsSchema,
    UploadAncillaryResponseSchema,
    UploadAbortResponseSchema,
} from '../../../src/lib/schemas/api-upload-responses.js';
import {
    CandidateRoleSchema,
    CandidateMutationSchema,
    ImageCandidateResultSchema,
} from '../../../src/lib/schemas/image-candidates.js';
import {
    mediaMergeDocs,
    MergeMediaRequestSchema,
    MergeEndpointResponseSchema,
} from '../../../src/lib/server/api/defs/admin/media/_merge-docs.js';
import { ReorderEpisodesRequestSchema } from '../../../src/lib/schemas/admin-episodes';
import {
    ActivitySharingDefaultSchema,
    ActivitySharingDefaultAppliedSchema,
    ApplyActivitySharingDefaultBodySchema,
} from '../../../src/lib/schemas/activity-sharing.js';
import {
    BEARER_AUTH,
    COMMON_ERRORS,
    COMMON_ERRORS_WITH_404,
    jsonResponse,
    apiErrorResponse,
    type PathsObject,
} from '../helpers';

// Canonical schemas — single source of truth for API responses
import { AdminStatusPayloadSchema } from '../../../src/lib/schemas/api-admin-status-payload';
import {
    CacheWarmingStatusSchema,
    PatListResponseSchema,
    PatCreateResponseSchema,
    PatDeleteResponseSchema,
    ServiceTokenListResponseSchema,
    ServiceTokenCreateResponseSchema,
    ServiceTokenDeleteResponseSchema,
    DeviceListResponseSchema,
    DeviceDeleteResponseSchema,
    AdminDeviceDeleteAllResponseSchema,
    PrivacySettingsItemSchema,
    PrivacySettingsUpdateResponseSchema,
    PlaybackQualityResponseSchema,
    PlaybackQualityClearResponseSchema,
    FFmpegJobStopResponseSchema,
    PluginSettingsResponseSchema,
    PluginSettingsUpdateResponseSchema,
    JellyseerrDebugResponseSchema,
    SonarrLookupResponseSchema,
    RadarrLookupResponseSchema,
    OAuthResponseSchema,
} from '../../../src/lib/schemas/api-admin-responses';
// These live in admin-types (the metrics/settings schema module), not the
// response-schema module — import them from their real source.
import {
    CacheStatsResponseSchema,
    FFmpegJobsResponseSchema,
    SystemMetricsSchema,
} from '../../../src/lib/schemas/admin-types';

// ============================================================================
// Route Definitions
// ============================================================================

export const adminRoutes: PathsObject = {
    '/api/admin/media/merge': {
        post: {
            tags: mediaMergeDocs.tags,
            summary: mediaMergeDocs.summary,
            description: mediaMergeDocs.description,
            security: BEARER_AUTH,
            requestBody: {
                required: true,
                content: { 'application/json': { schema: MergeMediaRequestSchema } },
            },
            responses: {
                '200': jsonResponse(
                    MergeEndpointResponseSchema,
                    'Album preview/apply or legacy media merge',
                ),
                ...COMMON_ERRORS_WITH_404,
                '409': apiErrorResponse(
                    'Stale preview, metadata lock, active scan, or unsafe merge',
                    409,
                ),
                '422': apiErrorResponse('Invalid pair or survivor', 422),
            },
        },
    },
    '/api/admin/media/{id}/episodes/reorder': {
        put: {
            tags: ['Admin'],
            summary: 'Reorder episodes within a series',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ id: z.string().guid() }) },
            requestBody: {
                required: true,
                content: { 'application/json': { schema: ReorderEpisodesRequestSchema } },
            },
            responses: {
                '200': jsonResponse(z.object({ message: z.string() }), 'Episodes reordered'),
                ...COMMON_ERRORS_WITH_404,
                '409': apiErrorResponse('Episode number conflicts with another episode', 409),
                '422': apiErrorResponse(
                    'Invalid episode numbers, duplicate numbers, or episodes outside the series',
                    422,
                ),
            },
        },
    },

    // ========================================================================
    // Status & Sync
    // ========================================================================

    '/api/admin/status': {
        get: {
            tags: ['Admin'],
            summary: 'Get the canonical admin status payload',
            description:
                'Returns the consolidated admin status payload: health verdict, attention items, system health (database, cache, AI, services), service/binary versions, active-session preview, and task/library/user counters.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(AdminStatusPayloadSchema, 'Admin status payload'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Cache
    // ========================================================================

    '/api/admin/cache-warming': {
        get: {
            tags: ['Admin'],
            summary: 'Get cache warming status',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(CacheWarmingStatusSchema, 'Cache warming status'),
                ...COMMON_ERRORS,
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Trigger cache warming',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            type: z.enum(['full', 'frequent', 'regular']).default('full').meta({
                                description: 'Cache warming type (default: full)',
                            }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(z.object({ message: z.string() }), 'Cache warming triggered'),
                ...COMMON_ERRORS,
            },
        },
    },

    '/api/cache-stats': {
        get: {
            tags: ['Admin'],
            summary: 'Get detailed cache statistics',
            description:
                'Returns comprehensive cache statistics including health, namespace breakdowns, invalidation stats, and warming info.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(CacheStatsResponseSchema, 'Cache statistics'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Personal Access Tokens (Admin)
    // ========================================================================

    '/api/admin/pats': {
        get: {
            tags: ['Admin'],
            summary: 'List all personal access tokens',
            description:
                'Returns all personal access tokens across all users. Admin-only endpoint.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(PatListResponseSchema, 'Personal access tokens'),
                ...COMMON_ERRORS,
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Create personal access token for a user',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            username: z.string().meta({ description: 'Target username' }),
                            name: z.string().meta({ description: 'Token name' }),
                            description: z
                                .string()
                                .max(1000)
                                .optional()
                                .meta({ description: 'Token description' }),
                            scopes: z
                                .array(z.enum(['read', 'write', 'admin']))
                                .optional()
                                .meta({
                                    description: 'Token scopes (default: ["read"])',
                                }),
                            expiresInDays: z.number().int().positive().optional().meta({
                                description: 'Expiry in days (null = never)',
                            }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(PatCreateResponseSchema, 'Token created successfully'),
                ...COMMON_ERRORS,
            },
        },
        delete: {
            tags: ['Admin'],
            summary: 'Revoke a personal access token',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    id: z.coerce.number().meta({ description: 'Token ID to revoke' }),
                }),
            },
            responses: {
                '200': jsonResponse(PatDeleteResponseSchema, 'Token revoked'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // Service Tokens
    // ========================================================================

    '/api/admin/service-tokens': {
        get: {
            tags: ['Admin'],
            summary: 'List all service tokens',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(ServiceTokenListResponseSchema, 'Service tokens'),
                ...COMMON_ERRORS,
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Create a service token',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            name: z.string().meta({ description: 'Token name' }),
                            description: z
                                .string()
                                .max(1000)
                                .optional()
                                .meta({ description: 'Token description' }),
                            actAsUser: z
                                .string()
                                .optional()
                                .meta({ description: 'Username to act as' }),
                            scopes: z
                                .array(z.enum(['read', 'write', 'admin']))
                                .optional()
                                .meta({
                                    description: 'Token scopes (default: ["admin"])',
                                }),
                            allowedIps: z
                                .array(z.string())
                                .optional()
                                .meta({ description: 'Allowed IP addresses' }),
                            expiresInDays: z.number().int().positive().optional().meta({
                                description: 'Expiry in days (null = never)',
                            }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(ServiceTokenCreateResponseSchema, 'Service token created'),
                ...COMMON_ERRORS,
            },
        },
        delete: {
            tags: ['Admin'],
            summary: 'Revoke a service token',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    id: z.coerce.number().meta({ description: 'Service token ID to revoke' }),
                }),
            },
            responses: {
                '200': jsonResponse(ServiceTokenDeleteResponseSchema, 'Service token revoked'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // Devices (Admin)
    // ========================================================================

    '/api/admin/devices': {
        get: {
            tags: ['Admin Devices'],
            summary: 'List devices for a user',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    username: z.string().meta({ description: 'Username to list devices for' }),
                }),
            },
            responses: {
                '200': jsonResponse(DeviceListResponseSchema, 'User device sessions'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
        delete: {
            tags: ['Admin Devices'],
            summary: 'Revoke a specific device session',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    username: z.string().meta({ description: 'Username' }),
                    id: z.string().meta({ description: 'Device session ID to revoke' }),
                }),
            },
            responses: {
                '200': jsonResponse(DeviceDeleteResponseSchema, 'Device session revoked'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    '/api/admin/devices/all': {
        delete: {
            tags: ['Admin Devices'],
            summary: 'Revoke all device sessions for a user',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    username: z.string().meta({
                        description: 'Username to revoke all devices for',
                    }),
                }),
            },
            responses: {
                '200': jsonResponse(
                    AdminDeviceDeleteAllResponseSchema,
                    'All device sessions revoked',
                ),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // Quick Connect
    // ========================================================================

    '/api/admin/quick-connect': {
        post: {
            tags: ['Admin'],
            summary: 'Authorize Quick Connect code for a user',
            description: 'Allows an admin to enter a Quick Connect code on behalf of another user.',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            code: z.string().meta({ description: 'Quick Connect code' }),
                            username: z.string().meta({
                                description: 'Target username to authorize',
                            }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(
                    z.object({ result: z.number() }),
                    'Quick connect authorization result (0 = success)',
                ),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Privacy Settings
    // ========================================================================

    '/api/admin/activity-sharing-default': {
        get: {
            tags: ['Admin'],
            summary: 'Read the saved activity sharing default',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(ActivitySharingDefaultSchema, 'Saved default'),
                '403': { description: 'Administrator access required' },
                ...COMMON_ERRORS,
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Apply the saved default to accounts without an explicit sharing choice',
            security: BEARER_AUTH,
            requestBody: {
                required: true,
                content: { 'application/json': { schema: ApplyActivitySharingDefaultBodySchema } },
            },
            responses: {
                '200': jsonResponse(
                    ActivitySharingDefaultAppliedSchema,
                    'Applied default and changed account count',
                ),
                '403': { description: 'Administrator access required' },
                '409': { description: 'The saved default changed since confirmation' },
                '422': { description: 'A confirmation and the expected default are required' },
                '503': { description: 'Database unavailable' },
                ...COMMON_ERRORS,
            },
        },
    },

    '/api/admin/privacy-settings': {
        get: {
            tags: ['Admin'],
            summary: 'Get hidden users list',
            description:
                'Returns all users with privacy settings enabled (hidden from other users).',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(
                    z.array(PrivacySettingsItemSchema),
                    'List of users with privacy settings',
                ),
                ...COMMON_ERRORS,
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Update user privacy settings',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            username: z.string().meta({ description: 'Target username' }),
                            hideFromOthers: z.boolean().meta({
                                description: 'Hide user from other users',
                            }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(
                    PrivacySettingsUpdateResponseSchema,
                    'Privacy settings updated',
                ),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // Playback Quality
    // ========================================================================

    '/api/admin/playback-quality': {
        get: {
            tags: ['Admin'],
            summary: 'Get playback quality analytics',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    days: z.coerce.number().optional().meta({
                        description: 'Number of days to analyze (default varies)',
                    }),
                }),
            },
            responses: {
                '200': jsonResponse(PlaybackQualityResponseSchema, 'Playback quality analytics'),
                ...COMMON_ERRORS,
            },
        },
        delete: {
            tags: ['Admin'],
            summary: 'Clear playback quality data',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(
                    PlaybackQualityClearResponseSchema,
                    'Playback quality data cleared',
                ),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // FFmpeg Jobs
    // ========================================================================

    '/api/admin/ffmpeg-jobs': {
        get: {
            tags: ['Admin'],
            summary: 'List active FFmpeg transcoding jobs',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(FFmpegJobsResponseSchema, 'FFmpeg jobs and config'),
                ...COMMON_ERRORS,
            },
        },
        delete: {
            tags: ['Admin'],
            summary: 'Stop an FFmpeg transcoding job',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    playSessionId: z.string().meta({
                        description: 'Play session ID of the job to stop',
                    }),
                }),
            },
            responses: {
                '200': jsonResponse(FFmpegJobStopResponseSchema, 'FFmpeg job stopped'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // System Metrics
    // ========================================================================

    '/api/admin/system-metrics': {
        get: {
            tags: ['Admin'],
            summary: 'Get system resource metrics',
            description: 'Returns CPU, memory, GPU, network, and dashboard process metrics.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(SystemMetricsSchema, 'System metrics'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Plugins
    // ========================================================================

    '/api/admin/plugins/{pluginId}/settings': {
        get: {
            tags: ['Admin'],
            summary: 'Get plugin settings',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({
                    pluginId: z.string().meta({ description: 'Plugin identifier' }),
                }),
            },
            responses: {
                '200': jsonResponse(PluginSettingsResponseSchema, 'Plugin settings'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
        put: {
            tags: ['Admin'],
            summary: 'Update plugin settings',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({
                    pluginId: z.string().meta({ description: 'Plugin identifier' }),
                }),
            },
            requestBody: {
                content: {
                    'application/json': {
                        schema: z
                            .record(z.string(), z.string())
                            .meta({ description: 'Plugin settings object' }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(PluginSettingsUpdateResponseSchema, 'Plugin settings updated'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // Debug
    // ========================================================================

    '/api/admin/debug/jellyseerr/{tmdbId}': {
        get: {
            tags: ['Admin Debug'],
            summary: 'Debug Jellyseerr lookup by TMDB ID',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({
                    tmdbId: z.string().meta({ description: 'TMDB ID' }),
                }),
                query: z.object({
                    mediaType: z
                        .string()
                        .optional()
                        .meta({ description: 'Media type (movie or tv)' }),
                }),
            },
            responses: {
                '200': jsonResponse(JellyseerrDebugResponseSchema, 'Jellyseerr lookup result'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    '/api/admin/debug/sonarr/lookup': {
        get: {
            tags: ['Admin Debug'],
            summary: 'Debug Sonarr lookup by TVDB ID',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    tvdbId: z.coerce.number().meta({ description: 'TVDB ID to look up' }),
                }),
            },
            responses: {
                '200': jsonResponse(SonarrLookupResponseSchema, 'Sonarr lookup result'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    '/api/admin/debug/radarr/lookup': {
        get: {
            tags: ['Admin Debug'],
            summary: 'Debug Radarr lookup by TMDB ID',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    tmdbId: z.coerce.number().meta({ description: 'TMDB ID to look up' }),
                }),
            },
            responses: {
                '200': jsonResponse(RadarrLookupResponseSchema, 'Radarr lookup result'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    // ========================================================================
    // OAuth Authorize (Admin)
    // ========================================================================

    '/api/oauth/authorize': {
        post: {
            tags: ['Admin'],
            summary: 'Approve OAuth device authorization',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            user_code: z.string().meta({ description: 'User code to approve' }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(OAuthResponseSchema, 'Authorization approved'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
        delete: {
            tags: ['Admin'],
            summary: 'Deny OAuth device authorization',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': {
                        schema: z.object({
                            user_code: z.string().meta({ description: 'User code to deny' }),
                        }),
                    },
                },
            },
            responses: {
                '200': jsonResponse(OAuthResponseSchema, 'Authorization denied'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },
    '/api/admin/upload/{libraryPathId}/{uploadId}': {
        get: {
            tags: ['Admin'],
            summary: 'Resolve attachment targets for a finished upload',
            description:
                'Requires library:admin and ownership of the upload session. Resolves only the finalized physical file in its library. A sole target is selected automatically only when the session has no explicit target. An explicit target absent from the linked titles stays ambiguous or pending and is never replaced automatically.',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ libraryPathId: z.uuid(), uploadId: z.uuid() }) },
            responses: {
                '200': jsonResponse(UploadAttachmentTargetsSchema, 'Current import binding'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
        delete: {
            tags: ['Admin'],
            summary: 'Cancel an upload session',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ libraryPathId: z.uuid(), uploadId: z.uuid() }) },
            responses: {
                '200': jsonResponse(UploadAbortResponseSchema, 'Upload cancelled'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },
    '/api/admin/upload/{libraryPathId}/ancillary/{mediaItemId}': {
        post: {
            tags: ['Admin'],
            summary: 'Attach a sidecar or undo a chapter upload',
            description:
                'Requires library:admin. Upload file and type as multipart form data, or send undoReceiptId to restore exact chapter rows and sidecar bytes. Subtitle/chapter files can be replaced; resources require an unused filename. JSON and WebVTT chapter uploads preserve manual markers; an empty JSON list clears uploaded chapters. uploadId pins the exact finalized file and requires ownership of that session.',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({ libraryPathId: z.uuid(), mediaItemId: z.uuid() }),
                query: z.object({ uploadId: z.uuid().optional() }),
            },
            requestBody: {
                required: true,
                content: {
                    'multipart/form-data': {
                        schema: {
                            oneOf: [
                                {
                                    type: 'object',
                                    required: ['file', 'type'],
                                    properties: {
                                        file: { type: 'string', format: 'binary' },
                                        type: {
                                            type: 'string',
                                            enum: ['subtitle', 'chapter', 'resource'],
                                        },
                                    },
                                },
                                {
                                    type: 'object',
                                    required: ['undoReceiptId'],
                                    properties: {
                                        undoReceiptId: { type: 'string', format: 'uuid' },
                                    },
                                },
                            ],
                        },
                    },
                },
            },
            responses: {
                '200': jsonResponse(
                    UploadAncillaryResponseSchema,
                    'Attached file or restored chapter list',
                ),
                '409': apiErrorResponse(
                    'Protected manual chapters, changed recovery state or existing resource',
                    409,
                ),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },
    '/api/admin/media/{id}/episode-thumbnails/regenerate': {
        post: {
            tags: ['Admin'],
            summary: 'Extract and select episode thumbnails in the background',
            description:
                'Parent scopes repair only missing or provably misassigned automatic pictures and preserve manual, hidden and healthy shared-file choices. Explicit single-episode extraction selects a new frame with guarded Undo. Publication checks the source, episode window and artwork choice again. Progress and truthful results are available on the returned run.',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ id: z.string().guid() }) },
            requestBody: {
                required: true,
                content: { 'application/json': { schema: RegenerateBodySchema } },
            },
            responses: {
                '200': jsonResponse(RegenerateResponseSchema, 'Extraction run queued'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },
    '/api/admin/media/{id}/episode-thumbnails/review': {
        get: {
            tags: ['Admin'],
            summary: 'Review shared episode thumbnail paths',
            description:
                'Administrator only. Lists a bounded page within one series or season. Sharing a path does not establish incorrect ownership. Review tokens bind deliberate extraction to the current source and choice.',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({ id: z.string().uuid() }),
                query: z.object({
                    limit: z.coerce.number().int().min(1).max(50).optional(),
                    offset: z.coerce.number().int().nonnegative().optional(),
                }),
            },
            responses: {
                '200': jsonResponse(SharedEpisodeThumbReviewSchema, 'Shared thumbnail review page'),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/media/file-health/reviews': {
        post: {
            tags: ['Admin'],
            summary: 'Review exact physical-file duration findings',
            description:
                'Administrator only. Preview current technical evidence and history, deliberately confirm selected findings with reason and inspection evidence, or revoke a decision. Raw measurements and historical failures are retained. Quiet audio never proves completeness.',
            security: BEARER_AUTH,
            requestBody: {
                required: true,
                content: { 'application/json': { schema: FileHealthReviewRequestSchema } },
            },
            responses: {
                '200': jsonResponse(
                    FileHealthReviewResponseSchema,
                    'Review preview or saved decision',
                ),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '409': apiErrorResponse('Evidence changed; refresh the preview', 409),
                '422': apiErrorResponse(
                    'Current clean evidence and deliberate inspection are required',
                    422,
                ),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/media/{id}/collaboration-review': {
        post: {
            tags: ['Admin'],
            summary: 'Review and confirm collaboration credits',
            description:
                'Administrator only. Preview ordered artist identities and affected tracks, confirm selected credits against the reviewed snapshot, or return an artist to the review queue. Album ownership stays unchanged. Returning to the queue does not undo saved credits.',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ id: z.string().uuid() }) },
            requestBody: {
                required: true,
                content: { 'application/json': { schema: CollaborationRequestSchema } },
            },
            responses: {
                '200': jsonResponse(CollaborationResponseSchema, 'Collaboration review result'),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '409': apiErrorResponse('Reviewed evidence changed; refresh the preview', 409),
                '422': apiErrorResponse('Invalid review or protected credit', 422),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/media/{id}/external-ids/exchange': {
        get: {
            tags: ['Admin'],
            summary: 'Preview a two-episode TMDB ID exchange',
            description:
                'Administrator only. Both episodes must be active canonical members of the same series, each with a distinct existing TMDB episode ID. Preview does not change either assignment.',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({ id: z.string().uuid() }),
                query: z.object({ otherId: z.string().uuid() }),
            },
            responses: {
                '200': jsonResponse(
                    EpisodeTmdbExchangePreviewSchema,
                    'Current pair and reviewed snapshot',
                ),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '422': apiErrorResponse('The pair is not eligible for exchange', 422),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Confirm an atomic episode TMDB ID exchange',
            description:
                'Administrator only. Requires the current pair snapshot. Pass undoReceiptId to restore the original assignments while the pair/source guard still matches. Both assignments, recovery evidence and the audit record commit together; unrelated media fields, links and watch data remain unchanged.',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ id: z.string().uuid() }) },
            requestBody: {
                required: true,
                content: { 'application/json': { schema: EpisodeTmdbExchangeConfirmSchema } },
            },
            responses: {
                '200': jsonResponse(
                    EpisodeTmdbExchangePreviewSchema,
                    'Saved assignments and fresh snapshot',
                ),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '409': apiErrorResponse('Reviewed pair changed or another owner holds an ID', 409),
                '422': apiErrorResponse('Invalid episode pair or snapshot', 422),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/library/quarantine-groups': {
        get: {
            tags: ['Admin'],
            summary: 'List actionable warning groups and recoverable warning history',
            description:
                'Requires library:admin. Group fingerprints fence one-click hiding. Paginated history restores warning visibility only, never media changes.',
            security: BEARER_AUTH,
            requestParams: { query: z.object({ historyAfter: z.uuid().optional() }) },
            responses: {
                '200': jsonResponse(
                    QuarantineSeriesGroupsResponseSchema,
                    'Groups and warning history',
                ),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Library administration access required', 403),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/library/quarantine-groups/resolve': {
        post: {
            tags: ['Admin'],
            summary: 'Review and resolve a bounded reconciliation warning group',
            description:
                'Requires library:admin. Automatic recheck retains its strict identity-binding proof. Current-match preview and one-click hiding affect only selected unchanged warnings, preserving media metadata and binding. Group hiding requires the current fingerprint. Show again restores only exact revisions from the original batch, with changed warnings refused; it does not undo media changes. Ordinary acceptance keeps its reviewed dependency confirmation.',
            security: BEARER_AUTH,
            requestBody: {
                required: true,
                content: { 'application/json': { schema: quarantineGroupResolveBodySchema } },
            },
            responses: {
                '200': jsonResponse(
                    QuarantineGroupResolveResponseSchema,
                    'Bounded review or resolution result',
                ),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Library administration access required', 403),
                '422': apiErrorResponse('Invalid group, continuation or reviewed selection', 422),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/media/{id}/images/candidates': {
        get: {
            tags: ['Admin'],
            summary: 'List image candidates and provenance',
            description:
                'Administrator only. Returns references without downloading images. Optionally filter by artwork role.',
            security: BEARER_AUTH,
            requestParams: {
                path: z.object({ id: z.string().guid() }),
                query: z.object({ role: CandidateRoleSchema.optional() }),
            },
            responses: {
                '200': jsonResponse(ImageCandidateResultSchema, 'Image candidates and provenance'),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '422': apiErrorResponse('Invalid artwork role', 422),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
        post: {
            tags: ['Admin'],
            summary: 'Curate image candidates',
            description:
                'Administrator only. Select an image, return to automatic selection, or hide a picture/source. Source hiding affects all image types unless a role is specified. References and files are retained; undoId restores the complete prior choice if unchanged. Legacy delete-provider preview/apply now archives rather than deletes. Curation is audit logged.',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ id: z.string().guid() }) },
            requestBody: {
                required: true,
                content: { 'application/json': { schema: CandidateMutationSchema } },
            },
            responses: {
                '200': jsonResponse(ImageCandidateResultSchema, 'Image curation result'),
                ...COMMON_ERRORS_WITH_404,
                '403': apiErrorResponse('Administrator access required', 403),
                '409': apiErrorResponse('Candidate selection changed; review again', 409),
                '422': apiErrorResponse('Invalid candidate mutation', 422),
                '503': apiErrorResponse('Database unavailable', 503),
            },
        },
    },
    '/api/admin/media/{id}/images/extract': {
        post: {
            tags: ['Admin'],
            summary: 'Extract and select a video frame',
            description:
                'Always extracts a new candidate and selects it as an admin choice, even when artwork already exists. The force field is retained for compatibility.',
            security: BEARER_AUTH,
            requestParams: { path: z.object({ id: z.string().guid() }) },
            requestBody: {
                required: true,
                content: { 'application/json': { schema: ExtractBodySchema } },
            },
            responses: {
                '200': jsonResponse(ExtractResponseSchema, 'Frame extraction result'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },
};
