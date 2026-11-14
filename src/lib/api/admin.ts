// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    ExternalIdsGetResponseSchema,
    ExternalIdMutateResponseSchema,
    ExternalIdDeleteResponseSchema,
} from '$lib/schemas/api-media-responses.js';
import { EpisodeTmdbExchangePreviewSchema } from '$lib/schemas/episode-tmdb-exchange.js';
import { UserTokenListResponseSchema } from '$lib/schemas/api-user-responses';
/**
 * Example names are fictional; production shapes and measurements are retained.
 * Admin API domain module
 *
 * Typed functions for admin status, sync, cache, tasks, devices,
 * tokens, plugins, debug, playback quality, transcoding, and system metrics.
 */

import { StuckItemReasonSchema } from '$lib/schemas/ingest-map.js';
import { z } from 'zod';
import type { UseCaseId } from '$lib/config/use-case-ids.js';
import { AdminUserEmailResponseSchema } from '$lib/schemas/admin-user.js';
import { SharedEpisodeThumbReviewSchema } from '$lib/schemas/admin-image-extraction.js';
import {
    FileHealthResponseSchema,
    type FileHealthResponse,
    type FileHealthRow,
    type FileHealthScope,
} from '$lib/schemas/admin-file-health.js';
import { apiGet, apiPost, apiPut, apiDelete, apiPatch, apiUpload } from './client.js';
import {
    UploadInitResponseSchema,
    UploadFinalizeResponseSchema,
    UploadAbortResponseSchema,
    UploadAncillaryResponseSchema,
} from '$lib/schemas/api-upload-responses.js';
import { DeviceCommandSchema } from '$lib/schemas/device-commands.js';
import { AdminStatusPayloadSchema } from '$lib/schemas/api-admin-status-payload.js';
import { LibraryStorageGrowthSchema } from '$lib/schemas/admin-library-storage-growth.js';
import {
    CollaborationResponseSchema,
    type CollaborationRequest,
} from '$lib/schemas/collaboration-review.js';
import { BrowserChildrenResponseSchema } from '$lib/schemas/api-admin-browser-children.js';
import {
    ConfigHealthResponseSchema,
    CacheWarmingResponseSchema,
    PatListResponseSchema,
    PatCreateResponseSchema,
    ServiceTokenListResponseSchema,
    ServiceTokenCreateResponseSchema,
    DeviceListResponseSchema,
    AdminDeviceDeleteAllResponseSchema,
    AdminConnectionSuccessSchema,
    AdminJellyfinPasswordStatusSchema,
    AdminJellyfinPasswordSchema,
    AdminSubsonicTokenStatusSchema,
    AdminSubsonicTokenSchema,
    QuickConnectResponseSchema,
    PrivacySettingsResponseSchema,
    PrivacySettingsUpdateResponseSchema,
    PlaybackQualityResponseSchema,
    PlaybackQualityClearResponseSchema,
    UserPlaybackQualityResponseSchema,
    DevicePlaybackQualityResponseSchema,
    LockMetricsResponseSchema,
    JellyseerrDebugResponseSchema,
    SonarrLookupResponseSchema,
    RadarrLookupResponseSchema,
    OAuthResponseSchema,
    PluginSettingsResponseSchema,
    PluginSettingsUpdateResponseSchema,
    PluginReloadResponseSchema,
    HolidaysListResponseSchema,
    HolidayMutationResponseSchema,
    HolidayDeleteResponseSchema,
    HolidayReorderResponseSchema,
    AdminRadioListResponseSchema,
    AdminRadioCreateResponseSchema,
    AdminRadioPatchResponseSchema,
    AdminRadioDeleteResponseSchema,
    FFmpegJobsResponseSchema,
    SystemMetricsSchema,
    StreamThroughputSchema,
    CacheStatsResponseSchema,
    LocalUsersListResponseSchema,
    UserIdentitiesResponseSchema,
    SetJellyfinMappingResponseSchema,
    UnlinkIdentityResponseSchema,
    SetIsAdminResponseSchema,
    SetAgeRatingResponseSchema,
    SetAllowLiveTvResponseSchema,
    type SetAllowLiveTvResponse,
    CreateLocalUserResponseSchema,
    SetUserPasswordResponseSchema,
    SetUserDisabledResponseSchema,
    DeleteLocalUserResponseSchema,
    ProvidersResponseSchema,
    ProviderHealthResponseSchema,
    MetadataChainReorderResponseSchema,
    AdminPlaySessionsResponseSchema,
    AdminPlaybackPlanResponseSchema,
    AdminRefreshUserWatchStateResponseSchema,
    AdminNavPinActionResponseSchema,
    SegmentsResponseSchema,
    SegmentsGenerateResponseSchema,
    SegmentsSetResponseSchema,
    SegmentsDeleteResponseSchema,
    TrickplayGenerateResponseSchema,
    ProbeRawResponseSchema,
    AdminChaptersResponseSchema,
    AdminEpisodesResponseSchema,
    AlbumsResponseSchema,
    TracksResponseSchema,
    HealthResponseSchema,
    HierarchyResponseSchema,
    MediaPreviewResponseSchema,
    RescanResponseSchema,
    SystemHealthResponseSchema,
    ClusterStatusResponseSchema,
    MaintenanceNoticeResponseSchema,
    IntegrityViolationsResponseSchema,
    IntegrityResolveResponseSchema,
    QuarantineResponseSchema,
    QuarantineInspectionResponseSchema,
    QuarantineResolveResponseSchema,
    ReconciliationPreviewResponseSchema,
    ReconciliationApplyResponseSchema,
    OnboardingStateResponseSchema,
    AdminUiPrefsResponseSchema,
    PreviewStatusResponseSchema,
    ScannerRunsResponseSchema,
    SubtitleSearchResponseSchema,
    SubtitleInstallResponseSchema,
} from '$lib/schemas/api-admin-responses.js';
import { SuccessTrueResponseSchema, NoContentSchema } from '$lib/schemas/common.js';
import {
    FileEpisodesResponseSchema,
    type SetFileEpisodesRequest,
} from '$lib/schemas/admin-file-episodes.js';
import { FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline.js';
import {
    AdminBroadcastSchema,
    AdminBroadcastListResponseSchema,
    SendBroadcastResponseSchema,
    type SendBroadcastRequest,
    type SetBroadcastPinRequest,
} from '$lib/schemas/admin-broadcasts.js';
import {
    ExternalPluginInstallResultSchema,
    ExternalPluginPreviewSchema,
    ExternalPluginEnableResultSchema,
    ExternalPluginDisableResultSchema,
    ExternalPluginReloadResultSchema,
    ExternalPluginUninstallResultSchema,
} from '$lib/schemas/api-external-plugins.js';
import type { HolidayCreateBody, HolidayUpdateBody } from '$lib/schemas/holidays.js';
import {
    ImageUploadResponseSchema,
    ImageDeleteResponseSchema,
    ImageBrowseResponseSchema,
    MediaImagesResponseSchema,
    MetadataUpdateResponseSchema,
    MetadataStatusResponseSchema,
} from '$lib/schemas/media-image-upload.js';
import { SyncEnqueuedResponseSchema } from '$lib/schemas/metadata-sync.js';
import { StreamPolicySchema, type UpdatePolicyRequest } from '$lib/schemas/play-sessions.js';
import type { MetadataPatch } from '$lib/schemas/api-admin-unmatched-responses.js';
import {
    ListPersonalMediaResponseSchema,
    PersonalSeriesChildrenResponseSchema,
} from '$lib/schemas/api-admin-unmatched-responses.js';
import { CompatibilityResponseSchema } from '$lib/schemas/admin-types.js';
import { PersonDetailResponseSchema } from '$lib/schemas/api-person-responses.js';
import { ReconciliationBackfillResponseSchema } from '$lib/schemas/admin-reconciliation-backfill.js';
import { RadioStreamInfoSchema } from '$lib/schemas/radio.js';
import {
    FileHealthReviewResponseSchema,
    type FileHealthReviewRequest,
} from '$lib/schemas/file-health-review.js';
import type { ReconciliationBackfillRequest } from '$lib/schemas/admin-reconciliation-backfill.js';
import {
    LibraryTypeSettingsResponseSchema,
    LibraryTypeSettingUpdateResponseSchema,
    LibraryGroupsResponseSchema,
    LibraryGroupMutationResponseSchema,
    LibraryPathsResponseSchema,
    LibraryPathMutationResponseSchema,
    LibrarySetupResponseSchema,
    LibraryUpdateResponseSchema,
    LibraryBrowseResponseSchema,
    LibraryGroupPermissionsResponseSchema,
    AvailableGroupsResponseSchema,
    SocialAudienceResponseSchema,
    FileStatsResponseSchema,
    PluginStatusResponseSchema,
    AutoIdentifyStartResponseSchema,
    DismissResponseSchema,
    RestoreDismissedResponseSchema,
    KeepPersonalMediaResponseSchema,
    RestoreKeptPersonalMediaResponseSchema,
    MatchResponseSchema,
    BulkMetadataUpdateResponseSchema,
    BulkLockResponseSchema,
    BulkSyncEnqueueResponseSchema,
    LibraryMetadataValuesResponseSchema,
    QuarantineSeriesGroupsResponseSchema,
    QuarantineGroupResolveResponseSchema,
    ReconciliationMovesResponseSchema,
    ReconciliationMoveUndoResponseSchema,
    ReconciliationProposalsResponseSchema,
    ReconciliationProposalApplyResponseSchema,
    ReconciliationProposalDismissResponseSchema,
} from '$lib/schemas/api-admin-library-responses.js';
import type { QuarantineGroupResolveBody } from '$lib/schemas/api-admin-library-responses.js';
import { ProviderSearchResponseSchema } from '$lib/schemas/api-admin-unmatched-responses.js';
import type {
    LibraryGroupCreateBody,
    LibraryGroupPatchBody,
    LibrarySetupInput,
    LibraryPathCreateBody,
    LibraryPathPatchBody,
    LibraryUpdateBody,
    PluginTriggerBody,
    ServiceTokenMethod,
    ServiceTokenScope,
} from '$lib/schemas/admin.js';
import {
    AddNavGroupResponseSchema,
    HomepageResetWidgetsResponseSchema,
    InstanceProfileResponseSchema,
} from '$lib/schemas/api-admin-navigation.js';
import {
    AdminAuditFeedResponseSchema,
    AdminAuditActorsResponseSchema,
} from '$lib/schemas/admin-audit.schema.js';
import {
    AttentionAckResponseSchema,
    AttentionSnoozeResponseSchema,
    StageActionResponseSchema,
} from '$lib/schemas/api-attention-responses.js';
import {
    AuditFeedResponseSchema,
    CircuitFleetResponseSchema,
    FailurePatternsResponseSchema,
    SystemicResponseSchema,
    TrendsResponseSchema,
} from '$lib/schemas/task-system-failure-detection.schema.js';
import {
    ObservabilityResponseSchema,
    MetricsBridgeResponseSchema,
} from '$lib/schemas/task-system-observability.schema.js';
import { NowSnapshotSchema } from '$lib/schemas/mission-control.schema.js';
import { CancelResponseSchema } from '$lib/schemas/run.schema.js';
import type { ApiRequestOptions, ApiResult } from './types.js';

// =========================================================================
// Status & Config
// =========================================================================

/**
 * GET /api/admin/status
 *
 * THE canonical admin status payload (admin IA redesign, spec §5): verdict +
 * attention items + nested system block + extras + counters + nav section
 * status. Replaces the former getAdminStatus / getAdminStatusExtras /
 * getAttention trio — one GET, one source of truth.
 */
export function getAdminStatusPayload(options?: ApiRequestOptions) {
    return apiGet('/api/admin/status', AdminStatusPayloadSchema, options);
}

/** Library size over time + disk-full estimate (admin home sparkline). */
export function getLibraryStorageGrowth(options?: ApiRequestOptions) {
    return apiGet('/api/admin/library/storage-growth', LibraryStorageGrowthSchema, options);
}

/**
 * GET /api/admin/ui-prefs — this admin user's UI preferences (nav style).
 * Admin IA redesign (spec §4). Per-user, live-switchable.
 */
export function getAdminUiPrefs(options?: ApiRequestOptions) {
    return apiGet('/api/admin/ui-prefs', AdminUiPrefsResponseSchema, options);
}

/** PATCH /api/admin/ui-prefs — persist this admin user's nav style. */
export function setAdminNavStyle(navStyle: 'sidebar' | 'mega') {
    return apiPatch('/api/admin/ui-prefs', AdminUiPrefsResponseSchema, { navStyle });
}

/** Config doctor report (same checks as `npm run doctor` / boot STEP 0). */
export function getConfigHealth() {
    return apiGet('/api/health/config', ConfigHealthResponseSchema);
}

// =========================================================================
// Sync
// =========================================================================

export function getCacheWarming() {
    return apiGet('/api/admin/cache-warming', CacheWarmingResponseSchema);
}

export function startCacheWarming(body?: { type?: 'full' | 'frequent' | 'regular' }) {
    return apiPost('/api/admin/cache-warming', CacheWarmingResponseSchema, body);
}

// =========================================================================
// Cache
// =========================================================================

export function getCacheStats() {
    return apiGet('/api/cache-stats', CacheStatsResponseSchema);
}

// =========================================================================
// PATs (Admin)
// =========================================================================

export function getAdminPats() {
    return apiGet('/api/admin/pats', PatListResponseSchema);
}

export function createAdminPat(body: {
    userId: string;
    name: string;
    description?: string;
    scopes?: ('read' | 'write' | 'admin' | 'jellyfin_compat' | 'jellyfin_compat_read')[];
    expiresInDays?: number | null;
}) {
    return apiPost('/api/admin/pats', PatCreateResponseSchema, body);
}

export function deleteAdminPat(id: string) {
    return apiDelete(`/api/admin/pats/${encodeURIComponent(id)}`, z.null());
}

// =========================================================================
// Service Tokens (Admin)
// =========================================================================

export function getServiceTokens() {
    return apiGet('/api/admin/service-tokens', ServiceTokenListResponseSchema);
}

export function createServiceToken(body: {
    name: string;
    description?: string;
    actAsUserId?: string;
    scopes: ServiceTokenScope[];
    allowedIps?: string[];
    allowedPathPrefixes?: string[];
    allowedMethods?: ServiceTokenMethod[];
    forceNonAdmin?: boolean;
    expiresInDays?: number | null;
}) {
    return apiPost('/api/admin/service-tokens', ServiceTokenCreateResponseSchema, body);
}

export function deleteServiceToken(id: string) {
    return apiDelete(`/api/admin/service-tokens/${encodeURIComponent(id)}`, z.null());
}

// =========================================================================
// Admin Devices
// =========================================================================

export function getAdminDevices(userId: string) {
    return apiGet('/api/admin/devices', DeviceListResponseSchema, {
        params: { userId },
    });
}

export function deleteAdminDevice(userId: string, id: string) {
    return apiDelete(
        `/api/admin/devices/${encodeURIComponent(userId)}/${encodeURIComponent(id)}`,
        z.null(),
    );
}
export function deleteAllAdminDevices(userId: string) {
    return apiPost(
        `/api/admin/devices/${encodeURIComponent(userId)}/revoke-all`,
        AdminDeviceDeleteAllResponseSchema,
    );
}

// ---- Per-user connections: Jellyfin /j password  ----

function jellyfinPasswordPath(username: string): string {
    return `/api/jellyfin-connect/admin/${encodeURIComponent(username)}/password`;
}

export function getAdminJellyfinPasswordStatus(username: string) {
    return apiGet(jellyfinPasswordPath(username), AdminJellyfinPasswordStatusSchema);
}

export function resetAdminJellyfinPassword(username: string) {
    return apiPost(jellyfinPasswordPath(username), AdminJellyfinPasswordSchema);
}

export function deleteAdminJellyfinPassword(username: string) {
    return apiDelete(jellyfinPasswordPath(username), AdminConnectionSuccessSchema);
}

// ---- Per-user connections: Subsonic token ----

function subsonicTokenPath(username: string): string {
    return `/api/admin/users/${encodeURIComponent(username)}/subsonic-password`;
}

export function getAdminSubsonicTokenStatus(username: string) {
    return apiGet(subsonicTokenPath(username), AdminSubsonicTokenStatusSchema);
}

export function resetAdminSubsonicToken(username: string) {
    return apiPost(subsonicTokenPath(username), AdminSubsonicTokenSchema);
}

export function deleteAdminSubsonicToken(username: string) {
    return apiDelete(subsonicTokenPath(username), AdminConnectionSuccessSchema);
}

// ---- Per-user connections: Personal Access Tokens (view + revoke only) ----

export function getAdminUserTokens(userId: string) {
    return apiGet(`/api/users/${encodeURIComponent(userId)}/pats`, UserTokenListResponseSchema);
}
export function deleteAdminUserToken(userId: string, id: number) {
    return apiDelete(`/api/users/${encodeURIComponent(userId)}/pats/${id}`, z.null());
}

// =========================================================================
// Quick Connect (Admin)
// =========================================================================

export function authorizeQuickConnect(body: { code: string; username: string }) {
    return apiPost('/api/admin/quick-connect', QuickConnectResponseSchema, body);
}

// =========================================================================
// Privacy Settings
// =========================================================================

export function getPrivacySettings() {
    return apiGet('/api/admin/privacy-settings', PrivacySettingsResponseSchema);
}

export function updatePrivacySettings(body: { username: string; hideFromOthers: boolean }) {
    return apiPost('/api/admin/privacy-settings', PrivacySettingsUpdateResponseSchema, body);
}

// =========================================================================
// Playback Quality
// =========================================================================

export function getPlaybackQuality(days?: number) {
    return apiGet('/api/admin/playback-quality', PlaybackQualityResponseSchema, {
        params: { days },
    });
}

export function clearPlaybackQuality() {
    return apiDelete('/api/admin/playback-quality', PlaybackQualityClearResponseSchema);
}

export function getUserPlaybackQuality(userId: string, days?: number) {
    return apiGet(
        `/api/admin/playback-quality/user/${encodeURIComponent(userId)}`,
        UserPlaybackQualityResponseSchema,
        { params: { days } },
    );
}

export function getDevicePlaybackQuality(deviceId: string, days?: number) {
    return apiGet(
        // Device ids are opaque client strings and may contain / ? # %.
        `/api/admin/playback-quality/device/${encodeURIComponent(deviceId)}`,
        DevicePlaybackQualityResponseSchema,
        {
            params: { days },
        },
    );
}

export function getLockMetrics() {
    return apiGet('/api/admin/lock-metrics', LockMetricsResponseSchema);
}

// =========================================================================
// Transcode Capabilities (GPU decode-capability cache)
// =========================================================================

const LearnedDecodeEntrySchema = z.object({
    codec: z.string(),
    bitDepth: z.number().optional(),
    learnedAt: z.string(),
    sample: z.string().optional(),
    /** Which sources the lesson diverts, worded server-side from the real key. */
    scope: z.string().optional(),
    /** Why the lesson was recorded. */
    reason: z.string().optional(),
    /** When the lesson stops being enforced (30-day TTL from learnedAt). */
    expiresAt: z.string().optional(),
});

const StaticSoftwareDecodeEntrySchema = z.object({
    codec: z.string(),
    bitDepths: z.string(),
    reason: z.string(),
});

const TranscodeCapabilitiesSchema = z.object({
    gpuAcceleration: z.string().optional(),
    hdrTonemap: z.string().optional(),
    hardwareDecodableCodecs: z.array(z.string()).optional(),
    learned: z.array(LearnedDecodeEntrySchema).optional(),
    staticSoftwareDecoded: z.array(StaticSoftwareDecodeEntrySchema).optional(),
    cleared: z.number().optional(),
    message: z.string().optional(),
});

export type TranscodeCapabilitiesResponse = z.infer<typeof TranscodeCapabilitiesSchema>;

export function getTranscodeCapabilities() {
    return apiGet('/api/admin/transcode-capabilities', TranscodeCapabilitiesSchema);
}

export function resetTranscodeDecodeCache() {
    return apiPost('/api/admin/transcode-capabilities', TranscodeCapabilitiesSchema, {
        action: 'reset-decode-cache',
    });
}

// =========================================================================
// Transcoding / FFmpeg
// =========================================================================

export function getFfmpegJobs() {
    return apiGet('/api/admin/ffmpeg-jobs', FFmpegJobsResponseSchema);
}

export function cancelFfmpegJob(playSessionId: string) {
    return apiDelete(
        `/api/admin/ffmpeg-jobs?playSessionId=${encodeURIComponent(playSessionId)}`,
        SuccessTrueResponseSchema,
    );
}

/** Metrics of the replica that answered (hostname) — not the cluster; see getClusterStatus. */
export function getSystemMetrics() {
    return apiGet('/api/admin/system-metrics', SystemMetricsSchema);
}

export function getStreamThroughput() {
    return apiGet('/api/admin/stream-throughput', StreamThroughputSchema);
}

// =========================================================================
// Providers
// =========================================================================

export function getProviders() {
    return apiGet('/api/admin/providers', ProvidersResponseSchema);
}

/**
 * `overrides` carries unsaved settings-form values (config key → value) so
 * Test Connection checks what the operator typed, not what is saved.
 */
export function checkProviderHealth(provider: string, overrides?: Record<string, string>) {
    return apiPost('/api/admin/providers/health', ProviderHealthResponseSchema, {
        provider,
        ...(overrides ? { overrides } : {}),
    });
}

export function reorderMetadataChain(chain: string[]) {
    return apiPut('/api/admin/providers', MetadataChainReorderResponseSchema, {
        chain,
    });
}

// =========================================================================
// Plugins
// =========================================================================

export function getPluginSettings(pluginId: string) {
    return apiGet(`/api/admin/plugins/${pluginId}/settings`, PluginSettingsResponseSchema);
}

export function updatePluginSettings(
    pluginId: string,
    body: { enabled?: boolean; settings?: Record<string, unknown> },
) {
    return apiPut(
        `/api/admin/plugins/${pluginId}/settings`,
        PluginSettingsUpdateResponseSchema,
        body,
    );
}

/** Hot-load external plugins (bounded: new-only, per-replica). */
export function reloadPlugins() {
    return apiPost('/api/admin/plugins/reload', PluginReloadResponseSchema);
}

/** Install (or upgrade) an external plugin from a signed manifest URL + detached signature. */
export function installExternalPlugin(body: {
    manifestUrl: string;
    signature: string;
    checksum?: string;
    force?: boolean;
}) {
    return apiPost('/api/admin/plugins/external/install', ExternalPluginInstallResultSchema, body);
}

/**
 * Dry-run an install and report what WOULD happen — no writes, no bundle fetch.
 *
 * Takes only the two fields that identify and authenticate the manifest;
 * `checksum` and `force` are install-time concerns and deliberately absent, so
 * a preview can never be mistaken for a rehearsal of a forced install.
 */
export function previewExternalPlugin(body: { manifestUrl: string; signature: string }) {
    return apiPost('/api/admin/plugins/external/preview', ExternalPluginPreviewSchema, body);
}

/**
 * Ask every loaded subtitle provider about one item.
 *
 * The response's `providers` count is why this returns the whole body rather
 * than just the array: zero providers means nothing was asked, which the UI
 * must not render as "no subtitles found".
 */
export function searchSubtitles(mediaItemId: string, languages: string[]) {
    const qs = new URLSearchParams({ mediaItemId, languages: languages.join(',') });
    return apiGet(`/api/admin/subtitles?${qs.toString()}`, SubtitleSearchResponseSchema);
}

/** Whether hover/scrub previews are currently admitted, and why not if not. */
export function getPreviewStatus() {
    return apiGet('/api/admin/previews', PreviewStatusResponseSchema);
}

/** Operator kill-switch for previews. Durable — it outlives a restart. */
export function setPreviewsDisabled(disabled: boolean) {
    return apiPost('/api/admin/previews', PreviewStatusResponseSchema, { disabled });
}

/**
 * Recent file-scanner passes with their match rates.
 *
 * Answers "did last night's scan actually work?", which neither the live
 * progress view nor the cumulative file-stats tiles can.
 */
/**
 * Recent runs, newest first. Pass `SCANNER_RUN_GLOBAL_SCOPE` to scope to
 * global (scope='all') scans rather than one library path. `libraryGroupId`
 * narrows to one library's folders (the per-library page's scan-history
 * section) — orthogonal to `libraryPathId`, and both may be set together.
 */
export function getScannerRuns(limit = 10, libraryPathId?: string, libraryGroupId?: string) {
    const qs = new URLSearchParams({ view: 'history', limit: String(limit) });
    if (libraryPathId) qs.set('library_path_id', libraryPathId);
    if (libraryGroupId) qs.set('library_group_id', libraryGroupId);
    return apiGet(`/api/admin/library/scanner-runs?${qs.toString()}`, ScannerRunsResponseSchema);
}

/**
 * The newest run per library path — one stable row each, whatever state it is
 * in. This is what the admin table renders by default; six libraries used to
 * emit six anonymous near-identical rows per scan cycle here. Pass
 * `libraryGroupId` to narrow to one library's folders.
 */
export function getLatestScannerRunPerLibrary(libraryGroupId?: string) {
    const qs = new URLSearchParams({ view: 'latest' });
    if (libraryGroupId) qs.set('library_group_id', libraryGroupId);
    return apiGet(`/api/admin/library/scanner-runs?${qs.toString()}`, ScannerRunsResponseSchema);
}

/** Download one candidate and install it as a sidecar next to the video. */
export function installSubtitle(body: {
    mediaItemId: string;
    fileId: string;
    providerId: string;
    candidateId: string;
    language: string;
    isForced?: boolean;
    isSDH?: boolean;
}) {
    return apiPost('/api/admin/subtitles', SubtitleInstallResponseSchema, body);
}
/**
 * Plugin repositories — the catalog's mutations.
 *
 * A repository grants ZERO trust: adding one changes what is ADVERTISED, never
 * what can run. Installing from the catalog still goes through
 * `installExternalPlugin` with the same signature the operator would have
 * pasted, and past the same signature, ABI and publisher-continuity gates.
 */
const RepositorySyncOutcomeSchema = z.object({
    repositoryId: z.string(),
    entries: z.number(),
    error: z.string().nullable().optional(),
});

const RepositoryMutationResponseSchema = z
    .object({
        repository: z.unknown().optional(),
        sync: RepositorySyncOutcomeSchema.optional(),
        outcomes: z.array(RepositorySyncOutcomeSchema).optional(),
    })
    .passthrough();

export function addPluginRepository(url: string) {
    return apiPost('/api/admin/plugins/repositories', RepositoryMutationResponseSchema, { url });
}

export function removePluginRepository(id: string) {
    return apiDelete('/api/admin/plugins/repositories', z.unknown(), { id });
}

/** Re-sync every enabled repository — the manual twin of the scheduled check. */
export function syncPluginRepositories() {
    return apiPut('/api/admin/plugins/repositories', RepositoryMutationResponseSchema, {});
}

export function enableExternalPlugin(id: string) {
    return apiPost(
        `/api/admin/plugins/external/${encodeURIComponent(id)}/enable`,
        ExternalPluginEnableResultSchema,
    );
}
export function disableExternalPlugin(id: string) {
    return apiPost(
        `/api/admin/plugins/external/${encodeURIComponent(id)}/disable`,
        ExternalPluginDisableResultSchema,
    );
}
export function reloadExternalPlugin(id: string) {
    return apiPost(
        `/api/admin/plugins/external/${encodeURIComponent(id)}/reload`,
        ExternalPluginReloadResultSchema,
    );
}
export function uninstallExternalPlugin(id: string) {
    return apiPost(
        `/api/admin/plugins/external/${encodeURIComponent(id)}/uninstall`,
        ExternalPluginUninstallResultSchema,
    );
}

const PluginTestResponseSchema = z.object({
    ok: z.boolean(),
    username: z.string().optional(),
    error: z.string().optional(),
});

/**
 * Test an integration credential (currently only `discogs`). Pass the freshly
 * typed token to validate it before saving; omit it to test the stored token.
 */
export function testPluginConnection(pluginId: string, token?: string) {
    return apiPost(`/api/admin/plugins/${pluginId}/test`, PluginTestResponseSchema, { token });
}

// =========================================================================
// Debug
// =========================================================================

export function debugJellyseerr(tmdbId: number | string, mediaType?: string) {
    return apiGet(`/api/admin/debug/jellyseerr/${tmdbId}`, JellyseerrDebugResponseSchema, {
        params: { mediaType },
    });
}

export function debugSonarrLookup(tvdbId: number | string) {
    return apiGet('/api/admin/debug/sonarr/lookup', SonarrLookupResponseSchema, {
        params: { tvdbId },
    });
}

export function debugRadarrLookup(tmdbId: number | string) {
    return apiGet('/api/admin/debug/radarr/lookup', RadarrLookupResponseSchema, {
        params: { tmdbId },
    });
}

// =========================================================================
// OAuth
// =========================================================================

export function authorizeOAuth(body: { user_code: string }) {
    return apiPost('/api/oauth/authorize', OAuthResponseSchema, body);
}

export function revokeOAuth(body: { user_code: string }) {
    return apiDelete('/api/oauth/authorize', OAuthResponseSchema, body);
}

// =========================================================================
// Holidays Plugin
// =========================================================================

export function getHolidays() {
    return apiGet('/api/plugins/holidays', HolidaysListResponseSchema);
}

export function createHoliday(body: HolidayCreateBody) {
    return apiPost('/api/plugins/holidays', HolidayMutationResponseSchema, body);
}

export function updateHoliday(id: string, body: HolidayUpdateBody) {
    return apiPut(`/api/plugins/holidays/${id}`, HolidayMutationResponseSchema, body);
}

export function deleteHoliday(id: string) {
    return apiDelete(`/api/plugins/holidays/${id}`, HolidayDeleteResponseSchema);
}

export function reorderHolidays(body: { order: string[] }) {
    return apiPost('/api/plugins/holidays/reorder', HolidayReorderResponseSchema, body);
}

// =========================================================================
// Admin Radio (internet radio stations — /api/admin/radio)
// =========================================================================

/** List all radio stations (admin view, includes metadataSource + lastError). */
export function getAdminRadioStations() {
    return apiGet('/api/admin/radio', AdminRadioListResponseSchema);
}

/** Create a new radio station. */
export function createAdminRadioStation(body: {
    name: string;
    streamUrl: string;
    genre?: string;
    description?: string;
    logoUrl?: string;
    metadataSource?: Record<string, unknown>;
}) {
    return apiPost('/api/admin/radio', AdminRadioCreateResponseSchema, body);
}

/** Update a radio station's fields (partial). */
export function updateAdminRadioStation(
    id: string,
    body: {
        name?: string;
        streamUrl?: string;
        genre?: string | null;
        description?: string | null;
        metadataSource?: Record<string, unknown> | null;
    },
) {
    return apiPatch(
        `/api/admin/radio/${encodeURIComponent(id)}`,
        AdminRadioPatchResponseSchema,
        body,
    );
}

/** Read a stream's ICY name/genre/description, to prefill a new station. */
export function getAdminRadioStreamInfo(streamUrl: string) {
    return apiPost('/api/admin/radio/stream-info', RadioStreamInfoSchema, { streamUrl });
}

/** Delete a radio station and its stored artwork. */
export function deleteAdminRadioStation(id: string) {
    return apiDelete(`/api/admin/radio/${encodeURIComponent(id)}`, AdminRadioDeleteResponseSchema);
}

// =========================================================================
// Person
// =========================================================================

export function getPerson(actorId: number | string) {
    return apiGet(`/api/people/${encodeURIComponent(String(actorId))}`, PersonDetailResponseSchema);
}

// =========================================================================
// Local Users (users table)
// =========================================================================

export function getLocalUsers() {
    return apiGet('/api/admin/users', LocalUsersListResponseSchema);
}

// =========================================================================
// Broadcast notifications (admin_broadcasts + the durable inbox)
// =========================================================================
//
// Distinct from `broadcastAdminMessage` / POST /api/admin/sessions/broadcast,
// which sends a PERISHABLE toast to live play sessions. These four drive the
// durable, pinnable announcement feature at /admin/notifications. The two are
// deliberately separate surfaces — see admin-broadcast.service.ts.

/** Send a durable announcement to every user, or to a chosen subset. */
export function broadcastNotification(body: SendBroadcastRequest) {
    return apiPost('/api/admin/notifications/broadcast', SendBroadcastResponseSchema, body);
}

/** The broadcast log — recent announcements and their current pin state. */
export function listBroadcasts() {
    return apiGet('/api/admin/notifications/broadcasts', AdminBroadcastListResponseSchema);
}

/**
 * Pin or unpin an announcement. One write however many recipients it reached —
 * pin state lives on the parent row, not on each recipient's copy.
 */
export function setBroadcastPin(id: string, body: SetBroadcastPinRequest) {
    return apiPatch(
        `/api/admin/notifications/broadcasts/${encodeURIComponent(id)}`,
        AdminBroadcastSchema,
        body,
    );
}

/**
 * Delete an announcement, retracting it from every inbox it reached (the child
 * rows cascade). This is the ONLY retraction — a sent broadcast's text is
 * immutable, so there is no edit counterpart to this function by design.
 */
export function deleteBroadcast(id: string) {
    return apiDelete(
        `/api/admin/notifications/broadcasts/${encodeURIComponent(id)}`,
        NoContentSchema,
    );
}

/** Federated identities (OIDC / native / forward_auth) + Jellyfin mapping for a user. */
export function getUserIdentities(username: string) {
    return apiGet(
        `/api/admin/users/${encodeURIComponent(username)}/identities`,
        UserIdentitiesResponseSchema,
    );
}

/**
 * Set/clear the Jellyfin login override and/or resolve the Jellyfin UUID now.
 * Pass `jellyfinUsername: null` to clear; omit it to leave unchanged.
 */
export function setUserJellyfinMapping(
    username: string,
    body: { jellyfinUsername?: string | null; resolve?: boolean },
) {
    return apiPost(
        `/api/admin/users/${encodeURIComponent(username)}/jellyfin`,
        SetJellyfinMappingResponseSchema,
        body,
    );
}

/** Unlink a federated identity (forces re-link on the user's next login). */
export function unlinkUserIdentity(username: string, provider: string, subject: string) {
    const qs = new URLSearchParams({ provider, subject }).toString();
    return apiDelete(
        `/api/admin/users/${encodeURIComponent(username)}/identities?${qs}`,
        UnlinkIdentityResponseSchema,
    );
}

/**
 * Effective per-user stream policy (per-user override, or the `__default__`
 * row, or the synthetic fallback). `user_id` on the response equals the
 * username when a per-user override exists, or `'__default__'` when the
 * value is inherited.
 */
export function getStreamPolicy(username: string) {
    return apiGet(
        `/api/admin/users/${encodeURIComponent(username)}/stream-policy`,
        StreamPolicySchema,
    );
}

/** Upsert a per-user stream policy override. Only send the fields that changed. */
export function updateStreamPolicy(username: string, body: UpdatePolicyRequest) {
    return apiPut(
        `/api/admin/users/${encodeURIComponent(username)}/stream-policy`,
        StreamPolicySchema,
        body,
    );
}

/** Remove the per-user stream policy override, falling back to the default. */
export function deleteStreamPolicy(username: string) {
    return apiDelete(
        `/api/admin/users/${encodeURIComponent(username)}/stream-policy`,
        NoContentSchema,
    );
}

export function setUserIsAdmin(username: string, isAdmin: boolean) {
    return apiPatch(`/api/admin/users/${encodeURIComponent(username)}`, SetIsAdminResponseSchema, {
        isAdmin,
    });
}

export function unpinUserAdmin(username: string) {
    return apiPatch(`/api/admin/users/${encodeURIComponent(username)}`, SetIsAdminResponseSchema, {
        unpin: true,
    });
}

export function setUserAllowLiveTv(
    username: string,
    allowLiveTv: boolean,
): Promise<ApiResult<SetAllowLiveTvResponse>> {
    return apiPatch(
        `/api/admin/users/${encodeURIComponent(username)}`,
        SetAllowLiveTvResponseSchema,
        { allowLiveTv },
    );
}

export function setUserAgeRating(username: string, maxAgeRating: number | null) {
    return apiPatch(
        `/api/admin/users/${encodeURIComponent(username)}`,
        SetAgeRatingResponseSchema,
        { maxAgeRating },
    );
}

export function unpinUserAgeRating(username: string) {
    return apiPatch(
        `/api/admin/users/${encodeURIComponent(username)}`,
        SetAgeRatingResponseSchema,
        { unpinAgeRating: true },
    );
}

/** The stable UUID endpoint owns email edits on both API surfaces. */
export function setLocalUserEmail(userId: string, email: string) {
    return apiPatch(`/api/users/${encodeURIComponent(userId)}`, AdminUserEmailResponseSchema, {
        email,
    });
}

/** Admin-create a native (built-in password) user. */
export function createLocalUser(body: {
    username: string;
    password: string;
    isAdmin: boolean;
    email?: string;
}) {
    return apiPost('/api/admin/users', CreateLocalUserResponseSchema, body);
}

/** Admin-set a user's native password (no current-password check; force-logout). */
export function setUserPassword(username: string, newPassword: string) {
    return apiPost(
        `/api/admin/users/${encodeURIComponent(username)}/password`,
        SetUserPasswordResponseSchema,
        { newPassword },
    );
}

/** Suspend (true) or reactivate (false) a user. */
export function setUserDisabled(username: string, disabled: boolean) {
    return apiPatch(
        `/api/admin/users/${encodeURIComponent(username)}`,
        SetUserDisabledResponseSchema,
        { disabled },
    );
}

/**
 * GDPR Art. 17 erasure of a user. Hard-deletes the user + all personal data and
 * anonymizes audit-attribution rows; returns the per-table erasure report as the
 * confirmation artifact.
 *
 * @param confirmUsername Must equal `username` (server enforces the typed-confirm guard).
 */
export function deleteLocalUser(username: string, confirmUsername: string) {
    return apiDelete(
        `/api/admin/users/${encodeURIComponent(username)}`,
        DeleteLocalUserResponseSchema,
        { confirmUsername },
    );
}

// =========================================================================
// Watch Stats
// =========================================================================

// `getWatchStats` now lives in its own dependency-light module (2026-09-25,
// fix round 1) so `PopularMediaStats.svelte` — mounted on `/browse` —
// doesn't pull in this whole admin API client. Re-exported here so other
// importers keep working.
export { getWatchStats } from './watch-stats.js';

// =========================================================================
// Metadata Editor
// =========================================================================

/** Upload an image file for a media item */
export function uploadMediaImage(mediaId: string, artworkType: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('artworkType', artworkType);
    return apiUpload(`/api/admin/media/${mediaId}/images`, ImageUploadResponseSchema, formData);
}

/** Upload an image by URL for a media item */
export function uploadMediaImageByUrl(mediaId: string, artworkType: string, url: string) {
    return apiPost(`/api/admin/media/${mediaId}/images`, ImageUploadResponseSchema, {
        artworkType,
        url,
    });
}

/** Delete a custom image */
export function deleteMediaImage(mediaId: string, artworkType: string) {
    return apiDelete(`/api/admin/media/${mediaId}/images`, ImageDeleteResponseSchema, undefined, {
        params: { type: artworkType },
    });
}

/** Get artwork for a media item, enriched with inheritance source info */
export function getMediaImages(mediaId: string) {
    return apiGet(`/api/admin/media/${mediaId}/images`, MediaImagesResponseSchema);
}

/** Browse available images from TMDB */
export function browseMediaImages(mediaId: string) {
    return apiGet(`/api/admin/media/${mediaId}/images/browse`, ImageBrowseResponseSchema);
}

/** Get metadata lock status */
export function getMediaMetadataStatus(mediaId: string) {
    return apiGet(`/api/media/${mediaId}/metadata`, MetadataStatusResponseSchema);
}

/** Update media metadata (title, year, overview) */
export function updateMediaMetadata(mediaId: string, patch: MetadataPatch) {
    return apiPatch(`/api/media/${mediaId}/metadata`, MetadataUpdateResponseSchema, patch);
}

/** Unlock metadata (allow syncs to overwrite) */
export function unlockMediaMetadata(mediaId: string) {
    return apiDelete(`/api/media/${mediaId}/metadata`, MetadataUpdateResponseSchema);
}

const NoSplitResponseSchema = z.object({ id: z.string(), noSplit: z.boolean() });

/**
 * Flag/unflag an artist as a single act that must not be split into separate
 * artists (e.g. "Above & Lanterns"). Sets `custom_metadata.no_split`, which the
 * scanner's collaboration-merge pass respects.
 */
export function setArtistNoSplit(artistId: string, noSplit: boolean) {
    return apiPatch(`/api/admin/media/${artistId}/no-split`, NoSplitResponseSchema, { noSplit });
}

/** Bounded, read-only collaboration proposal and deliberate review actions. */
export function reviewArtistCollaboration(artistId: string, request: CollaborationRequest) {
    return apiPost(
        `/api/admin/media/${artistId}/collaboration-review`,
        CollaborationResponseSchema,
        request,
    );
}

// `syncMediaMetadata` now lives in its own dependency-light module
// (2026-09-25, fix round 1) so `$lib/utils/media-context-actions` — reached
// from every rail page — doesn't pull in this whole admin API client.
// Re-exported here so other importers keep working.
export { syncMediaMetadata } from './media-sync.js';

/**
 * Enqueue a series metadata sync with children via BullMQ.
 * Returns the enqueued job ID; progress is delivered via the admin task SSE stream.
 */
export function syncMediaMetadataEnqueue(mediaId: string) {
    return apiPost(`/api/admin/media/${mediaId}/sync`, SyncEnqueuedResponseSchema, {
        includeChildren: true,
    });
}

/**
 * Enqueue a chapter sync for a media item via BullMQ.
 * Returns the enqueued job ID; progress is delivered via the admin task SSE stream.
 */
export function syncChapters(mediaId: string) {
    return apiPost(`/api/admin/media/${mediaId}/chapters/sync`, SyncEnqueuedResponseSchema);
}

export interface ImageSyncOptions {
    mode?: 'execute' | 'plan';
    scope?: 'series' | 'season' | 'episode' | 'movie';
    extractVideo?: boolean;
}

const ImageSyncResponseSchema = z.object({
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

export type ImageSyncResponse = z.infer<typeof ImageSyncResponseSchema>;

export function syncMediaImages(mediaId: string, options: ImageSyncOptions = {}) {
    return apiPost(`/api/admin/media/${mediaId}/images/sync`, ImageSyncResponseSchema, {
        mode: options.mode ?? 'execute',
        scope: options.scope,
        extractVideo: options.extractVideo ?? true,
    });
}

const ExtractPosterResponseSchema = z.object({
    extracted: z.boolean(),
    filePath: z.string().optional(),
    reason: z.string().optional(),
});

export type ExtractPosterResponse = z.infer<typeof ExtractPosterResponseSchema>;

export function extractPosterFromVideo(
    mediaId: string,
    options: {
        artworkType?: 'poster' | 'backdrop' | 'thumb';
        force?: boolean;
    } = {},
) {
    return apiPost(`/api/admin/media/${mediaId}/images/extract`, ExtractPosterResponseSchema, {
        artworkType: options.artworkType ?? 'poster',
        force: options.force ?? false,
    });
}

// =========================================================================
// Media CRUD
// =========================================================================

const DeleteMediaResponseSchema = z.object({
    deleted: z.boolean(),
});

export function deleteMedia(mediaId: string, opts: { cascade?: boolean } = {}) {
    const qs = opts.cascade ? '?cascade=true' : '';
    return apiDelete(`/api/admin/media/${mediaId}${qs}`, DeleteMediaResponseSchema);
}

const MusicHierarchyTrackSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    sort_order: z.number().nullable(),
    runtime_seconds: z.number().nullable(),
    album_id: z.string(),
});

const MusicHierarchyAlbumSchema = z.object({
    id: z.string(),
    title: z.string(),
    year: z.number().nullable(),
    custom_poster_url: z.string().nullable(),
    track_count: z.number(),
    sort_order: z.number().nullable(),
    tracks: z.array(MusicHierarchyTrackSchema),
});

const MusicHierarchyArtistSchema = z.object({
    id: z.string(),
    title: z.string(),
    custom_poster_url: z.string().nullable(),
    album_count: z.number(),
    track_count: z.number(),
});

const MusicHierarchyResponseSchema = z.object({
    artist: MusicHierarchyArtistSchema,
    albums: z.array(MusicHierarchyAlbumSchema),
    currentItemId: z.string(),
    resolvedFromChild: z.boolean(),
});

export type MusicHierarchyResponse = z.infer<typeof MusicHierarchyResponseSchema>;

export function getMusicHierarchy(mediaId: string) {
    return apiGet(`/api/admin/media/${mediaId}/music-hierarchy`, MusicHierarchyResponseSchema);
}

const DuplicateMediaItemSchema = z.object({
    id: z.string(),
    title: z.string(),
    year: z.number().nullable(),
    created_at: z.string(),
});

const DuplicateGroupSchema = z.object({
    tmdb_id: z.string(),
    media_type: z.string(),
    items: z.array(DuplicateMediaItemSchema),
});

const MediaDuplicatesResponseSchema = z.object({
    duplicates: z.array(DuplicateGroupSchema),
});

export type MediaDuplicatesResponse = z.infer<typeof MediaDuplicatesResponseSchema>;

export function getMediaDuplicates() {
    return apiGet('/api/admin/media/duplicates', MediaDuplicatesResponseSchema);
}

// File-less duplicate pairs (real file row with no external_ids alongside a TMDB
// discovery row) — invisible to getMediaDuplicates which groups by external_id.
const FilelessDuplicatePairSchema = z.object({
    fileId: z.string(),
    fileTitle: z.string(),
    discoveryId: z.string(),
    discoveryTitle: z.string(),
    tmdbId: z.string(),
    mediaType: z.string(),
    year: z.number().nullable(),
});

const FilelessDuplicatesResponseSchema = z.object({
    pairs: z.array(FilelessDuplicatePairSchema),
    total: z.number().optional(),
});

export type FilelessDuplicatePair = z.infer<typeof FilelessDuplicatePairSchema>;

export function getFilelessDuplicatePairs() {
    return apiGet('/api/admin/media/fileless-duplicates', FilelessDuplicatesResponseSchema);
}

const MergeMediaResponseSchema = z.object({
    keepId: z.string(),
    mergeId: z.string(),
    seasonsReparented: z.number(),
    itemsDeleted: z.number(),
});

export type MergeMediaResponse = z.infer<typeof MergeMediaResponseSchema>;

/**
 * Merge `mergeId` into `keepId`. For file-less duplicate reconciliation, keep the
 * file row and pass the discovery row as mergeId (see findFilelessDuplicatePairs).
 */
export function mergeMediaItems(keepId: string, mergeId: string) {
    return apiPost('/api/admin/media/merge', MergeMediaResponseSchema, { keepId, mergeId });
}

// =========================================================================
// File Health
// =========================================================================

export type { FileHealthResponse, FileHealthRow };

/** First argument remains AbortSignal for existing callers. */
export function getFileHealth(
    signal?: AbortSignal,
    options: { scope?: FileHealthScope; cursor?: string } = {},
) {
    const params = new URLSearchParams();
    if (options.scope) params.set('scope', options.scope);
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.size ? `?${params.toString()}` : '';
    return apiGet(`/api/admin/media/file-health${query}`, FileHealthResponseSchema, { signal });
}

/** Preview, confirm, or revoke a deliberate review of exact duration findings. */
export function reviewFileHealth(request: FileHealthReviewRequest) {
    return apiPost('/api/admin/media/file-health/reviews', FileHealthReviewResponseSchema, request);
}

// =========================================================================
// Browser Compatibility Matrix
// =========================================================================

export function getMediaCompatibility(mediaId: string, capsString?: string) {
    const params = capsString ? `?caps=${encodeURIComponent(capsString)}` : '';
    return apiGet(
        `/api/admin/media/${mediaId}/compatibility${params}`,
        CompatibilityResponseSchema,
    );
}

// =========================================================================
// Library Type Settings
// =========================================================================

export function getLibraryTypeSettings() {
    return apiGet('/api/admin/library-type-settings', LibraryTypeSettingsResponseSchema);
}

export function upsertLibraryTypeSetting(body: {
    mediaType: string;
    displayName: string | null;
    sidebarVisible: boolean;
    icon: string | null;
    sortOrder: number;
}) {
    return apiPut('/api/admin/library-type-settings', LibraryTypeSettingUpdateResponseSchema, body);
}

// =========================================================================
// Library Groups
// =========================================================================

export function getLibraryGroups() {
    return apiGet('/api/admin/library-groups', LibraryGroupsResponseSchema);
}

export function createLibraryGroup(body: LibraryGroupCreateBody) {
    return apiPost('/api/admin/library-groups', LibraryGroupMutationResponseSchema, body);
}

export function updateLibraryGroup(id: string, body: LibraryGroupPatchBody) {
    return apiPatch(`/api/admin/library-groups/${id}`, LibraryGroupMutationResponseSchema, body);
}

export function deleteLibraryGroup(groupId: string) {
    return apiDelete(`/api/admin/library-groups/${groupId}`, z.null());
}

// =========================================================================
// Library Paths
// =========================================================================

export function getLibraryPaths() {
    return apiGet('/api/admin/library-paths', LibraryPathsResponseSchema);
}

export function createLibraryPath(body: LibraryPathCreateBody) {
    return apiPost('/api/admin/library-paths', LibraryPathMutationResponseSchema, body);
}

/** Composite: create a library group + its paths in one call (setup wizard). */
export function createLibrary(body: LibrarySetupInput) {
    return apiPost('/api/admin/libraries', LibrarySetupResponseSchema, body);
}

/**
 * Library settings save (the per-library page's Settings section):
 * name/icon/description/max_age_rating plus media_type/provider/
 * fallback_providers, which are fanned out to every folder in the library.
 */
export function updateLibrary(id: string, body: LibraryUpdateBody) {
    return apiPatch(`/api/admin/libraries/${id}`, LibraryUpdateResponseSchema, body);
}

/**
 * Folder picker: list subdirectories of `path`, or (when omitted) the
 * allowed roots that currently exist. Never lists files.
 */
export function browseLibraryFolders(path?: string) {
    const qs = path ? `?${new URLSearchParams({ path }).toString()}` : '';
    return apiGet(`/api/admin/library/browse${qs}`, LibraryBrowseResponseSchema);
}

export function patchLibraryPath(id: string, body: LibraryPathPatchBody) {
    return apiPatch(`/api/admin/library-paths/${id}`, LibraryPathMutationResponseSchema, body);
}

const DeleteLibraryFolderResponseSchema = z.object({
    filesToDetach: z.number(),
    detachRunId: z.string().optional(),
    scansCancelled: z.number(),
    uploadsAborted: z.number(),
});

/**
 * Delete a library folder. 409 (`code: 'conflict'`) while a scan of it or an
 * upload into it runs; `force` cancels those first. The folder's scanned
 * files are retired in the background (`detachRunId`).
 */
export function deleteLibraryPath(id: string, opts: { force?: boolean } = {}) {
    return apiDelete(
        `/api/admin/library-paths/${encodeURIComponent(id)}${opts.force ? '?force=1' : ''}`,
        DeleteLibraryFolderResponseSchema,
    );
}

// =========================================================================
// Library Group Permissions
// =========================================================================

export function getLibraryGroupPermissions() {
    return apiGet('/api/admin/library-group-permissions', LibraryGroupPermissionsResponseSchema);
}

export function saveLibraryGroupPermissions(body: {
    library_group_id: string;
    allowed_groups: string[];
}) {
    return apiPut(
        '/api/admin/library-group-permissions',
        LibraryGroupPermissionsResponseSchema,
        body,
    );
}

export function getAvailableGroups() {
    return apiGet('/api/admin/available-groups', AvailableGroupsResponseSchema);
}

/** Resolved effect of the Sharing & Privacy settings — counts only, no names. */
export function getSocialAudience() {
    return apiGet('/api/admin/social-audience', SocialAudienceResponseSchema);
}

// =========================================================================
// Library File Stats
// =========================================================================

export function getLibraryFileStats() {
    return apiGet('/api/admin/library/file-stats', FileStatsResponseSchema);
}

// =========================================================================
// File Scanner Plugin
// =========================================================================

export function getFileScannerStatus() {
    return apiGet('/api/admin/plugins/file-scanner', PluginStatusResponseSchema);
}

export function triggerFileScanner(body: PluginTriggerBody = {}) {
    return apiPost('/api/admin/plugins/file-scanner', PluginStatusResponseSchema, body);
}

const ValidatePathResponseSchema = z.object({
    exists: z.boolean(),
    isDirectory: z.boolean(),
    readable: z.boolean(),
    isEmpty: z.boolean(),
});

/** Check a library folder path (exists / is a dir / readable / empty) before saving it. */
export function validateLibraryPath(path: string) {
    return apiPost('/api/admin/library/validate-path', ValidatePathResponseSchema, { path });
}

/**
 * One library offered by a remote media server's library picker.
 *
 * `name` is upstream's own spelling and is rendered verbatim — nothing is
 * inferred from it (see `remote-library-sources.ts`).
 */
const RemoteLibraryOptionSchema = z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    supported: z.boolean(),
    unsupportedReason: z.string().optional(),
    path: z.string(),
    existing: z
        .object({
            libraryPathId: z.string(),
            libraryGroupId: z.string(),
            language: z.string(),
            enabled: z.boolean(),
        })
        .optional(),
});

export type RemoteLibraryOption = z.infer<typeof RemoteLibraryOptionSchema>;

/**
 * `status` is a required discriminator, NOT an optional field.
 *
 * The whole point of this endpoint is that "server unreachable" and "server has
 * no libraries" are different answers. If `status` could be absent the client
 * would fall back to rendering an empty list and reproduce exactly the bug this
 * replaces.
 */
const RemoteLibrariesResponseSchema = z.object({
    provider: z.string(),
    label: z.string(),
    mediaType: z.string(),
    settingsHref: z.string(),
    requiredKeys: z.array(z.string()),
    status: z.enum(['ok', 'not_configured', 'unreachable']),
    libraries: z.array(RemoteLibraryOptionSchema).optional(),
    missingKeys: z.array(z.string()).optional(),
    message: z.string().optional(),
});

export type RemoteLibrariesResponse = z.infer<typeof RemoteLibrariesResponseSchema>;

/** List the libraries a remote media server hosts, for the add-library picker. */
export function getRemoteLibraries(provider: string) {
    return apiGet(
        `/api/admin/library/remote-libraries?provider=${encodeURIComponent(provider)}`,
        RemoteLibrariesResponseSchema,
    );
}

// =========================================================================
// Auto-Identify
// =========================================================================

export function startAutoIdentify(
    mediaItemIds?: string[],
    scope?: { libraryGroupId?: string; mediaType?: 'movie' | 'tv'; search?: string },
) {
    // Body must match autoIdentifyPostBodySchema exactly ({ options? } only,
    // .strict()) — an `action` field here 422s. Progress/completion is
    // polled via the generic run-status endpoint using the returned jobId,
    // not by re-POSTing here (this route only ever starts a new run).
    // `mediaItemIds` narrows the run to those items ("Auto-identify selected").
    return apiPost(
        '/api/admin/auto-identify',
        AutoIdentifyStartResponseSchema,
        mediaItemIds?.length
            ? { options: { mediaItemIds } }
            : scope && Object.values(scope).some(Boolean)
              ? { options: { scope } }
              : {},
    );
}

// =========================================================================
// Unmatched Files (Personal Media)
// =========================================================================

export function listUnmatchedFiles(params: {
    limit: number;
    offset: number;
    sort: string;
    q?: string;
    mediaType?: 'movie' | 'series';
    libraryGroupId?: string;
    disposition?: 'unresolved' | 'kept';
}) {
    const queryParts = [`limit=${params.limit}`, `offset=${params.offset}`, `sort=${params.sort}`];
    if (params.q) queryParts.push(`q=${encodeURIComponent(params.q)}`);
    if (params.mediaType) queryParts.push(`mediaType=${params.mediaType}`);
    if (params.libraryGroupId) queryParts.push(`libraryGroupId=${params.libraryGroupId}`);
    if (params.disposition === 'kept') queryParts.push('disposition=kept');
    return apiGet(
        `/api/admin/unmatched-files?${queryParts.join('&')}`,
        ListPersonalMediaResponseSchema,
    );
}

export function getUnmatchedFileChildren(id: string) {
    return apiGet(
        `/api/admin/unmatched-files/${id}/children`,
        PersonalSeriesChildrenResponseSchema,
    );
}

export function dismissUnmatchedFile(id: string) {
    return apiDelete(`/api/admin/unmatched-files/${id}`, DismissResponseSchema);
}

/** Undo for {@link dismissUnmatchedFile}: put the item (and its children) back. */
export function restoreUnmatchedFile(id: string) {
    return apiPost(`/api/admin/unmatched-files/${id}/restore`, RestoreDismissedResponseSchema, {});
}

export function keepPersonalMedia(id: string) {
    return apiPost(`/api/admin/unmatched-files/${id}/keep`, KeepPersonalMediaResponseSchema, {});
}

export function restoreKeptPersonalMedia(id: string) {
    return apiDelete(
        `/api/admin/unmatched-files/${id}/keep`,
        RestoreKeptPersonalMediaResponseSchema,
    );
}

export function matchUnmatchedFile(
    id: string,
    body: { provider: string; externalId: string; type: 'movie' | 'series' },
) {
    return apiPost(`/api/admin/unmatched-files/${id}/match`, MatchResponseSchema, body);
}

export interface MatchAttemptResult {
    ok: boolean;
    status: number;
    error?: string;
    /** Set on a 409 "already-mapped" conflict: the row that already owns the id. */
    conflictMediaId?: string | null;
    /** The file row being identified — the recommended merge keep target. */
    fileMediaId?: string;
}

/**
 * Like matchUnmatchedFile, but surfaces the structured 409 conflict body so the
 * UI can offer a one-click "merge into existing" instead of dead-ending when the
 * chosen provider id is already owned by another (usually discovery) row. The
 * generic apiPost client drops the body on non-2xx, hence the raw fetch.
 */
export async function matchUnmatchedFileDetailed(
    id: string,
    body: { provider: string; externalId: string; type: 'movie' | 'series' },
): Promise<MatchAttemptResult> {
    const res = await fetch(`/api/admin/unmatched-files/${id}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, status: res.status };
    let payload: Record<string, unknown> = {};
    try {
        payload = (await res.json()) as Record<string, unknown>;
    } catch {
        // non-JSON body — fall through with status only
    }
    return {
        ok: false,
        status: res.status,
        error: typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`,
        conflictMediaId:
            typeof payload.conflictMediaId === 'string' ? payload.conflictMediaId : null,
        fileMediaId: typeof payload.fileMediaId === 'string' ? payload.fileMediaId : id,
    };
}

// =========================================================================
// Provider Search
// =========================================================================

export function searchProvider(params: { q: string; mediaType: 'movie' | 'series' | 'any' }) {
    return apiGet('/api/admin/provider-search', ProviderSearchResponseSchema, {
        params: { q: params.q, mediaType: params.mediaType },
    });
}

// =========================================================================
// Reconciliation Backfill
// =========================================================================

/**
 * Trigger the episode reconciliation backfill task.
 * Returns { runId, message } on success (no `success` wrapper).
 */
export function triggerReconciliationBackfill(body: ReconciliationBackfillRequest = {}) {
    return apiPost(
        '/api/admin/reconciliation-backfill',
        ReconciliationBackfillResponseSchema,
        body,
    );
}

// =========================================================================
// Admin Play Sessions
// =========================================================================

export function getAdminPlaySessions() {
    return apiGet('/api/admin/play-sessions', AdminPlaySessionsResponseSchema);
}

export function killAdminPlaySession(id: string) {
    return apiPost(`/api/admin/play-sessions/${id}/kill`, SuccessTrueResponseSchema);
}

export function getAdminPlaybackPlan(planId: string) {
    return apiGet(
        `/api/admin/playback-plans/${encodeURIComponent(planId)}`,
        AdminPlaybackPlanResponseSchema,
    );
}

export function refreshUserWatchState(username: string) {
    return apiPost(
        `/api/admin/users/${encodeURIComponent(username)}/refresh-watch-state`,
        AdminRefreshUserWatchStateResponseSchema,
    );
}

// =========================================================================
// Admin Nav Pins
// =========================================================================

export function addNavPin(body: { href: string; label: string }) {
    return apiPost('/api/admin/nav-pins', AdminNavPinActionResponseSchema, body);
}

export function removeNavPin(body: { href: string }) {
    return apiDelete('/api/admin/nav-pins', AdminNavPinActionResponseSchema, body);
}

// `getNavPins` now lives in its own dependency-light module (2026-09-25) so
// Sidebar.svelte's lazy-fetch doesn't pull in this whole admin API client on
// every page. Re-exported here so existing importers are unaffected.
export { getNavPins } from './nav-pins.js';

// =========================================================================
// Navigation Groups
// =========================================================================

/** Add a group name to NAVIGATION_AVAILABLE_GROUPS. */
export function addNavGroup(body: { group: string }) {
    return apiPost('/api/admin/navigation/groups', AddNavGroupResponseSchema, body);
}

// =========================================================================
// Homepage Widgets
// =========================================================================

/** Reset all per-user homepage widget orders to admin-configured defaults. */
export function resetHomepageWidgets() {
    return apiPost('/api/admin/homepage/reset-widgets', HomepageResetWidgetsResponseSchema);
}

// =========================================================================
// Instance Profile
// =========================================================================

/** Apply (or preview) an instance use-case preset. */
export function applyInstanceProfile(body: {
    useCases: UseCaseId[];
    landingPath?: string;
    dryRun?: boolean;
}) {
    return apiPost('/api/admin/instance-profile', InstanceProfileResponseSchema, body);
}

// =========================================================================
// Media Admin — Custom Metadata (music/audio items)
// =========================================================================

// Values are arbitrary JSON: chapters are an array and lyrics an object, so a
// primitives-only schema failed validation on exactly the fields the tabs read.
const AdminCustomMetadataResponseSchema = z.object({
    undoIds: z.object({ chapters: z.uuid().optional(), lyrics: z.uuid().optional() }).optional(),
    custom_metadata: z.record(z.string(), z.unknown()),
});

const AdminCustomMetadataUpdateResponseSchema = z.object({
    undoId: z.uuid().optional(),
    updated: z.boolean(),
});

export function getAdminCustomMetadata(mediaId: string) {
    return apiGet(`/api/admin/media/${mediaId}/metadata`, AdminCustomMetadataResponseSchema);
}

export function updateAdminCustomMetadata(mediaId: string, metadata: Record<string, unknown>) {
    return apiPatch(
        `/api/admin/media/${mediaId}/metadata`,
        AdminCustomMetadataUpdateResponseSchema,
        { metadata },
    );
}

export function undoAdminCuratedOutput(
    mediaId: string,
    output: 'chapters' | 'lyrics',
    receiptId: string,
) {
    return apiPatch(
        `/api/admin/media/${mediaId}/metadata`,
        AdminCustomMetadataUpdateResponseSchema,
        { metadata: {}, output, undoReceiptId: receiptId },
    );
}

/** Bulk-merge custom_metadata for a list of media items (max 500). */
export function bulkUpdateMediaMetadata(ids: string[], metadata: Record<string, unknown>) {
    return apiPut('/api/admin/media/bulk-metadata', BulkMetadataUpdateResponseSchema, {
        ids,
        metadata,
    });
}

/**
 * Bulk lock/unlock a list of media items (max 500 per call — chunk larger
 * selections client-side). Cheap DB-only op, executes synchronously.
 */
export function bulkSetLock(ids: string[], locked: boolean) {
    return apiPatch('/api/admin/media/bulk-lock', BulkLockResponseSchema, { ids, locked });
}

/**
 * Enqueue a bulk metadata sync for a list of media items (max 500 per call).
 * Hits TMDB per item, so this returns a jobId immediately — poll progress and
 * completion via GET /api/runs/{jobId} (same pattern as startAutoIdentify).
 */
export function enqueueBulkSync(
    ids: string[],
    opts: { includeChildren?: boolean; forceChildren?: boolean } = {},
) {
    return apiPost('/api/admin/media/bulk-sync', BulkSyncEnqueueResponseSchema, {
        ids,
        includeChildren: opts.includeChildren ?? false,
        forceChildren: opts.forceChildren ?? false,
    });
}

/** Get distinct metadata values for a library type + key (for autocomplete). */
export function getLibraryMetadataValues(mediaType: string, key: string) {
    return apiGet(
        `/api/admin/library-type/${encodeURIComponent(mediaType)}/metadata-values`,
        LibraryMetadataValuesResponseSchema,
        { params: { key } },
    );
}

// =========================================================================
// Media Admin — External IDs
// =========================================================================

export function getMediaExternalIds(mediaId: string) {
    return apiGet(`/api/admin/media/${mediaId}/external-ids`, ExternalIdsGetResponseSchema);
}

export function upsertMediaExternalId(
    mediaId: string,
    body: { provider: string; externalId: string },
) {
    return apiPut(`/api/admin/media/${mediaId}/external-ids`, ExternalIdMutateResponseSchema, body);
}

export function deleteMediaExternalId(mediaId: string, provider: string) {
    return apiDelete(
        `/api/admin/media/${mediaId}/external-ids?provider=${encodeURIComponent(provider)}`,
        ExternalIdDeleteResponseSchema,
    );
}

export function previewEpisodeTmdbExchange(mediaId: string, otherId: string) {
    return apiGet(
        `/api/admin/media/${encodeURIComponent(mediaId)}/external-ids/exchange`,
        EpisodeTmdbExchangePreviewSchema,
        { params: { otherId } },
    );
}

export function confirmEpisodeTmdbExchange(
    mediaId: string,
    otherId: string,
    snapshot: string,
    undoReceiptId?: string,
) {
    return apiPost(
        `/api/admin/media/${encodeURIComponent(mediaId)}/external-ids/exchange`,
        EpisodeTmdbExchangePreviewSchema,
        { otherId, snapshot, ...(undoReceiptId ? { undoReceiptId } : {}) },
    );
}

// =========================================================================
// Media Admin — Segments
// =========================================================================

export function getMediaSegments(mediaId: string) {
    return apiGet(`/api/admin/media/${mediaId}/segments`, SegmentsResponseSchema);
}

export function generateMediaSegments(
    mediaId: string,
    scope: 'single' | 'children' | 'deep',
    options: { outroOnly?: boolean } = {},
) {
    return apiPost(`/api/admin/media/${mediaId}/segments`, SegmentsGenerateResponseSchema, {
        scope,
        ...(options.outroOnly ? { outroOnly: true } : {}),
    });
}

export function undoMediaSegments(mediaId: string, receiptId: string) {
    return apiPost(`/api/admin/media/${mediaId}/segments`, z.object({ restored: z.boolean() }), {
        scope: 'undo',
        receiptId,
    });
}

export function setMediaSegment(
    mediaId: string,
    body: { type: 'Intro' | 'Outro'; startMs: number; endMs: number },
) {
    return apiPost(`/api/admin/media/${mediaId}/segments`, SegmentsSetResponseSchema, {
        scope: 'set',
        ...body,
    });
}

export function clearMediaSegments(mediaId: string, type?: 'Outro') {
    const suffix = type ? `?type=${encodeURIComponent(type)}` : '';
    return apiDelete(`/api/admin/media/${mediaId}/segments${suffix}`, SegmentsDeleteResponseSchema);
}

/**
 * Cancel a run.
 *
 * Three components hand-rolled this exact `apiPost(.../cancel, ...)` call; this
 * is the one typed helper they should all use. A `pending` run terminalizes
 * synchronously, an `active` one moves to `cancelling` and finalizes
 * asynchronously, which is why the response carries `deferred`.
 */
export function cancelRun(runId: string, opts: { hard?: boolean } = {}) {
    return apiPost(`/api/runs/${encodeURIComponent(runId)}/cancel`, CancelResponseSchema, {
        hard: opts.hard ?? false,
    });
}

// =========================================================================
// Media Admin — Trickplay
// =========================================================================

export function generateTrickplay(mediaId: string, body: { force?: boolean; width?: number } = {}) {
    return apiPost(
        `/api/admin/media/${mediaId}/trickplay/generate`,
        TrickplayGenerateResponseSchema,
        body,
    );
}

// =========================================================================
// Media Admin — Episode Thumbnails
// =========================================================================

export function regenerateEpisodeThumbnails(
    mediaId: string,
    body: { force?: boolean; scope?: 'series' | 'season' | 'episode'; reviewToken?: string } = {},
) {
    return apiPost(
        `/api/admin/media/${mediaId}/episode-thumbnails/regenerate`,
        TrickplayGenerateResponseSchema,
        body,
    );
}

export function getSharedEpisodeThumbReview(mediaId: string, limit = 12, offset = 0) {
    return apiGet(
        `/api/admin/media/${encodeURIComponent(mediaId)}/episode-thumbnails/review?limit=${limit}&offset=${offset}`,
        SharedEpisodeThumbReviewSchema,
    );
}

// =========================================================================
// Media Admin — Probe Raw
// =========================================================================

export function probeRawFile(mediaId: string, fileId: string) {
    return apiPost(`/api/admin/media/${mediaId}/probe-raw`, ProbeRawResponseSchema, { fileId });
}

// =========================================================================
// Media Admin — Chapters & Streams
// =========================================================================

export function getMediaChapters(mediaId: string, fileId?: string | null) {
    const params = fileId ? `?fileId=${fileId}` : '';
    return apiGet(`/api/admin/media/${mediaId}/chapters${params}`, AdminChaptersResponseSchema);
}

// `getMediaStreams` now lives in its own dependency-light module (2026-09-25,
// fix round 1) so `MediaFileInfoModal.svelte` — reached from every rail page
// — doesn't pull in this whole admin API client. Re-exported here so other
// importers (e.g. the admin-only `FilesTab.svelte`) keep working.
export { getMediaStreams } from './media-streams.js';

// =========================================================================
// Media Admin — File → episode links set by hand
// =========================================================================

function fileEpisodesPath(mediaId: string, fileId: string): string {
    return `/api/admin/media/${mediaId}/files/${fileId}/episodes`;
}

export function getFileEpisodes(mediaId: string, fileId: string) {
    return apiGet(fileEpisodesPath(mediaId, fileId), FileEpisodesResponseSchema);
}

export function undoFileEpisodes(mediaId: string, fileId: string, receiptId: string) {
    return apiPut(
        `/api/admin/media/${mediaId}/files/${fileId}/episodes`,
        FileEpisodesResponseSchema,
        { undoReceiptId: receiptId },
    );
}

export function setFileEpisodes(mediaId: string, fileId: string, body: SetFileEpisodesRequest) {
    return apiPut(fileEpisodesPath(mediaId, fileId), FileEpisodesResponseSchema, body);
}

export function clearFileEpisodes(mediaId: string, fileId: string, revision: string) {
    return apiDelete(fileEpisodesPath(mediaId, fileId), FileEpisodesResponseSchema, { revision });
}

// =========================================================================
// Media Admin — Episodes
// =========================================================================

export function getAdminEpisodes(seriesId: string) {
    return apiGet(`/api/admin/media/${seriesId}/episodes`, AdminEpisodesResponseSchema);
}

// =========================================================================
// Media Admin — Albums & Tracks
// =========================================================================

export function getAdminAlbums(artistId: string) {
    return apiGet(`/api/admin/media/${artistId}/albums`, AlbumsResponseSchema);
}

export function getAdminTracks(albumId: string) {
    return apiGet(`/api/admin/media/${albumId}/tracks`, TracksResponseSchema);
}

const ArtistSearchResponseSchema = z.object({
    artists: z.array(z.object({ id: z.string(), title: z.string() })),
    snapshot: z.string().optional(),
});
const AssignArtistResponseSchema = z.object({
    artistId: z.string(),
    artistTitle: z.string(),
});

export type ArtistSearchResult = z.infer<typeof ArtistSearchResponseSchema>['artists'][number];

export function searchArtists(albumId: string, q: string) {
    return apiGet(`/api/admin/media/${albumId}/artist`, ArtistSearchResponseSchema, {
        params: { q },
    });
}

export function reassignAlbumArtist(albumId: string, artistId: string, snapshot?: string) {
    return apiPatch(`/api/admin/media/${albumId}/artist`, AssignArtistResponseSchema, {
        artistId,
        snapshot,
    });
}

export function createArtistAndAssign(albumId: string, artistName: string, snapshot?: string) {
    return apiPost(`/api/admin/media/${albumId}/artist`, AssignArtistResponseSchema, {
        artistName,
        snapshot,
    });
}

// =========================================================================
// Media Admin — Health
// =========================================================================

export function getSeriesHealth(seriesId: string) {
    return apiGet(`/api/admin/media/${seriesId}/health`, HealthResponseSchema);
}

export function getReconciliationPreview(seriesId: string) {
    return apiGet(
        `/api/admin/media/${seriesId}/health/reconcile`,
        ReconciliationPreviewResponseSchema,
    );
}

export function applyReconciliation(
    seriesId: string,
    payload: { minConfidence?: number; episodeIds?: string[] },
) {
    return apiPost(
        `/api/admin/media/${seriesId}/health/reconcile`,
        ReconciliationApplyResponseSchema,
        payload,
    );
}

// =========================================================================
// Media Admin — Hierarchy
// =========================================================================

export function getMediaHierarchy(seriesId: string) {
    return apiGet(`/api/admin/media/${seriesId}/hierarchy`, HierarchyResponseSchema);
}

// =========================================================================
// Media Admin — Preview
// =========================================================================

export function getMediaPreview(itemId: string) {
    return apiGet(`/api/admin/media/${itemId}/preview`, MediaPreviewResponseSchema);
}

/** A series' seasons and episodes with issue badges (media browser drill-down). */
export function getBrowserChildren(seriesId: string) {
    return apiGet(`/api/admin/media/${seriesId}/browser-children`, BrowserChildrenResponseSchema);
}

// =========================================================================
// Media Admin — Rescan
// =========================================================================

export function rescanMediaAudioFeatures(mediaId: string) {
    return apiPost(`/api/admin/media/${mediaId}/rescan`, RescanResponseSchema, {
        type: 'audio-features',
    });
}

// =========================================================================
// Series Ordering
// =========================================================================

export function setSeriesOrdering(
    seriesId: string,
    body: { orderingType: string; provider: string; groupId: string },
) {
    return apiPut(`/api/series/${seriesId}/ordering`, SuccessTrueResponseSchema, body);
}

// =========================================================================
// System Health
// =========================================================================

export function getSystemHealth(detail?: boolean) {
    return apiGet(`/api/health${detail ? '?detail=true' : ''}`, SystemHealthResponseSchema);
}

// =========================================================================
// Cluster Status
// =========================================================================

/**
 * Returns live cluster node status and recent online/offline transition events.
 * Validates response against ClusterStatusResponseSchema (Zod).
 * Polling interval on the admin page is 10s to match the heartbeat frequency.
 */
export function getClusterStatus() {
    return apiGet('/api/admin/cluster', ClusterStatusResponseSchema);
}

// =========================================================================
// Admin Messaging & Maintenance
// =========================================================================

/**
 * `delivery`: 'command' = sent to a device that reports command status (follow
 * `command` through `device.command_status`), 'toast' = shown through the play
 * session's own admin channel, 'stopped' = the session was stopped.
 */
const SessionCommandResponseSchema = z.object({
    delivery: z.enum(['command', 'toast', 'stopped']),
    command: DeviceCommandSchema.optional(),
});
// Broadcast intentionally returns `{ ok: true }` with no delivery count.
// A per-pod count would be misleading on multi-pod deployments and
// cluster-wide aggregation is not worth the round-trip.
const BroadcastMessageResponseSchema = z.object({ ok: z.literal(true) });
const MaintenanceClearedResponseSchema = z.object({ ok: z.literal(true) });

/**
 * Show a message on one active play session (`ui.message`, max 280 characters).
 * POST /api/admin/sessions/{playSessionId}/commands
 */
export function sendSessionMessage(
    sessionId: string,
    body: {
        text: string;
        severity?: 'info' | 'warning' | 'error';
    },
) {
    return apiPost(
        `/api/admin/sessions/${encodeURIComponent(sessionId)}/commands`,
        SessionCommandResponseSchema,
        {
            type: 'ui.message' as const,
            args: { text: body.text, ...(body.severity ? { severity: body.severity } : {}) },
        },
    );
}

/** Broadcast a toast message to all active play sessions on this pod. */
export function broadcastSessionMessage(body: {
    message: string;
    severity?: 'info' | 'warning' | 'error';
    durationMs?: number;
}) {
    return apiPost('/api/admin/sessions/broadcast', BroadcastMessageResponseSchema, body);
}

/** Get the currently active maintenance notice (null if none). */
export function getMaintenanceNotice() {
    return apiGet('/api/admin/maintenance', MaintenanceNoticeResponseSchema);
}

/** Set a new maintenance notice (fails if one is already active). */
export function setMaintenanceNotice(body: { message: string; minutes: number }) {
    return apiPost('/api/admin/maintenance', MaintenanceNoticeResponseSchema, body);
}

/** Clear any active maintenance notice (idempotent). */
export function clearMaintenanceNotice() {
    return apiDelete('/api/admin/maintenance', MaintenanceClearedResponseSchema);
}

// =========================================================================
// Integrity Violations
// =========================================================================

export function getIntegrityViolations(params?: {
    rule?: string;
    severity?: string;
    limit?: number;
}) {
    return apiGet('/api/admin/integrity', IntegrityViolationsResponseSchema, {
        params: {
            rule: params?.rule,
            severity: params?.severity,
            limit: params?.limit,
        },
    });
}

export function resolveIntegrityViolation(id: string, resolution?: string) {
    return apiPost(
        `/api/admin/integrity/${encodeURIComponent(id)}/resolve`,
        IntegrityResolveResponseSchema,
        resolution ? { resolution } : {},
    );
}

// =========================================================================
// Sync Quarantine
// =========================================================================

export function getQuarantineEntries(params?: { limit?: number }) {
    return apiGet('/api/admin/quarantine', QuarantineResponseSchema, {
        params: { limit: params?.limit },
    });
}

export function resolveQuarantineEntry(
    id: string,
    resolution: 'reattached' | 'dismissed' | 'recreated',
    fingerprint?: string,
) {
    return apiPost(
        `/api/admin/quarantine/${encodeURIComponent(id)}/resolve`,
        QuarantineResolveResponseSchema,
        { resolution, fingerprint },
    );
}

export function inspectQuarantineGroup(group: string, after?: string) {
    return apiGet('/api/admin/quarantine', QuarantineInspectionResponseSchema, {
        params: { group, after, limit: 25 },
    });
}

/** Per-series bulk triage list — see /admin/library/quarantine. */
export function listQuarantineSeriesGroups(historyAfter?: string) {
    return apiGet('/api/admin/library/quarantine-groups', QuarantineSeriesGroupsResponseSchema, {
        params: { historyAfter },
    });
}

/** Bulk-resolve every unresolved quarantine row in one series group. */
export function resolveQuarantineSeriesGroup(body: QuarantineGroupResolveBody) {
    return apiPost(
        '/api/admin/library/quarantine-groups/resolve',
        QuarantineGroupResolveResponseSchema,
        body,
    );
}

/** Recent reconciliation moves (episodes bound or moved by the reconcilers), with undo state. */
export function listReconciliationMoves(params?: { seriesId?: string; limit?: number }) {
    return apiGet('/api/admin/reconciliation-moves', ReconciliationMovesResponseSchema, {
        params: { seriesId: params?.seriesId, limit: params?.limit },
    });
}

/** Undo one reconciliation move: restores the episode's identity and position. */
export function undoReconciliationMove(id: string) {
    return apiPost(
        `/api/admin/reconciliation-moves/${encodeURIComponent(id)}/undo`,
        ReconciliationMoveUndoResponseSchema,
        {},
    );
}

/** Open absolute-numbering proposals, one row each, for the per-row apply / dismiss buttons. */
export function listReconciliationProposals(params?: { seriesId?: string; limit?: number }) {
    return apiGet('/api/admin/reconciliation-proposals', ReconciliationProposalsResponseSchema, {
        params: { seriesId: params?.seriesId, limit: params?.limit },
    });
}

/** Apply one proposal: the episode adopts the TMDB identity and moves (undoable). */
export function applyReconciliationProposal(quarantineId: string) {
    return apiPost(
        `/api/admin/reconciliation-proposals/${encodeURIComponent(quarantineId)}/apply`,
        ReconciliationProposalApplyResponseSchema,
        {},
    );
}

/** Dismiss one proposal; the pair is not proposed or applied again. */
export function dismissReconciliationProposal(quarantineId: string) {
    return apiPost(
        `/api/admin/reconciliation-proposals/${encodeURIComponent(quarantineId)}/dismiss`,
        ReconciliationProposalDismissResponseSchema,
        {},
    );
}

// =========================================================================
// Admin Audit Log
// =========================================================================

export interface GetAdminAuditFeedOptions {
    actors?: string[];
    actions?: string[];
    since?: string;
    cursor?: string;
    limit?: number;
}

/**
 * GET /api/admin/admin-audit
 *
 * Returns a cursor-paginated feed of admin audit events (source='admin').
 * Response shape: { items: AdminAuditEventRow[], page: { limit, nextCursor?, hasMore } }
 */
export function getAdminAuditFeed(
    opts: GetAdminAuditFeedOptions = {},
    options?: ApiRequestOptions,
) {
    const pairs: [string, string][] = [];
    for (const a of opts.actors ?? []) pairs.push(['actor', a]);
    for (const g of opts.actions ?? []) pairs.push(['action', g]);
    if (opts.since) pairs.push(['since', opts.since]);
    if (opts.cursor) pairs.push(['cursor', opts.cursor]);
    if (opts.limit) pairs.push(['limit', String(opts.limit)]);
    const qs = pairs.length > 0 ? `?${new URLSearchParams(pairs).toString()}` : '';
    return apiGet(`/api/admin/admin-audit${qs}`, AdminAuditFeedResponseSchema, options);
}

/**
 * GET /api/admin/admin-audit/actors
 *
 * Returns { actors: string[] } — distinct actor usernames seen in audit_log (source='admin').
 */
export function getAdminAuditActors(options?: ApiRequestOptions) {
    return apiGet('/api/admin/admin-audit/actors', AdminAuditActorsResponseSchema, options);
}

// =========================================================================
// Attention (Ops Bell)
// =========================================================================

/**
 * POST /api/admin/attention/ack
 *
 * Acknowledges one attention item by id + fingerprint.
 * Returns { ok: boolean }.
 */
export function ackAttentionItem(
    body: { id: string; fingerprint: string },
    options?: ApiRequestOptions,
) {
    return apiPost('/api/admin/attention/ack', AttentionAckResponseSchema, body, options);
}

/**
 * POST /api/admin/attention/snooze
 *
 * Snoozes one attention item for a duration (time-boxed suppression).
 * Returns { ok: boolean }.
 */
export function snoozeAttentionItem(
    body: { id: string; fingerprint: string; durationMs: number },
    options?: ApiRequestOptions,
) {
    return apiPost('/api/admin/attention/snooze', AttentionSnoozeResponseSchema, body, options);
}

/**
 * GET /api/v1/setup/onboarding
 *
 * Auto-detected onboarding checklist state (steps + allDismissed). Reflects
 * live system state (library/TMDB/scan/AI), not stale rows. Admin-only.
 */
export function getOnboardingChecklist(options?: ApiRequestOptions) {
    return apiGet('/api/v1/setup/onboarding', OnboardingStateResponseSchema, options);
}

// =========================================================================
// Chunked Upload
// =========================================================================

/** Initialise a chunked-upload session for a library path. */
export function initUploadSession(
    libraryPathId: string,
    body: {
        filename: string;
        mimeType: string;
        totalSize: number;
        totalChunks: number;
        destinationFolder?: string;
        metadata?: Record<string, string>;
    },
    options?: ApiRequestOptions,
) {
    return apiPost(
        `/api/admin/upload/${encodeURIComponent(libraryPathId)}/init`,
        UploadInitResponseSchema,
        body,
        options,
    );
}

/** Finalise a chunked-upload session and trigger ingest. */
export function finalizeUploadSession(
    libraryPathId: string,
    uploadId: string,
    body: { totalChunks: number; sha256?: string },
    options?: ApiRequestOptions,
) {
    return apiPost(
        `/api/admin/upload/${encodeURIComponent(libraryPathId)}/finalize/${encodeURIComponent(uploadId)}`,
        UploadFinalizeResponseSchema,
        body,
        options,
    );
}

/** Abort and delete a chunked-upload session. */
export function abortUploadSession(libraryPathId: string, uploadId: string) {
    return apiDelete(
        `/api/admin/upload/${encodeURIComponent(libraryPathId)}/${encodeURIComponent(uploadId)}`,
        UploadAbortResponseSchema,
    );
}

/** Upload an ancillary file (subtitle, chapter, resource) for a media item. */
export function uploadAncillaryFile(
    libraryPathId: string,
    mediaItemId: string,
    file: File,
    type: 'subtitle' | 'chapter' | 'resource',
    uploadId?: string,
) {
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    return apiUpload(
        `/api/admin/upload/${encodeURIComponent(libraryPathId)}/ancillary/${encodeURIComponent(mediaItemId)}${uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : ''}`,
        UploadAncillaryResponseSchema,
        form,
    );
}

/** Recover the chapter rows and sidecar bytes replaced by an upload. */
export function undoUploadedChapterFile(
    libraryPathId: string,
    mediaItemId: string,
    receiptId: string,
    uploadId?: string,
) {
    const form = new FormData();
    form.append('undoReceiptId', receiptId);
    return apiUpload(
        `/api/admin/upload/${encodeURIComponent(libraryPathId)}/ancillary/${encodeURIComponent(mediaItemId)}${uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : ''}`,
        UploadAncillaryResponseSchema,
        form,
    );
}

// =========================================================================
// Ingest (Pipeline)
// =========================================================================

// ---------------------------------------------------------------------------
// Shared ingest Zod schemas (aligned to ingest-map.types.ts interfaces).
// ---------------------------------------------------------------------------

const MapItemSchema = z.object({
    media_item_id: z.string(),
    media_type: z.string(),
    title: z.string(),
    series_title: z.string().nullish(),
    season_number: z.number().nullish(),
    episode_number: z.number().nullish(),
    created_at: z.string(),
    stages: z.array(
        z.object({
            stage_id: z.string(),
            status: z.string(),
            attempt: z.number().optional(),
            processing_version: z.number().optional(),
            updated_at: z.string().optional(),
            error: z
                .object({ message: z.string(), code: z.string().optional() })
                .nullable()
                .optional(),
        }),
    ),
});

const SummaryBucketSchema = z.object({
    bucket_id: z.string(),
    total: z.number(),
    recent: z.number(),
});

export const IngestMapResponseSchema = z.object({
    items: z.array(MapItemSchema),
    summaryBuckets: z.array(SummaryBucketSchema).optional(),
    window: z.object({ since: z.string(), until: z.string() }),
    page: z.object({
        limit: z.number().int(),
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
    }),
});
export type IngestMapResponse = z.infer<typeof IngestMapResponseSchema>;

const ScanIssueEntrySchema = z.object({
    // Derived from the canonical list: a hand-copied enum that lags the server
    // makes this validated client REJECT the whole response the first time a
    // new issue type is written.
    type: z.enum(FILE_HEALTH_ISSUE_TYPES),
    detected_at: z.string(),
    attempt_count: z.number().optional(),
    next_retry_at: z.string().optional(),
    detail: z.string().optional(),
});

const ScanIssueRowSchema = z.object({
    file_path: z.string(),
    library_group_id: z.string().nullable(),
    issues: z.array(ScanIssueEntrySchema),
    created_at: z.string(),
    updated_at: z.string(),
});

export const IngestScanIssuesResponseSchema = z.object({
    issues: z.array(ScanIssueRowSchema),
    total: z.number(),
    truncated: z.boolean(),
});
export type IngestScanIssuesResponse = z.infer<typeof IngestScanIssuesResponseSchema>;

const StageActivityEntrySchema = z.object({
    stage_id: z.string(),
    last_completed_at: z.string().nullable(),
    completed_5m: z.number(),
    running: z.number(),
    failed_1h: z.number(),
});

const IngestStageProgressSchema = z.object({
    stage_id: z.string(),
    completed: z.number(),
    remaining: z.number(),
    notApplicable: z.number(),
    eligibleTotal: z.number(),
    completed_5m: z.number(),
    running: z.number(),
    failedRecent: z.number(),
    failed_transient: z.number().optional(),
    failed_permanent: z.number().optional(),
});

export const IngestStageActivityResponseSchema = z.object({
    stages: z.array(StageActivityEntrySchema),
    progress: z.array(IngestStageProgressSchema).optional().default([]),
});
export type IngestStageActivityResponse = z.infer<typeof IngestStageActivityResponseSchema>;

const PipelineSummarySchema = z.object({
    inFlight: z.number(),
    failedLastHour: z.number(),
    deadLetterItems: z.number(),
    running: z.number(),
    oldestPendingAgeSec: z.number().nullable(),
    degradedItems: z.number(),
    outboxBacklogReady: z.number().optional(),
    outboxBacklogInBackoff: z.number().optional(),
    // Optional so a stale/older cached payload without this field still
    // parses. See `PipelineSummary.reidentifyItems` in ingest-map.types.ts.
    reidentifyItems: z.number().optional(),
});

const StageErrorDetailSchema = z.object({
    message: z.string().optional(),
    code: z.string().optional(),
});

const StuckItemSchema = z.object({
    media_item_id: z.string(),
    title: z.string(),
    series_title: z.string().nullable(),
    season_number: z.number().nullable(),
    episode_number: z.number().nullable(),
    media_type: z.string(),
    stage_id: z.string(),
    status: z.string(),
    // Optional so older cached/snapshot payloads remain readable.
    reason: StuckItemReasonSchema.optional(),
    attempt: z.number(),
    last_error: StageErrorDetailSchema.nullable(),
    stuck_since: z.string(),
    stuck_age_sec: z.number(),
});

const DeadLetterItemSchema = z.object({
    media_item_id: z.string(),
    title: z.string(),
    series_title: z.string().nullable(),
    season_number: z.number().nullable(),
    episode_number: z.number().nullable(),
    media_type: z.string(),
    stage_id: z.string(),
    attempt: z.number(),
    last_error: StageErrorDetailSchema.nullable(),
    dead_since: z.string(),
    dead_age_sec: z.number(),
});

const ErrorGroupSchema = z.object({
    stage_id: z.string(),
    fingerprint: z.string(),
    sample_message: z.string(),
    error_code: z.string().nullable(),
    count: z.number(),
    first_seen: z.string(),
    last_seen: z.string(),
});

export const IngestDiagnosticsResponseSchema = z.object({
    summary: PipelineSummarySchema,
    stuckItems: z.array(StuckItemSchema),
    deadLetter: z.array(DeadLetterItemSchema),
    errorGroups: z.array(ErrorGroupSchema),
});
export type IngestDiagnosticsResponse = z.infer<typeof IngestDiagnosticsResponseSchema>;

const QueueDepthEntrySchema = z.object({
    resourceClass: z.string(),
    active: z.number(),
    waiting: z.number(),
    concurrencyCap: z.number(),
    paused: z.boolean(),
});

const PerTaskQueueDepthSchema = z.object({
    taskId: z.string(),
    active: z.number(),
    waiting: z.number(),
});

export const IngestQueueDepthsResponseSchema = z.object({
    queueDepths: z.array(QueueDepthEntrySchema),
    perTask: z.array(PerTaskQueueDepthSchema).optional(),
    error: z.string().nullable().optional(),
});
export type IngestQueueDepthsResponse = z.infer<typeof IngestQueueDepthsResponseSchema>;

/** Load the live pipeline map for a given time window. */
export function getIngestMap(
    window: '1h' | '24h' | '7d' | '30d' | 'all' = '24h',
    params?: { mediaType?: string[]; limit?: number },
) {
    const qs = new URLSearchParams({ window });
    if (params?.mediaType) params.mediaType.forEach((t) => qs.append('mediaType', t));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    return apiGet(`/api/admin/ingest/map?${qs.toString()}`, IngestMapResponseSchema);
}

/** List scan issues (audio files that failed tag parsing). */
export function getIngestScanIssues(limit?: number) {
    return apiGet('/api/admin/ingest/scan-issues', IngestScanIssuesResponseSchema, {
        params: limit !== undefined ? { limit } : undefined,
    });
}

/** Per-stage activity + headline-stage progress. */
export function getIngestStageActivity() {
    return apiGet('/api/admin/ingest/stage-activity', IngestStageActivityResponseSchema);
}

/** Aggregated diagnostic datasets (health strip, stuck, dead-letter, error groups). */
export function getIngestDiagnostics() {
    return apiGet('/api/admin/ingest/diagnostics', IngestDiagnosticsResponseSchema);
}

/** Current BullMQ queue depths per resource class. */
export function getIngestQueueDepths() {
    return apiGet('/api/admin/ingest/queue-depths', IngestQueueDepthsResponseSchema);
}

// =========================================================================
// Task System — Observability & Failure Detection
// =========================================================================

/**
 * GET /api/admin/task-system/observability
 *
 * Composed liveness view: heartbeats, class leaders, boot-recovery row,
 * component health, schedule countdowns, and a rollup health verdict.
 */
export function getTaskSystemObservability() {
    return apiGet('/api/admin/task-system/observability', ObservabilityResponseSchema);
}

/**
 * GET /api/admin/task-system/metrics
 *
 * Prometheus → JSON bridge: queue depths, run counts, duration histogram,
 * backpressure totals, stage backlogs.
 */
export function getTaskSystemMetrics() {
    return apiGet('/api/admin/task-system/metrics', MetricsBridgeResponseSchema);
}

/**
 * GET /api/admin/task-system/now
 *
 * Coalesced slow-changing snapshot for Mission Control: class snapshots,
 * node identities, schedule countdowns, health summary, embedding coverage.
 */
export function getTaskSystemNow() {
    return apiGet('/api/admin/task-system/now', NowSnapshotSchema);
}

/**
 * GET /api/admin/task-system/audit
 *
 * Audit-log feed (source='subsystem'): newest-first, cursor-paginated.
 */
export function getTaskSystemAuditFeed(
    opts: {
        categories?: string[];
        severity?: 'info' | 'warn' | 'error';
        since?: string;
        cursor?: string;
        limit?: number;
    } = {},
) {
    const pairs: [string, string][] = [];
    for (const c of opts.categories ?? []) pairs.push(['category', c]);
    if (opts.severity) pairs.push(['severity', opts.severity]);
    if (opts.since) pairs.push(['since', opts.since]);
    if (opts.cursor !== undefined) pairs.push(['cursor', opts.cursor]);
    if (opts.limit !== undefined) pairs.push(['limit', String(opts.limit)]);
    const qs = pairs.length > 0 ? `?${new URLSearchParams(pairs).toString()}` : '';
    return apiGet(`/api/admin/task-system/audit${qs}`, AuditFeedResponseSchema);
}

/**
 * GET /api/admin/task-system/failures/patterns
 *
 * Grouped failure patterns over a window, count-sorted.
 */
export function getTaskSystemFailurePatterns(
    opts: {
        source?: 'run' | 'item' | 'all';
        sinceHours?: number;
        limit?: number;
        taskId?: string;
    } = {},
) {
    const params: Record<string, string> = {};
    if (opts.source) params.source = opts.source;
    if (opts.sinceHours !== undefined) params.sinceHours = String(opts.sinceHours);
    if (opts.limit !== undefined) params.limit = String(opts.limit);
    if (opts.taskId) params.taskId = opts.taskId;
    const qs = Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
    return apiGet(`/api/admin/task-system/failures/patterns${qs}`, FailurePatternsResponseSchema);
}

/**
 * GET /api/admin/task-system/circuits
 *
 * Circuit-breaker fleet: open/half-open summary + per-task entries.
 */
export function getTaskSystemCircuits() {
    return apiGet('/api/admin/task-system/circuits', CircuitFleetResponseSchema);
}

/**
 * GET /api/admin/task-system/systemic
 *
 * Systemic-failure roll-up: stalled counts, backpressure shed,
 * orphans reclaimed, open circuits.
 */
export function getTaskSystemSystemic(sinceHours?: number) {
    const qs = sinceHours !== undefined ? `?sinceHours=${sinceHours}` : '';
    return apiGet(`/api/admin/task-system/systemic${qs}`, SystemicResponseSchema);
}

/**
 * GET /api/admin/task-system/trends
 *
 * Retained trend snapshots (oldest→newest) for in-app trend charts.
 */
export function getTaskSystemTrends(sinceHours?: number) {
    const qs = sinceHours !== undefined ? `?sinceHours=${sinceHours}` : '';
    return apiGet(`/api/admin/task-system/trends${qs}`, TrendsResponseSchema);
}

// =========================================================================
// Task System — Pipeline Remediation
// =========================================================================

/**
 * POST /api/admin/task-system/pipeline/accept-reidentify
 *
 * Stage-wide "accept as expected": flip non-retryable dead-letters to
 * skipped_permanent for a stage. Auth: tasks:admin.
 */
export function acceptReidentifyForStage(stageId: string) {
    return apiPost('/api/admin/task-system/pipeline/accept-reidentify', StageActionResponseSchema, {
        stageId,
    });
}

/**
 * POST /api/admin/task-system/pipeline/accept-reidentify-item
 *
 * Per-item "accept as expected": flip ONE non-retryable dead-letter to
 * skipped_permanent. Auth: tasks:admin.
 */
export function acceptReidentifyItem(mediaItemId: string, stageId: string) {
    return apiPost(
        '/api/admin/task-system/pipeline/accept-reidentify-item',
        StageActionResponseSchema,
        { mediaItemId, stageId },
    );
}

/**
 * POST /api/admin/task-system/pipeline/release-stuck
 *
 * Stage-wide release of wedged `running` rows whose owning run is no longer
 * active. Recovered rows become `failed_transient`. Auth: tasks:admin.
 */
export function releaseStuckForStage(stageId: string) {
    return apiPost('/api/admin/task-system/pipeline/release-stuck', StageActionResponseSchema, {
        stageId,
    });
}

/**
 * POST /api/admin/task-system/pipeline/requeue-dead-letter
 *
 * Requeue all dead-lettered pipeline events in the event_outbox.
 * Auth: tasks:admin.
 */
export function requeueDeadLetterEvents() {
    return apiPost(
        '/api/admin/task-system/pipeline/requeue-dead-letter',
        StageActionResponseSchema,
        {},
    );
}

/**
 * POST /api/admin/task-system/pipeline/retry-stage
 *
 * Stage-wide bulk retry: flip every `failed_permanent` row for a stage back
 * to `pending`. Auth: tasks:admin.
 */
export function retryStage(stageId: string) {
    return apiPost('/api/admin/task-system/pipeline/retry-stage', StageActionResponseSchema, {
        stageId,
    });
}

// Admin repair pickers share the quick-nav search contract. Filtering is server-side
// so episodes/tracks cannot consume the result window before series are selected.
export function searchFileEpisodeSeries(query: string) {
    return apiGet(
        `/api/admin/media/search?q=${encodeURIComponent(query)}&mediaType=series`,
        z.object({
            results: z.array(
                z.object({
                    id: z.string(),
                    title: z.string().nullable(),
                    year: z.number().nullable(),
                }),
            ),
        }),
    );
}

export function getRepairMediaFiles(mediaId: string) {
    return apiGet(
        `/api/admin/media/${mediaId}/files?children=true`,
        z.object({ files: z.array(z.object({ id: z.string(), file_path: z.string() })) }),
    );
}

export { recheckFileHealth, awaitFileHealthRecheck } from './file-health-recheck.js';
