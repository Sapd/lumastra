// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Session Test Fixtures
 *
 * Provides factory functions for creating test watch history entries,
 * watch status records, and OAuth tokens.
 */

import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { generateTestId } from '../setup/test-database.js';
import { ensureTestUser } from './user.fixtures.js';
import { normalizeJellyfinId } from '../../../src/lib/server/utils/jellyfin-id.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'MOVIE' | 'EPISODE' | 'TV';

export interface TestWatchHistoryEntry {
    id: string;
    user_id: string;
    media_id: string; // jellyfin_id or other media identifier
    media_type: MediaType;
    session_start_time: Date;
    session_end_time: Date | null;
    actual_watch_time_seconds: number | null;
    resolution_width?: number;
}

export interface TestMovieWatchStatus {
    user_id: string;
    movie_jellyfin_id: string;
    is_watched: boolean;
    playback_position_ticks: number;
    runtime_ticks: number | null;
    watched_at: Date | null;
}

export interface TestOAuthToken {
    user_id: string;
    client_id: string;
    device_name: string | null;
    device_session_id: string;
    token: string;
    expires_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
}

// =============================================================================
// Factory Functions - Watch History
// =============================================================================

/**
 * Parse resolution string like '1080p' or '720p' to width/height.
 */
function parseResolution(resolution: string): { width: number; height: number } | null {
    const match = resolution.match(/^(\d+)p?$/);
    if (!match) return null;
    const height = parseInt(match[1], 10);
    // Common aspect ratio 16:9
    const width = Math.round((height * 16) / 9);
    return { width, height };
}

/**
 * Create a test watch history entry.
 */
export function createTestWatchHistoryEntry(
    userId: string,
    mediaId: string,
    mediaType: MediaType,
    options: {
        id?: string;
        startTime?: Date;
        endTime?: Date | null;
        watchTimeSeconds?: number;
        resolution?: string; // e.g., '1080p', '720p'
    } = {},
): TestWatchHistoryEntry {
    const startTime = options.startTime || new Date();
    const watchTimeSeconds = options.watchTimeSeconds ?? 30 * 60; // Default 30 min
    const endTime = options.endTime ?? new Date(startTime.getTime() + watchTimeSeconds * 1000);
    const parsedResolution = options.resolution ? parseResolution(options.resolution) : null;

    return {
        id: options.id || crypto.randomUUID(),
        user_id: userId,
        media_id: mediaId,
        media_type: mediaType,
        session_start_time: startTime,
        session_end_time: endTime,
        actual_watch_time_seconds: watchTimeSeconds,
        resolution_width: parsedResolution?.width,
    };
}

/**
 * Create a batch of watch history entries for trending calculations.
 */
export function createTrendingWatchHistoryBatch(
    mediaId: string,
    mediaType: MediaType,
    config: {
        userCount: number;
        sessionsPerUser?: number;
        watchTimeRange?: [number, number]; // [min, max] in seconds
        daysBack?: number;
    },
): TestWatchHistoryEntry[] {
    const sessions: TestWatchHistoryEntry[] = [];
    const sessionsPerUser = config.sessionsPerUser ?? 1;
    const [minWatch, maxWatch] = config.watchTimeRange ?? [300, 3600]; // 5 min to 1 hour
    const daysBack = config.daysBack ?? 7;

    for (let u = 0; u < config.userCount; u++) {
        const userId = randomUUID();

        for (let s = 0; s < sessionsPerUser; s++) {
            const startTime = new Date();
            startTime.setDate(startTime.getDate() - Math.floor(Math.random() * daysBack));

            const watchTime = Math.floor(Math.random() * (maxWatch - minWatch + 1)) + minWatch;

            sessions.push(
                createTestWatchHistoryEntry(userId, mediaId, mediaType, {
                    startTime,
                    watchTimeSeconds: watchTime,
                }),
            );
        }
    }

    return sessions;
}

/**
 * Create watch history entries spread over time for analytics testing.
 */
export function createAnalyticsWatchHistory(
    userId: string,
    mediaIds: string[],
    mediaType: MediaType,
    options: {
        daysBack?: number;
        sessionsPerItem?: number;
    } = {},
): TestWatchHistoryEntry[] {
    const sessions: TestWatchHistoryEntry[] = [];
    const daysBack = options.daysBack ?? 30;
    const sessionsPerItem = options.sessionsPerItem ?? 1;

    for (const mediaId of mediaIds) {
        for (let i = 0; i < sessionsPerItem; i++) {
            const dayOffset = Math.floor(Math.random() * daysBack);
            const startTime = new Date();
            startTime.setDate(startTime.getDate() - dayOffset);

            sessions.push(
                createTestWatchHistoryEntry(userId, mediaId, mediaType, {
                    startTime,
                }),
            );
        }
    }

    return sessions;
}

// =============================================================================
// Factory Functions - Watch Status
// =============================================================================

/**
 * Create a test movie watch status.
 */
export function createTestMovieWatchStatus(
    userId: string,
    movieJellyfinId: string,
    options: {
        isWatched?: boolean;
        playbackPositionTicks?: number;
        runtimeTicks?: number;
    } = {},
): TestMovieWatchStatus {
    const runtimeTicks = options.runtimeTicks ?? 2 * 60 * 60 * 10_000_000; // Default 2 hours
    const isWatched = options.isWatched ?? true;
    const playbackPositionTicks = options.playbackPositionTicks ?? (isWatched ? runtimeTicks : 0);

    return {
        user_id: userId,
        movie_jellyfin_id: movieJellyfinId,
        is_watched: isWatched,
        playback_position_ticks: playbackPositionTicks,
        runtime_ticks: runtimeTicks,
        watched_at: isWatched ? new Date() : null,
    };
}

// =============================================================================
// Factory Functions - OAuth Tokens
// =============================================================================

/**
 * Create a test OAuth token.
 */
export function createTestOAuthToken(
    username: string,
    options: {
        clientId?: string;
        deviceSessionId?: string;
        deviceName?: string;
        expiresInDays?: number;
        revoked?: boolean;
        lastUsed?: Date | null;
    } = {},
): TestOAuthToken {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (options.expiresInDays ?? 30));

    return {
        user_id: username,
        client_id: options.clientId || 'test-client',
        device_session_id: options.deviceSessionId || generateTestId('session'),
        device_name: options.deviceName ?? 'Test Device',
        token: crypto.randomUUID().replace(/-/g, '').slice(0, 64),
        expires_at: expiresAt,
        revoked_at: options.revoked ? new Date() : null,
        last_used_at: options.lastUsed ?? null,
    };
}

/**
 * Create multiple OAuth tokens for a user (different devices).
 */
export function createTestOAuthTokensBatch(
    username: string,
    deviceCount: number,
    options: {
        activeCount?: number; // How many should be non-revoked
        devices?: Array<{ name: string; lastUsedDaysAgo?: number }>;
    } = {},
): TestOAuthToken[] {
    const activeCount = options.activeCount ?? deviceCount;
    const tokens: TestOAuthToken[] = [];

    for (let i = 0; i < deviceCount; i++) {
        const device = options.devices?.[i];
        const lastUsed = device?.lastUsedDaysAgo
            ? new Date(Date.now() - device.lastUsedDaysAgo * 24 * 60 * 60 * 1000)
            : new Date();

        tokens.push(
            createTestOAuthToken(username, {
                deviceSessionId: generateTestId(`session_${i}`),
                deviceName: device?.name || `Device ${i + 1}`,
                revoked: i >= activeCount,
                lastUsed,
            }),
        );
    }

    return tokens;
}

// =============================================================================
// Insert Functions
// =============================================================================

/**
 * Insert a test watch history entry.
 * Resolves media_item_id from external_ids (jellyfin provider) if available.
 */
export async function insertTestWatchHistoryEntry(
    sql: Sql,
    session: TestWatchHistoryEntry,
): Promise<string> {
    await ensureTestUser(sql, session.user_id);
    // Resolve media_item_id UUID from Jellyfin ID via external_ids.
    // Normalize to dashless format because insertTestExternalIds normalizes before storing.
    const normalizedMediaId = normalizeJellyfinId(session.media_id);
    const mediaItemRows = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = 'jellyfin' AND external_id = ${normalizedMediaId}
        LIMIT 1
    `;
    const mediaItemId = mediaItemRows[0]?.media_id ?? null;

    const result = await sql<{ id: number }[]>`
        INSERT INTO watch_history (
            user_id, media_type, source_service, title,
            session_start_time, session_end_time,
            actual_watch_time_seconds, resolution_width,
            media_id
        )
        VALUES (
            ${session.user_id},
            ${session.media_type.toLowerCase()},
            'jellyfin',
            'Test Content',
            ${session.session_start_time},
            ${session.session_end_time},
            ${session.actual_watch_time_seconds},
            ${session.resolution_width ?? null},
            ${mediaItemId}
        )
        RETURNING id
    `;
    return String(result[0]?.id || session.id);
}

/**
 * Insert multiple watch history entries.
 */
export async function insertTestWatchHistoryEntries(
    sql: Sql,
    sessions: TestWatchHistoryEntry[],
): Promise<string[]> {
    const ids: string[] = [];
    for (const session of sessions) {
        await insertTestWatchHistoryEntry(sql, session);
        ids.push(session.id);
    }
    return ids;
}

/**
 * Insert a test movie watch status.
 */
export async function insertTestMovieWatchStatus(
    sql: Sql,
    status: TestMovieWatchStatus,
): Promise<void> {
    await sql`
        INSERT INTO user_movie_watch_status (
            user_id, movie_jellyfin_id, is_watched,
            playback_position_ticks, runtime_ticks, watched_at, updated_at
        )
        VALUES (
            ${status.user_id},
            ${status.movie_jellyfin_id},
            ${status.is_watched},
            ${status.playback_position_ticks},
            ${status.runtime_ticks},
            ${status.watched_at},
            NOW()
        )
        ON CONFLICT (user_id, movie_jellyfin_id) DO UPDATE SET
            is_watched = EXCLUDED.is_watched,
            playback_position_ticks = EXCLUDED.playback_position_ticks,
            runtime_ticks = EXCLUDED.runtime_ticks,
            watched_at = EXCLUDED.watched_at,
            updated_at = NOW()
    `;
}

/**
 * Insert a test OAuth token.
 */
export async function insertTestOAuthToken(sql: Sql, token: TestOAuthToken): Promise<number> {
    // token.user_id must be a users.id UUID (mig 16.46.0 — oauth_refresh_tokens.user_id is now uuid)
    await ensureTestUser(sql, token.user_id);
    const result = await sql<{ id: number }[]>`
        INSERT INTO oauth_refresh_tokens (
            user_id, client_id, device_name, device_session_id,
            token_hash, expires_at, revoked_at, last_used_at
        )
        VALUES (
            ${token.user_id}::uuid,
            ${token.client_id},
            ${token.device_name},
            ${token.device_session_id},
            ${token.token},
            ${token.expires_at},
            ${token.revoked_at},
            ${token.last_used_at}
        )
        RETURNING id
    `;
    return result[0].id;
}

/**
 * Insert multiple OAuth tokens.
 */
export async function insertTestOAuthTokens(sql: Sql, tokens: TestOAuthToken[]): Promise<number[]> {
    const ids: number[] = [];
    for (const token of tokens) {
        const id = await insertTestOAuthToken(sql, token);
        ids.push(id);
    }
    return ids;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create trending test scenario with multiple users watching content.
 */
export async function createTrendingTestScenario(
    sql: Sql,
    mediaItems: Array<{ mediaId: string; mediaType: MediaType }>,
    options: {
        usersPerItem?: number;
        minWatchTimeSeconds?: number;
    } = {},
): Promise<{
    sessionIds: string[];
    expectedScores: Map<string, number>;
}> {
    const usersPerItem = options.usersPerItem ?? 5;
    const minWatchTime = options.minWatchTimeSeconds ?? 300;
    const sessionIds: string[] = [];
    const expectedScores = new Map<string, number>();

    for (const { mediaId, mediaType } of mediaItems) {
        // Create varying number of sessions per item for different trending scores
        const userCount = Math.floor(Math.random() * usersPerItem) + 1;
        const sessions = createTrendingWatchHistoryBatch(mediaId, mediaType, {
            userCount,
            watchTimeRange: [minWatchTime, minWatchTime * 4],
        });

        const ids = await insertTestWatchHistoryEntries(sql, sessions);
        sessionIds.push(...ids);

        // Calculate expected trending score: (unique_viewers * 100) + total_watch_minutes
        const uniqueViewers = userCount;
        const totalWatchMinutes = sessions.reduce(
            (sum, s) => sum + (s.actual_watch_time_seconds ?? 0) / 60,
            0,
        );
        const score = uniqueViewers * 100 + Math.floor(totalWatchMinutes);
        expectedScores.set(mediaId, score);
    }

    return { sessionIds, expectedScores };
}
