// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test Fixtures Index
 *
 * Re-exports all test fixture utilities for convenient importing.
 *
 * @example
 * import { createTestMediaItem, createTestRating, insertTestWatchHistoryEntry } from '../../fixtures';
 */

// Media fixtures
export {
    type MediaType,
    type TestMediaItem,
    type TestExternalId,
    type TestMediaEmbedding,
    SAMPLE_MOVIES,
    SAMPLE_TV_SHOWS,
    createTestMediaItem,
    createTestExternalIds,
    createTestEmbedding,
    insertTestMediaItem,
    insertTestMediaItems,
    insertTestExternalIds,
    insertTestEmbedding,
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    createTestMovieBatch,
} from './media.fixtures.js';

// User fixtures
export {
    type TestUserRating,
    type TestWatchStateEntry,
    type TestUserProfile,
    TEST_USERS,
    generateTestUserId,
    derivedUsername,
    createTestRating,
    createTestRatingsBatch,
    createTestWatchStateEntry,
    createTestWatchStateBatch,
    insertTestRating,
    insertTestRatings,
    bulkInsertTestRatings,
    insertTestWatchStateEntry,
    insertTestWatchState,
    insertTestUserProfile,
    ensureTestUser,
    ensureTestUsers,
    createTestUserWithRatings,
    createRatingsTestScenario,
} from './user.fixtures.js';

// Episode fixtures
export {
    type TestJellyfinEpisode,
    type TestJellyfinSeason,
    type TestSeriesWithEpisodes,
    createTestEpisode,
    createTestSeason,
    createTestSeriesStructure,
    insertTestEpisode,
    insertTestEpisodes,
    insertTestSeason,
    insertTestSeasons,
    createAndInsertTestSeries,
    insertTestEpisodeWatchStatus,
    markEpisodesWatched,
    stripJellyfinIds,
} from './episode.fixtures.js';

// Music fixtures
export {
    type TestMusicArtist,
    type TestMusicAlbum,
    type TestMusicTrack,
    SAMPLE_MUSIC_ARTISTS,
    SAMPLE_MUSIC_ALBUMS,
    SAMPLE_MUSIC_TRACKS,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    createAndInsertTestMusicHierarchy,
    MUSIC_FIXTURE_EMBEDDING_DIMS,
    musicFixtureEmbedding,
    musicFixtureEmbeddingLiteral,
} from './music.fixtures.js';

// Session fixtures
export {
    type MediaType as SessionMediaType,
    type TestWatchHistoryEntry,
    type TestMovieWatchStatus,
    type TestOAuthToken,
    createTestWatchHistoryEntry,
    createTrendingWatchHistoryBatch,
    createAnalyticsWatchHistory,
    createTestMovieWatchStatus,
    createTestOAuthToken,
    createTestOAuthTokensBatch,
    insertTestWatchHistoryEntry,
    insertTestWatchHistoryEntries,
    insertTestMovieWatchStatus,
    insertTestOAuthToken,
    insertTestOAuthTokens,
    createTrendingTestScenario,
} from './session.fixtures.js';

// Library-group placement (access-boundary fixtures)
export {
    type PlaceableMediaType,
    type PlaceInLibraryGroupResult,
    placeInLibraryGroup,
} from './library-access.fixtures.js';
