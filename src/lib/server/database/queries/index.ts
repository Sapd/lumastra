// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Database Queries - Centralized Query Modules
 *
 * This module exports all centralized, typed query functions.
 * Use these instead of writing inline SQL in API routes and services.
 *
 * @example
 * ```typescript
 * import { userRatings, externalIds, watchHistory } from '$lib/server/database/queries';
 *
 * // Get user's rating
 * const rating = await userRatings.getUserRating.one(sql, { userId, mediaId });
 *
 * // Resolve TMDB ID to internal UUID
 * const mediaId = await externalIds.resolveFromTmdb.get(sql, { tmdbId: 550, mediaType: 'movie' });
 *
 * // Get trending movies
 * const trending = await watchHistory.getTrendingMovies.all(sql, { days: 7, limit: 20 });
 * ```
 */

export {
    FILE_HEALTH_RULE_VERSION,
    FILE_HEALTH_RECHECK_BATCH,
    listDueFileHealthRechecks,
    claimFileHealthRecheck,
    settleFileHealthRecheck,
    type FileHealthRecheckCandidate,
} from './file-health-recheck.queries.js';
export {
    getHealthSourceSnapshot,
    assertHealthSourceCurrent,
    getAdminTailAssessments,
    getAdminTailAssessmentsForMedia,
} from './file-health-assessment.queries.js';
export { lockLibraryScanFence } from './file-scanner-runs.queries.js';
export {
    findTrackFilesMissingDiscNumberByPrefix,
    type TrackFileMissingDiscNumber,
} from './media-files.queries.js';
export { ManualAlbumArtistAssignmentError } from './artist-merge.queries.js';
export { findRetentionArtists, findEmptyRetentionArtists } from './music-retention.queries.js';
export { classifiedMediaReferenceGuard } from './never-owned-media-gc.queries.js';

export { artistHasPlayableTrackSql } from './music.queries.js';

// Core typed query utilities
export {
    findMusicAlbumFolderTracks,
    type MusicAlbumFolderTrack,
} from './music-album-folder.queries.js';
export {
    defineQuery,
    defineWriteQuery,
    defineScalarQuery,
    defineExistsQuery,
    type TypedQuery,
    type TypedWriteQuery,
    type BaseMediaRow,
    type MediaRowWithTmdb,
    type MediaRowWithAvailability,
    type MediaRowWithEmbedding,
} from '../typed-query.js';

// External ID resolution queries
export * as externalIds from './external-ids.queries.js';
export {
    resolveFromTmdb,
    resolveFromJellyfin,
    resolveFromImdb,
    getTmdbId,
    getJellyfinId,
    getImdbId,
    existsByTmdb,
    existsByJellyfin,
    getAllExternalIds,
    batchResolveFromTmdb,
    batchResolveFromJellyfin,
    batchGetTmdbIds,
    buildTmdbKey,
    parseTmdbKey,
    // Provider-agnostic aliases (preferred for new code)
    resolvePrimaryExternalId,
    getPrimaryExternalId,
    batchResolvePrimaryExternalId,
    buildExternalIdKey,
    type Provider,
    type ExternalIdRow,
    type ResolvedMediaId,
    type AllExternalIds,
} from './external-ids.queries.js';

// User ratings queries
export * as userRatings from './user-ratings.queries.js';
export {
    getUserRating,
    getUserRatingByTmdb,
    hasUserRated,
    getUserRatings,
    getUserLikedMedia,
    getUserDislikedMedia,
    getUserRatingsWithMetadata,
    getUsersWhoRated,
    getUserRatingStats,
    getUserRatingCount,
    getUserTodayRatingCount,
    getUserRatingDistribution,
    getMediaAverageRating,
    upsertUserRating,
    deleteUserRating,
    deleteAllUserRatings,
    bulkInsertRatings,
    getDislikedMediaCTEFragment,
    getLikedMediaCTEFragment,
    // Extended queries
    getUserRatingsFullMetadata,
    deleteUserRatingsSimple,
    deleteUserSuggestions,
    deleteUserProfile,
    countUserRatings,
    countUserSuggestions,
    countUserProfiles,
    countUserWatchlist,
    ensureUserExists,
    ensureUserProfileExists,
    deleteUserSuggestionByMediaId,
    getMediaTypeById,
    type UserRatingRow,
    type UserRatingWithTmdb,
    type UserRatingWithMetadata,
    type UserRatingFullRow,
    type RatingStats,
    type RatingDistribution,
} from './user-ratings.queries.js';

// Watch history queries
export * as watchHistory from './watch-history.queries.js';
export {
    timeframeToInterval,
    timeframeToDays,
    getMediaWatchStats,
    getMediaWatchStatsInTimeframe,
    getTrendingMedia,
    getTrendingMovies,
    getTrendingEpisodes,
    getMediaViewers,
    getUserRecentWatchActivity,
    getRecentActivity,
    getUserWatchStats,
    getUserWatchStatsInTimeframe,
    getUserWatchCount,
    getPlaybackQualityStats,
    getTranscodingPercentage,
    getUsersWhoWatched,
    type Timeframe,
    type WatchHistoryRow,
    type WatchStatsRow,
    type TrendingMediaRow,
    type UserWatchActivityRow,
    type PlaybackQualityRow,
    type ViewerRow,
} from './watch-history.queries.js';

// Watch status queries (episodes + movies)
export * as watchStatus from './watch-status.queries.js';
export {
    // Episode watch status
    getSeriesEpisodesWithWatchStatus,
    getSeasonEpisodesWithWatchStatus,
    // Episode lookups
    getSeriesEpisodes,
    getSeasonEpisodes,
    getSeriesEpisodeIds,
    getSeasonEpisodeIds,
    // User watch history (UUID-based)
    hasUserWatched,
    batchGetWatchStatus,
    getWatchedStatusBatch,
    type EpisodeWatchStatusRow,
    type EpisodeRow,
} from './watch-status.queries.js';

// Watch state queries (UUID-based, provider-agnostic)
export * as watchState from './watch-state.queries.js';
export {
    getUserWatchState,
    batchGetUserWatchStates,
    getResumePositions,
    getWatchStateForProfile,
    type WatchStateRow,
    type WatchStateProfileRow,
} from './watch-state.queries.js';

// User watch history queries (reads from user_media_state)
export * as userWatchHistory from './user-watch-history.queries.js';
export {
    getWatchedItems,
    getWatchedMovies,
    getWatchedTvShows,
    getRecentWatchedMoviesWithEmbeddings,
    getRecentWatchedTvWithEmbeddings,
    getRecentWatchedWithTitles,
    getWatchedCount,
    getWatchedMovieCount,
    getWatchedTvCount,
    type WatchedItemRow,
    type WatchedItemWithTitleRow,
    type WatchedSourceRow,
} from './user-watch-history.queries.js';

// User excluded series queries
export * as userExcludedSeries from './user-excluded-series.queries.js';
export {
    getExcludedSeries,
    getExcludedSeriesKeys,
    resolveTmdbToCatalogIds,
    resolveCatalogIdsToExternal,
    removeExcludedSeriesById,
    upsertExcludedSeries,
    clearExcludedSeries,
    type ExcludedSeriesRow,
    type ExcludedSeriesKind,
} from './user-excluded-series.queries.js';

// User pinned genres queries
export * as userPinnedGenres from './user-pinned-genres.queries.js';
export {
    getPinnedGenres,
    getPinnedGenreNames,
    isGenrePinned,
    pinGenre,
    unpinGenre,
    type PinnedGenreRow,
} from './user-pinned-genres.queries.js';

// User preferences queries (widget order + playback)
export * as userPreferences from './user-preferences.queries.js';
export {
    getWidgetOrder,
    upsertWidgetOrderFull,
    upsertWidgetOrderOnly,
    upsertHiddenWidgetsOnly,
    deleteAllWidgetOrder,
    getPlaybackPreferences,
    upsertPlaybackPreferences,
    deletePlaybackPreferences,
    getFeedPreferences,
    upsertFeedPreferencesFull,
    loadFeedPrefsForUser,
    type WidgetOrderRow,
    type PlaybackPreferencesRow,
    type FeedPreferencesRow,
} from './user-preferences.queries.js';

// Device sessions queries (OAuth tokens)
export {
    getActiveSessions,
    getAllSessions,
    getDeviceSummary,
    updateSessionLastUsed,
    cleanupExpiredSessions,
    type OAuthRefreshTokenRow,
    type DeviceSessionRow,
} from './device-sessions.queries.js';

// =============================================================================
// MODULAR QUERY SYSTEM - New structured imports
// =============================================================================

// Fragment modules (SQL fragments for building queries)
export * as mediaFragments from './fragments/base-media.fragments.js';
export * as watchHistoryFragments from './fragments/watch-history.fragments.js';
export * as jsonbExtractors from './fragments/jsonb-extractors.js';

// Builder modules (query construction utilities)
export * as mediaQueryBuilder from './builders/media-query.builder.js';
export * as externalIdSubqueryBuilder from './builders/external-id-subquery.builder.js';
export * as providerMetadataBuilder from './builders/provider-metadata.builder.js';
export { buildContinueWatchingCompletionFilter } from './builders/continue-watching.builder.js';

// Resolver modules (ID resolution utilities)
export * as mediaIdResolver from './resolvers/media-id.resolver.js';

// Filter modules (WHERE clause helpers)
export * as watchHistoryFilters from './filters/watch-history.filters.js';

// =============================================================================
// SERVICE-SPECIFIC QUERY MODULES
// =============================================================================

// Episode ordering queries
export * as episodeOrderings from './episode-orderings.queries.js';
export {
    getSeriesOrdering,
    upsertSeriesOrdering,
    deleteSeriesOrdering,
    getEpisodeOrderings,
    findEpisodeByAbsoluteNumber,
    getAbsoluteNumber,
    hasOrderingsCache,
    deleteEpisodeOrderings,
    batchInsertEpisodeOrderings,
    resolveMediaIdFromTmdbId,
    resolveTmdbIdFromMediaId,
    type EpisodeOrderingType,
    type OrderingSource,
    type SeriesOrderingRow,
    type EpisodeOrderingRow,
    type EpisodeOrderingInsert,
} from './episode-orderings.queries.js';

export {
    deleteExpiredUploadSession,
    uploadStagingLibraryRoots,
    hasUploadStagingSession,
} from './upload-sessions.queries.js';

// Transcode jobs queries
export * as transcodeJobs from './transcode-jobs.queries.js';
export {
    retireOrphanedJob,
    getJob as getTranscodeJob,
    getJobsForPod,
    getAllActiveJobs,
    getJobsByPlaySessions,
    upsertJob,
    updateLastAccessed,
    updateLastProgress,
    updateStatus as updateTranscodeJobStatus,
    updateProgress as updateTranscodeJobProgress,
    deleteJob as deleteTranscodeJob,
    cleanupExpiredJobs,
    claimJobForRestoration,
    markPodJobsAsStopped,
    JobStatus,
    type TranscodeJobRow,
    type TranscodeJobInsert,
    type CleanedUpJobRow,
    type JobStatusRow,
} from './transcode-jobs.queries.js';

// Catalog operations queries
export * as catalogOperations from './catalog-operations.queries.js';
export {
    getMediaItemById,
    mediaItemExists,
    findMediaIdByExternalId,
    getExternalIdsForMedia,
    externalIdExists,
    batchResolveExternalIds,
    getProviderMetadata,
    hasProviderMetadata,
    isMediaAvailable,
    getLibraryAvailability,
    getImageMetadata,
    type MediaItemRow,
    type ExternalIdRow as CatalogExternalIdRow,
    type ProviderMetadataRow,
    type ImageMetadataRow,
} from './catalog-operations.queries.js';

// For-you helpers queries
export * as forYouHelpers from './for-you-helpers.queries.js';
export {
    getDislikedMediaIds,
    buildAvailabilityFilter,
    buildEmbeddingSourceFilter,
    getRandomPopularItem,
    type WatchedMediaRow,
    type RatedMediaRow,
    type RandomPopularItemRow,
} from './for-you-helpers.queries.js';

// Media lookup queries (UUID/Jellyfin resolution)
export * as mediaLookup from './media-lookup.queries.js';
export {
    mediaItemExistsByUuid,
    getMediaDetailsById,
    getMediaItemById as getBasicMediaItemById,
    getExternalIdsByMediaId,
    buildExternalIdsObject,
    resolveTmdbToUuid,
    getTmdbCompositeKeys,
    findSeriesByName,
    type MediaItemRow as MediaLookupItemRow,
    type MediaDetailsRow,
    type ExternalIdRecord,
    type SeriesSearchResult,
} from './media-lookup.queries.js';

// Embedding queries (read-only embedding operations)
export * as embeddings from './embeddings.queries.js';
export {
    getDualEmbedding,
    getLibraryEmbeddingCount,
    getDiscoveryEmbeddingCount,
    getTotalEmbeddingCount,
    type MediaCatalogMetadata,
    type DualEmbeddingResult,
} from './embeddings.queries.js';

// Media search queries (full-text, trigram, multi-field)
export * as mediaSearch from './search.queries.js';
export {
    searchMedia,
    searchMediaFulltext,
    searchMediaTrigram,
    searchEpisode,
    findSeriesContext,
    type SearchOptions,
    type FulltextSearchOptions,
    type SeriesSearchContext,
} from './search.queries.js';

// Browse queries (alphabetical, library filtering)
export * as browse from './browse.queries.js';
export {
    getMediaAlphabetical,
    buildGenreMembershipFilter,
    getAvailableLibraries,
    type AlphabeticalBrowseOptions,
    type AlphabeticalBrowseResult,
    type LibraryInfo,
} from './browse.queries.js';

// Episode search queries (full-text and trigram search)
export * as episodeSearch from './episode-search.queries.js';
export {
    prepareSearchTerms,
    searchEpisodesFullText,
    searchEpisodesTrigram,
    searchEpisodes,
    findEpisodeByNumber,
    findEpisodeBySeriesName,
    findEpisodeBySeriesExternalId,
    getSeriesEpisodesList,
    getSeasonEpisodesList,
    type EpisodeSearchResult,
    type EpisodeLookupResult,
    type EpisodeByNameLookupResult,
} from './episode-search.queries.js';

// Playback analytics queries (admin quality metrics)
export * as playbackAnalytics from './playback-analytics.queries.js';
export {
    getOverallStats,
    getTranscodingStats,
    getTranscodeReasons,
    getDeviceTypeStats,
    getStreamTypeStats,
    getClientTypeStats,
    getDailyTrends,
    getDailyByDeviceType,
    getUsersWithIssues,
    getDevicesWithIssues,
    getCommonIssues,
    getCrossTabAnalysis,
    clearAllTelemetryData,
    type OverallStatsRow,
    type TranscodingStatsRow,
    type DeviceTypeStatsRow,
    type StreamTypeStatsRow,
    type ClientTypeStatsRow,
    type DailyTrendRow,
    type UserWithIssuesRow,
    type DeviceWithIssuesRow,
    type CommonIssueRow,
    type DailyByDeviceTypeRow,
    type TranscodeReasonRow,
    type CrossTabAnalysisRow,
} from './playback-analytics.queries.js';

// OAuth Refresh Tokens queries
export {
    getDeviceApprover,
    hasConflictingDeviceSessionLineage,
    listApprovedDeviceSessionIds,
    revokeDeviceSessionTree,
} from './oauth-refresh-tokens.queries.js';
export * as oauthRefreshTokens from './oauth-refresh-tokens.queries.js';
export {
    validateRefreshToken,
    getActiveRefreshTokens,
    getDeviceNameBySession,
    createRefreshToken,
    updateRefreshTokenLastUsed,
    revokeRefreshToken,
    revokeAllUserRefreshTokens,
    revokeUserClientRefreshTokens,
    updateRefreshTokenGroups,
    cleanupRefreshTokens,
    type RefreshTokenRow,
    type CreateRefreshTokenParams as OAuthCreateRefreshTokenParams,
} from './oauth-refresh-tokens.queries.js';

// Provider Device Tokens queries
export * as providerDeviceTokens from './provider-device-tokens.queries.js';
export {
    getJellyfinTokenBySession,
    getActiveJellyfinTokens,
    upsertJellyfinToken,
    updateJellyfinTokenLastUsed,
    deleteJellyfinToken,
    revokeJellyfinToken,
    revokeAllUserJellyfinTokens,
    cleanupOrphanedJellyfinTokens,
    cleanupRevokedJellyfinTokens,
    type JellyfinDeviceTokenRow,
    type CreateJellyfinTokenParams as JellyfinCreateTokenParams,
} from './provider-device-tokens.queries.js';

// OAuth Device Codes queries
export * as oauthDeviceCodes from './oauth-device-codes.queries.js';
export {
    getDeviceCodeByDeviceCode,
    getDeviceCodeByUserCode,
    createDeviceCode,
    authorizeDeviceCode,
    denyDeviceCode,
    updateDeviceCodeStatus,
    recordDeviceCodePoll,
    deleteDeviceCode,
    cleanupExpiredDeviceCodes,
    countPendingDeviceCodes,
    consumeAuthorizedDeviceCode,
    type DeviceCodeRow,
    type DeviceCodeStatus,
    type CreateDeviceCodeParams,
} from './oauth-device-codes.queries.js';

// Library Permissions queries
export * as libraryPermissions from './library-permissions.queries.js';
export {
    getCachedPermissions,
    getStalePermissionUsers,
    upsertPermissions,
    deletePermissions,
    type JellyfinPermissionsRow,
    type UpsertPermissionsParams,
} from './library-permissions.queries.js';

// AI Sync queries
export * as aiSync from './ai-sync.queries.js';
export {
    // Series sync
    upsertJellyfinSeason,
    upsertJellyfinEpisode,
    episodeExists,
    // Embeddings
    upsertMediaEmbedding,
    embeddingExists,
    getSeriesInfoForProgress,
    // Types
    type JellyfinSeasonInsert,
    type JellyfinEpisodeInsert,
} from './ai-sync.queries.js';

// Metadata Aggregation queries
export * as metadataAggregation from './metadata-aggregation.queries.js';
export {
    FIELD_PRIORITY,
    FIELD_PRIORITY_DEFAULT,
    FIELD_PRIORITY_OVERRIDES,
    getFieldPriority,
    isProviderUsedInAggregation,
    aggregateMetadataForMedia,
    batchAggregateMetadata,
    getItemsNeedingAggregation,
    aggregateRecentlyUpdatedProvider,
    getAggregationStats,
    getDetailedAggregationStats,
} from './metadata-aggregation.queries.js';

// AI Admin queries (admin endpoints)
export * as aiAdmin from './ai-admin.queries.js';
export {
    // System stats
    getSystemStats,
    deleteExpiredSuggestions,
    // Suggestions
    deleteUserSuggestions as deleteUserSuggestionsAdmin,
    // Watch history stats
    getWatchHistoryStats,
    // Reset operations
    deleteAllMediaEmbeddings,
    deleteAllMediaItems,
    deleteLibraryAvailability,
    deleteAllExternalIds,
    deleteAllProviderMetadata,
    deleteEmbeddingsBySource,
    deleteProviderMetadataByProviders,
    // MDBList
    getMdblistCoverage,
    getMdblistTagStats,
    // Search
    searchMediaByTitle,
    // Types
    type SystemStats,
    type WatchHistoryStats,
    type ResetEmbeddingsResult,
    type MdblistCoverageResult,
    type MdblistTagStats,
    type EmbeddingSearchRow,
} from './ai-admin.queries.js';

// Playlists queries
export * as playlists from './playlists.queries.js';
export {
    getOwnedPlaylists,
    getSharedPlaylists,
    getPlaylistById,
    getPlaylistItems,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    deletePlaylistChatMessages,
    touchPlaylist,
    getNextPosition,
    insertPlaylistItem,
    getItemPosition,
    deletePlaylistItem,
    reorderItemsAfterDelete,
    verifyItemsBelongToPlaylist,
    updateItemPosition,
    bulkDeletePlaylistItems,
    recalculatePositions,
    verifyItemExists,
    upsertWatchedStatus,
    getPlaylistMembers,
    inviteMember,
    getPlaylistInvite,
    acceptInvite,
    deleteInvite,
    updateMemberRole,
    deleteMember,
    deleteMemberWatchedStatus,
    type CoverItemRow,
    type PlaylistRow,
    type PlaylistItemRow,
    type InsertedItemRow,
    type PlaylistMemberRow,
    type PlaylistInviteRow,
} from './playlists.queries.js';

// Playlist items queries (TV/music expansion)
export * as playlistItems from './playlist-items.queries.js';
export {
    getSeriesEpisodesForPlaylist,
    getAlbumTracks,
    type SeriesEpisodeRow,
    type AlbumTrackRow,
} from './playlist-items.queries.js';

// Media file resolution queries
export * as mediaFileResolution from './media-file-resolution.queries.js';
export { resolveMediaFiles } from './media-file-resolution.queries.js';

// OAuth Admin queries (auth/admin endpoints)
export * as oauthAdmin from './oauth-admin.queries.js';
export {
    upsertUserGroups,
    revokeOAuthTokenBySessionId,
    getHiddenUsers,
    setUserPrivacySetting,
    type TokenRevocationResult,
    type PrivacySetting,
} from './oauth-admin.queries.js';

// AI Assistant queries (AI assistant messages)
export * as assistant from './assistant.queries.js';
export {
    insertUserMessage,
    insertAssistantMessage,
    insertChatExchange,
    type InsertUserMessageParams,
    type InsertAssistantMessageParams,
} from './assistant.queries.js';

// =============================================================================
// LEGACY EXPORTS - Backwards compatibility (re-exports from media-queries.ts)
// =============================================================================

export {
    // Fragments
    MediaQueryFragments,
    WatchHistoryFragments,
    JsonbArrayExtractors,
    TypedJsonbExtractors,
    // Builders
    buildExternalIdSubquery,
    buildExternalIdSubqueries,
    prebuiltExternalIdSubqueries,
    prebuiltExternalIdSubqueries as ExternalIdSubqueries,
    buildExternalIdExistsChecks,
    prebuiltExternalIdExistsChecks,
    prebuiltExternalIdExistsChecks as ExternalIdExistsChecks,
    buildExternalIdExclusions,
    prebuiltExternalIdExclusions,
    prebuiltExternalIdExclusions as ExternalIdExclusions,
    buildJsonArrayExtract,
    buildMediaQuery,
    mediaSelectFields,
    mediaJoins,
    parseMediaRow,
    // Provider metadata
    getProviderArray,
    resetProviderArrayCache,
    buildMetadataProviderOrder,
    buildMetadataLateralJoin,
    buildMetadataLateralJoinFragment,
    getDynamicMediaQueryFragments,
    buildProviderFilterUnsafe,
    buildProviderOrderUnsafe,
    buildProviderMetadataSubquery,
    // Resolvers
    resolveMediaId,
    batchResolveMediaIds,
    buildMediaKey,
    parseMediaKey,
    resolveMediaIdByProvider,
    getExternalIds,
    resolveJellyfinIdToMediaId,
    getMediaExternalIds,
    // Filters (note: timeframeToDays is also exported from watch-history.queries.js)
    buildTimeWindowFilter,
    buildMinWatchTimeFilter,
    buildTimeframeFilter,
    buildCompletionFilter,
    // Types
    type TmdbMediaItem,
    type MediaQueryOptions,
    type MediaFieldOptions,
    type ParsedMediaItem,
    type DynamicMediaQueryFragments,
    // Note: Timeframe is exported from watch-history.queries.js
} from './media-queries.js';
export * from './media-annotations.queries.js';
export * from './media-segments.queries.js';
export {
    loadFingerprint,
    saveFingerprint,
    pruneCompletedSeasonFingerprints,
    type FingerprintIdentity,
} from './media-segment-fingerprints.queries.js';

// Media items queries (plugin system helpers)
export { getJellyfinItemCount } from './media-items.queries.js';

// Library paths (file scanner)
export {
    getAllLibraryPaths,
    getEnabledLibraryPaths,
    getEnabledLibraryPathsByProvider,
    getLibraryPathById,
    getLibraryPathsByGroup,
    createLibraryPath,
    updateLibraryPath,
    deleteLibraryPath,
    FILESYSTEM_LIBRARY_PROVIDERS,
    REMOTE_LIBRARY_PROVIDERS,
    type LibraryPathRow,
    type LibraryPathMediaType,
    type LibraryPathProvider,
    type CreateLibraryPathParams,
    type UpdateLibraryPathParams,
    type GetEnabledLibraryPathsOptions,
} from './library-paths.queries.js';

export * from './users.queries.js';
export * from './user-identities.queries.js';

// =============================================================================
// CENTRALIZED QUERY MODULES (from query-layer consolidation)
// =============================================================================

// Availability queries
export * as availability from './availability.queries.js';

// Media detail queries
export * as mediaDetails from './media-details.queries.js';

// Keyword media queries
export * as keywordMedia from './keyword-media.queries.js';

// Embedding statistics queries
export * as embeddingStats from './embedding-stats.queries.js';

// Latest embeddings queries
export * as latestEmbeddings from './latest-embeddings.queries.js';

// Watchlist media queries
export * as watchlistMedia from './watchlist-media.queries.js';

// Mood recommendation queries
export * as moodRecommendations from './mood-recommendations.queries.js';

// Assistant RAG queries
export * as assistantRag from './assistant-rag.queries.js';

// Play sessions queries
export * as playSessions from './play-sessions.queries.js';

// Season detail queries (season listing with watch progress)
export * as seasonDetail from './season-detail.queries.js';

// Episode detail queries (episode listing with watch state)
export * as episodeDetail from './episode-detail.queries.js';

// Embedding similarity queries (steered vector similarity)
export * as embeddingSimilarity from './embedding-similarity.queries.js';

// Social activity queries (watch activity with privacy filtering)
export * as socialActivity from './social-activity.queries.js';

// Provider preference queries (per-media provider overrides)
export * as providerPreference from './provider-preference.queries.js';

// Shared row types (namespace export to avoid conflicts with typed-query.ts BaseMediaRow)
export * as sharedRowTypes from './types/index.js';

// Admin nav pin queries
export * as adminNavPins from './admin-nav-pins.queries.js';
export {
    getNavPins,
    addNavPin,
    removeNavPin,
    type AdminNavPinRow,
} from './admin-nav-pins.queries.js';

// Sync quarantine queries (W2.1 — schema only, W2.2 will be the first writer)
export * as syncQuarantine from './sync-quarantine.queries.js';
export {
    quarantineWrite,
    archiveQuarantineSnapshot,
    hideQuarantineGroupSnapshot,
    restoreQuarantineDispositionBatch,
    listQuarantineDispositionHistory,
    type QuarantineDispositionKind,
    type QuarantineDispositionHistory,
    listUnresolvedQuarantine,
    listAllQuarantine,
    getQuarantineById,
    resolveQuarantine,
    countUnresolvedQuarantine,
    type QuarantineEntry,
    type QuarantineWrite,
    type QuarantineResolution,
} from './sync-quarantine.queries.js';

// Sonic Embeddings Admin queries
export * as sonicEmbeddingsAdmin from './sonic-embeddings-admin.queries.js';
export {
    getSonicEmbeddingsStats,
    type SonicEmbeddingsStats,
} from './sonic-embeddings-admin.queries.js';

// GDPR Export queries (Art. 15 data-subject export)
export * as gdprExport from './gdpr-export.queries.js';
export { collectUserExport, EXPORT_TABLE_ALLOWLIST } from './gdpr-export.queries.js';

// GDPR Erasure queries (Art. 17 right to erasure)
export * as gdprErasure from './gdpr-erasure.queries.js';
export {
    eraseUserData,
    erasureTombstone,
    ERASURE_TABLE_REGISTRY,
    STREAM_POLICY_SENTINEL,
    type ErasureResult,
    type ErasureTableReport,
    type ErasureStrategy,
    type ErasureKeyType,
    type ErasureTableEntry,
} from './gdpr-erasure.queries.js';

// NOTE: the training-assignments and compliance-reporting query re-exports are
// not part of this barrel: those modules are private and are imported directly
// by their own routes, so nothing here depends on them.

export {
    getTrackFeedback,
    clearTrackFeedback,
    setExplicitTrackRating,
} from './music-interactions.queries.js';

export { claimMusicPlayStart, isRecordedListenEvent } from './music-tracking.queries.js';

export {
    resolveStation,
    feedStationMap,
    stationIdsOfFeeds,
    type ResolvedStation,
} from './livetv-channels.queries.js';
export {
    getImageDescriptorOwners,
    imageDescriptorOwnersSql,
    effectivePosterSql,
    effectivePosterItemsSql,
} from './image-descriptor.queries.js';
export type { ImageOwnerRow, LocalImageInput, ArtworkRole } from './image-descriptor.queries.js';

// Audiobook catalog resources and sweep maintenance.
export * as audiobookCatalog from './audiobook-catalog.queries.js';
export {
    listCatalogBooks,
    listCatalogResources,
    getCatalogResource,
    catalogLetterCounts,
    catalogPreviews,
    audiobookPreviewsForAdmittedIds,
    type CatalogOptions,
    type CatalogBookRow,
    type ResourceOptions,
} from './audiobook-catalog.queries.js';
export {
    normalizeAudiobookName,
    syncAudiobookCatalog,
    cleanupAudiobookCatalog,
    lockAudiobookCatalog,
} from './audiobook-catalog-maintenance.queries.js';

export { audiobookDurationMs } from './audiobook-duration.js';
export { catalogFacets } from './audiobook-catalog.queries.js';
export {
    pruneSyncChanges,
    withSyncReset,
    checkSyncInstance,
    deleteSyncChangesForUser,
} from './sync-changes.queries.js';

// Rename/reconnect candidates and trickplay locator snapshots
export * as fileRematch from './file-rematch.queries.js';
export { applyActivitySharingDefault } from './activity-sharing.queries.js';

export * as albumLocalArt from './album-local-art.queries.js';
export {
    findLocalAlbumArtCandidates,
    markLocalAlbumArtChecked,
    getLocalAlbumTracks,
    persistAlbumReleaseIdentifiers,
    getAlbumReleaseIdentifiers,
    type AlbumReleaseIdentifiers,
    type LocalAlbumTrack,
} from './album-local-art.queries.js';

export { getLegacyLocalArtwork } from './media-artwork.queries.js';
export { getSuppressedImageProviders } from './image-candidates.queries.js';
export { getFileAssociationCounts } from './admin-file-associations.queries.js';

export { recordPatUsage, type PatUsageBatch } from './pat-usage.queries.js';

export { getRadioStreamUrl } from './radio-stream.queries.js';

export {
    sessionCarPlayContext,
    recordSessionCarPlayContext,
} from './play-session-client-context.queries.js';

export {
    availableAudiobookIds,
    refreshAudiobookLibrarySettings,
    retireAudiobookLibraryPath,
    preserveAudiobookLibraryAgeRating,
} from './audiobook-library.queries.js';

export {
    getLocalSyncFiles,
    getJellyfinPairings,
    queryJellyfinPairingStatus,
    type PushScope,
    type PairingCandidate,
    type FileInventoryState,
    type FileInventoryNeed,
    getLinkedJellyfinUsers,
    getFileInventoryState,
    needsFileInventory,
    lockFilePairing,
    claimFileInventory,
    saveFileInventory,
    saveFileInventoryItems,
    savePairingCandidates,
    getSyncProviderIdentities,
    requeueNewJellyfinPairing,
} from './jellyfin-file-pairing.queries.js';

export { updateEpgRefreshStatus } from './livetv-sources.queries.js';

export {
    getSourceFavoritesForImport,
    restoreSourceFavorites,
    type SourceFavoriteSnapshotRow,
} from './livetv-channels.queries.js';

export { getInitialScanKeys } from './file-scanner-runs.queries.js';
