// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test Cleanup Utilities
 *
 * Provides table truncation and data cleanup utilities for test isolation.
 */

import type postgres from 'postgres';
import { TRUNCATE_ADVISORY_LOCK_KEY } from '../setup/test-database.js';

/**
 * Tables organized by category for selective cleanup.
 */
export const TEST_TABLES = {
    // Core media tables (order matters for TRUNCATE: dependents first)
    media: [
        'media_file_items',
        'media_files',
        'media_item_stage_state',
        'event_outbox',
        // Intro-analyzer evidence rows (migration 16.184.0). They FK media_items
        // ON DELETE CASCADE, so the media TRUNCATE below already clears them —
        // listing them keeps the set explicit for anyone reading this as the
        // inventory of media-scoped test state.
        'media_segment_candidates',
        'media_titles',
        'media_items',
        'external_ids',
        'provider_metadata',
        'media_embeddings',
        'library_availability',
    ],

    // User data tables
    userData: [
        'user_ratings',
        // Watchlist contents live here since migration 16.259.0. Dependents
        // first: playlist_items FKs playlists ON DELETE CASCADE.
        'playlist_items',
        'playlists',
        'user_media_state',
        // Append-only event log (migration 12.44.0); cleared with state for
        // test isolation so a prior test's events don't leak into the next.
        'user_media_events',
        'user_suggestions',
        'user_profiles',
    ],

    // Watch tracking tables
    watchStatus: ['user_media_state', 'user_media_events', 'watch_history'],

    // Jellyfin content tables (tables dropped in migration 10.4.0 — kept as empty for compatibility)
    jellyfinContent: [] as string[],

    // User preferences
    // user_excluded_series was folded into user_media_flags (migration 16.108.0).
    // Tests that previously cleared user_excluded_series should clear user_media_flags instead.
    preferences: ['user_widget_order', 'user_playback_preferences', 'user_media_flags'],

    // Session/auth tables
    sessions: ['oauth_refresh_tokens'],

    // Media file tables (migration 11.22.0)
    mediaFiles: ['media_file_items', 'media_files'],

    // Sonic / Music-Map tables. media_audio_embeddings and
    // media_audio_map_coords FK media_items ON DELETE CASCADE (so a media
    // TRUNCATE already clears them), but mood_vectors is STANDALONE — it has no
    // FK to media_items and therefore survives a media TRUNCATE. Tests whose
    // assertions depend on the nearest-sonic-mood resolution must clear
    // mood_vectors explicitly for isolation, or rows another file leaves behind
    // bleed into their results. Listed here (dependents first) so callers can
    // truncate the exact set the Music-Map query reads in one shot.
    sonic: ['media_audio_map_coords', 'media_audio_embeddings', 'mood_vectors'],

    // All tables (for full cleanup)
    all: [
        'media_file_items',
        'media_files',
        'media_item_stage_state',
        'event_outbox',
        'media_segment_candidates',
        'media_titles',
        'media_items',
        'external_ids',
        'provider_metadata',
        'media_embeddings',
        'library_availability',
        'user_ratings',
        // Watchlist contents live here since migration 16.259.0. Dependents
        // first: playlist_items FKs playlists ON DELETE CASCADE.
        'playlist_items',
        'playlists',
        'user_media_state',
        'user_media_events',
        'user_suggestions',
        'user_profiles',
        'watch_history',
        'user_widget_order',
        'user_playback_preferences',
        // user_excluded_series folded into user_media_flags (migration 16.108.0)
        'user_media_flags',
        'user_taste_dampers',
        'oauth_refresh_tokens',
    ],
} as const;

/**
 * Truncate specified tables with CASCADE.
 * Fast cleanup for test isolation.
 */
export async function truncateTables(sql: postgres.Sql, tables: readonly string[]): Promise<void> {
    if (tables.length === 0) return;

    // Serialize all test TRUNCATEs behind a shared transaction-scoped advisory
    // lock so concurrent/overlapping resets across files can't deadlock on
    // CASCADE-overlapping tables. Mirrors truncateTestTables; see
    // TRUNCATE_ADVISORY_LOCK_KEY. Auto-releases on commit/rollback.
    const tableList = tables.join(', ');
    await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${TRUNCATE_ADVISORY_LOCK_KEY})`;
        await tx.unsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    });
}

/**
 * Truncate all test-related tables.
 */
export async function truncateAllTestTables(sql: postgres.Sql): Promise<void> {
    await truncateTables(sql, TEST_TABLES.all);
}

/**
 * Delete test data matching a specific pattern.
 * Useful for cleanup when truncation is too aggressive.
 */
export async function deleteTestDataByPattern(
    sql: postgres.Sql,
    table: string,
    column: string,
    pattern: string,
): Promise<number> {
    const result = await sql.unsafe(`DELETE FROM ${table} WHERE ${column} LIKE $1`, [
        `%${pattern}%`,
    ]);
    return result.count;
}

/**
 * Delete data created by a specific test user.
 */
export async function cleanupTestUser(sql: postgres.Sql, userId: string): Promise<void> {
    // Delete in order respecting foreign keys
    await sql`DELETE FROM user_ratings WHERE user_id = ${userId}`;
    await sql`DELETE FROM playlist_items WHERE playlist_id IN (
        SELECT id FROM playlists WHERE user_id = ${userId}
    )`;
    await sql`DELETE FROM playlists WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_media_state WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_media_events WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_suggestions WHERE user_id = ${userId}`;
    await sql`DELETE FROM watch_history WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_widget_order WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_playback_preferences WHERE user_id = ${userId}`;
    // user_excluded_series was folded into user_media_flags (migration 16.108.0)
    await sql`DELETE FROM user_media_flags WHERE user_id = ${userId}`;
    await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
}

/**
 * Delete media items created during tests (by ID prefix).
 * Also cleans up related external_ids, embeddings, etc.
 */
export async function cleanupTestMediaItems(sql: postgres.Sql, mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;

    // Delete in order respecting foreign keys
    await sql`DELETE FROM user_ratings WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM playlist_items WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM user_media_state WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM user_media_events WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM user_suggestions WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM library_availability WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM external_ids WHERE media_id = ANY(${mediaIds}::uuid[])`;
    await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds}::uuid[])`;
}

/**
 * Clean up test sessions and viewing data.
 */
export async function cleanupTestSessions(sql: postgres.Sql, sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;

    await sql`DELETE FROM watch_history WHERE id = ANY(${sessionIds}::uuid[])`;
}

/**
 * Batch cleanup helper that handles multiple operations atomically.
 */
export async function batchCleanup(
    sql: postgres.Sql,
    options: {
        userIds?: string[];
        mediaIds?: string[];
        sessionIds?: string[];
        tables?: readonly string[];
    },
): Promise<void> {
    // Use transaction for atomic cleanup
    // TransactionSql is API-compatible with Sql for template literals
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        if (options.tables && options.tables.length > 0) {
            await truncateTables(tx, options.tables);
            return; // Truncation handles everything
        }

        if (options.sessionIds && options.sessionIds.length > 0) {
            await cleanupTestSessions(tx, options.sessionIds);
        }

        if (options.mediaIds && options.mediaIds.length > 0) {
            await cleanupTestMediaItems(tx, options.mediaIds);
        }

        if (options.userIds) {
            for (const userId of options.userIds) {
                await cleanupTestUser(tx, userId);
            }
        }
    });
}
