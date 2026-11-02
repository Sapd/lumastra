// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scope resolution for GET /api/social/watch-activity/[id].
 *
 * The behaviour under test: episodes stay episode-scoped (no rollup to the
 * parent series) so the copy can honestly say "watched this episode", while
 * seasons still roll up and describe themselves as the series.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserContext } from '$lib/server/types.js';
import { toUserId } from '$lib/shared/user-id.js';
import * as messages from '$lib/paraglide/messages.js';

const { getUserDisplayInfoByIds } = vi.hoisted(() => ({
    getUserDisplayInfoByIds: vi.fn(async (_sql: unknown, ids: string[]) =>
        ids.map((id): { id: string; display_name: string | null } => ({
            id,
            display_name: 'Public Name',
        })),
    ),
}));

const {
    getMediaTypeAndParent,
    getRatedActivities,
    getWatchedActivities,
    getAudiobookListeningActivities,
    getOwnAudiobookListening,
    getAudiobookChapterTable,
    checkMediaAccess,
    resolveExternalIdToMediaId,
    getAnnotations,
} = vi.hoisted(() => ({
    getMediaTypeAndParent: vi.fn(),
    getRatedActivities: vi.fn(),
    getWatchedActivities: vi.fn(),
    getAudiobookListeningActivities: vi.fn(),
    getOwnAudiobookListening: vi.fn(),
    getAudiobookChapterTable: vi.fn(),
    checkMediaAccess: vi.fn(),
    resolveExternalIdToMediaId: vi.fn(),
    getAnnotations: vi.fn().mockResolvedValue([]),
}));

const mockFeatures = vi.hoisted(() => ({ social: true }));

const { resolveAnyMediaId } = vi.hoisted(() => ({ resolveAnyMediaId: vi.fn() }));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId },
}));

vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async () => new Map(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/social-activity.queries.js', () => ({
    getMediaTypeAndParent,
    getRatedActivities,
    getWatchedActivities,
    getAudiobookListeningActivities,
    getOwnAudiobookListening,
    getAudiobookChapterTable,
    resolveExternalIdToMediaId,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess }));
vi.mock('$lib/server/database/queries/media-queries.js', () => ({
    resolveMediaIdByProvider: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-annotations.queries.js', () => ({
    getAnnotations,
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds,
}));
vi.mock('$lib/server/config.js', () => ({ features: mockFeatures }));

// Aliases matching the extraction-seam tests below — same underlying mocks
// used by the scope-resolution suite above, just named to match what
// buildWatchActivity's own tests read from.
const mockGetAudiobookListeningActivities = getAudiobookListeningActivities;
const mockGetOwnAudiobookListening = getOwnAudiobookListening;
const mockGetAudiobookChapterTable = getAudiobookChapterTable;
const mockGetMediaTypeAndParent = getMediaTypeAndParent;
const mockGetWatchedActivities = getWatchedActivities;
const mockGetRatedActivities = getRatedActivities;
const mockGetAnnotations = getAnnotations;
const mockCheckMediaAccess = checkMediaAccess;
const mockResolveExternalIdToMediaId = resolveExternalIdToMediaId;
const mockResolveAnyMediaId = resolveAnyMediaId;

function makeUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-4000-8000-000000000099'),
        username: 'me',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: true,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

/**
 * Every message function returns its own key. Two reasons:
 *  - The real paraglide message index fails to load under the node vitest
 *    config (a known pre-existing condition in this repo), and importing it
 *    would take this whole suite down with it.
 *  - What matters here is WHICH key the scope logic selects, not its English
 *    wording — asserting on keys keeps the test stable if the copy is reworded.
 */
vi.mock('$lib/paraglide/messages.js', () => ({
    social_someone: () => 'Someone',
    social_episodes: () => 'social_episodes',
    social_one_episode: () => 'social_one_episode',
    social_rating_bad_1: () => 'social_rating_bad_1',
    social_rating_bad_2: () => 'social_rating_bad_2',
    social_rating_bad_3: () => 'social_rating_bad_3',
    social_rating_bad_4: () => 'social_rating_bad_4',
    social_rating_excellent_1: () => 'social_rating_excellent_1',
    social_rating_excellent_2: () => 'social_rating_excellent_2',
    social_rating_excellent_3: () => 'social_rating_excellent_3',
    social_rating_excellent_4: () => 'social_rating_excellent_4',
    social_rating_good_1: () => 'social_rating_good_1',
    social_rating_good_2: () => 'social_rating_good_2',
    social_rating_good_3: () => 'social_rating_good_3',
    social_rating_good_4: () => 'social_rating_good_4',
    social_rating_okay_1: () => 'social_rating_okay_1',
    social_rating_okay_2: () => 'social_rating_okay_2',
    social_rating_okay_3: () => 'social_rating_okay_3',
    social_rating_okay_4: () => 'social_rating_okay_4',
    social_rating_poor_1: () => 'social_rating_poor_1',
    social_rating_poor_2: () => 'social_rating_poor_2',
    social_rating_poor_3: () => 'social_rating_poor_3',
    social_rating_poor_4: () => 'social_rating_poor_4',
    social_reviewed: ({ name }: { name: string }) => `${name} reviewed`,
    social_tv_complete_1: () => 'social_tv_complete_1',
    social_tv_complete_2: () => 'social_tv_complete_2',
    social_tv_complete_3: () => 'social_tv_complete_3',
    social_tv_half_1: () => 'social_tv_half_1',
    social_tv_half_2: () => 'social_tv_half_2',
    social_tv_half_3: () => 'social_tv_half_3',
    social_tv_progress_episodes: () => 'social_tv_progress_episodes',
    social_tv_progress_high: () => 'social_tv_progress_high',
    social_tv_progress_percent: () => 'social_tv_progress_percent',
    social_tv_quarter: () => 'social_tv_quarter',
    social_tv_started_1: () => 'social_tv_started_1',
    social_tv_started_2: () => 'social_tv_started_2',
    social_tv_started_3: () => 'social_tv_started_3',
    social_watched_1: () => 'social_watched_1',
    social_watched_2: () => 'social_watched_2',
    social_watched_3: () => 'social_watched_3',
    social_watched_episode_1: () => 'social_watched_episode_1',
    social_watched_episode_2: () => 'social_watched_episode_2',
    social_watched_episode_3: () => 'social_watched_episode_3',
    social_watched_series_1: () => 'social_watched_series_1',
    social_watched_series_2: () => 'social_watched_series_2',
    social_watched_series_3: () => 'social_watched_series_3',
    // Reached via buildWatchActivity → buildAudiobookListeningEntries.
    // Missing here since 4c7e56e49 added the untagged-tail row, which took
    // out five tests in this file with "m.… is not a function" — the cost of
    // a hand-maintained mock list.
    audiobook_chapter_untagged_tail: () => 'audiobook_chapter_untagged_tail',
    social_listen_chapter: () => 'social_listen_chapter',
    social_listen_chapter_percent: () => 'social_listen_chapter_percent',
    social_listen_percent: () => 'social_listen_percent',
    social_listen_started: () => 'social_listen_started',
    social_listen_finished: () => 'social_listen_finished',
    social_listen_finished_times: () => 'social_listen_finished_times',
    social_listen_shared: () => 'social_listen_shared',
    social_listen_shared_together: () => 'social_listen_shared_together',
    social_listen_shared_ahead: () => 'social_listen_shared_ahead',
    social_listen_shared_ahead_one: () => 'social_listen_shared_ahead_one',
    social_listen_shared_ahead_timed: () => 'social_listen_shared_ahead_timed',
    social_listen_shared_ahead_one_timed: () => 'social_listen_shared_ahead_one_timed',
    social_listen_shared_behind_timed: () => 'social_listen_shared_behind_timed',
    social_listen_shared_behind_one_timed: () => 'social_listen_shared_behind_one_timed',
    social_listen_shared_ahead_time_only: () => 'social_listen_shared_ahead_time_only',
    social_listen_shared_behind_time_only: () => 'social_listen_shared_behind_time_only',
    // Reached indirectly, through formatDurationHoursMinutes.
    time_hours_abbr: () => 'time_hours_abbr',
    time_minutes_abbr: () => 'time_minutes_abbr',
    time_zero_minutes: () => 'time_zero_minutes',
    social_listen_shared_behind: () => 'social_listen_shared_behind',
    social_listen_shared_behind_one: () => 'social_listen_shared_behind_one',
}));

import { socialWatchActivityDef, buildWatchActivity } from './social-watch-activity.js';

const SERIES_ID = '11111111-1111-4111-8111-111111111111';
const EPISODE_ID = '22222222-2222-4222-8222-222222222222';
const SEASON_ID = '33333333-3333-4333-8333-333333333333';

/** One watcher, with no series progress counters. */
function oneWatcher() {
    return [
        {
            user_id: '44444444-4444-4444-8444-444444444444',
            username: 'alice',
            last_played_at: new Date(),
            play_count: 1,
            episodes_watched: null,
            total_episodes: null,
        },
    ];
}

async function callWith(id: string) {
    return socialWatchActivityDef.handlers.GET!(
        { locals: { user: { userId: 'me', username: 'me' } }, params: { id } } as never,
        {} as never,
    );
}

describe('social watch-activity scope resolution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.social = true;
        getRatedActivities.mockResolvedValue([]);
        getWatchedActivities.mockResolvedValue(oneWatcher());
        checkMediaAccess.mockResolvedValue(true);
    });

    it('keeps an episode scoped to itself and says "episode"', async () => {
        getMediaTypeAndParent.mockResolvedValue({
            id: EPISODE_ID,
            media_type: 'episode',
            parent_id: SERIES_ID,
        });

        const body = await (await callWith(EPISODE_ID)).json();

        // Queried against the EPISODE, not the parent series.
        expect(getWatchedActivities).toHaveBeenCalledWith(
            expect.anything(),
            EPISODE_ID,
            'episode',
            expect.anything(),
        );
        expect(body.activities[0].description).toMatch(/^social_watched_episode_/);
        // Series progress must not be attached to a single episode.
        expect(body.activities[0].progress).toBeUndefined();
    });

    it('says "series" on a series, not the bare "watched this"', async () => {
        getMediaTypeAndParent.mockResolvedValue({
            id: SERIES_ID,
            media_type: 'tv',
            parent_id: null,
        });

        const body = await (await callWith(SERIES_ID)).json();

        expect(getWatchedActivities).toHaveBeenCalledWith(
            expect.anything(),
            SERIES_ID,
            'tv',
            expect.anything(),
        );
        // This is the fallback path (null episode counters) that used to render
        // the vague "{name} has watched this".
        expect(body.activities[0].description).toMatch(/^social_watched_series_/);
    });

    it('still rolls a season up to its series', async () => {
        getMediaTypeAndParent
            .mockResolvedValueOnce({ id: SEASON_ID, media_type: 'season', parent_id: SERIES_ID })
            .mockResolvedValueOnce({ id: SERIES_ID, media_type: 'tv', parent_id: null });

        const body = await (await callWith(SEASON_ID)).json();

        // Rolled up: the query targets the SERIES, because there is no
        // per-season watch row to point at.
        expect(getWatchedActivities).toHaveBeenCalledWith(
            expect.anything(),
            SERIES_ID,
            'tv',
            expect.anything(),
        );
        expect(body.activities[0].description).toMatch(/^social_watched_series_/);
    });

    // ------------------------------------------------------------------
    // Edge cases found by an edge-case walk over the scoping change.
    // ------------------------------------------------------------------

    it('scopes a composite episode key, not just a UUID', async () => {
        // parseMediaId accepts `episode` tokens, and this branch used to cast
        // them to movie|tv and fall through to the generic "watched this".
        resolveExternalIdToMediaId.mockResolvedValue(EPISODE_ID);
        getMediaTypeAndParent.mockResolvedValue({
            id: EPISODE_ID,
            media_type: 'episode',
            parent_id: SERIES_ID,
        });

        const body = await (await callWith('tmdb:1399:episode')).json();

        expect(resolveExternalIdToMediaId).toHaveBeenCalledWith(
            expect.anything(),
            '1399',
            'episode',
        );
        expect(getWatchedActivities).toHaveBeenCalledWith(
            expect.anything(),
            EPISODE_ID,
            'episode',
            expect.anything(),
        );
        expect(body.activities[0].description).toMatch(/^social_watched_episode_/);
    });

    it('returns nothing when a season has no movie/series ancestor', async () => {
        // Broken or over-deep parent chain: the season row itself carries no
        // watch state, so querying it would render an empty list under a
        // header naming a series we never actually found.
        getMediaTypeAndParent
            .mockResolvedValueOnce({ id: SEASON_ID, media_type: 'season', parent_id: 'dangling' })
            .mockResolvedValueOnce(null);

        const body = await (await callWith(SEASON_ID)).json();

        expect(body.activities).toEqual([]);
        expect(getWatchedActivities).not.toHaveBeenCalled();
    });

    it('refuses a season whose parent is neither movie nor series', async () => {
        // Corrupted parent_id pointing at an unrelated row. The old guard
        // excluded only episode/season, so it would have adopted this and
        // described a music album as "this series".
        getMediaTypeAndParent
            .mockResolvedValueOnce({ id: SEASON_ID, media_type: 'season', parent_id: 'album-1' })
            .mockResolvedValueOnce({ id: 'album-1', media_type: 'album', parent_id: null });

        const body = await (await callWith(SEASON_ID)).json();

        expect(body.activities).toEqual([]);
        expect(getWatchedActivities).not.toHaveBeenCalled();
    });

    it('leaves movies with the unqualified wording', async () => {
        getMediaTypeAndParent.mockResolvedValue({
            id: SERIES_ID,
            media_type: 'movie',
            parent_id: null,
        });

        const body = await (await callWith(SERIES_ID)).json();

        expect(body.activities[0].description).toMatch(/^social_watched_[123]$/);
    });
});

describe('buildWatchActivity — extraction seam', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.social = true;
    });

    it('returns unavailable when FEATURE_SOCIAL is off', async () => {
        mockFeatures.social = false;
        const out = await buildWatchActivity({} as never, 'tmdb:550:movie', makeUser());
        expect(out).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('returns invalid-id for an unparseable id', async () => {
        const out = await buildWatchActivity({} as never, 'not-an-id', makeUser());
        expect(out).toEqual({ ok: false, reason: 'invalid-id' });
    });

    it('rolls a season up to its series before querying', async () => {
        mockGetMediaTypeAndParent
            .mockResolvedValueOnce({ id: 'season-1', media_type: 'season', parent_id: 'series-1' })
            .mockResolvedValueOnce({ id: 'series-1', media_type: 'tv', parent_id: null });
        mockGetWatchedActivities.mockResolvedValue([]);
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetAnnotations.mockResolvedValue([]);

        const out = await buildWatchActivity(
            {} as never,
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            makeUser(),
        );

        expect(out.ok).toBe(true);
        // The series id — NOT the season id — is what gets queried.
        expect(mockGetWatchedActivities).toHaveBeenCalledWith(
            expect.anything(),
            'series-1',
            'tv',
            expect.anything(),
        );
    });

    it('runs the access check on every call — there is no caller opt-out', async () => {
        mockGetMediaTypeAndParent.mockResolvedValue({
            id: 'x',
            media_type: 'movie',
            parent_id: null,
        });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetWatchedActivities.mockResolvedValue([]);
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetAnnotations.mockResolvedValue([]);

        await buildWatchActivity({} as never, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', makeUser());

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            'x',
            expect.anything(),
        );
    });

    it('runs the access check when the caller has not already done it', async () => {
        mockGetMediaTypeAndParent.mockResolvedValue({
            id: 'x',
            media_type: 'movie',
            parent_id: null,
        });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetWatchedActivities.mockResolvedValue([]);
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetAnnotations.mockResolvedValue([]);

        await buildWatchActivity({} as never, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', makeUser());

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            'x',
            expect.anything(),
        );
    });
});

/**
 * The access check follows the row this function RESOLVED, which the season
 * roll-up and the external-id fallbacks can move away from whatever id the
 * caller saw. There is no caller opt-out to get this wrong with.
 */
describe('buildWatchActivity — access check follows the target', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.social = true;
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetWatchedActivities.mockResolvedValue([]);
        mockGetAnnotations.mockResolvedValue([]);
        mockCheckMediaAccess.mockResolvedValue(true);
    });

    it('re-checks access on the series when a season rolls up to it', async () => {
        mockGetMediaTypeAndParent
            .mockResolvedValueOnce({ id: SEASON_ID, media_type: 'season', parent_id: SERIES_ID })
            .mockResolvedValueOnce({ id: SERIES_ID, media_type: 'tv', parent_id: null });

        await buildWatchActivity({} as never, SEASON_ID, makeUser());

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            SERIES_ID,
            expect.anything(),
        );
    });

    it('refuses the rolled-up series when access to it is denied', async () => {
        mockGetMediaTypeAndParent
            .mockResolvedValueOnce({ id: SEASON_ID, media_type: 'season', parent_id: SERIES_ID })
            .mockResolvedValueOnce({ id: SERIES_ID, media_type: 'tv', parent_id: null });
        mockCheckMediaAccess.mockResolvedValue(false);

        const out = await buildWatchActivity({} as never, SEASON_ID, makeUser());

        expect(out).toEqual({ ok: false, reason: 'not-found' });
        expect(mockGetWatchedActivities).not.toHaveBeenCalled();
    });

    it('checks the target even when it is the id the caller resolved', async () => {
        mockGetMediaTypeAndParent.mockResolvedValue({
            id: SERIES_ID,
            media_type: 'movie',
            parent_id: null,
        });

        await buildWatchActivity({} as never, SERIES_ID, makeUser());

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            SERIES_ID,
            expect.anything(),
        );
    });

    it('checks the id the EXTERNAL-ID fallback resolved, not the raw one', async () => {
        // The Jellyfin-UUID fallback also swaps the target. A caller that
        // checked the raw id has not checked this row.
        mockGetMediaTypeAndParent
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: SERIES_ID, media_type: 'movie', parent_id: null });
        mockResolveAnyMediaId.mockResolvedValue({ internalId: SERIES_ID });
        mockCheckMediaAccess.mockResolvedValue(false);

        const out = await buildWatchActivity(
            {} as never,
            '55555555-5555-4555-8555-555555555555',
            makeUser(),
        );

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            SERIES_ID,
            expect.anything(),
        );
        expect(out).toEqual({ ok: false, reason: 'not-found' });
    });
});

/**
 * A lookup that FAILED and a lookup that legitimately found nobody are
 * different answers. They used to share one return value (`ok: true` with an
 * empty list), which `context` maps to "push to included[]" — telling a client
 * "requested, honored, nobody watched this" when the truth was "we never found
 * the item".
 */
describe('buildWatchActivity — resolution failure is not an empty result', () => {
    const JELLYFIN_UUID = '55555555-5555-4555-8555-555555555555';

    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.social = true;
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetWatchedActivities.mockResolvedValue([]);
        mockGetAnnotations.mockResolvedValue([]);
        mockCheckMediaAccess.mockResolvedValue(true);
        mockResolveExternalIdToMediaId.mockResolvedValue(null);
        mockResolveAnyMediaId.mockResolvedValue({ internalId: null });
    });

    it('reports unresolved when a season has no movie/series ancestor', async () => {
        mockGetMediaTypeAndParent
            .mockResolvedValueOnce({ id: SEASON_ID, media_type: 'season', parent_id: 'dangling' })
            .mockResolvedValueOnce(null);

        const out = await buildWatchActivity({} as never, SEASON_ID, makeUser());

        expect(out).toEqual({ ok: false, reason: 'unresolved' });
    });

    it('reports unresolved when a composite episode key does not normalize', async () => {
        const out = await buildWatchActivity({} as never, 'tmdb:1399:episode', makeUser());

        expect(out).toEqual({ ok: false, reason: 'unresolved' });
    });

    it('reports unresolved when the id resolves to nothing at all', async () => {
        mockGetMediaTypeAndParent.mockResolvedValue(null);

        const out = await buildWatchActivity({} as never, EPISODE_ID, makeUser());

        expect(out).toEqual({ ok: false, reason: 'unresolved' });
    });

    it('resolves a Jellyfin UUID through external_ids, like every other section', async () => {
        // `context` resolves rawId with resolveCatalogInternalId, which falls
        // back to an external_ids (Jellyfin) lookup. Without the same fallback
        // here, details/rating/watched resolve and social alone comes back
        // empty — for a supported id form.
        mockGetMediaTypeAndParent
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: SERIES_ID, media_type: 'movie', parent_id: null });
        mockResolveAnyMediaId.mockResolvedValue({ internalId: SERIES_ID });

        const out = await buildWatchActivity({} as never, JELLYFIN_UUID, makeUser());

        expect(out.ok).toBe(true);
        expect(mockGetWatchedActivities).toHaveBeenCalledWith(
            expect.anything(),
            SERIES_ID,
            'movie',
            expect.anything(),
        );
    });

    it('keeps the standalone route answering 200 with an empty list', async () => {
        // The route's own contract is unchanged — only `context` needs to tell
        // the two apart, and it does so via the outcome, not the status code.
        mockGetMediaTypeAndParent.mockResolvedValue(null);

        const res = await callWith(EPISODE_ID);

        expect(res.status).toBe(200);
        expect((await res.json()).activities).toEqual([]);
    });
});

/**
 * Audiobooks take a different query, a different visibility regime and a
 * different row shape (design doc §4.1 / §4.2). The three things that must hold:
 * the movie/TV query never runs on a book, the trust-circle query never runs
 * before `checkMediaAccess`, and a listening row merges onto an existing rating
 * row instead of being dropped for anyone who rated the book.
 */
describe('buildWatchActivity — audiobooks', () => {
    const BOOK_ID = '66666666-6666-4666-8666-666666666666';
    const ANNA = '77777777-7777-4777-8777-777777777777';

    function listeningRow(overrides: Record<string, unknown> = {}) {
        return {
            user_id: ANNA,
            username: 'anna',
            position_ms: 700_000,
            duration_ms: 1_800_000,
            is_finished: false,
            finished_recently: false,
            times_finished: 0,
            ...overrides,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.social = true;
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetWatchedActivities.mockResolvedValue([]);
        mockGetAnnotations.mockResolvedValue([]);
        mockGetAudiobookListeningActivities.mockResolvedValue([]);
        mockGetOwnAudiobookListening.mockResolvedValue(null);
        mockGetAudiobookChapterTable.mockResolvedValue({
            chapters: [
                { id: 0, title: 'Kapitel 1', start: 0, end: 600 },
                { id: 1, title: 'Kapitel 2', start: 600, end: 1200 },
                { id: 2, title: 'Kapitel 3', start: 1200, end: 1800 },
            ],
            duration_ms: 1_800_000,
        });
        mockGetMediaTypeAndParent.mockResolvedValue({
            id: BOOK_ID,
            media_type: 'audiobook',
            parent_id: null,
        });
    });

    it('reads the listening query and NEVER the watched-only one', async () => {
        mockGetAudiobookListeningActivities.mockResolvedValue([listeningRow()]);

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser());

        expect(out.ok).toBe(true);
        expect(mockGetAudiobookListeningActivities).toHaveBeenCalledWith(
            expect.anything(),
            BOOK_ID,
            expect.anything(),
        );
        // Relaxing getWatchedActivities' is_watched filter, or routing a book
        // through it, is the thing the design doc forbids: it would surface
        // "Anna is 20 minutes into this film" on every movie modal.
        expect(mockGetWatchedActivities).not.toHaveBeenCalled();
    });

    it('emits position, chapter and duration on the item', async () => {
        mockGetAudiobookListeningActivities.mockResolvedValue([listeningRow()]);

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser());

        const item = out.ok ? out.body.activities[0] : undefined;
        expect(item).toMatchObject({
            author: {
                userId: ANNA,
                displayName: 'Public Name',
                images: {
                    primary: {
                        href: `/api/users/${ANNA}/images/avatar?size=card&v=0&fallback=initials`,
                        variants: {
                            thumb: `/api/users/${ANNA}/images/avatar?size=thumb&v=0&fallback=initials`,
                        },
                        revision: '0',
                        source: 'generated',
                    },
                },
            },
            positionMs: 700_000,
            durationMs: 1_800_000,
            chapterIndex: 1,
            chapterTitle: 'Kapitel 2',
            chapterCount: 3,
            watchedOnly: true,
        });
    });

    it('uses the mounted surface for versioned avatar URLs without exposing a login username', async () => {
        mockGetAudiobookListeningActivities.mockResolvedValue([listeningRow()]);

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser(), 'v1');
        const item = out.ok ? out.body.activities[0] : undefined;

        expect(item).toMatchObject({
            author: {
                userId: ANNA,
                displayName: 'Public Name',
                images: {
                    primary: {
                        href: `/api/v1/users/${ANNA}/images/avatar?size=card&v=0&fallback=initials`,
                        variants: {
                            thumb: `/api/v1/users/${ANNA}/images/avatar?size=thumb&v=0&fallback=initials`,
                        },
                        revision: '0',
                        source: 'generated',
                    },
                },
            },
        });
    });

    it('runs checkMediaAccess BEFORE any social query, and stops on denial', async () => {
        // Without this the endpoint is an existence oracle for books outside the
        // viewer's libraries: the trust-circle predicate answers "may I see this
        // PERSON", never "may I see this BOOK".
        mockCheckMediaAccess.mockResolvedValue(false);
        mockGetAudiobookListeningActivities.mockResolvedValue([listeningRow()]);

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser());

        expect(out).toEqual({ ok: false, reason: 'not-found' });
        expect(mockGetAudiobookListeningActivities).not.toHaveBeenCalled();
        expect(mockGetOwnAudiobookListening).not.toHaveBeenCalled();
        expect(mockGetAudiobookChapterTable).not.toHaveBeenCalled();
        expect(mockGetRatedActivities).not.toHaveBeenCalled();
    });

    it('detects a shared listen from the viewer own row', async () => {
        mockGetAudiobookListeningActivities.mockResolvedValue([
            listeningRow({ position_ms: 1_300_000 }),
        ]);
        mockGetOwnAudiobookListening.mockResolvedValue(
            listeningRow({ user_id: 'me', username: 'me', position_ms: 100_000 }),
        );

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser());

        const item = out.ok ? out.body.activities[0] : undefined;
        expect(item?.sharedListen).toBe(true);
        expect(item?.chapterDelta).toBe(2);
        // Timed now: a chapter count alone cannot say how far ahead that is.
        expect(item?.description).toBe('social_listen_shared_ahead_timed');
    });

    it('merges the listening fields onto an existing rating row', async () => {
        // The movie rule skips a watcher who already rated. Applied here it would
        // hide the position from exactly the people most engaged with the book.
        mockGetRatedActivities.mockResolvedValue([
            {
                user_id: ANNA,
                username: 'anna',
                rating: 9,
                created_at: new Date('2026-07-01T00:00:00Z'),
                rating_style: 'stars',
            },
        ]);
        mockGetAudiobookListeningActivities.mockResolvedValue([listeningRow()]);

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser());
        const activities = out.ok ? out.body.activities : [];

        expect(activities).toHaveLength(1);
        expect(activities[0].rating).toBe(9);
        expect(activities[0].ratingStyle).toBe('stars');
        expect(activities[0].positionMs).toBe(700_000);
        // The listening line wins the copy; the rating still renders from `rating`.
        expect(activities[0].description).toBe('social_listen_chapter_percent');
        // A rated row is not "watch only".
        expect(activities[0].watchedOnly).toBeUndefined();
    });

    it('skips the chapter/own-row reads entirely when the circle is dark', async () => {
        // No configured trust circle -> the predicate emitted `AND false` -> no
        // rows -> nothing to project. The section is simply absent.
        mockGetAudiobookListeningActivities.mockResolvedValue([]);

        const out = await buildWatchActivity({} as never, BOOK_ID, makeUser());

        expect(out.ok).toBe(true);
        expect(out.ok && out.body.activities).toEqual([]);
    });
});

/**
 * A composite key cannot name an audiobook today, which is why the composite
 * branch of buildWatchActivity does not route through resolveTarget for them.
 * Pinned rather than assumed: if either list grows an audiobook entry, an
 * audiobook would reach the endpoint classified as a MOVIE, and its finished rows
 * would render through getWatchedActivities — visible to everyone with
 * hide_streams = false rather than to the trust circle. This test is the tripwire.
 */
describe('composite keys cannot name an audiobook', () => {
    it('rejects an audiobook media-type token and an audiobookshelf provider', async () => {
        const { parseMediaId, validateParsedMediaId } =
            await import('$lib/server/utils/media-key-parser.js');

        expect(validateParsedMediaId(parseMediaId('tmdb:550:audiobook'))).toBe(false);
        expect(validateParsedMediaId(parseMediaId('audiobookshelf:abc123:audiobook'))).toBe(false);
        expect(validateParsedMediaId(parseMediaId('audiobookshelf:abc123'))).toBe(false);
    });
});

/**
 * The audiobook listening fields have to be declared in FOUR places, and three of
 * them silently drop data rather than erroring:
 *
 *  1. `api-media-responses.SocialActivityItemSchema` — the exported shape;
 *  2. `api-integrations-responses.SocialWatchActivityResponseSchema` — what the web
 *     client parses this route's body with. An undeclared field here is DELETED
 *     from what the client receives, with no warning: the response schema is
 *     `.passthrough()` so `toStrict()` skips it, and Zod 4's `.strict()` only ever
 *     constrains the top-level object anyway, never `activities[]` items
 *     (both measured — see `toStrict` in `$lib/api/client.ts`);
 *  3. `api-media-context-response.MediaContextResponseSchema` — the client-side
 *     context schema;
 *  4. the `/media/{id}/context` def's declared docs 200 schema, where `mount`
 *     STRIPS undeclared keys from 2xx bodies in dev and prod (covered by
 *     `media-id-context.test.ts`, which drives the real mounted route).
 *
 * 1-3 are asserted here. They all read from the same object today; this is what
 * fails if a future edit re-forks one of them.
 */
describe('the audiobook listening fields survive every declared schema', () => {
    const LISTENING_ITEM = {
        author: {
            userId: '44444444-4444-4444-8444-444444444444',
            displayName: 'Anna',
            images: {
                primary: {
                    href: '/api/users/44444444-4444-4444-8444-444444444444/images/avatar',
                    variants: {
                        thumb: '/api/users/44444444-4444-4444-8444-444444444444/images/avatar?quality=50',
                    },
                    revision: '0',
                    source: 'self',
                },
            },
        },
        description: 'Anna ist bei Kapitel 2',
        watchedOnly: true,
        positionMs: 700_000,
        durationMs: 1_800_000,
        chapterTitle: 'Kapitel 2',
        chapterIndex: 1,
        chapterCount: 3,
        finished: true,
        recentlyFinished: true,
        timesFinished: 2,
        sharedListen: true,
        chapterDelta: 1,
        positionDeltaMs: 600_000,
    };

    it('keeps every field through the exported item schema', async () => {
        const { SocialActivityItemSchema } = await import('$lib/schemas/api-media-responses.js');
        expect(SocialActivityItemSchema.parse(LISTENING_ITEM)).toEqual(LISTENING_ITEM);
    });

    it('requires a public author and preserves a null display name', async () => {
        const { SocialActivityItemSchema } = await import('$lib/schemas/api-media-responses.js');
        const anonymous = {
            ...LISTENING_ITEM,
            author: { ...LISTENING_ITEM.author, displayName: null },
        };
        expect(SocialActivityItemSchema.parse(anonymous)).toEqual(anonymous);
        const { author, ...fields } = LISTENING_ITEM;
        expect(
            SocialActivityItemSchema.safeParse({
                ...fields,
                userId: author.userId,
                username: 'private-login',
                images: {},
            }).success,
        ).toBe(false);
    });

    it('keeps every field through this route own response schema', async () => {
        // The web client PARSES with this schema, and an item field it does not
        // declare is deleted from the result with no warning at all (nothing
        // strictens `activities[]` — see the block comment above). It was a
        // hand-maintained copy and had already drifted, so this assertion is the
        // actual protection, not a tripwire elsewhere.
        const { SocialWatchActivityResponseSchema } =
            await import('$lib/schemas/api-integrations-responses.js');
        const parsed = SocialWatchActivityResponseSchema.parse({ activities: [LISTENING_ITEM] });
        expect(parsed.activities[0]).toEqual(LISTENING_ITEM);
    });

    it('keeps every field through the client context schema', async () => {
        const { MediaContextResponseSchema } =
            await import('$lib/schemas/api-media-context-response.js');
        const parsed = MediaContextResponseSchema.parse({
            included: ['social'],
            social: { activities: [LISTENING_ITEM] },
        });
        expect(parsed.social?.activities[0]).toEqual(LISTENING_ITEM);
    });
});

describe('social activity public authors', () => {
    const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const REVIEWER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.social = true;
        getMediaTypeAndParent.mockResolvedValue({
            id: SERIES_ID,
            media_type: 'tv',
            parent_id: null,
        });
        checkMediaAccess.mockResolvedValue(true);
        getRatedActivities.mockResolvedValue([]);
        getWatchedActivities.mockResolvedValue([]);
        getAnnotations.mockResolvedValue([]);
    });

    it.each(['Public Person', null, undefined])(
        'uses public name %s for ratings, progress, reviews and the current user',
        async (name) => {
            const displayName = name ?? null;
            getUserDisplayInfoByIds.mockResolvedValueOnce(
                name === undefined
                    ? []
                    : [ACTOR_ID, REVIEWER_ID, makeUser().userId, oneWatcher()[0].user_id].map(
                          (id) => ({
                              // Exercise case-insensitive author matching.
                              id: id.toUpperCase(),
                              display_name: displayName,
                          }),
                      ),
            );
            getRatedActivities.mockResolvedValue([
                {
                    user_id: ACTOR_ID,
                    username: 'private-rating-login',
                    rating: 9,
                    rating_style: 'stars',
                    created_at: new Date('2026-10-17T12:00:00Z'),
                },
            ]);
            getWatchedActivities.mockResolvedValue([
                {
                    ...oneWatcher()[0],
                    username: 'private-watcher-login',
                    episodes_watched: 8,
                    total_episodes: 10,
                },
            ]);
            getAnnotations.mockResolvedValue([
                { user_id: ACTOR_ID, id: 'rating-review', content: 'Rating review' },
                { user_id: REVIEWER_ID, id: 'only-review', content: 'Review only' },
                { user_id: makeUser().userId, id: 'own-review', content: 'Own review' },
            ]);
            const ratingMessage = vi.spyOn(messages, 'social_rating_excellent_1');
            const progressMessage = vi.spyOn(messages, 'social_tv_progress_high');
            const reviewedMessage = vi.spyOn(messages, 'social_reviewed');
            const random = vi.spyOn(Math, 'random').mockReturnValue(0);
            try {
                const out = await buildWatchActivity({} as never, SERIES_ID, makeUser(), 'v1');
                if (!out.ok) throw new Error('Expected social activity');
                const { activities } = out.body;
                expect(activities).toHaveLength(4);
                for (const activity of activities) {
                    expect(activity.author.displayName).toBe(displayName);
                    expect(activity.author.images.primary.href).toMatch(/^\/api\/v1\/users\//);
                    expect(activity).not.toHaveProperty('username');
                    expect(activity).not.toHaveProperty('userId');
                    expect(activity).not.toHaveProperty('images');
                }
                expect(JSON.stringify(out.body)).not.toContain('private-');
                expect(ratingMessage).toHaveBeenCalledWith({ name: name ?? 'Someone' });
                expect(progressMessage).toHaveBeenCalledWith({
                    name: name ?? 'Someone',
                    percent: 80,
                });
                expect(reviewedMessage).toHaveBeenCalledWith({ name: name ?? 'Someone' });
                expect(
                    activities.find((a) => a.author.userId.toLowerCase() === ACTOR_ID)?.reviewId,
                ).toBe('rating-review');
                expect(activities.find((a) => a.isSelf)?.reviewId).toBe('own-review');
                const { SocialWatchActivityResponseSchema } =
                    await import('$lib/schemas/api-integrations-responses.js');
                expect(SocialWatchActivityResponseSchema.parse(out.body)).toEqual(out.body);
            } finally {
                random.mockRestore();
                ratingMessage.mockRestore();
                progressMessage.mockRestore();
                reviewedMessage.mockRestore();
            }
        },
    );
});
