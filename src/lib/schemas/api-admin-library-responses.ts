// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Library API Response Zod Schemas
 *
 * Schemas for library management endpoints:
 *   /api/admin/library-type-settings
 *   /api/admin/library-groups
 *   /api/admin/library-paths
 *   /api/admin/library-group-permissions
 *   /api/admin/available-groups
 *   /api/admin/library/file-stats
 *   /api/admin/provider-search
 *   /api/admin/auto-identify
 *   /api/admin/unmatched-files/[id]
 *   /api/admin/unmatched-files/[id]/match
 *   /api/admin/plugins/[pluginId]
 */

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import { PageBlockSchema } from './api-for-you-responses.js';
import { LIBRARY_PATH_PROVIDERS } from './common.js';

// ============================================================================
// Library Type Settings
// ============================================================================

export const LibraryTypeSettingRowSchema = z
    .object({
        media_type: z.string(),
        display_name: z.string().nullable(),
        sidebar_visible: z.boolean(),
        icon: z.string().nullable(),
        sort_order: z.number().int(),
    })
    .meta({ id: 'LibraryTypeSettingRow' });

export type LibraryTypeSettingRow = z.infer<typeof LibraryTypeSettingRowSchema>;

export const LibraryTypeSettingsResponseSchema = z
    .object({
        settings: z.array(LibraryTypeSettingRowSchema),
    })
    .meta({ id: 'LibraryTypeSettingsResponse' });

export type LibraryTypeSettingsResponse = z.infer<typeof LibraryTypeSettingsResponseSchema>;

export const LibraryTypeSettingUpdateResponseSchema = z
    .object({
        setting: LibraryTypeSettingRowSchema,
    })
    .meta({ id: 'LibraryTypeSettingUpdateResponse' });

export type LibraryTypeSettingUpdateResponse = z.infer<
    typeof LibraryTypeSettingUpdateResponseSchema
>;

// ============================================================================
// Library Groups
// ============================================================================

export const LibraryGroupDataSchema = z
    .object({
        images: ImageSetSchema.optional(),
        id: z.string(),
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        sortOrder: z.number().int(),
        maxAgeRating: z.number().int().nullable().optional(),
        metadataProviderChain: z.array(z.string()).optional(),
        fieldPriorityOverrides: z.record(z.string(), z.array(z.string())).optional(),
        /**
         * Item count for this library, from `getLibraryGroupsWithCounts`.
         * Optional: only the admin library-groups list endpoint populates it — every other caller of
         * `mapLibraryGroupToApi` omits it.
         */
        itemCount: z.number().int().nonnegative().optional(),
    })
    .meta({ id: 'LibraryGroupData' });

export type LibraryGroupData = z.infer<typeof LibraryGroupDataSchema>;

export const LibraryGroupsResponseSchema = z
    .object({
        items: z.array(LibraryGroupDataSchema),
        page: z.object({
            limit: z.number().int(),
            offset: z.number().int().optional(),
            hasMore: z.boolean(),
            total: z.number().int().optional(),
        }),
    })
    .meta({ id: 'LibraryGroupsResponse' });

export type LibraryGroupsResponse = z.infer<typeof LibraryGroupsResponseSchema>;

export const LibraryGroupMutationResponseSchema = z
    .object({
        group: LibraryGroupDataSchema,
    })
    .meta({ id: 'LibraryGroupMutationResponse' });

export type LibraryGroupMutationResponse = z.infer<typeof LibraryGroupMutationResponseSchema>;

// ============================================================================
// Library Paths
// ============================================================================

export const LibraryPathSchema = z
    .object({
        id: z.string(),
        path: z.string(),
        mediaType: z.enum([
            'movie',
            'tv',
            'anime',
            'music',
            'audiobook',
            'home_video',
            'training',
            'educational',
            'personal',
        ]),
        language: z.string(),
        provider: z.enum(LIBRARY_PATH_PROVIDERS),
        fallbackProviders: z.array(z.enum(['tmdb', 'anidb', 'jellyfin'])).default([]),
        enabled: z.boolean(),
        providerPath: z.string().nullable().optional(),
        libraryGroupId: z.string(),
        editionLabel: z.string().nullable().optional(),
        scanChapters: z.boolean().optional(),
        // mapLibraryPathToApi emits sourcePrefix (the ApiLibraryPath interface
        // includes it); declare it so the mapped row conforms.
        sourcePrefix: z.string().nullable().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
    })
    .meta({ id: 'LibraryPath' });

export type LibraryPath = z.infer<typeof LibraryPathSchema>;

export const LibraryPathPageSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

export const LibraryPathsResponseSchema = z
    .object({
        items: z.array(LibraryPathSchema),
        page: LibraryPathPageSchema,
    })
    .meta({ id: 'LibraryPathsResponse' });

export type LibraryPathsResponse = z.infer<typeof LibraryPathsResponseSchema>;

export const LibraryPathMutationResponseSchema = z
    .object({
        path: LibraryPathSchema,
    })
    .meta({ id: 'LibraryPathMutationResponse' });

export type LibraryPathMutationResponse = z.infer<typeof LibraryPathMutationResponseSchema>;

// Composite "create a library" response: the new group plus all its paths.
export const LibrarySetupResponseSchema = z
    .object({
        group: LibraryGroupDataSchema,
        paths: z.array(LibraryPathSchema),
    })
    .meta({ id: 'LibrarySetupResponse' });

export type LibrarySetupResponse = z.infer<typeof LibrarySetupResponseSchema>;

// Composite "update a library" response (PATCH /api/admin/libraries/[id]):
// the updated group plus every one of its folders, since a settings save can
// fan media_type/provider/fallback_providers out to all of them.
export const LibraryUpdateResponseSchema = z
    .object({
        group: LibraryGroupDataSchema,
        paths: z.array(LibraryPathSchema),
    })
    .meta({ id: 'LibraryUpdateResponse' });

export type LibraryUpdateResponse = z.infer<typeof LibraryUpdateResponseSchema>;

// ============================================================================
// Library folder browse (GET /api/admin/library/browse)
// ============================================================================

/** One subdirectory of the browsed path, or one allowed root. */
export const LibraryBrowseEntrySchema = z
    .object({
        name: z.string(),
        path: z.string().describe('Absolute path'),
        readable: z.boolean(),
        childCount: z
            .number()
            .int()
            .nullable()
            .describe('Subdirectory count, capped; null when it could not be read'),
        /** Set when this exact path is already a configured library folder. */
        libraryGroupId: z.string().optional(),
        libraryName: z.string().optional(),
    })
    .meta({ id: 'LibraryBrowseEntry' });

export type LibraryBrowseEntry = z.infer<typeof LibraryBrowseEntrySchema>;

export const LibraryBrowseResponseSchema = z
    .object({
        /** Echoes the resolved path being listed; null for the roots listing. */
        path: z.string().nullable(),
        entries: z.array(LibraryBrowseEntrySchema),
    })
    .meta({ id: 'LibraryBrowseResponse' });

export type LibraryBrowseResponse = z.infer<typeof LibraryBrowseResponseSchema>;

// ============================================================================
// Library Group Permissions
// ============================================================================

export const LibraryGroupPermissionSchema = z.object({
    libraryGroupId: z.string(),
    allowedGroups: z.array(z.string()),
});

export const LibraryGroupPermissionsResponseSchema = z
    .object({
        permissions: z.array(LibraryGroupPermissionSchema),
    })
    .meta({ id: 'LibraryGroupPermissionsResponse' });

export type LibraryGroupPermissionsResponse = z.infer<typeof LibraryGroupPermissionsResponseSchema>;

// ============================================================================
// Available Groups
// ============================================================================

// ============================================================================
// Social audience (resolved effect of the Sharing & Privacy settings)
// ============================================================================

/**
 * Counts only, never names. The panel exists to make a setting's blast radius
 * legible; a name list would be new disclosure without added clarity.
 */
export const SocialAudienceResponseSchema = z
    .object({
        /** Resolved mode — `'auto'` is already collapsed to what it means. */
        mode: z.enum(['household', 'groups']),
        /** Live users the audience currently contains. */
        audienceSize: z.number(),
        /** Of those, how many are actually sharing (switch on, not hidden). */
        sharingCount: z.number(),
        /** Of those, how many set `hide_streams`. */
        hiddenCount: z.number(),
        /** The configured group names, in the operator's own spelling. */
        configuredGroups: z.array(z.string()),
    })
    .meta({ id: 'SocialAudienceResponse' });

export type SocialAudienceResponse = z.infer<typeof SocialAudienceResponseSchema>;

export const AvailableGroupsResponseSchema = z
    .object({
        groups: z.array(z.string()),
    })
    .meta({ id: 'AvailableGroupsResponse' });

export type AvailableGroupsResponse = z.infer<typeof AvailableGroupsResponseSchema>;

// ============================================================================
// File Stats
// ============================================================================

export const FileStatsResponseSchema = z
    .object({
        totalFiles: z.number().int(),
        withMtime: z.number().int(),
        withHash: z.number().int(),
        probed: z.number().int(),
        withKeyframes: z.number().int(),
        totalSizeBytes: z.number(),
        avgDurationSeconds: z.number().nullable(),
    })
    .meta({ id: 'FileStatsResponse' });

export type FileStatsResponse = z.infer<typeof FileStatsResponseSchema>;

// ============================================================================
// Plugin (file-scanner)
// ============================================================================

export const PluginScanProgressSchema = z.object({
    processedItems: z.number().int().optional(),
    totalItems: z.number().int().optional(),
    currentItem: z.string().optional(),
    currentSubStatus: z.string().optional(),
    created: z.number().int().optional(),
    updated: z.number().int().optional(),
    skipped: z.number().int().optional(),
    /** Current scan phase: 'discovering' while the directory walk runs, 'scanning' once files are being processed. */
    phase: z.enum(['discovering', 'scanning']).optional().describe('Current scan phase'),
});

export type PluginScanProgress = z.infer<typeof PluginScanProgressSchema>;

/**
 * One library path's scan, as the admin library page shows it on that
 * library's row. The aggregate `progress` sums every concurrent scan and
 * names whichever reported last — with the hourly scan of every library
 * running, a manual "scan Series" read as "scanning Anime" there.
 */
export const LibraryScanStatusSchema = z.object({
    libraryPathId: z.string().describe('library_paths.id being scanned'),
    state: z
        .enum(['queued', 'running', 'cancelling'])
        .describe("'queued' = waiting for a scan slot; 'running' = walking/processing"),
    trigger: z
        .enum(['manual', 'scheduled', 'other'])
        .describe("'scheduled' = the periodic automatic scan, 'manual' = an admin started it"),
    processedItems: z.number().int().optional(),
    totalItems: z.number().int().optional(),
    phase: z.enum(['discovering', 'scanning']).optional(),
});

export type LibraryScanStatus = z.infer<typeof LibraryScanStatusSchema>;

export const PluginStatusResponseSchema = z
    .object({
        message: z.string().optional(),
        jobId: z.string().optional(),
        isRunning: z.boolean().optional(),
        progress: PluginScanProgressSchema.nullable().optional(),
        /** file-scanner only: every queued/running per-library scan. */
        libraries: z.array(LibraryScanStatusSchema).optional(),
        /** POST trigger only: true when every requested scan was already queued/running. */
        alreadyRunning: z.boolean().optional(),
    })
    .meta({ id: 'PluginStatusResponse' });

export type PluginStatusResponse = z.infer<typeof PluginStatusResponseSchema>;

// ============================================================================
// Auto-Identify
// ============================================================================

export const AutoIdentifyStartResponseSchema = z
    .object({
        started: z.boolean(),
        jobId: z.string().optional(),
    })
    .meta({ id: 'AutoIdentifyStartResponse' });

export type AutoIdentifyStartResponse = z.infer<typeof AutoIdentifyStartResponseSchema>;

// ============================================================================
// Dismiss / Match
// ============================================================================

export const DismissResponseSchema = z
    .object({
        dismissed: z.number().int().optional(),
    })
    .meta({ id: 'DismissResponse' });

export type DismissResponse = z.infer<typeof DismissResponseSchema>;

export const RestoreDismissedResponseSchema = z
    .object({
        restored: z.number().int(),
    })
    .meta({ id: 'RestoreDismissedResponse' });

export type RestoreDismissedResponse = z.infer<typeof RestoreDismissedResponseSchema>;

export const KeepPersonalMediaResponseSchema = z
    .object({ disposition: z.literal('kept') })
    .meta({ id: 'KeepPersonalMediaResponse' });

export const RestoreKeptPersonalMediaResponseSchema = z
    .object({ restored: z.literal(true) })
    .meta({ id: 'RestoreKeptPersonalMediaResponse' });

export const MatchResponseSchema = z
    .object({
        mediaItemId: z.string().optional(),
    })
    .meta({ id: 'MatchResponse' });

export type MatchResponse = z.infer<typeof MatchResponseSchema>;

// ============================================================================
// Bulk Metadata Update
// ============================================================================

export const BulkMetadataUpdateRequestSchema = z
    .object({
        ids: z.array(z.string().guid()).min(1).max(500).describe('UUIDs of media_items to update'),
        metadata: z
            .record(z.string(), z.unknown())
            .describe('Key-value pairs to merge into custom_metadata'),
    })
    .meta({ id: 'BulkMetadataUpdateRequest' });

export type BulkMetadataUpdateRequest = z.infer<typeof BulkMetadataUpdateRequestSchema>;

export const BulkMetadataUpdateResponseSchema = z
    .object({
        updatedCount: z.number(),
        skippedCount: z.number(),
    })
    .meta({ id: 'BulkMetadataUpdateResponse' });

export type BulkMetadataUpdateResponse = z.infer<typeof BulkMetadataUpdateResponseSchema>;

// ============================================================================
// Bulk Lock / Unlock
// ============================================================================

export const BulkLockResponseSchema = z
    .object({
        updatedCount: z.number(),
        skippedCount: z.number(),
        failedIds: z.array(z.string()),
    })
    .meta({ id: 'BulkLockResponse' });

export type BulkLockResponse = z.infer<typeof BulkLockResponseSchema>;

// ============================================================================
// Bulk Metadata Sync (enqueue)
// ============================================================================

export const BulkSyncEnqueueResponseSchema = z
    .object({
        started: z.literal(true),
        jobId: z.string(),
    })
    .meta({ id: 'BulkSyncEnqueueResponse' });

export type BulkSyncEnqueueResponse = z.infer<typeof BulkSyncEnqueueResponseSchema>;

// ============================================================================
// Library Metadata Values (autocomplete)
// ============================================================================

export const LibraryMetadataValuesResponseSchema = z
    .object({
        values: z.array(z.string()),
    })
    .meta({ id: 'LibraryMetadataValuesResponse' });

export type LibraryMetadataValuesResponse = z.infer<typeof LibraryMetadataValuesResponseSchema>;

// ============================================================================
// Quarantine (internal — delegated from /api/v1/libraries/quarantine)
// ============================================================================

export const QuarantineEntryV1Schema = z
    .object({
        id: z.string(),
        provider: z.string(),
        externalId: z.string(),
        mediaType: z.string(),
        parentTmdbId: z.string().nullable(),
        expectedSeriesId: z.string().nullable(),
        payload: z.record(z.string(), z.unknown()),
        reason: z.string(),
        source: z.string(),
        createdAt: z.string().datetime(),
        resolvedAt: z.string().datetime().nullable(),
        resolvedBy: z.string().nullable(),
        resolution: z.enum(['reattached', 'dismissed', 'recreated']).nullable(),
    })
    .meta({ id: 'QuarantineEntryV1', description: 'Quarantine entry' });

export const QuarantineCollectionResponseSchema = z
    .object({
        items: z.array(QuarantineEntryV1Schema),
        page: PageBlockSchema,
        counts: z.object({ unresolved: z.number().int() }),
    })
    .meta({ id: 'QuarantineCollectionResponse', description: 'Paginated quarantine entries' });

export type QuarantineCollectionResponse = z.infer<typeof QuarantineCollectionResponseSchema>;

// ============================================================================
// Quarantine — per-series bulk triage (/admin/library/quarantine)
// ============================================================================

export const QuarantineSeriesGroupSchema = z
    .object({
        seriesId: z
            .string()
            .nullable()
            .describe('Effective series UUID, or null when unresolvable'),
        parentTmdbId: z.string().nullable().describe('TMDB series id, used when seriesId is null'),
        seriesTitle: z
            .string()
            .nullable()
            .describe('media_items.title for seriesId, when it still exists'),
        fingerprint: z
            .string()
            .regex(/^[0-9a-f]{32}$/)
            .describe('Complete group warning revision for one-click hiding'),
        totalUnresolved: z
            .number()
            .int()
            .describe('Total unresolved quarantine rows in this group'),
        reasonCounts: z
            .record(z.string(), z.number().int())
            .describe('Unresolved row count per reason string'),
        oldestCreatedAt: z.string().datetime(),
        newestCreatedAt: z.string().datetime(),
    })
    .meta({
        id: 'QuarantineSeriesGroup',
        description: 'Unresolved quarantine rows grouped by series',
    });

export type QuarantineSeriesGroup = z.infer<typeof QuarantineSeriesGroupSchema>;

export const QuarantineDispositionHistorySchema = z.object({
    batchId: z.uuid().describe('Original warning disposition batch; never a media undo receipt'),
    kind: z.enum(['hidden', 'no-proposal', 'completed', 'superseded', 'gone']),
    actor: z.string(),
    createdAt: z.string().datetime(),
    count: z.number().int().nonnegative(),
    restorable: z.number().int().nonnegative(),
    seriesTitle: z.string().nullable(),
});
export type QuarantineDispositionHistory = z.infer<typeof QuarantineDispositionHistorySchema>;

export const QuarantineSeriesGroupsResponseSchema = z
    .object({
        groups: z.array(QuarantineSeriesGroupSchema),
        history: z.object({
            items: z.array(QuarantineDispositionHistorySchema),
            continuation: z.uuid().optional(),
        }),
    })
    .meta({
        id: 'QuarantineSeriesGroupsResponse',
        description: 'Per-series quarantine triage list',
    });

export type QuarantineSeriesGroupsResponse = z.infer<typeof QuarantineSeriesGroupsResponseSchema>;

/** Body for POST /api/admin/library/quarantine-groups/resolve. */
export const quarantineGroupResolveBodySchema = z
    .object({
        groupKey: z
            .string()
            .max(200)
            .optional()
            .describe('Exact group key for hiding, including unknown'),
        groupFingerprint: z
            .string()
            .regex(/^[0-9a-f]{32}$/)
            .optional()
            .describe('Revision shown in the group list'),
        batchId: z.uuid().optional().describe('Original warning batch to show again'),
        seriesId: z
            .string()
            .optional()
            .describe('Effective series UUID (mutually exclusive with parentTmdbId)'),
        parentTmdbId: z
            .string()
            .optional()
            .describe('TMDB series id fallback key, used when the group has no seriesId'),
        reviewedPage: z
            .object({
                ids: z.array(z.uuid()).max(1000),
                fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                continuation: z.uuid().optional(),
            })
            .strict()
            .optional()
            .describe('Exact seed UUIDs and immutable page bound shown before confirmation'),
        reviewed: z
            .array(
                z
                    .object({ id: z.uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
                    .strict(),
            )
            .max(1000)
            .optional()
            .describe(
                'Exact warning versions displayed in the reviewed dependency batch confirmation',
            ),
        after: z
            .uuid()
            .optional()
            .describe('Immutable warning id continuation; absent starts a new traversal'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe(
                'Bounded warning page size; Accept may expand complete reviewed dependencies up to 1000 warnings',
            ),
        action: z
            .enum([
                'dismiss',
                'restore',
                'accept',
                'preview-accept',
                'recheck',
                'preview-current-match',
                'confirm-current-match',
            ])
            .describe(
                'dismiss = dismiss group; accept = re-match a bounded batch; recheck = close identity-bound applied decisions; preview/confirm-current-match = selected positional metadata acknowledgement without media writes',
            ),
    })
    .strict();

export type QuarantineGroupResolveBody = z.infer<typeof quarantineGroupResolveBodySchema>;

export const QuarantineGroupResolveResponseSchema = z
    .object({
        action: z.enum([
            'dismiss',
            'restore',
            'accept',
            'preview-accept',
            'recheck',
            'preview-current-match',
            'confirm-current-match',
        ]),
        reviewedPage: z
            .object({
                ids: z.array(z.uuid()).max(1000),
                fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                continuation: z.uuid().optional(),
            })
            .strict()
            .optional(),
        batchId: z.uuid().optional(),
        restored: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Exact original warnings shown again by restore'),
        changed: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Changed warnings refused by Show again'),
        pageChanged: z.boolean().optional(),
        inspectableEpisodeIds: z
            .array(z.uuid())
            .max(3000)
            .optional()
            .describe(
                'Preview-only current navigable episode IDs; never inferred from historical keys',
            ),
        review: z
            .array(
                z.object({
                    id: z.uuid(),
                    fingerprint: z.string(),
                    episodeId: z.uuid(),
                    currentTitle: z.string().nullable(),
                    currentTmdbEpisodeId: z.string().nullable(),
                    overview: z.string().nullable(),
                    stillPath: z.string().nullable(),
                    title: z.string(),
                    tmdbEpisodeId: z.string(),
                    seasonNumber: z.number().int().nonnegative(),
                    episodeNumber: z.number().int().nonnegative(),
                }),
            )
            .optional()
            .describe('preview-accept only: complete dependency batch to review before accepting'),
        currentMatchReview: z
            .array(
                z.object({
                    id: z.uuid(),
                    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                    episodeId: z.string(),
                    proposedTitle: z.string().nullable(),
                    proposedTmdbEpisodeId: z.string().nullable(),
                    proposedSeasonNumber: z.number().int().nonnegative().nullable(),
                    proposedEpisodeNumber: z.number().int().nonnegative().nullable(),
                    currentTitle: z.string().nullable(),
                    currentTmdbEpisodeId: z.string().nullable(),
                    currentSeasonNumber: z.number().int().nonnegative().nullable(),
                    currentEpisodeNumber: z.number().int().nonnegative().nullable(),
                    currentSeriesId: z.uuid().nullable(),
                    titleBinding: z.string().nullable(),
                    eligible: z.boolean(),
                    retainedReason: z.string().optional(),
                }),
            )
            .optional()
            .describe(
                'Current/proposed values and reasons for an exact, read-only current-match review',
            ),
        blockedReview: z
            .array(
                z.object({
                    episodeId: z.string(),
                    title: z.string(),
                    target: z.string(),
                    reason: z.string(),
                    blockingEpisodeId: z
                        .uuid()
                        .optional()
                        .describe('Existing blocking holder to inspect when known'),
                }),
            )
            .optional()
            .describe(
                'Retained warning proposals in this page, including oversized dependencies; continue to inspect later warnings',
            ),
        blocked: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
                'Examined warning decisions retained: changed, missing dependencies or components larger than 1000 warnings',
            ),
        resolved: z
            .number()
            .int()
            .nonnegative()
            .describe('Rows marked resolved by this call; zero for restore'),
        examined: z.number().int().nonnegative().optional().describe('Warnings examined this call'),
        retained: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Examined warnings retained for review'),
        retainedReasons: z.record(z.string(), z.number().int().nonnegative()).optional(),
        retainedReview: z
            .array(
                z.object({
                    warningId: z.uuid(),
                    episodeId: z.string(),
                    reason: z.string(),
                }),
            )
            .max(1000)
            .optional(),
        continuation: z
            .uuid()
            .optional()
            .describe('Pass as after to continue; absence ends this traversal'),
        appliedExternalIds: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('accept only: external ids written'),
        updatedTitles: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('accept only: episode titles updated'),
        skipped: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
                'accept only: eligible reviewed warnings not applied; excludes blocked warnings',
            ),
    })
    .superRefine((value, ctx) => {
        const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
        if (value.action === 'accept' || value.action === 'preview-accept') {
            const { examined, blocked, skipped, appliedExternalIds, updatedTitles } = value;
            if (
                examined === undefined ||
                blocked === undefined ||
                skipped === undefined ||
                appliedExternalIds === undefined ||
                updatedTitles === undefined
            ) {
                issue('Accept and preview require complete batch totals');
                return;
            }
            if (value.pageChanged) {
                if (
                    [
                        examined,
                        blocked,
                        skipped,
                        appliedExternalIds,
                        updatedTitles,
                        value.resolved,
                    ].some((n) => n !== 0) ||
                    value.continuation !== undefined ||
                    value.reviewedPage !== undefined ||
                    (value.review?.length ?? 0) !== 0 ||
                    (value.blockedReview?.length ?? 0) !== 0
                )
                    issue(
                        'Changed pages require zero totals and no continuation or review authority',
                    );
                return;
            }
            if (value.action === 'accept') {
                if (
                    value.resolved + skipped + blocked !== examined ||
                    appliedExternalIds !== value.resolved ||
                    updatedTitles !== appliedExternalIds
                )
                    issue('Accept requires disjoint batch totals and consistent actual writes');
            } else {
                if (
                    !value.review ||
                    !value.reviewedPage ||
                    !value.blockedReview ||
                    value.review.length + blocked !== examined ||
                    value.blockedReview.length !== blocked ||
                    value.resolved !== 0 ||
                    skipped !== 0 ||
                    appliedExternalIds !== 0 ||
                    updatedTitles !== 0 ||
                    value.reviewedPage.continuation !== value.continuation
                )
                    issue(
                        'Preview requires a complete reviewed page, decisions and coherent zero-write totals',
                    );
            }
        }
        if (
            value.action === 'recheck' &&
            (value.examined === undefined ||
                value.retained === undefined ||
                value.examined < 0 ||
                value.resolved < 0 ||
                value.retained < 0 ||
                value.resolved + value.retained !== value.examined)
        ) {
            ctx.addIssue({
                code: 'custom',
                message: 'Recheck requires complete and consistent batch totals',
            });
        }
        if (
            value.action === 'restore' &&
            (value.resolved !== 0 || value.restored === undefined || value.changed === undefined)
        )
            issue('Restore requires explicit restored/changed totals and zero new resolutions');
        if (value.action === 'preview-current-match' || value.action === 'confirm-current-match') {
            if (
                value.examined === undefined ||
                value.retained === undefined ||
                value.resolved + value.retained !== value.examined
            )
                issue('Current-match totals must be consistent');
            if (
                value.pageChanged &&
                (value.examined !== 0 ||
                    value.resolved !== 0 ||
                    value.retained !== 0 ||
                    value.continuation !== undefined ||
                    value.reviewedPage !== undefined ||
                    value.currentMatchReview !== undefined)
            )
                issue('A stale current-match review cannot return authority or advance traversal');
            if (
                value.action === 'preview-current-match' &&
                !value.pageChanged &&
                (!value.reviewedPage ||
                    !value.currentMatchReview ||
                    value.currentMatchReview.length !== value.examined ||
                    value.resolved !== 0 ||
                    value.retained !== value.examined)
            )
                issue('Current-match preview requires a complete read-only page');
        }
    })
    .meta({ id: 'QuarantineGroupResolveResponse', description: 'Bulk quarantine resolve result' });

export type QuarantineGroupResolveResponse = z.infer<typeof QuarantineGroupResolveResponseSchema>;

// ============================================================================
// Reconciliation moves — undo records (/admin/library/quarantine)
// ============================================================================

export const ReconciliationMoveSchema = z
    .object({
        id: z.string().describe('Move id (the undo target)'),
        seriesId: z.string(),
        seriesTitle: z.string().optional().describe('Series title, when the series still exists'),
        episodeId: z
            .string()
            .optional()
            .describe(
                'Episode id; absent once the episode was deleted (the move cannot be undone)',
            ),
        episodeTitle: z
            .string()
            .optional()
            .describe('Current episode title, when the episode still exists'),
        service: z.enum(['absolute-numbering', 'season-structure', 'filename-title']),
        evidence: z
            .string()
            .optional()
            .describe(
                'What backed the match (number-match, filename-absolute, filename-absolute-corroborated, episode-group)',
            ),
        tmdbEpisodeId: z.string().describe('TMDB episode id the move bound'),
        fromSeason: z.number().int(),
        fromEpisode: z.number().int(),
        toSeason: z.number().int(),
        toEpisode: z.number().int(),
        appliedAt: z.string().datetime(),
        undoneAt: z.string().datetime().optional(),
        undoneBy: z.string().optional(),
    })
    .meta({
        id: 'ReconciliationMove',
        description: 'An episode the reconciliation services bound or moved, with its undo state',
    });

export type ReconciliationMove = z.infer<typeof ReconciliationMoveSchema>;

export const ReconciliationMovesResponseSchema = z
    .object({
        moves: z.array(ReconciliationMoveSchema),
    })
    .meta({
        id: 'ReconciliationMovesResponse',
        description: 'Recent reconciliation moves, newest first',
    });

export type ReconciliationMovesResponse = z.infer<typeof ReconciliationMovesResponseSchema>;

export const ReconciliationMoveUndoResponseSchema = z
    .object({
        moveId: z.string(),
        episodeId: z.string(),
        seasonNumber: z.number().int().describe('Season the episode was restored to'),
        episodeNumber: z.number().int().describe('Episode number the episode was restored to'),
    })
    .meta({
        id: 'ReconciliationMoveUndoResponse',
        description: 'Where the episode sits after the undo',
    });

export type ReconciliationMoveUndoResponse = z.infer<typeof ReconciliationMoveUndoResponseSchema>;

// ----------------------------------------------------------------------------
// Reconciliation proposals — per-row apply / dismiss (/admin/library/quarantine)
// ----------------------------------------------------------------------------

export const ReconciliationProposalSchema = z
    .object({
        id: z.string().describe('Quarantine row id (the apply / dismiss target)'),
        seriesId: z.string().optional(),
        seriesTitle: z.string().optional().describe('Series title, when the series still exists'),
        episodeId: z.string(),
        fromSeason: z.number().int(),
        fromEpisode: z.number().int(),
        toSeason: z.number().int(),
        toEpisode: z.number().int(),
        currentTitle: z.string().optional().describe('Title the file-backed episode has now'),
        proposedTitle: z.string().optional().describe('TMDB title of the target episode'),
        evidence: z
            .string()
            .optional()
            .describe(
                'What backs the match (number-match, filename-absolute, filename-absolute-corroborated, filename-absolute-untitled)',
            ),
        createdAt: z.string().datetime(),
    })
    .meta({
        id: 'ReconciliationProposal',
        description: 'An absolute-numbering match waiting for an admin to apply or dismiss it',
    });

export type ReconciliationProposal = z.infer<typeof ReconciliationProposalSchema>;

export const ReconciliationProposalsResponseSchema = z
    .object({
        proposals: z.array(ReconciliationProposalSchema),
    })
    .meta({
        id: 'ReconciliationProposalsResponse',
        description: 'Open absolute-numbering proposals',
    });

export type ReconciliationProposalsResponse = z.infer<typeof ReconciliationProposalsResponseSchema>;

export const ReconciliationProposalApplyResponseSchema = z
    .object({
        quarantineId: z.string(),
        moveId: z.string().describe('The undo record of the applied move'),
        episodeId: z.string(),
        seasonNumber: z.number().int().describe('Season the episode sits in now'),
        episodeNumber: z.number().int().describe('Episode number the episode has now'),
    })
    .meta({
        id: 'ReconciliationProposalApplyResponse',
        description: 'Where the episode sits after the proposal was applied',
    });

export type ReconciliationProposalApplyResponse = z.infer<
    typeof ReconciliationProposalApplyResponseSchema
>;

export const ReconciliationProposalDismissResponseSchema = z
    .object({
        quarantineId: z.string(),
    })
    .meta({
        id: 'ReconciliationProposalDismissResponse',
        description: 'The proposal that was dismissed',
    });

export type ReconciliationProposalDismissResponse = z.infer<
    typeof ReconciliationProposalDismissResponseSchema
>;

// ============================================================================
// Unmatched Files (internal — delegated from /api/v1/libraries/unmatched-files)
// ============================================================================

const UnmatchedLibraryGroupSchema = z
    .object({ id: z.string(), name: z.string() })
    .meta({ id: 'UnmatchedLibraryGroup', description: 'Library group summary' });

export const UnmatchedFileItemSchema = z
    .object({
        id: z.string(),
        title: z.string(),
        media_type: z.string(),
        release_year: z.number().int().nullable(),
        overview: z.string().nullable(),
        custom_poster_url: z.string().nullable(),
        custom_backdrop_url: z.string().nullable(),
        custom_logo_url: z.string().nullable(),
        custom_thumb_url: z.string().nullable(),
        metadata_locked: z.boolean(),
        metadata_locked_by: z.string().nullable(),
        metadata_locked_at: z.string().datetime().nullable(),
        created_at: z.string().datetime(),
        episode_count: z.number().int().optional(),
        season_count: z.number().int().optional(),
    })
    .meta({ id: 'UnmatchedFileItem', description: 'Unmatched personal media item' });

export const UnmatchedFilesCollectionResponseSchema = z
    .object({
        items: z.array(UnmatchedFileItemSchema),
        page: PageBlockSchema,
        libraryGroups: z.array(UnmatchedLibraryGroupSchema),
    })
    .meta({
        id: 'UnmatchedFilesCollectionResponse',
        description: 'Paginated unmatched personal media',
    });

export type UnmatchedFilesCollectionResponse = z.infer<
    typeof UnmatchedFilesCollectionResponseSchema
>;

// ============================================================================
// Integrity Violations (internal — delegated from /api/v1/libraries/integrity)
// ============================================================================

export const IntegrityViolationV1Schema = z
    .object({
        id: z.string(),
        rule: z.string(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        mediaId: z.string().nullable(),
        details: z.record(z.string(), z.unknown()),
        detectedAt: z.string().datetime(),
        resolvedAt: z.string().datetime().nullable(),
        resolution: z.string().nullable(),
    })
    .meta({ id: 'IntegrityViolationV1', description: 'Integrity violation entry' });

export const IntegrityViolationCountSchema = z
    .object({
        rule: z.string(),
        count: z.number().int(),
    })
    .meta({ id: 'IntegrityViolationCount', description: 'Violation count by rule' });

export const IntegrityViolationsResponseSchema = z
    .object({
        violations: z.array(IntegrityViolationV1Schema),
        counts: z.array(IntegrityViolationCountSchema),
    })
    .meta({
        id: 'IntegrityViolationsResponse',
        description: 'Integrity violations list with per-rule counts',
    });

export type IntegrityViolationsResponse = z.infer<typeof IntegrityViolationsResponseSchema>;

// ============================================================================
// Coverage Backlog (internal — delegated from /api/v1/libraries/coverage/backlog)
// ============================================================================

export const CoverageBacklogStageSchema = z
    .object({
        stage_id: z.string(),
        backlog: z.number().int(),
    })
    .meta({ id: 'CoverageBacklogStage', description: 'Stage backlog count' });

export const CoverageBacklogResponseSchema = z
    .object({
        stages: z.array(CoverageBacklogStageSchema),
    })
    .meta({ id: 'CoverageBacklogResponse', description: 'Coverage sweep backlog per stage' });

export type CoverageBacklogResponse = z.infer<typeof CoverageBacklogResponseSchema>;
