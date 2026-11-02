// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for `user-notifier.service.ts` against the real test DB.
 *
 * Everything below the Jellyseerr boundary is real: `isInitializingWindow`
 * reads `library_paths`, the new-release rule runs on its actual SQL,
 * `publishUserEvent` persists through `insertNotification`, and the coalescing
 * guarantee is the migration-16.191.0 index rather than a stub. Only
 * `jellyseerrClient` is mocked — it is an outbound HTTP client.
 *
 * The four properties the design turns on (docs/architecture/user-events.md):
 *   1. the initializing window suppresses EVERYTHING,
 *   2. `series_excluded` is an unfollow the notifier honours,
 *   3. a notification never names an item the user cannot see,
 *   4. a ten-episode season drop is ONE row per user.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import type { Consumer } from '$lib/server/utils/sse-replay-hub.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { toUserId } from '$lib/shared/user-id.js';
import { upsertWatchlistItem } from '../database/queries/watchlist.queries.js';
import { getWatchlistPlaylistId } from '../database/queries/watchlist-playlist.queries.js';
import { createAccessGroup, addMember } from './access-control.service.js';
import {
    createAndInsertTestSeries,
    generateTestUserId,
    ensureTestUser,
    derivedUsername,
    insertTestEpisodeWatchStatus,
    type TestSeriesWithEpisodes,
} from '../../../../tests/integration/fixtures/index.js';

const jellyseerr = vi.hoisted(() => ({
    configured: false,
    requests: [] as unknown[],
    /** Call counter hook — proves WHEN the network call happens, not just that it did. */
    onGetRequests: (): void => {},
}));

// Isolate the notifier's scheduling clock, leaving the global timers used by
// postgres.js connection setup real, even when this test runs alone.
const requestDrainTimers = vi.hoisted(() => ({
    setTimeout: vi.fn(() => ({ unref: (): void => {} })),
    clearTimeout: vi.fn(),
}));
vi.mock('node:timers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:timers')>()),
    ...requestDrainTimers,
}));

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        isConfigured: () => jellyseerr.configured,
        getRequests: async () => {
            await jellyseerr.onGetRequests();
            return jellyseerr.requests;
        },
    },
    // The real enum, not a stand-in: the notifiable-status filter compares
    // against it, and a mock that drifted from jellyseerr.ts would make the
    // DECLINED test pass for the wrong reason.
    RequestStatus: { PENDING_APPROVAL: 1, APPROVED: 2, DECLINED: 3 },
}));

const {
    handleUserNotifiableMediaBecamePlayable,
    drainRequestAvailableChecks,
    EVENT_KIND_LIBRARY_NEW_EPISODE,
    EVENT_KIND_REQUEST_AVAILABLE,
} = await import('./user-notifier.service.js');
const { userEventsHub, publishUserEvent } = await import('./notification-events.service.js');
const { NOTIFICATION_EVENT_KIND_NAMES } = await import('../api/event-kinds.js');

const TABLES = [
    'user_notifications',
    'user_media_flags',
    'playlist_items',
    'playlists',
    'user_media_state',
    'user_media_events',
    'media_items',
    'external_ids',
    'library_paths',
    'library_groups',
    'user_profiles',
    'users',
] as const;

describe('user-notifier.service (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TABLES);
        requestDrainTimers.setTimeout.mockClear();
        requestDrainTimers.clearTimeout.mockClear();
        jellyseerr.configured = false;
        jellyseerr.requests = [];
        jellyseerr.onGetRequests = (): void => {};
        userEventsHub.consumers.clear();
    });

    afterEach(async () => {
        // Direct-handler cases also stage checks. Finish them against this
        // test's rows/mocks before the next test truncates or replaces them.
        await drainRequestAvailableChecks();
    });

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * A library_paths row older than the 48h initializing window, so
     * `isInitializingWindow()` is false. Every test that expects a
     * notification needs this; the one test that expects silence omits it.
     */
    async function libraryPathAgedBy(interval: string): Promise<void> {
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('Series')
            RETURNING id::text
        `;
        await sql.unsafe(
            `INSERT INTO library_paths (path, media_type, library_group_id, created_at)
             VALUES ('/data/series', 'tv', $1::uuid, now() - interval '${interval}')`,
            [group.id],
        );
    }

    const settledInstall = (): Promise<void> => libraryPathAgedBy('30 days');
    const freshInstall = (): Promise<void> => libraryPathAgedBy('10 minutes');

    let tmdbSeed = 880_001;

    /**
     * Season 1 aired two months ago (what `watchSeasonOne` watches), season 2
     * airs today: a whole new season released at once, a new release under
     * `new-release-rule.ts`.
     */
    async function makeSeries(): Promise<TestSeriesWithEpisodes> {
        const series = await createAndInsertTestSeries(sql, {
            tmdbId: tmdbSeed++,
            seasonCount: 2,
            episodesPerSeason: 10,
        });
        await sql`
            UPDATE media_items ep
            SET premiere_date = CURRENT_DATE - 60
            FROM media_items season
            WHERE ep.parent_id = season.id
              AND season.parent_id = ${series.seriesId}::uuid
              AND season.season_number = 1
        `;
        return series;
    }

    async function makeUser(overrides: { maxAgeRating?: number } = {}): Promise<string> {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        if (overrides.maxAgeRating !== undefined) {
            // `age_rating_pinned = true` alongside the column — under the
            // canonical formula (`computeOwnerMaxAge` in
            // resolve-token-user-access.ts) an UNPINNED `max_age_rating` is
            // ignored in favour of the group-derived cap, so a bare column
            // write here would make this fixture describe a realistic
            // condition (an admin-set cap) as if it were the default
            // (`age_rating_pinned boolean DEFAULT false`, base-schema-sql.ts)
            // — which the canonical formula treats as UNRESTRICTED. This is a
            // correction to match reality, not a weakened test: the maxAge
            // this fixture asks for is only actually enforced when pinned.
            await sql`
                UPDATE users
                SET max_age_rating = ${overrides.maxAgeRating}, age_rating_pinned = true
                WHERE id = ${userId}::uuid
            `;
        }
        return userId;
    }

    /**
     * A pinned admin with a pinned (admin-set) age cap — the shape the old
     * doc comment on `boundaryFor` described. Both pins matter for what this
     * fixture is proving: `admin_pinned` makes the admin verdict authoritative
     * (mirrors `computeOwnerIsAdminOverride`) and `age_rating_pinned` makes the
     * age column authoritative too — yet `resolveTokenUserAccess` still nulls
     * `maxAgeRating` for an admin unconditionally (`effectiveMaxAge = isAdmin
     * ? null : ...`), so this user's OWN pinned cap must not restrict them.
     */
    async function makePinnedAdmin(maxAgeRating: number): Promise<string> {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`
            UPDATE users
            SET is_admin = true,
                admin_pinned = true,
                max_age_rating = ${maxAgeRating},
                age_rating_pinned = true
            WHERE id = ${userId}::uuid
        `;
        return userId;
    }

    /** Make `userId` an ACTIVE viewer of the series: 3 recent watched episodes. */
    async function watchSeasonOne(
        userId: string,
        series: TestSeriesWithEpisodes,
        count = 3,
    ): Promise<void> {
        const season1 = series.seasons.find((s) => s.seasonNumber === 1)!;
        const episodes = season1.episodes.slice(0, count);
        for (const [i, ep] of episodes.entries()) {
            await insertTestEpisodeWatchStatus(sql, userId, ep.jellyfin_id, { isWatched: true });
            // Half an hour apart, newest last: separate viewing moments. Rows
            // stamped at the same instant are a bulk mark, which is not interest.
            await sql`
                UPDATE user_media_state ums
                SET last_watched_at = now() - make_interval(mins => ${(episodes.length - 1 - i) * 30}::int)
                FROM external_ids ei
                WHERE ei.provider = 'jellyfin' AND ei.media_type = 'episode'
                  AND ei.external_id = ${ep.jellyfin_id}
                  AND ums.media_id = ei.media_id AND ums.user_id = ${userId}::uuid
            `;
        }
    }

    /** Push a user's whole watch history `days` into the past, keeping its spacing. */
    async function ageWatchHistory(userId: string, days: number): Promise<void> {
        await sql`
            UPDATE user_media_state
            SET last_watched_at = last_watched_at - make_interval(days => ${days}::int)
            WHERE user_id = ${userId}::uuid
        `;
    }

    /** Add a specials season (S00) with one episode; returns the episode's media id. */
    async function addSpecial(series: TestSeriesWithEpisodes): Promise<string> {
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('Specials', 'season', ${series.seriesId}::uuid, 0, 'active')
            RETURNING id::text
        `;
        const [episode] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Special 1', 'episode', ${season.id}::uuid, 0, 1, 'active')
            RETURNING id::text
        `;
        return episode.id;
    }

    /** A calendar day `days` before today, as YYYY-MM-DD. */
    function daysAgoDate(days: number): string {
        return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }

    /**
     * The files of these episodes arrive now, together (one batch), with the
     * given air dates. The fixture's episodes air today and have no file.
     */
    async function arrive(
        mediaIds: readonly string[],
        airDate: (i: number) => string,
    ): Promise<void> {
        for (const [i, id] of mediaIds.entries()) {
            await sql`
                UPDATE media_items
                SET premiere_date = ${airDate(i)}::date, has_files = true, library_added_at = now()
                WHERE id = ${id}::uuid
            `;
        }
    }

    async function episodeMediaIds(series: TestSeriesWithEpisodes, seasonNumber: number) {
        const season = series.seasons.find((s) => s.seasonNumber === seasonNumber)!;
        const jellyfinIds = season.episodes.map((e) => e.jellyfin_id);
        const rows = await sql<{ media_id: string; external_id: string }[]>`
            SELECT media_id::text, external_id
            FROM external_ids
            WHERE provider = 'jellyfin'
              AND media_type = 'episode'
              AND external_id = ANY(${jellyfinIds})
        `;
        const order = new Map(jellyfinIds.map((id, i) => [id, i]));
        return rows
            .sort((a, b) => order.get(a.external_id)! - order.get(b.external_id)!)
            .map((r) => r.media_id);
    }

    async function dropSeason(series: TestSeriesWithEpisodes, seasonNumber: number): Promise<void> {
        for (const mediaId of await episodeMediaIds(series, seasonNumber)) {
            await handleUserNotifiableMediaBecamePlayable(sql, {
                event: 'media.becamePlayable',
                mediaId,
                mediaType: 'episode',
            });
        }
        // The request branch is STAGED inside the handler and delivered out of
        // the dispatcher's transaction (Jellyseerr is network I/O). In
        // production a debounced timer runs this; here we await it so the
        // assertions are deterministic rather than timing-dependent.
        await drainRequestAvailableChecks();
    }

    /**
     * Register a live SSE consumer for one user and collect its frames.
     * Mirrors the shape `streamResponse` builds once replay has drained.
     */
    function captureFrames(targetUserId: string): { frames: string[] } {
        const frames: string[] = [];
        const decoder = new TextDecoder();
        const consumer: Consumer = {
            controller: {
                enqueue: (chunk: Uint8Array): void => {
                    frames.push(decoder.decode(chunk));
                },
            } as unknown as ReadableStreamDefaultController<Uint8Array>,
            localBuffer: [],
            replayDone: true,
            targetUserId,
        };
        userEventsHub.consumers.add(consumer);
        return { frames };
    }

    async function notificationsFor(userId: string) {
        return sql<{ kind: string; payload: Record<string, unknown>; coalesce_key: string }[]>`
            SELECT kind, payload, coalesce_key
            FROM user_notifications
            WHERE user_id = ${userId}::uuid
            ORDER BY created_at
        `;
    }

    // ------------------------------------------------------------------
    // Wire-name contract
    // ------------------------------------------------------------------

    /**
     * `event-kinds.test.ts` proves the taxonomy's names appear as literals in
     * this emitter. This is the other direction: the literals this emitter
     * hands to `publishUserEvent` are ADVERTISED names, verbatim — so the pair
     * cannot drift apart by a typo on either side.
     *
     * A SUBSET check, not equality. It used to be equality, which was correct
     * only while this file was the sole emitter of every notification-class
     * kind. `admin.broadcast` (migration 16.209.0) is emitted by
     * `admin-broadcast.service.ts` instead, so requiring this file to account
     * for the whole taxonomy would fail for a kind it is not supposed to know
     * about. Nothing is lost: "every advertised kind has a real emitter
     * somewhere" is exactly what `event-kinds.test.ts`'s no-skip-list
     * `EMITTER_CHECKS` already enforces, per kind, and it is that test — not
     * this one — that fails when a kind is added with no emitter at all.
     */
    it('emits advertised notification kind names, verbatim', () => {
        const emitted = [EVENT_KIND_LIBRARY_NEW_EPISODE, EVENT_KIND_REQUEST_AVAILABLE];
        const advertised = new Set<string>(NOTIFICATION_EVENT_KIND_NAMES);
        const unadvertised = emitted.filter((kind) => !advertised.has(kind));
        expect(
            unadvertised,
            `this emitter writes wire strings that no kind advertises: ${unadvertised.join(', ')}`,
        ).toEqual([]);
    });

    // ------------------------------------------------------------------
    // 1. The initializing window
    // ------------------------------------------------------------------

    it('suppresses every notification during the initializing window', async () => {
        await freshInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series);

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it('emits once the initializing window has passed', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series);

        await dropSeason(series, 2);

        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe('library.new_episode');
        expect(rows[0].payload.seriesId).toBe(series.seriesId);
        expect(rows[0].payload.seasonNumber).toBe(2);
    });

    // ------------------------------------------------------------------
    // 2. series_excluded
    // ------------------------------------------------------------------

    it('suppresses a series the user excluded by UUID', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series);
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${series.seriesId}, 'series', 'series_excluded')
        `;

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it('suppresses a series the user excluded by its TMDB id', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series);
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${`tv:${series.tmdbId}`}, 'tmdb_tv', 'series_excluded')
        `;

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it('does not suppress a series on a title-keyed mute', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series);
        const [{ title }] = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${series.seriesId}::uuid
        `;
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${title.toUpperCase()}, 'series_name', 'series_excluded')
        `;

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(1);
    });

    // ------------------------------------------------------------------
    // 3. The access gate
    // ------------------------------------------------------------------

    it('suppresses a notification the user is age-gated out of', async () => {
        await settledInstall();
        const series = await makeSeries();
        const allowed = await makeUser();
        const blocked = await makeUser({ maxAgeRating: 12 });
        await watchSeasonOne(allowed, series);
        await watchSeasonOne(blocked, series);
        // Every row, not just the series: `accessibleTo` requires the EPISODE
        // id to clear the age filter too, and an untouched episode's
        // `age_rating` is NULL — with `UNRATED_CONTENT_VISIBLE` false by
        // default (config.ts) a NULL-rated episode is denied under ANY
        // finite-cap boundary regardless of the actual cap value, which would
        // let `blocked` stay correctly denied for the WRONG reason (fix-round-1
        // review finding 2) and mask a regression that only mis-computed the
        // cap comparison itself. Full-table UPDATE is safe: `beforeEach`
        // truncates `media_items`, so only this test's own series exists.
        await sql`UPDATE media_items SET age_rating = 18`;

        await dropSeason(series, 2);

        // `allowed` is the positive control: same series, same rating, an
        // unrestricted user — proves a denial below is the CAP deciding it,
        // not the delivery pipeline being broken.
        expect(await notificationsFor(allowed)).toHaveLength(1);
        expect(await notificationsFor(blocked)).toHaveLength(0);
    });

    // Security review 5, P1: the notifier used to read `max_age_rating` (and
    // `is_admin`/`groups`) straight off the `users` row, with no pin
    // awareness, no in-app cohort MIN and no group re-derivation — a fourth,
    // divergent copy of the age-cap formula every other surface computes via
    // `resolveTokenUserAccess`. Both cases below are over-GRANTS under that
    // old formula: a title above the user's REAL effective cap would have
    // reached them as a push notification, which is an existence leak.
    it('suppresses a notification the pinned column would allow but the in-app cohort caps below', async () => {
        await settledInstall();
        const series = await makeSeries();
        // Pinned 18 (an admin-set cap) PLUS an in-app cohort cap of 6 — the
        // canonical MIN-merge (computeOwnerMaxAge + the in-app cohort MIN in
        // resolveTokenUserAccess) makes the EFFECTIVE cap 6, not 18.
        const userId = await makeUser({ maxAgeRating: 18 });
        const group = await createAccessGroup(sql, {
            name: `kids6-pinned-${crypto.randomUUID()}`,
            capabilities: [{ capability: 'max_age_rating', value: '6' }],
        });
        expect(group.ok).toBe(true);
        if (!group.ok) return;
        await addMember(sql, group.data.id, userId, null);
        await watchSeasonOne(userId, series);
        // Every row in this series (the series row AND every episode) to 12:
        // `accessibleTo` requires the EPISODE id to pass the age filter too,
        // and an untouched episode row's `age_rating` is NULL — with
        // `UNRATED_CONTENT_VISIBLE` false by default a NULL-rated episode
        // would be denied regardless of the cap under test, confounding the
        // very comparison (18 vs. 6) this test exists to isolate. Full-table
        // UPDATE is safe: `beforeEach` truncates `media_items`, so only this
        // test's own series exists.
        await sql`UPDATE media_items SET age_rating = 12`;

        await dropSeason(series, 2);

        // 12 <= the old code's raw column (18) -> delivered under the bug.
        // 12 > the canonical effective cap (6) -> must NOT be delivered.
        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    // Positive control for the test above (fix-round-1 review finding 1):
    // "not delivered" alone does not distinguish the age cap actually
    // blocking the item from the resolver returning null, the in-app lookup
    // failing closed to cap 0, or the delivery pipeline being broken outright
    // — all of which would ALSO show up as zero notifications. Same pinned +
    // cohort setup, but the item now clears the MIN-merged effective cap (12
    // <= min(18, 12)), so it MUST be delivered.
    it('delivers when the item clears the pinned/cohort MIN-merged cap', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser({ maxAgeRating: 18 });
        const group = await createAccessGroup(sql, {
            name: `kids12-pinned-${crypto.randomUUID()}`,
            capabilities: [{ capability: 'max_age_rating', value: '12' }],
        });
        expect(group.ok).toBe(true);
        if (!group.ok) return;
        await addMember(sql, group.data.id, userId, null);
        await watchSeasonOne(userId, series);
        await sql`UPDATE media_items SET age_rating = 12`;

        await dropSeason(series, 2);

        // 12 <= min(18, 12) = 12 -> must be delivered.
        expect(await notificationsFor(userId)).toHaveLength(1);
    });

    it('suppresses a notification for a cohort-only age cap when the column is NULL', async () => {
        await settledInstall();
        const series = await makeSeries();
        // No column value at all (unpinned, NULL) — the most realistic
        // standalone-install shape, where the in-app cohort IS the age
        // mechanism. The old code read `max_age_rating` raw and treated a
        // NULL as fully unrestricted.
        const userId = await makeUser();
        const group = await createAccessGroup(sql, {
            name: `kids6-only-${crypto.randomUUID()}`,
            capabilities: [{ capability: 'max_age_rating', value: '6' }],
        });
        expect(group.ok).toBe(true);
        if (!group.ok) return;
        await addMember(sql, group.data.id, userId, null);
        await watchSeasonOne(userId, series);
        // See the identical comment in the pinned-cohort test above: the
        // episode id must ALSO clear the age filter, or a NULL-rated episode
        // (the fixture default) denies every finite-cap boundary regardless
        // of the actual cap value under test.
        await sql`UPDATE media_items SET age_rating = 12`;

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    // Positive control for the test above (fix-round-1 review finding 1) —
    // same cohort-only, NULL-column setup, item within the cap.
    it('delivers a cohort-only cap when the item clears it', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        const group = await createAccessGroup(sql, {
            name: `kids12-only-${crypto.randomUUID()}`,
            capabilities: [{ capability: 'max_age_rating', value: '12' }],
        });
        expect(group.ok).toBe(true);
        if (!group.ok) return;
        await addMember(sql, group.data.id, userId, null);
        await watchSeasonOne(userId, series);
        await sql`UPDATE media_items SET age_rating = 6`;

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(1);
    });

    // Fix-round-1 review finding 3: the notifier switching to
    // `resolveTokenUserAccess` widens admin behaviour on purpose (see the
    // `boundaryFor` doc comment and the task-8 report's "Admin semantics
    // finding") — an admin's OWN pinned age cap must NOT restrict them,
    // because `resolveTokenUserAccess` nulls `maxAgeRating` for every admin
    // unconditionally, matching what `checkMediaAccess` does for every other
    // admin-gated read path. This guards that INTENDED behaviour change: a
    // pinned admin with a pinned cap of 6 still gets a notification for an
    // item rated 12.
    it('delivers to a pinned admin regardless of their own pinned age cap (matches checkMediaAccess)', async () => {
        await settledInstall();
        const series = await makeSeries();
        const adminId = await makePinnedAdmin(6);
        await watchSeasonOne(adminId, series);
        await sql`UPDATE media_items SET age_rating = 12`;

        await dropSeason(series, 2);

        expect(await notificationsFor(adminId)).toHaveLength(1);
    });

    // ------------------------------------------------------------------
    // 4. Coalescing
    // ------------------------------------------------------------------

    it('turns a ten-episode season drop into one row per user', async () => {
        await settledInstall();
        const series = await makeSeries();
        const a = await makeUser();
        const b = await makeUser();
        await watchSeasonOne(a, series);
        await watchSeasonOne(b, series);

        await dropSeason(series, 2);

        expect(await notificationsFor(a)).toHaveLength(1);
        expect(await notificationsFor(b)).toHaveLength(1);
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM user_notifications
        `;
        expect(n).toBe(2);
    });

    /**
     * The race the sequential `dropSeason()` above cannot reproduce.
     *
     * The outbox dispatcher shards by `hashtext(media_item_id)` and drains
     * shards in PARALLEL, so two episodes of one season are handled at the same
     * time on any 8+ core host. Both emitters' `hasCoalescedNotificationToday`
     * pre-checks then pass — they are check-then-act reads in separate
     * transactions — and the unique index keeps exactly one row. Before the
     * insert's outcome gated delivery, the user still got TWO toasts for that
     * one row.
     *
     * Driven at `publishUserEvent` rather than through the handler on purpose:
     * two `Promise.all`'d handler calls happen to serialize often enough on the
     * connection pool that the assertion would pass with the bug present, which
     * is a test that proves nothing. These two land on the real index at the
     * same time, every run.
     */
    it('CONCURRENT emits for one coalesce key: one row AND one live frame', async () => {
        const userId = await makeUser();
        const live = captureFrames(userId);
        const data = {
            seriesId: '00000000-0000-0000-0000-0000000000aa',
            coalesceKey: 'series:00000000-0000-0000-0000-0000000000aa:s2',
        };

        await Promise.all([
            publishUserEvent({
                userId,
                kind: EVENT_KIND_LIBRARY_NEW_EPISODE,
                persist: true,
                data,
            }),
            publishUserEvent({
                userId,
                kind: EVENT_KIND_LIBRARY_NEW_EPISODE,
                persist: true,
                data,
            }),
        ]);

        expect(await notificationsFor(userId)).toHaveLength(1);
        expect(live.frames).toHaveLength(1);
        expect(live.frames[0]).toContain('event: library.new_episode');
    });

    it('parallel handler runs for one season still settle at one row per user', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series);

        const ids = await episodeMediaIds(series, 2);
        await Promise.all(
            ids.slice(0, 3).map((mediaId) =>
                handleUserNotifiableMediaBecamePlayable(sql, {
                    event: 'media.becamePlayable',
                    mediaId,
                    mediaType: 'episode',
                }),
            ),
        );

        expect(await notificationsFor(userId)).toHaveLength(1);
    });

    it('the index — not the handler — is what forbids the second row', async () => {
        const userId = await makeUser();
        const payload = { coalesceKey: 'series:x:s2' };
        await sql`
            INSERT INTO user_notifications (user_id, kind, payload)
            VALUES (${userId}::uuid, 'library.new_episode', ${sql.json(payload)})
        `;
        await expect(
            sql`
                INSERT INTO user_notifications (user_id, kind, payload)
                VALUES (${userId}::uuid, 'library.new_episode', ${sql.json(payload)})
            `,
        ).rejects.toThrow(/user_notifications_coalesce_daily_uniq|duplicate key/i);
    });

    it('leaves notifications without a coalesce key uncapped', async () => {
        const userId = await makeUser();
        for (let i = 0; i < 3; i++) {
            await sql`
                INSERT INTO user_notifications (user_id, kind, payload)
                VALUES (${userId}::uuid, 'device.state', ${sql.json({ seq: i })})
            `;
        }
        expect(await notificationsFor(userId)).toHaveLength(3);
    });

    // ------------------------------------------------------------------
    // Interest derivation
    // ------------------------------------------------------------------

    it('a season pack with old air dates never notifies, not even an active fan', async () => {
        // The Middle on prod, 2026-10: a viewer in the middle of a binge got a
        // push for every 2010–2016 episode as each requested season arrived.
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        const ids = await episodeMediaIds(series, 2);
        await arrive(ids, (i) => `2012-09-${String(1 + i).padStart(2, '0')}`);

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it("this week's episode notifies", async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        const [premiere] = await episodeMediaIds(series, 2);
        await arrive([premiere], () => daysAgoDate(1));

        await handleUserNotifiableMediaBecamePlayable(sql, {
            event: 'media.becamePlayable',
            mediaId: premiere,
            mediaType: 'episode',
        });

        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.mediaId).toBe(premiere);
        expect(rows[0].payload.reason).toBe('watching');
    });

    it('a recent episode inside a mostly old bulk arrival does not notify', async () => {
        // A newly added or requested series: nine old episodes and last
        // week's arrive together. That is a back catalogue, not a release.
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        const ids = await episodeMediaIds(series, 2);
        await arrive(ids, (i) =>
            i === ids.length - 1 ? daysAgoDate(5) : `2019-03-${String(1 + i).padStart(2, '0')}`,
        );

        await handleUserNotifiableMediaBecamePlayable(sql, {
            event: 'media.becamePlayable',
            mediaId: ids[ids.length - 1],
            mediaType: 'episode',
        });

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it('a follower who stopped watching long ago still hears about a new release', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        await ageWatchHistory(userId, 200);
        const ids = await episodeMediaIds(series, 2);
        await arrive([ids[4]], () => daysAgoDate(2));

        await handleUserNotifiableMediaBecamePlayable(sql, {
            event: 'media.becamePlayable',
            mediaId: ids[4],
            mediaType: 'episode',
        });

        expect(await notificationsFor(userId)).toHaveLength(1);
    });

    it('an episode the user has already watched does not notify them', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        // Watched already (another source had it first).
        const [premiere] = await episodeMediaIds(series, 2);
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
            VALUES (${userId}::uuid, ${premiere}::uuid, true, now())
        `;

        await handleUserNotifiableMediaBecamePlayable(sql, {
            event: 'media.becamePlayable',
            mediaId: premiere,
            mediaType: 'episode',
        });

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it('a user whose only history is one bulk mark is not a follower', async () => {
        // Prod 2026-10-02: an import marked whole series watched for every user
        // in one instant; each new season then pushed to ~30 users.
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 10);
        await sql`
            UPDATE user_media_state
            SET last_watched_at = now() - interval '200 days'
            WHERE user_id = ${userId}::uuid
        `;

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it("an episode row without its own season number takes the season row's", async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        const [premiereId] = await episodeMediaIds(series, 2);
        await sql`UPDATE media_items SET season_number = NULL WHERE id = ${premiereId}::uuid`;

        await handleUserNotifiableMediaBecamePlayable(sql, {
            event: 'media.becamePlayable',
            mediaId: premiereId,
            mediaType: 'episode',
        });

        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.seasonNumber).toBe(2);
    });

    it('an undated special never notifies; a special that aired this week does', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await watchSeasonOne(userId, series, 3);
        const specialId = await addSpecial(series);
        const playable = {
            event: 'media.becamePlayable' as const,
            mediaId: specialId,
            mediaType: 'episode' as const,
        };

        await handleUserNotifiableMediaBecamePlayable(sql, playable);
        expect(await notificationsFor(userId)).toHaveLength(0);

        await arrive([specialId], () => daysAgoDate(1));
        await handleUserNotifiableMediaBecamePlayable(sql, playable);
        expect(await notificationsFor(userId)).toHaveLength(1);
    });

    it('the watchlist alone, never started, does not notify', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await upsertWatchlistItem(sql, toUserId(userId), series.seriesId);

        await dropSeason(series, 2);

        expect(await notificationsFor(userId)).toHaveLength(0);
    });

    it('a watchlisted series the user has started notifies, reason watchlist', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await upsertWatchlistItem(sql, toUserId(userId), series.seriesId);
        await watchSeasonOne(userId, series, 1);

        await dropSeason(series, 2);

        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.reason).toBe('watchlist');
    });

    // A user can have more than one playlist_items row for the same media_id
    // on their watchlist playlist (a legal season-keyed duplicate under
    // idx_playlist_items_unique_media); it must still be one notification.
    it('a watchlisted series with a fan-out playlist_items row still notifies exactly once', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        await upsertWatchlistItem(sql, toUserId(userId), series.seriesId);
        await watchSeasonOne(userId, series, 1);
        const playlistId = await getWatchlistPlaylistId(sql, toUserId(userId));
        await sql`
            INSERT INTO playlist_items (playlist_id, media_id, season_number, episode_number, title, position)
            VALUES (${playlistId!}, ${series.seriesId}::uuid, 1, NULL, 'Fan-out row', 99)
        `;

        await dropSeason(series, 2);

        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.reason).toBe('watchlist');
    });

    it('reports the most explicit reason when a user is in several buckets', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        // Watching AND watchlisted AND explicitly following the same series.
        await watchSeasonOne(userId, series, 3);
        await upsertWatchlistItem(sql, toUserId(userId), series.seriesId);
        // Same shape the /series-notifications endpoint writes: target_type is
        // 'series' and target_id is the series UUID as text.
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${series.seriesId}, 'series', 'series_episode_notifications')
        `;

        await dropSeason(series, 2);

        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        // A deliberate opt-in must never be reported as passive watch history.
        expect(rows[0].payload.reason).toBe('following');
    });

    it('ignores a user with no expressed interest at all', async () => {
        await settledInstall();
        const series = await makeSeries();
        const bystander = await makeUser();

        await dropSeason(series, 2);

        expect(await notificationsFor(bystander)).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // request.available
    // ------------------------------------------------------------------

    it('skips the request branch entirely when Jellyseerr is not configured', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        jellyseerr.configured = false;
        jellyseerr.requests = [
            {
                id: 7,
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];

        await dropSeason(series, 2);

        const rows = await notificationsFor(userId);
        expect(rows.filter((r) => r.kind === 'request.available')).toHaveLength(0);
    });

    it('notifies the requester once when Jellyseerr is configured', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        jellyseerr.configured = true;
        jellyseerr.requests = [
            {
                id: 7,
                status: 2, // APPROVED
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];

        await dropSeason(series, 2);

        const rows = (await notificationsFor(userId)).filter((r) => r.kind === 'request.available');
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.mediaId).toBe(series.seriesId);
        expect(rows[0].payload.requestId).toBe(7);
    });

    it('never tells a user their DECLINED request is available', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        jellyseerr.configured = true;
        jellyseerr.requests = [
            {
                id: 8,
                status: 3, // DECLINED — the operator said no
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];

        await dropSeason(series, 2);

        const rows = (await notificationsFor(userId)).filter((r) => r.kind === 'request.available');
        expect(rows).toHaveLength(0);
    });

    // Fix-round-1 review finding 4: `accessibleTo`/`boundaryFor`/
    // `resolveNotifiableAccess` are shared by BOTH per-recipient loops, but
    // that is proof by construction, not by a test that actually drives this
    // branch — cover the request.available seam directly with the same
    // pinned/cohort divergence the new-episode cases above exercise.
    it('suppresses a request.available notification the pinned/cohort MIN-merge denies', async () => {
        const series = await makeSeries();
        const userId = await makeUser({ maxAgeRating: 18 });
        const group = await createAccessGroup(sql, {
            name: `kids6-request-${crypto.randomUUID()}`,
            capabilities: [{ capability: 'max_age_rating', value: '6' }],
        });
        expect(group.ok).toBe(true);
        if (!group.ok) return;
        await addMember(sql, group.data.id, userId, null);
        // Rate every row — see the identical comment on the new-episode cases:
        // `accessibleTo` also checks the EPISODE id here (`staged.itemId`),
        // and an untouched row's NULL `age_rating` would deny regardless of
        // the cap under test.
        await sql`UPDATE media_items SET age_rating = 12`;
        jellyseerr.configured = true;
        jellyseerr.requests = [
            {
                id: 20,
                status: 2, // APPROVED
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];

        await dropSeason(series, 2);

        const rows = (await notificationsFor(userId)).filter((r) => r.kind === 'request.available');
        // 12 <= the old code's raw column (18) -> delivered under the bug.
        // 12 > the canonical effective cap min(18, 6) = 6 -> must NOT be delivered.
        expect(rows).toHaveLength(0);
    });

    // Positive control for the test above (fix-round-1 review finding 1):
    // same pinned/cohort shape, item within the MIN-merged cap.
    it('delivers a request.available notification the pinned/cohort MIN-merge allows', async () => {
        const series = await makeSeries();
        const userId = await makeUser({ maxAgeRating: 18 });
        const group = await createAccessGroup(sql, {
            name: `kids12-request-${crypto.randomUUID()}`,
            capabilities: [{ capability: 'max_age_rating', value: '12' }],
        });
        expect(group.ok).toBe(true);
        if (!group.ok) return;
        await addMember(sql, group.data.id, userId, null);
        await sql`UPDATE media_items SET age_rating = 12`;
        jellyseerr.configured = true;
        jellyseerr.requests = [
            {
                id: 21,
                status: 2,
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];

        await dropSeason(series, 2);

        const rows = (await notificationsFor(userId)).filter((r) => r.kind === 'request.available');
        // 12 <= min(18, 12) = 12 -> must be delivered.
        expect(rows).toHaveLength(1);
    });

    it('asks Jellyseerr ONCE for a ten-episode season drop, outside the handler', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        jellyseerr.configured = true;
        jellyseerr.requests = [
            {
                id: 9,
                status: 2,
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];

        let calls = 0;
        jellyseerr.onGetRequests = () => {
            calls++;
        };

        // Ten `media.becamePlayable` events used to mean ten Jellyseerr round
        // trips, each inside a `FOR UPDATE` transaction. Staging keys by subject,
        // so the drain asks once for the whole season — and asks it after the
        // handler has returned.
        for (const mediaId of await episodeMediaIds(series, 2)) {
            await handleUserNotifiableMediaBecamePlayable(sql, {
                event: 'media.becamePlayable',
                mediaId,
                mediaType: 'episode',
            });
        }
        expect(calls).toBe(0); // nothing on the wire while the tx is open
        expect(requestDrainTimers.setTimeout).toHaveBeenCalledExactlyOnceWith(
            expect.any(Function),
            1_000,
        );

        await drainRequestAvailableChecks();
        expect(calls).toBe(1);
        expect(requestDrainTimers.clearTimeout).toHaveBeenCalledTimes(1);
        expect(
            (await notificationsFor(userId)).filter((r) => r.kind === 'request.available'),
        ).toHaveLength(1);
    });

    it('awaits a request drain that is already scanning Jellyseerr', async () => {
        await settledInstall();
        const series = await makeSeries();
        const userId = await makeUser();
        jellyseerr.configured = true;
        jellyseerr.requests = [
            {
                id: 10,
                status: 2,
                media: { tmdbId: series.tmdbId, mediaType: 'tv' },
                requestedBy: { id: 1, username: derivedUsername(userId) },
            },
        ];
        let releaseScan!: () => void;
        let reportScanStarted!: () => void;
        const blocked = new Promise<void>((resolve) => {
            releaseScan = resolve;
        });
        const scanStarted = new Promise<void>((resolve) => {
            reportScanStarted = resolve;
        });
        jellyseerr.onGetRequests = async () => {
            reportScanStarted();
            await blocked;
        };
        const [mediaId] = await episodeMediaIds(series, 2);
        await handleUserNotifiableMediaBecamePlayable(sql, {
            event: 'media.becamePlayable',
            mediaId,
            mediaType: 'episode',
        });
        const first = drainRequestAvailableChecks();
        let joined = false;
        try {
            await scanStarted;
            const second = drainRequestAvailableChecks().then(() => {
                joined = true;
            });
            await Promise.resolve();
            expect(joined).toBe(false);
            releaseScan();
            await Promise.all([first, second]);
            expect(joined).toBe(true);
        } finally {
            releaseScan();
            await first;
        }
        expect(
            (await notificationsFor(userId)).filter((r) => r.kind === 'request.available'),
        ).toHaveLength(1);
    });
});
