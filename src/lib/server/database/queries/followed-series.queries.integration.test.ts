// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getFollowedSeriesFromDb` — the explicit-follow half of the upcoming-episodes
 * filter. Pins the cast-safe join (other flag types store non-UUID target ids
 * in the same column) and the expiry rule.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id';
import { getFollowedSeriesFromDb } from './watch-state.queries.js';

describe('getFollowedSeriesFromDb (integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_media_flags', 'media_items', 'user_profiles', 'users']);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
    });

    async function series(title: string): Promise<string> {
        const id = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${id}::uuid, ${title}, 'tv', 'active', true)
        `;
        return id;
    }

    async function flag(targetId: string, flagType: string, expiresAt: Date | null = null) {
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type, expires_at)
            VALUES (${userId}::uuid, ${targetId}, 'series', ${flagType}, ${expiresAt})
        `;
    }

    it('lists followed series, ignoring expired follows and other flag types', async () => {
        const followed = await series('Starhaven');
        const expired = await series('Andara');
        const excluded = await series('Luma');
        await flag(followed, 'series_episode_notifications');
        await flag(expired, 'series_episode_notifications', new Date(Date.now() - 60_000));
        await flag(excluded, 'series_excluded');
        // Name-keyed and composite-keyed rows share the column; they must not break the cast.
        await flag('some series name', 'series_excluded');
        await flag('tmdb:1:movie', 'request_dismissed');

        const rows = await getFollowedSeriesFromDb.all(sql, {
            userId,
            deniedGroupIds: null,
            ageRating: null,
        });
        expect(rows.map((r) => r.series_name)).toEqual(['starhaven']);
    });
});
