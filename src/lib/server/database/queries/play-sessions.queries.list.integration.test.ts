// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for getAllActiveSessionsWithMedia, the query behind the
 * "playing now" list. Each test names the bug it prevents.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    createPlaySession,
    getAllActiveSessionsWithMedia,
} from '$lib/server/database/queries/play-sessions.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

describe('getAllActiveSessionsWithMedia (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['play_sessions', 'user_devices', 'media_items']);
    });

    /** Series -> season -> episode chain, plus a movie, owned by nobody. */
    async function seedEpisode(): Promise<{ episodeId: string }> {
        const seriesId = crypto.randomUUID();
        const seasonId = crypto.randomUUID();
        const episodeId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status) VALUES
                (${seriesId}::uuid, 'Example Show', 'tv', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
            VALUES (${seasonId}::uuid, 'Season 2', 'season', 'active', ${seriesId}::uuid, 2)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number, runtime_seconds)
            VALUES (${episodeId}::uuid, 'Pilot', 'episode', 'active', ${seasonId}::uuid, 2, 5, 1800)
        `;
        return { episodeId };
    }

    async function startEpisodeSession(userId: UserId, mediaId: string, deviceId: string) {
        await createPlaySession(sql, {
            surface: 'web',
            media_id: mediaId,
            user_id: userId,
            device_id: deviceId,
            client_name: 'Lumastra tvOS',
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
            runtime_ms: 1800_000,
        });
    }

    it('returns the series title and season/episode numbers for an episode', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { episodeId } = await seedEpisode();
        await startEpisodeSession(userId, episodeId, 'device-episode-fields');

        const [row] = await getAllActiveSessionsWithMedia(sql, { userId });
        expect(row).toMatchObject({
            media_title: 'Pilot',
            series_title: 'Example Show',
            season_number: 2,
            episode_number: 5,
        });
    });

    it('prefers the custom device name over the reported name', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { episodeId } = await seedEpisode();
        await sql`
            INSERT INTO user_devices (user_id, device_id, reported_name, custom_name)
            VALUES (${userId}::uuid, 'device-named', 'Apple TV', 'Wohnzimmer')
        `;
        await startEpisodeSession(userId, episodeId, 'device-named');

        const [row] = await getAllActiveSessionsWithMedia(sql, { userId });
        expect(row.device_name).toBe('Wohnzimmer');
    });

    it('uses the reported device name when no custom name is set', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { episodeId } = await seedEpisode();
        await sql`
            INSERT INTO user_devices (user_id, device_id, reported_name, custom_name)
            VALUES (${userId}::uuid, 'device-reported', 'Apple TV', NULL)
        `;
        await startEpisodeSession(userId, episodeId, 'device-reported');

        const [row] = await getAllActiveSessionsWithMedia(sql, { userId });
        expect(row.device_name).toBe('Apple TV');
    });

    it('returns a null device name when the device was never registered', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { episodeId } = await seedEpisode();
        await startEpisodeSession(userId, episodeId, 'device-unregistered');

        const [row] = await getAllActiveSessionsWithMedia(sql, { userId });
        expect(row.device_name).toBeNull();
        expect(row.client_name).toBe('Lumastra tvOS');
    });
});
