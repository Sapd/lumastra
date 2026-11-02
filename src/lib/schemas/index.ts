// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod Schema Index
 *
 * Re-exports all schemas for convenient imports:
 * import { paginationSchema, createPlaylistSchema } from '$lib/schemas';
 *
 * Note: Some schemas have name conflicts. Import directly from specific
 * schema files when you need types that conflict (e.g., Visibility, RequestStatus).
 */

export * from './provider-calls.js';

// Common schemas
export * from './common';
export * from './public-author';
export * from './lenient-batch';

// API response schemas (SINGLE SOURCE OF TRUTH for response types)
export * from './api-responses';
export * from './api-common-responses';
export * from './api-media-responses';
export * from './api-series-responses';
export * from './api-search-responses';
export * from './api-conformance';
export { DEBUG_REPORT_ENUM_LITERALS } from './debug-report.js';

// New API response schemas for API client modules
export * from './api-admin-responses';
export * from './api-admin-unmatched-responses';
// `UserIdentitiesResponse`/`UserIdentitiesResponseSchema` are also defined in
// `./api-admin-responses` (legacy admin-only shape); re-export this module's
// version explicitly so the barrel has an unambiguous name to offer.
export * from './api-user-responses';
export type { UserIdentitiesResponse } from './api-user-responses';
export { UserIdentitiesResponseSchema } from './api-user-responses';
export * from './api-ai-responses';
export * from './api-browse-responses';
export * from './api-playback-responses';
export * from './api-content-responses';
export * from './api-for-you-responses';
export * from './api-stats-responses';

// Domain-specific schemas (validation + response types)
export * from './play-sessions';
export * from './playlists';
export * from './ai';
export * from './playback';
export * from './watch-together';
export * from './user';
export * from './admin';
export * from './admin-user';
export * from './request';
export * from './browse';
export * from './holidays';
export * from './bullmq-task-types';
export * from './livetv';
export * from './ingest-map';

// Internal type schemas (SINGLE SOURCE OF TRUTH)
// Note: Some exports are excluded to avoid conflicts with domain schemas above
// playback-types: PlaylistContext conflicts with playlists.ts - excluding it
export {
    ChapterInfoSchema,
    MediaSegmentTypeSchema,
    MediaSegmentSchema,
    NextEpisodeInfoSchema,
    NextPlaylistItemInfoSchema,
    TrickplayInfoSchema,
    LiveTvProgramInfoSchema,
    VideoStreamInfoSchema,
    AudioStreamInfoSchema,
    SubtitleStreamInfoSchema,
    MediaSourceInfoSchema,
    PlaybackVariantSchema,
    PlaybackInfoSchema,
    StreamOptionsSchema,
    PlaybackProgressReportSchema,
    ProgressRequestBodySchema,
    PlaybackEventTypeSchema,
    QualityModeSchema,
    TranscodingProfileSchema,
} from './playback-types';
export type {
    ChapterInfo,
    MediaSegmentType,
    MediaSegment,
    NextEpisodeInfo,
    NextPlaylistItemInfo,
    TrickplayInfo,
    LiveTvProgramInfo,
    VideoStreamInfo,
    AudioStreamInfo,
    SubtitleStreamInfo,
    MediaSourceInfo,
    PlaybackVariant,
    PlaybackInfo,
    StreamOptions,
    PlaybackProgressReport,
    ProgressRequestBody,
    PlaybackEventType,
    QualityMode,
    TranscodingProfile,
} from './playback-types';
export * from './personal-stats-types';
export * from './admin-types';
// notifications-types: conflicts with request.ts RequestStatus - import directly if needed
export {
    DownloadProgressSchema,
    NotificationMediaTypeSchema,
    SeasonStatusSchema,
    RequestNotificationSchema,
    RequestNotificationsStateSchema,
} from './notifications-types';
export type {
    DownloadProgress,
    NotificationMediaType,
    SeasonStatus,
    RequestNotification,
    RequestNotificationsState,
} from './notifications-types';
export * from './assistant-types';
export * from './plugin-types';
export * from './watched-types';
export * from './session-update';
// playlist-utils-types: excluded - all exports conflict with playlists.ts
// Import directly from './playlist-utils-types' if needed
// watch-together-core-types: conflicts with watch-together.ts - import directly if needed
export {
    ReactionEmojiSchema,
    ScreenEffectSchema,
    WatchTogetherEventSchema,
} from './watch-together-core-types';
export type { WatchTogetherEvent } from './watch-together-core-types';

// Shared audiobook identity, summary, and shared discovery preview.
export {
    AudiobookPersonRefSchema,
    AudiobookSeriesRefSchema,
    AudiobookKindSchema,
    AudiobookChapterSchema,
    AudiobookSummarySchema,
    type AudiobookPersonRef,
    type AudiobookSeriesRef,
    type AudiobookKind,
    type AudiobookChapter,
    type AudiobookSummary,
} from './api-audiobook.js';
export {
    AudiobookPreviewSchema,
    AudiobookPageSchema,
    type AudiobookPreview,
} from './api-audiobook-preview.js';

export { AudiobookFacetsSchema } from './api-audiobooks-responses.js';
export {
    PlaybackProgressSchema,
    buildPlaybackProgress,
    type PlaybackProgress,
} from './playback-progress.js';

export {
    ReplayItemSchema,
    ReplayRequestSchema,
    ReplayDocumentedRequestSchema,
    ReplayResponseSchema,
} from './play-session-replay.js';

export {
    ActivitySharingDefaultSchema,
    ApplyActivitySharingDefaultBodySchema,
    ActivitySharingDefaultAppliedSchema,
} from './activity-sharing.js';

export {
    ExtractBodySchema,
    ExtractResponseSchema,
    RegenerateBodySchema,
    RegenerateResponseSchema,
    type ExtractResponse,
    type RegenerateResponse,
} from './admin-image-extraction.js';

export { InitialScanStatusSchema, type InitialScanStatus } from './server-info.js';
