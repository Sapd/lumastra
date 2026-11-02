// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the access boundary of `effectiveWatchingFor`.
 *
 * Security-critical: Continue Watching / Next Up are replayed from historical
 * watch state and must never surface media the user can no longer reach after
 * a policy change — neither directly (base rows) nor via the synthetic next-up
 * / new-episode injection paths that historically bypassed the allow-list
 * (findNextSequentialEpisode, getNewEpisodesForUser).
 *
 * This file exercises the base allow-list end-to-end (the same
 * `resolveAllowedMediaIds` funnel that H1's synthetic next-up and M1's
 * new-episode injection now reuse): a restricted user (denied library group OR
 * age cap) must NOT receive a Continue Watching row for restricted content,
 * while an unrestricted user does. A mocked SessionReadModel also exercises
 * real live-session overlay injection against the database boundary, including
 * a removed audiobook source. Sonarr-driven new-episodes are not asserted here.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/effective-watching.access.integration.test.ts
 *
 * Run against preprod:
 *   npm run test:integration -- src/lib/server/services/effective-watching.access.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import { effectiveWatchingFor } from './effective-watching.service.js';
import type { ActiveSessionView } from './session-read-model.service.js';

const liveSessions = vi.hoisted(() => ({ items: [] as ActiveSessionView[] }));
vi.mock('./session-read-model.service.js', () => ({
    getSessionReadModel: () => ({ getActiveSessionsForUser: async () => liveSessions.items }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a movie media_item with a single local file in the given library
 * group, plus an in-progress user_media_state row so it qualifies for the
 * Continue Watching query (resume_position_ms > 0, is_watched = false).
 *
 * Movies (no season/episode hierarchy) are the simplest deterministic CW
 * fixture — the base allow-list is media-type-agnostic, so a movie row proves
 * the library-group + age dimensions just as well as an episode.
 */
async function seedInProgressMovie(
    sql: postgres.Sql,
    opts: {
        userId: string;
        title: string;
        libraryGroupId: string;
        ageRating: number | null;
    },
): Promise<string> {
    const mediaId = randomUUID();
    const fileId = randomUUID();

    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, age_rating)
        VALUES (${mediaId}::uuid, ${opts.title}, 'movie', 'active', true, ${opts.ageRating})
    `;
    await sql`
        INSERT INTO media_files (id, file_path, library_group_id)
        VALUES (${fileId}::uuid, ${'/data/movies/' + opts.title + '.mkv'}, ${opts.libraryGroupId}::uuid)
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${mediaId}::uuid)
    `;
    await sql`
        INSERT INTO user_media_state (
            user_id, media_id, is_watched,
            resume_position_ms, runtime_ms,
            first_watched_at, last_event_at, last_event_source
        )
        VALUES (
            ${opts.userId}::uuid, ${mediaId}::uuid, false,
            1800000, 6000000,
            NOW(), NOW(), 'lumastra-player'
        )
    `;
    return mediaId;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let sql: postgres.Sql;

// Two library groups: one always allowed, one denied to the restricted user.
const ALLOWED_GROUP = randomUUID();
const DENIED_GROUP = randomUUID();

beforeAll(() => {
    sql = getTestDb() as unknown as postgres.Sql;
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    liveSessions.items = [];
    await truncateTables(sql, [
        ...TEST_TABLES.media,
        ...TEST_TABLES.watchStatus,
        ...TEST_TABLES.userData,
    ]);
    // media_files.library_group_id has a FK to library_groups(id); seed the
    // two groups so file inserts validate. Truncated above via CASCADE on
    // media_files, so re-create each run.
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES
            (${ALLOWED_GROUP}::uuid, 'Allowed Group'),
            (${DENIED_GROUP}::uuid, 'Denied Group')
        ON CONFLICT (id) DO NOTHING
    `;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('effectiveWatchingFor access boundary (Integration)', () => {
    it.each(['age', 'library', 'removed'] as const)(
        'rechecks an audiobook injected by a live session against the %s restriction',
        async (restriction) => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const mediaId = randomUUID();
            await sql`UPDATE library_groups SET max_age_rating = 18 WHERE id = ${DENIED_GROUP}::uuid`;
            await sql`INSERT INTO media_items
                (id, title, media_type, status, has_files, library_group_id)
                VALUES (${mediaId}::uuid, 'Live Adult Book', 'audiobook', 'active', true,
                        ${DENIED_GROUP}::uuid)`;
            const now = new Date();
            liveSessions.items = [
                {
                    sessionId: `sess-${mediaId}`,
                    source: 'lumastra',
                    sourceSessionId: null,
                    userId,
                    username: derivedUsername(userId),
                    displayName: null,
                    mediaId,
                    title: 'Live Adult Book',
                    hasFiles: true,
                    seriesId: null,
                    mediaType: 'audiobook',
                    positionMs: 35000,
                    runtimeMs: 120000,
                    status: 'PAUSED',
                    isPlaying: false,
                    startedAt: now,
                    lastHeartbeatAt: now,
                    lastSeenAt: now,
                    heartbeatAgeMs: 0,
                    isFresh: true,
                    isBuffering: false,
                },
            ];
            const input = {
                username: derivedUsername(userId),
                userId,
                limit: 20,
                sql,
                skipSuspicion: true,
            };
            const unrestricted = await effectiveWatchingFor(input);
            expect(unrestricted.continueWatching.map((item) => item.id)).toContain(mediaId);
            if (restriction === 'removed') {
                await sql`UPDATE media_items SET has_files = false, is_dismissed = true
                    WHERE id = ${mediaId}::uuid`;
            }
            const restricted = await effectiveWatchingFor({
                ...input,
                access:
                    restriction === 'removed'
                        ? undefined
                        : {
                              deniedGroupIds: restriction === 'library' ? [DENIED_GROUP] : null,
                              ageRating:
                                  restriction === 'age'
                                      ? { maxAgeRating: 12, allowUnrated: true }
                                      : null,
                          },
            });
            expect(restricted.continueWatching.map((item) => item.id)).not.toContain(mediaId);
        },
    );
    it('hides a denied-library-group Continue Watching row from a restricted user, but shows it to an unrestricted user', async () => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);

        const allowedMovieId = await seedInProgressMovie(sql, {
            userId,
            title: 'Allowed Group Movie',
            libraryGroupId: ALLOWED_GROUP,
            ageRating: null,
        });
        const deniedMovieId = await seedInProgressMovie(sql, {
            userId,
            title: 'Denied Group Movie',
            libraryGroupId: DENIED_GROUP,
            ageRating: null,
        });

        // Unrestricted user (no access boundary) sees both rows.
        const unrestricted = await effectiveWatchingFor({
            username: derivedUsername(userId),
            userId,
            limit: 20,
            sql,
            skipSuspicion: true,
        });
        const unrestrictedIds = unrestricted.continueWatching.map((i) => i.id);
        expect(unrestrictedIds).toContain(allowedMovieId);
        expect(unrestrictedIds).toContain(deniedMovieId);

        // Restricted user (denied the DENIED_GROUP) sees only the allowed row.
        const restricted = await effectiveWatchingFor({
            username: derivedUsername(userId),
            userId,
            limit: 20,
            sql,
            skipSuspicion: true,
            access: {
                deniedGroupIds: [DENIED_GROUP],
                ageRating: null,
            },
        });
        const restrictedIds = restricted.continueWatching.map((i) => i.id);
        expect(restrictedIds).toContain(allowedMovieId);
        expect(restrictedIds).not.toContain(deniedMovieId);
    });

    it('hides an over-age Continue Watching row from an age-capped user, but shows it to an unrestricted user', async () => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);

        // age_rating 12 is within cap; 18 is above the user's cap of 12.
        const kidsMovieId = await seedInProgressMovie(sql, {
            userId,
            title: 'Family Movie',
            libraryGroupId: ALLOWED_GROUP,
            ageRating: 12,
        });
        const adultMovieId = await seedInProgressMovie(sql, {
            userId,
            title: 'Adult Movie',
            libraryGroupId: ALLOWED_GROUP,
            ageRating: 18,
        });

        const unrestricted = await effectiveWatchingFor({
            username: derivedUsername(userId),
            userId,
            limit: 20,
            sql,
            skipSuspicion: true,
        });
        const unrestrictedIds = unrestricted.continueWatching.map((i) => i.id);
        expect(unrestrictedIds).toContain(kidsMovieId);
        expect(unrestrictedIds).toContain(adultMovieId);

        const capped = await effectiveWatchingFor({
            username: derivedUsername(userId),
            userId,
            limit: 20,
            sql,
            skipSuspicion: true,
            access: {
                deniedGroupIds: null,
                ageRating: { maxAgeRating: 12, allowUnrated: true },
            },
        });
        const cappedIds = capped.continueWatching.map((i) => i.id);
        expect(cappedIds).toContain(kidsMovieId);
        expect(cappedIds).not.toContain(adultMovieId);
    });
});
