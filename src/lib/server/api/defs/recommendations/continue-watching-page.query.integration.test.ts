// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
    generateTestUserId,
    placeInLibraryGroup,
} from '../../../../../../tests/integration/fixtures/index.js';
import { getExactContinueWatchingPageFromDb } from './continue-watching-page.query.js';
import { rebuildStateFromEvents } from '$lib/server/services/watch-state-rebuilder.service.js';
import type { UserId } from '$lib/shared/user-id';

describe('exact Continue Watching page query', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_flags',
            'user_media_events',
            'user_media_state',
            'media_file_items',
            'media_files',
            'external_ids',
            'media_items',
        ]);
    });

    it('orders globally by activity and applies offset/limit in SQL', async () => {
        const userId = generateTestUserId('cw_exact_page');
        await ensureTestUser(sql, userId);
        const movies = await Promise.all(
            ['Old', 'Middle', 'Newest'].map((title) =>
                createAndInsertTestMovie(sql, { title, withFileItem: true }),
            ),
        );
        const eventTimes = [
            '2026-07-01T10:00:00.000Z',
            '2026-07-02T10:00:00.000Z',
            '2026-07-03T10:00:00.000Z',
        ];
        for (let i = 0; i < movies.length; i++) {
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movies[i].id}::uuid`;
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms,
                    runtime_ms, watch_count, last_event_at, last_event_source
                ) VALUES (
                    ${userId}, ${movies[i].id}::uuid, false, 600000,
                    3600000, 0, ${eventTimes[i]}::timestamptz, 'integration-test'
                )
            `;
        }

        const rows = await getExactContinueWatchingPageFromDb.all(sql, {
            userId,
            limit: 1,
            minMs: 30_000,
            minPercent: 5,
            maxAgeDays: 0,
            deniedGroupIds: null,
            ageRating: null,
            page: {
                offset: 1,
                mediaTypes: ['movie'],
                staleAfterDays: 30,
                audiobookStaleAfterDays: 30,
                minProgressPercent: 5,
            },
        });

        expect(rows.map((row) => row.media_id)).toEqual([movies[1].id]);
    });

    it('suppresses a paused episode after a later episode was completed', async () => {
        const userId = generateTestUserId('cw_later_episode');
        await ensureTestUser(sql, userId);
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const pausedId = randomUUID();
        const completedId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${seriesId}, 'Series', 'tv', 'active', false)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
            VALUES (${seasonId}, 'Season 1', 'season', 'active', ${seriesId}, 1)
        `;
        await sql`
            INSERT INTO media_items (
                id, title, media_type, status, has_files, parent_id,
                season_number, episode_number, runtime_seconds
            ) VALUES
                (${pausedId}, 'Episode 1', 'episode', 'active', true, ${seasonId}, 1, 1, 3600),
                (${completedId}, 'Episode 2', 'episode', 'active', true, ${seasonId}, 1, 2, 3600)
        `;
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_event_at, last_watched_at, last_event_source
            ) VALUES
                (${userId}, ${pausedId}, false, 600000, 3600000, 0,
                 NOW() - INTERVAL '2 days', NULL, 'integration-test'),
                (${userId}, ${completedId}, true, 0, 3600000, 1,
                 NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 'integration-test')
        `;

        const rows = await getExactContinueWatchingPageFromDb.all(sql, {
            userId,
            limit: 10,
            minMs: 30_000,
            minPercent: 5,
            maxAgeDays: 0,
            deniedGroupIds: null,
            ageRating: null,
            page: {
                offset: 0,
                mediaTypes: ['episode'],
                staleAfterDays: 30,
                audiobookStaleAfterDays: 30,
                minProgressPercent: 5,
            },
        });

        expect(rows).toEqual([]);
    });

    it('hides upstream-watched E2 with a stale partial position until playback resumes', async () => {
        const userId = generateTestUserId('cw_page_upstream_watched');
        await ensureTestUser(sql, userId);
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const episodeId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${seriesId}, 'Series', 'tv', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
            VALUES (${seasonId}, 'Season 1', 'season', 'active', ${seriesId}, 1)
        `;
        await sql`
            INSERT INTO media_items (
                id, title, media_type, status, has_files, parent_id,
                season_number, episode_number, runtime_seconds
            ) VALUES (${episodeId}, 'Episode 2', 'episode', 'active', true, ${seasonId}, 1, 2, 2700)
        `;
        // Played arrived after the partial position but retained an old LastPlayedDate.
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, source, event_type, position_ms, runtime_ms, occurred_at, recorded_at
            ) VALUES
                (${userId}, ${episodeId}, 'lumastra-player', 'progress', 476056, 2700000,
                 NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes'),
                (${userId}, ${episodeId}, 'jellyfin-sync', 'mark_watched', NULL, 2700000,
                 NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 minute')
        `;
        const state = await rebuildStateFromEvents(sql, { userId, mediaId: episodeId });
        expect(state).toMatchObject({ is_watched: true, resume_position_ms: 476056 });
        const options = {
            userId,
            limit: 10,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 0,
            deniedGroupIds: null,
            ageRating: null,
            page: {
                offset: 0,
                mediaTypes: ['episode'],
                staleAfterDays: 30,
                audiobookStaleAfterDays: 30,
                minProgressPercent: 10,
            },
        };
        expect(await getExactContinueWatchingPageFromDb.all(sql, options)).toEqual([]);

        // Genuine playback after the report is a rewatch and must still surface.
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, source, event_type, position_ms, runtime_ms, occurred_at
            ) VALUES (${userId}, ${episodeId}, 'lumastra-player', 'progress', 500000, 2700000,
                      NOW() - INTERVAL '30 seconds')
        `;
        await rebuildStateFromEvents(sql, { userId, mediaId: episodeId });
        const rewatch = await getExactContinueWatchingPageFromDb.all(sql, options);
        expect(rewatch.map((row) => row.media_id)).toEqual([episodeId]);
    });

    it('surfaces a just-started long audiobook (sub-10%) via the flat minMs floor', async () => {
        const userId = generateTestUserId('cw_page_audiobook');
        await ensureTestUser(sql, userId);
        const bookId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${bookId}, 'Jenseits der Zeit', 'audiobook', 'active', true)
        `;
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_event_at, last_event_source
            ) VALUES (
                ${userId}, ${bookId}, false, ${6 * 60 * 1000}, ${14 * 60 * 60 * 1000},
                0, NOW() - INTERVAL '5 minutes', 'integration-test'
            )
        `;

        const rows = await getExactContinueWatchingPageFromDb.all(sql, {
            userId,
            limit: 10,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 0,
            deniedGroupIds: null,
            ageRating: null,
            page: {
                offset: 0,
                mediaTypes: null,
                staleAfterDays: 30,
                audiobookStaleAfterDays: 30,
                minProgressPercent: 10,
            },
        });

        expect(rows.map((row) => row.media_id)).toContain(bookId);
    });

    /**
     * C3 (2026-09-18 fix-plan-4): `user_media_state` only proves the caller had
     * access WHEN they watched the item, not that they still do. Seam per
     * Global Constraint 2: the query runs against real Postgres with two rows
     * — one the caller may currently see, one they may not — and the denied
     * row must be absent from the page, not merely absent from some
     * downstream filter.
     */
    describe('access boundary is honoured (differential)', () => {
        // Both a denied and an allowed group: the query itself requires
        // `has_files = true` (or a jellyfin external id) before a row can
        // surface at all, so "no files" is not a usable allowed-control here
        // the way it is for queries with no playability requirement — the
        // allowed row needs a REAL placement too, just in a group that is
        // never on the denied list.
        const DENIED_GROUP_NAME = 'Denied Continue-Watching Group';
        const ALLOWED_GROUP_NAME = 'Allowed Continue-Watching Group';
        let groupA: string;
        let groupB: string;

        beforeEach(async () => {
            groupA = randomUUID();
            groupB = randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupA}::uuid, ${DENIED_GROUP_NAME}), (${groupB}::uuid, ${ALLOWED_GROUP_NAME})
            `;
        });

        afterAll(async () => {
            await sql`
                DELETE FROM library_groups WHERE name IN (${DENIED_GROUP_NAME}, ${ALLOWED_GROUP_NAME})
            `;
        });

        async function seedResumable(opts: {
            userId: UserId;
            libraryGroupId: string;
            ageRating?: number | null;
        }): Promise<string> {
            const id = randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, age_rating)
                VALUES (
                    ${id}::uuid, ${`Boundary ${id.slice(0, 8)}`}, 'movie', 'active',
                    false, ${opts.ageRating ?? null}
                )
            `;
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                    watch_count, last_event_at, last_event_source
                ) VALUES (
                    ${opts.userId}, ${id}::uuid, false, 600000, 3600000,
                    0, NOW() - INTERVAL '1 hour', 'integration-test'
                )
            `;
            // Sets has_files = true as part of placement.
            await placeInLibraryGroup(sql, {
                mediaItemId: id,
                mediaType: 'movie',
                libraryGroupId: opts.libraryGroupId,
            });
            return id;
        }

        async function fetchIds(
            userId: UserId,
            deniedGroupIds: string[] | null,
            ageRating: { maxAgeRating: number | null; allowUnrated: boolean } | null,
        ): Promise<string[]> {
            const rows = await getExactContinueWatchingPageFromDb.all(sql, {
                userId,
                limit: 50,
                minMs: 30_000,
                minPercent: 5,
                maxAgeDays: 0,
                deniedGroupIds,
                ageRating,
                page: {
                    offset: 0,
                    mediaTypes: ['movie'],
                    staleAfterDays: 30,
                    audiobookStaleAfterDays: 30,
                    minProgressPercent: 5,
                },
            });
            return rows.map((row) => row.media_id);
        }

        it('excludes a resumable item whose file now sits in a denied library group', async () => {
            const userId = generateTestUserId('cw_boundary_library');
            await ensureTestUser(sql, userId);
            const denied = await seedResumable({ userId, libraryGroupId: groupA });
            const allowed = await seedResumable({ userId, libraryGroupId: groupB });

            // 1. Positive control — unrestricted access surfaces both rows.
            const open = await fetchIds(userId, null, null);
            expect(open).toEqual(expect.arrayContaining([denied, allowed]));

            // 2. Restricted — the denied row is gone, the allowed row survives.
            const restricted = await fetchIds(userId, [groupA], null);
            expect(restricted).toContain(allowed);
            expect(restricted).not.toContain(denied);
        });

        it('excludes a resumable item whose age rating now exceeds the caller ceiling', async () => {
            const userId = generateTestUserId('cw_boundary_age');
            await ensureTestUser(sql, userId);
            const adult = await seedResumable({ userId, libraryGroupId: groupB, ageRating: 18 });
            const family = await seedResumable({ userId, libraryGroupId: groupB, ageRating: 6 });

            const open = await fetchIds(userId, null, null);
            expect(open).toEqual(expect.arrayContaining([adult, family]));

            const limited = await fetchIds(userId, null, { maxAgeRating: 12, allowUnrated: true });
            expect(limited).toContain(family);
            expect(limited).not.toContain(adult);
        });
    });
});
