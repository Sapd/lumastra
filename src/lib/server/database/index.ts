// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Database module exports
// Re-exports all database-related functionality for clean imports

export {
    Database,
    getDb,
    getTaskDb,
    getAdminDb,
    getHeartbeatDb,
    DB_POOL_MAX,
    DB_POOL_TOTAL_PER_INSTANCE,
    testDbConnection,
    closeDb,
    createExternalIdKey,
    parseExternalIdKey,
    buildExternalIdMap,
    buildExternalIdSet,
    ExternalIdMap,
    ExternalIdSet,
    // Deprecated aliases kept for test compatibility
    tmdbKey,
    parseTmdbKey,
} from './connection.js';

export type {
    ExternalIdKey,
    ExternalIdMediaType,
    ExternalIdKeyComponents,
    TmdbMediaType,
    TmdbMediaKey,
    UserProfile,
    UserRating,
    UserSuggestion,
    MediaEmbedding,
} from './connection.js';

export {
    MigrationSystem,
    generateMigrationChecksum,
    type MigrationRecord,
    type Migration,
} from './migration-system.js';

export { BASE_SCHEMA_MIGRATION, BASE_SCHEMA_VERSION } from './base-schema.js';

export { migrateSchema } from './migrate-schema.js';

export { withTx } from './with-tx.js';

// Media query utilities
export {
    // SQL fragments
    MediaQueryFragments,
    JsonbArrayExtractors,
    // ID resolution
    resolveMediaId,
    batchResolveMediaIds,
    buildMediaKey,
    parseMediaKey,
    // Query builders
    buildMediaQuery,
    mediaSelectFields,
    mediaJoins,
    // Result parsing
    parseMediaRow,
    // Types
    type TmdbMediaItem,
    type MediaQueryOptions,
    type ParsedMediaItem,
} from './queries/media-queries.js';
