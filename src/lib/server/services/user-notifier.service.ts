// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout, clearTimeout } from 'node:timers';

/**
 * user-notifier.service.ts — the emitter for the two notification-class event
 * kinds (`library.new_episode`, `request.available`).
 *
 * Both hang off ONE pipeline hook, `media.becamePlayable`, because both answer
 * the same question from different angles: something a person asked for is now
 * watchable. Registered beside `MediaAddedNotifier` in the orchestrator —
 * same shape, different audience: `MediaAddedNotifier` fans an operator-facing
 * webhook, this one addresses individual users
 * (docs/architecture/user-events.md, "Emitters and hook points").
 *
 * Order inside the handler is load-bearing:
 *
 *   1. `isInitializingWindow()` FIRST. Without it a fresh install fires one
 *      notification per imported item to every user. Everything else in this
 *      file is a detail by comparison.
 *   2. `library.new_episode` — who hears about an episode is decided by
 *      `new-release-rule.ts`, the rule of the "New episodes available" banner,
 *      never a copy of it: newly released episodes of followed series only.
 *   3. `request.available` — only the terminal edge earns a row; the
 *      downloading/importing states stay with the client-side poll. This branch
 *      is STAGED in the handler and delivered by `drainRequestAvailableChecks()`
 *      afterwards, because asking Jellyseerr is network I/O and the handler runs
 *      inside the dispatcher's `FOR UPDATE` transaction (see the staging note
 *      further down).
 *
 * Every emit passes the per-user library + age gate first. A notification that
 * names a title the user cannot browse is an existence leak with a push
 * notification attached.
 *
 * Coalescing (a season drop is ONE notification, not ten) is enforced by the
 * unique partial index added in migration 16.191.0, not by the loop below, and
 * duplicate LIVE delivery is prevented by `insertNotification`'s
 * `ON CONFLICT DO NOTHING` result — which `publishUserEvent` consults before it
 * broadcasts. The `hasCoalescedNotificationToday` pre-checks here are an
 * optimisation on top of both: they save an INSERT round trip in the common
 * case. They are NOT the correctness mechanism and cannot be — they are
 * check-then-act reads in separate transactions and the outbox dispatcher
 * drains shards in parallel.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { isInitializingWindow } from './attention/attention-service.js';
import { registerPipelineEventHandler } from './pipeline-event-dispatcher.service.js';
import { publishUserEvent } from './notification-events.service.js';
import {
    listUsersExcludingSeries,
    SERIES_INTEREST_MOMENT_GAP_SECONDS,
} from './series-interest.service.js';
import {
    DEFAULT_NEW_RELEASE_CONFIG,
    followReasonFor,
    qualifiesAsNewRelease,
    type EpisodeCandidate,
    type FollowReason,
    type SeriesFollowState,
} from './new-release-rule.js';
import {
    getEpisodeArrivalsForSeries,
    getSeriesFollowers,
    isAiringStatus,
    type EpisodeArrivalRow,
    type SeriesFollowerRow,
} from '$lib/server/database/queries/new-release-episodes.queries.js';
import { hasCoalescedNotificationToday } from '$lib/server/database/queries/user-notifications.queries.js';
import { resolveUsernamesToUsers } from '$lib/server/database/queries/users.queries.js';
import { getDeniedLibraryGroups } from '$lib/server/cache/library-group-permissions-cache.js';
import {
    resolveTokenUserAccess,
    type TokenUserAccess,
} from '$lib/server/auth/resolve-token-user-access.js';
import {
    restrictedAccess,
    type MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import { getDb } from '$lib/server/database/connection.js';
import { jellyseerrClient, RequestStatus, type JellyseerrRequest } from '$lib/server/jellyseerr.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain.js';
import type { PipelineEventPayload } from '$lib/types/pipeline.js';

const log = Logger.for('UserNotifier');

/**
 * The two wire strings this file emits, written as literals here on purpose.
 *
 * `event-kinds.ts` is the taxonomy — what a client may subscribe to — but the
 * EMITTER is what decides the SSE `event:` field, and the guard in
 * `event-kinds.test.ts` reads this file from disk to prove the advertised name
 * and the emitted name are the same string. Importing the constant from the
 * taxonomy would make that check pass on a file that emits nothing, which is
 * precisely the failure the guard exists to catch.
 * `user-notifier.service.integration.test.ts` closes the loop in the other
 * direction: it asserts both of these are ADVERTISED in
 * `NOTIFICATION_EVENT_KIND_NAMES`, so the pair cannot drift apart silently. A
 * subset rather than an equality, because this is no longer the only emitter of
 * a notification-class kind — `admin.broadcast` is emitted by
 * `admin-broadcast.service.ts`, and "every advertised kind has SOME emitter" is
 * what `event-kinds.test.ts` enforces per kind.
 */
export const EVENT_KIND_LIBRARY_NEW_EPISODE = 'library.new_episode';
export const EVENT_KIND_REQUEST_AVAILABLE = 'request.available';

/**
 * How many Jellyseerr requests to scan for the item that just became playable.
 * Jellyseerr has no "requests for tmdbId" endpoint, so this is a bounded page
 * of the most recent requests rather than a lookup — matching
 * `getFulfilledRequestsForUser`'s existing take of 100.
 */
const JELLYSEERR_REQUEST_SCAN_SIZE = 100;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface MediaRow {
    id: string;
    title: string;
    year: number | null;
    media_type: string;
    parent_id: string | null;
    season_number: number | null;
    episode_number: number | null;
}

interface NotifiableUserRow {
    id: string;
    username: string;
}

/**
 * The item the notification is *about*, which is not always the item that
 * became playable: an episode's request was made against its series, and the
 * card a client renders deep-links to the series.
 */
interface ResolvedItem {
    /** The media_items row for the event's own mediaId. */
    item: MediaRow;
    /** The series row when `item` is an episode, else null. */
    series: MediaRow | null;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

async function loadMediaRow(sql: postgres.Sql, mediaId: string): Promise<MediaRow | null> {
    // Pipeline hydration by primary key. The access decision is per-USER and
    // happens in `accessibleTo()` below, against this row's id — gating here
    // would be meaningless (there is no single caller to gate for).
    const rows = await sql<MediaRow[]>`
        SELECT id::text, title, year, media_type, parent_id::text, season_number, episode_number
        FROM media_items
        WHERE id = ${mediaId}::uuid
    `;
    return rows[0] ?? null;
}

/**
 * Resolve the event's media id, and — for an episode — walk to its SERIES.
 *
 * `episode.parent_id` is the SEASON, not the series: the hierarchy is
 * series → season → episode and the walk is two hops. Assuming one hop yields
 * the season row, whose title is "Season 3" and whose id deep-links nowhere
 * useful.
 */
async function resolveItem(sql: postgres.Sql, mediaId: string): Promise<ResolvedItem | null> {
    const item = await loadMediaRow(sql, mediaId);
    if (!item) return null;
    if (item.media_type !== 'episode') return { item, series: null };

    if (!item.parent_id) return { item, series: null };
    const season = await loadMediaRow(sql, item.parent_id);
    // Hop 2. A season with no parent is an orphan the scanner will reconcile;
    // there is no series to notify about, so drop the episode branch.
    if (!season?.parent_id) return { item, series: null };
    const series = await loadMediaRow(sql, season.parent_id);
    // An episode row may lack its own season number; the season row has it.
    // Same fallback the interest SQL uses, so premiere detection and the
    // payload's numbering agree with the watch history they are checked against.
    const episode =
        item.season_number === null ? { ...item, season_number: season.season_number } : item;
    return { item: episode, series: series?.media_type === 'tv' ? series : null };
}

// ---------------------------------------------------------------------------
// Per-user access gate
// ---------------------------------------------------------------------------

async function loadNotifiableUsers(
    sql: postgres.Sql,
    userIds: readonly string[],
): Promise<Map<string, NotifiableUserRow>> {
    if (userIds.length === 0) return new Map();
    // id + username only. The access DECISION — is_admin, groups, age cap —
    // is `resolveTokenUserAccess()`'s job now (see `resolveNotifiableAccess`
    // below), not a raw column read here (security review 5, P1: the old raw
    // read here had no pin awareness, no in-app-cohort MIN and no group
    // re-derivation, and could both over-grant and over-deny relative to the
    // canonical composition). This SQL filter and the resolver's
    // `disabled`/`deleted` flags are two DIFFERENT freshness tiers, not one
    // authoritative source deferring to the other: this is a live read on
    // every call, while the resolver's flags come from an L1 cache with up to
    // a 10-minute TTL (`user-admin-cache.ts`, invalidated on write but still
    // laggy across a cold replica). A disable/delete that lands inside that
    // window is caught HERE, before the resolver even runs; the resolver call
    // in each per-recipient loop is what fails closed for every candidate
    // this SELECT let through but that changed state since — neither check
    // alone is sufficient, so both stay.
    const rows = await sql<NotifiableUserRow[]>`
        SELECT id::text, username
        FROM users
        WHERE id = ANY(${userIds as string[]}::uuid[])
          AND disabled_at IS NULL
          AND deleted_at IS NULL
    `;
    return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Resolve `username`'s canonical access for the notification gate, or `null`
 * to skip the recipient entirely.
 *
 * The single place both per-recipient loops (`emitNewEpisode`,
 * `emitRequestAvailable`) get a `TokenUserAccess` — collapsed here instead of
 * each loop repeating `resolveTokenUserAccess()` plus its own
 * `!access || access.disabled || access.deleted` fail-closed check (security
 * review 5, P1 fix-round-1: two copies of that check are two places for the
 * fail-closed condition to drift apart).
 */
async function resolveNotifiableAccess(username: string): Promise<TokenUserAccess | null> {
    const access = await resolveTokenUserAccess(username);
    if (!access || access.disabled || access.deleted) return null;
    return access;
}

/**
 * Build the same boundary the canonical per-user access resolver grants.
 *
 * Delegates entirely to `resolveTokenUserAccess()` — the SAME composition
 * `resolveDbAuth`/`resolveInAppAccess`/`mergeMaxAge` produce for a live
 * session or a token request: `age_rating_pinned` decides column-vs-group-
 * derived cap, the in-app cohort MIN-merges on top, and the library groups are
 * the EFFECTIVE (synced ∪ in-app) set. This file used to hand-compose a
 * fourth copy of that formula from the raw `users` row — no pin awareness, no
 * in-app cohort, no group re-derivation — which could both over-grant (a
 * pinned 18 cap bypassing a stricter in-app cohort cap) and over-deny (an
 * unpinned NULL column read as "unrestricted" when a cohort-only install's
 * actual cap was e.g. 6, or the reverse) relative to what every other surface
 * decides. Fixed as part of security review 5, P1 — do not hand-compose a
 * fifth copy; call the resolver.
 *
 * Admins are not special-cased here: `resolveTokenUserAccess` already nulls
 * `maxAgeRating` for an admin (mirroring `forward-auth.ts`'s session-path
 * derivation), and `getDeniedLibraryGroups` opens the library axis for one on
 * its own. That IS exactly what `checkMediaAccess` does for an admin
 * `UserContext` — an admin is never age-gated by either surface, even one
 * whose `max_age_rating` column holds a non-null value. (This function's
 * previous comment claimed the opposite of THIS file's own old behaviour —
 * that an admin here "stays age-gated, exactly what checkMediaAccess does" —
 * which was backwards: the old raw-column read here COULD age-gate an admin,
 * while checkMediaAccess never does. Switching to the resolver corrects that:
 * an admin now gets the same unconditional age bypass every other surface
 * gives them.)
 */
async function boundaryFor(
    sql: postgres.Sql,
    access: TokenUserAccess,
): Promise<MediaAccessBoundary> {
    const denied = await getDeniedLibraryGroups(sql, {
        isAdmin: access.permissions.ownerIsAdmin,
        userGroups: access.userGroups,
    });
    return restrictedAccess({
        deniedGroupIds: denied ?? [],
        maxAgeRating: access.permissions.maxAgeRating,
        allowUnrated: config.UNRATED_CONTENT_VISIBLE,
    });
}

/**
 * Whether the user may see EVERY id the notification would reveal.
 *
 * All of them, not any: a `library.new_episode` card names the series and links
 * to the episode, so a user who is denied either must not receive it. The
 * episode carries the file (and therefore the library group); the series
 * usually carries the age rating.
 */
async function accessibleTo(
    sql: postgres.Sql,
    access: TokenUserAccess,
    mediaIds: readonly string[],
): Promise<boolean> {
    const ids = [...new Set(mediaIds)];
    const boundary = await boundaryFor(sql, access);
    const allowed = await filterAccessibleMediaIds(sql, ids, boundary);
    return ids.every((id) => allowed.has(id));
}

// ---------------------------------------------------------------------------
// library.new_episode
// ---------------------------------------------------------------------------

function posterRef(mediaId: string): string {
    // `images/{role}` (PLURAL) — the canonical media image endpoint. This said
    // `image/poster` until 2026-08-05, a route that has never existed, so every
    // notification's poster 404'd. Nothing caught it: the tests and the preprod
    // e2e both asserted on the payload JSON and never rendered the image, and
    // the `no-hardcoded-api-path` lint rule that would have flagged it only
    // covers `api/defs/**`, not services.
    //
    // Still surface-absolute, and unavoidably so: this runs on the worker with
    // no request context, so it cannot know whether the reader is a browser
    // (`/api`) or a Bearer client (`/api/v1`). It is therefore a CONVENIENCE for
    // consumers that want a ready-made URL — the web inbox ignores it and builds
    // its own from `mediaId`/`seriesId` via `entityImageUrl`, which is also how
    // it gets an episode still rather than only the series poster.
    return `/api/media/${mediaId}/images/poster?size=thumb`;
}

/**
 * Why a `library.new_episode` notification reached this user.
 *
 * Carried on the payload so a client can explain itself ("Because you follow
 * Harbor Lights") and so a future preferences screen can let someone keep one
 * source and mute another — today the only way to stop these is to unfollow the
 * series entirely, for every reason at once.
 *
 * One per follow reason of `new-release-rule.ts` (`followReasonFor`, which
 * also picks the most explicit one when several apply):
 *   `following` — an explicit `series_episode_notifications` opt-in.
 *   `watching`  — at least two viewing moments of the series.
 *   `watchlist` — on the user's watchlist and started (one viewing moment).
 *
 * There is deliberately no `requested` member: a Jellyseerr request produces
 * `request.available`, a different kind with a single candidate path of its own,
 * and no request-derived source feeds THIS emitter. Adding one here would be a
 * value no code path can ever set.
 */
type NewEpisodeReason = 'following' | 'watchlist' | 'watching';

/**
 * `(series, season)` — the coalescing identity. The kind and the user are index
 * columns in their own right, and the day comes from `created_at`, so this key
 * holds only the parts the emitter knows.
 */
function newEpisodeCoalesceKey(seriesId: string, seasonNumber: number | null): string {
    return `series:${seriesId}:s${seasonNumber ?? 'unknown'}`;
}

/** The notification's wording for each follow reason of the rule. */
const REASON_FOR_FOLLOW: Record<FollowReason, NewEpisodeReason> = {
    followed: 'following',
    watchlist: 'watchlist',
    watched: 'watching',
};

function toFollowState(row: SeriesFollowerRow): SeriesFollowState {
    return {
        seriesId: row.series_id,
        watchedEpisodeCount: row.watched_episode_count,
        watchedMomentCount: row.watched_moment_count,
        lastWatchedAt: row.last_watched_at,
        newestWatchedAirDate: row.newest_watched_air_date,
        explicitlyFollowed: row.explicitly_followed,
        inWatchlist: row.in_watchlist,
        airing: isAiringStatus(row.series_status),
    };
}

function toCandidate(row: EpisodeArrivalRow): EpisodeCandidate {
    return {
        id: row.id,
        seriesId: row.series_id,
        seasonNumber: Number(row.season_number),
        episodeNumber: Number(row.episode_number),
        airDate: row.air_date,
        fileAddedAt: row.file_added_at,
        hasFile: true,
        watched: false,
    };
}

/**
 * Who hears about an episode that just became playable: the users for whom
 * it is a NEW RELEASE under `new-release-rule.ts`, the rule of the "New
 * episodes available" banner. A fulfilled request or a season pack of old
 * episodes notifies nobody (prod 2026-10: a viewer binge-watching The Middle
 * was told about every 2010–2016 episode as its seasons arrived).
 */
async function emitNewEpisode(sql: postgres.Sql, resolved: ResolvedItem): Promise<void> {
    const { item: episode, series } = resolved;
    if (!series) return;

    const config = DEFAULT_NEW_RELEASE_CONFIG;
    const now = new Date();
    // Enough history to see the episode's whole arrival batch (as the banner).
    const lookbackDays = config.windowDays + Math.ceil(config.bulkSpanHours / 24) + 1;
    const [followers, arrivalRows] = await Promise.all([
        getSeriesFollowers(sql, series.id, SERIES_INTEREST_MOMENT_GAP_SECONDS),
        getEpisodeArrivalsForSeries(sql, null, [series.id], lookbackDays, {
            includeEpisodeId: episode.id,
        }),
    ]);
    if (followers.length === 0) return;

    const arrivals = arrivalRows.map(toCandidate);
    // A duplicate S/E row collapses to the oldest row; judge that one.
    const target =
        arrivals.find((e) => e.id === episode.id) ??
        arrivals.find(
            (e) =>
                e.seasonNumber === episode.season_number &&
                e.episodeNumber === episode.episode_number,
        );
    if (!target) return;

    // The user-independent half first (window, bulk import), so an old
    // episode costs no further queries. `airing` is a property of the series.
    const seriesState = toFollowState(followers[0]);
    const anyone: SeriesFollowState = {
        ...seriesState,
        lastWatchedAt: null,
        newestWatchedAirDate: null,
    };
    if (!qualifiesAsNewRelease(target, anyone, arrivals, now, config)) return;

    const [excluded, watchedBy] = await Promise.all([
        listUsersExcludingSeries(sql, series.id),
        listUsersWhoWatched(sql, [episode.id, target.id]),
    ]);

    // `series_excluded` (the mute) removes everyone but an explicit follower:
    // switching on episode notifications for a series outranks the mute.
    const candidateReasons = new Map<string, NewEpisodeReason>();
    for (const row of followers) {
        const state = toFollowState(row);
        const follow = followReasonFor(state, config);
        if (!follow) continue;
        if (excluded.has(row.user_id) && follow !== 'followed') continue;
        const candidate = { ...target, watched: watchedBy.has(row.user_id) };
        if (!qualifiesAsNewRelease(candidate, state, arrivals, now, config)) continue;
        candidateReasons.set(row.user_id, REASON_FOR_FOLLOW[follow]);
    }
    const candidates = new Set(candidateReasons.keys());
    if (candidates.size === 0) return;

    await warnOnWatchHistoryFanOut(sql, series, candidateReasons);

    const users = await loadNotifiableUsers(sql, [...candidates]);
    const coalesceKey = newEpisodeCoalesceKey(series.id, episode.season_number);

    for (const user of users.values()) {
        // Per-user isolation: a transient failure on ONE candidate (a DB blip in
        // the access gate, say) must not truncate the rest of the list. The
        // caller swallows a throw, and this event is consumed either way, so an
        // un-isolated loop drops every remaining user permanently and silently.
        try {
            // Cheap early-out only — see the coalescing note at the top of the
            // file. The INSERT in publishUserEvent is what actually forbids the
            // second row AND the second toast; deleting that guard is not made
            // safe by this check.
            if (
                await hasCoalescedNotificationToday(sql, {
                    userId: user.id,
                    kind: EVENT_KIND_LIBRARY_NEW_EPISODE,
                    coalesceKey,
                })
            ) {
                continue;
            }
            // +1 `users` read and +1 in-app read on a cold L1, on top of the
            // three queries above (hasCoalescedNotificationToday, denied
            // groups, filterAccessibleMediaIds) — paid per CANDIDATE (a
            // series' followers/watchers/watchlisters), not per notification
            // sent, and only once the coalescing early-out has already ruled
            // out the common repeat case. The worker subscribes to the
            // auth-cache invalidation bus, so a warm L1 serves this with zero
            // DB round trips.
            const access = await resolveNotifiableAccess(user.username);
            if (!access) continue;
            if (!(await accessibleTo(sql, access, [episode.id, series.id]))) continue;

            await publishUserEvent({
                userId: user.id,
                kind: EVENT_KIND_LIBRARY_NEW_EPISODE,
                persist: true,
                data: {
                    mediaId: episode.id,
                    seriesId: series.id,
                    seriesTitle: series.title,
                    episodeTitle: episode.title,
                    seasonNumber: episode.season_number,
                    episodeNumber: episode.episode_number,
                    posterUrl: posterRef(series.id),
                    coalesceKey,
                    // Why THIS user is being told. Falls back to `watching`,
                    // which is unreachable — every path into `candidates` above
                    // records a reason — but the payload should never carry a
                    // missing field on a row a client may read for years.
                    reason: candidateReasons.get(user.id) ?? 'watching',
                },
            });
        } catch (err) {
            log.warn('library.new_episode emit failed for user; continuing', {
                userId: user.id,
                seriesId: series.id,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/** Below this many watch-history recipients a fan-out is never suspicious. */
const WATCH_HISTORY_FAN_OUT_MIN_RECIPIENTS = 10;

/**
 * Log when watch history alone would notify most of the install. Nearly every
 * user genuinely watching one show is possible but rare; the usual cause is
 * bad watch data — an import or bulk mark that stamped a series watched for
 * everyone, which is how ~30 users got a premiere push for a show they had
 * never seen (prod, 2026-10-02). Observability only: nothing is suppressed.
 */
async function warnOnWatchHistoryFanOut(
    sql: postgres.Sql,
    series: { id: string; title: string },
    reasons: ReadonlyMap<string, NewEpisodeReason>,
): Promise<void> {
    let viaWatching = 0;
    for (const reason of reasons.values()) if (reason === 'watching') viaWatching++;
    if (viaWatching < WATCH_HISTORY_FAN_OUT_MIN_RECIPIENTS) return;

    // Never throws: a failed count must not cost every candidate their push.
    try {
        const [row] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM users`;
        if (viaWatching * 2 <= row.total) return;
        log.warn('library.new_episode would reach most users through watch history alone', {
            seriesId: series.id,
            seriesTitle: series.title,
            viaWatching,
            totalUsers: row.total,
        });
    } catch (err) {
        log.debug('fan-out check skipped', {
            seriesId: series.id,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Users who watched any of these rows (an episode and its duplicate S/E row). */
async function listUsersWhoWatched(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<Set<string>> {
    const rows = await sql<{ user_id: string }[]>`
        SELECT DISTINCT user_id::text AS user_id
        FROM user_media_state
        WHERE media_id = ANY(${[...new Set(mediaIds)]}::uuid[])
          AND is_watched = true
    `;
    return new Set(rows.map((r) => r.user_id));
}

// ---------------------------------------------------------------------------
// request.available
// ---------------------------------------------------------------------------

async function tmdbIdFor(sql: postgres.Sql, mediaId: string): Promise<number | null> {
    const rows = await sql<{ external_id: string }[]>`
        SELECT external_id
        FROM external_ids
        WHERE media_id = ${mediaId}::uuid AND provider = 'tmdb'
        LIMIT 1
    `;
    const raw = rows[0]?.external_id;
    if (raw === undefined) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A `request.available` check staged inside the dispatcher transaction and
 * delivered outside it. Everything here is read from the DB in-tx; the drain
 * needs no further hydration before it calls Jellyseerr.
 */
interface StagedRequestCheck {
    /** The item the notification is about (movie or series). */
    subjectId: string;
    /** The item that actually became playable — also access-gated. */
    itemId: string;
    publicType: 'movie' | 'series';
    title: string;
    year: number | null;
    tmdbId: number;
}

/**
 * Staged checks, keyed by subject id so a ten-episode season drop asks
 * Jellyseerr ONCE.
 */
const pendingRequestChecks = new Map<string, StagedRequestCheck>();
let requestDrainTimer: ReturnType<typeof setTimeout> | null = null;
let requestDrainPromise: Promise<void> | null = null;

/** Coalescing window before a drain runs. */
const REQUEST_DRAIN_DELAY_MS = 1_000;

/**
 * In-transaction half: DB-only, no network.
 *
 * The dispatcher runs handlers inside a per-row `FOR UPDATE` transaction and
 * documents the contract explicitly — "a handler MUST stay fast and DB-only, no
 * slow network I/O that would pin a pool connection across the wire"
 * (`pipeline-event-dispatcher.service.ts`). Calling `getRequests` here violated
 * it: a struggling Jellyseerr held one pooled connection and one outbox row lock
 * for up to the client timeout on EVERY `media.becamePlayable`, and
 * `isConfigured()` only latches false on ENOTFOUND, so timeouts and 5xx never
 * back it off.
 *
 * Same split as `media-added-notifier.service.ts` — stage in the tx, do the slow
 * outbound work after — but staged in memory rather than in a table. The whole
 * branch is already best-effort (a Jellyseerr outage drops the notification with
 * a log line and no retry), so a pod restart losing a staged check is the
 * failure mode this path already has, and it does not earn a migration, a table
 * and a leader-gated flush loop of its own. If `request.available` ever becomes
 * something whose loss must be recoverable, promote this map to a staging table
 * — the shape is deliberately the same.
 */
async function stageRequestAvailableCheck(
    sql: postgres.Sql,
    resolved: ResolvedItem,
): Promise<void> {
    // A request is made against a movie or a SERIES — never an episode. So the
    // subject of `request.available` for an episode is its series.
    const subject = resolved.series ?? resolved.item;
    const publicType = toPublicMediaType(subject.media_type);
    if (publicType !== 'movie' && publicType !== 'series') return;

    const tmdbId = await tmdbIdFor(sql, subject.id);
    if (tmdbId === null) return;

    pendingRequestChecks.set(subject.id, {
        subjectId: subject.id,
        itemId: resolved.item.id,
        publicType,
        title: subject.title,
        year: subject.year,
        tmdbId,
    });
    scheduleRequestDrain();
}

function scheduleRequestDrain(): void {
    if (requestDrainTimer !== null) return;
    requestDrainTimer = setTimeout(() => {
        requestDrainTimer = null;
        void drainRequestAvailableChecks().catch((err: unknown) => {
            log.warn('request.available drain rejected', {
                err: err instanceof Error ? err.message : String(err),
            });
        });
    }, REQUEST_DRAIN_DELAY_MS);
    // A pending notification must never keep a shutting-down worker alive.
    if (typeof requestDrainTimer.unref === 'function') requestDrainTimer.unref();
}

/**
 * Out-of-transaction half: one Jellyseerr fetch per batch, then per-subject
 * delivery on a normal pooled connection.
 *
 * Exported so tests can await the work the timer would otherwise do later.
 * Concurrent callers join the same promise, so awaiting this also waits for
 * a timer-started scan. An explicit drain consumes the scheduled timer too.
 */
export function drainRequestAvailableChecks(): Promise<void> {
    if (requestDrainTimer !== null) {
        clearTimeout(requestDrainTimer);
        requestDrainTimer = null;
    }
    if (requestDrainPromise) return requestDrainPromise;
    // Defer the body until the shared promise is assigned, including the
    // empty-batch path which would otherwise finish synchronously.
    requestDrainPromise = Promise.resolve()
        .then(async () => {
            while (pendingRequestChecks.size > 0) {
                const batch = [...pendingRequestChecks.values()];
                pendingRequestChecks.clear();

                // Not the dispatcher's transaction handle — a pooled connection of
                // our own, which is the entire point of doing this out here.
                // publishUserEvent's durable write already uses this same pool.
                const sql = getDb();
                if (!sql) {
                    log.warn('DB unavailable — dropping staged request.available checks', {
                        dropped: batch.length,
                    });
                    return;
                }

                let requests: JellyseerrRequest[];
                try {
                    requests = await jellyseerrClient.getRequests({
                        status: 'all',
                        take: JELLYSEERR_REQUEST_SCAN_SIZE,
                    });
                } catch (err) {
                    log.warn('Seerr request scan failed — dropping staged checks', {
                        dropped: batch.length,
                        err: err instanceof Error ? err.message : String(err),
                    });
                    return;
                }

                for (const staged of batch) {
                    try {
                        await emitRequestAvailable(sql, staged, requests);
                    } catch (err) {
                        log.warn('request.available emit failed for item; continuing', {
                            subjectId: staged.subjectId,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }
        })
        .finally(() => {
            requestDrainPromise = null;
        });
    return requestDrainPromise;
}

/**
 * Which Jellyseerr request statuses earn "your request is available".
 *
 * | Status                | Notify | Why                                                                |
 * | --------------------- | ------ | ------------------------------------------------------------------ |
 * | 1 `PENDING_APPROVAL`  | yes    | The ask is real and the media is here; approval never happened but  |
 * |                       |        | the user's intent did, and the popup already shows them the request. |
 * | 2 `APPROVED`          | yes    | The design's main case.                                             |
 * | 3 `DECLINED`          | NO     | The operator said no. The item arriving by some other route is not   |
 * |                       |        | their request being fulfilled, and the card deep-links to a request  |
 * |                       |        | that was refused.                                                    |
 * | 4 `FAILED`            | yes    | Jellyseerr's own import gave up, but Lumastra can play it now — from |
 * |                       |        | the requester's side that is exactly "available".                    |
 * | 5 `COMPLETED`         | yes    | The normal terminal state (not in the local enum; see the            |
 * |                       |        | `status: RequestStatus | number` comment in jellyseerr.ts).          |
 *
 * Expressed as "not DECLINED" rather than an allowlist on purpose: a status
 * Jellyseerr adds later is far more likely to be another flavour of "in
 * progress" than a second refusal, and failing open costs one notification for
 * media the user demonstrably asked for, while failing closed would silently
 * switch the kind off against a newer Jellyseerr.
 */
function isNotifiableRequestStatus(status: number): boolean {
    return status !== RequestStatus.DECLINED;
}

async function emitRequestAvailable(
    sql: postgres.Sql,
    staged: StagedRequestCheck,
    requests: readonly JellyseerrRequest[],
): Promise<void> {
    const { subjectId, publicType, tmdbId } = staged;
    const jellyseerrType = publicType === 'series' ? 'tv' : 'movie';
    const matching = requests.filter(
        (r) =>
            r.media?.tmdbId === tmdbId &&
            r.media?.mediaType === jellyseerrType &&
            isNotifiableRequestStatus(r.status),
    );
    if (matching.length === 0) return;

    // Jellyseerr user → Lumastra user by username, the convention every other
    // request surface uses (`defs/requests/[id]/index.ts:163`). displayName is
    // the documented fallback for Jellyseerr accounts with no local username.
    const byUsername = new Map<string, number>();
    for (const r of matching) {
        const name = r.requestedBy?.username ?? r.requestedBy?.displayName;
        if (!name) continue;
        // First request wins — the id is only carried so a client can deep-link
        // to the request; duplicates for one user are the same notification.
        if (!byUsername.has(name.toLowerCase())) byUsername.set(name.toLowerCase(), r.id);
    }
    if (byUsername.size === 0) return;

    const resolvedUsers = await resolveUsernamesToUsers(sql, [...byUsername.keys()]);
    const coalesceKey = `media:${subjectId}`;

    for (const [name, requestId] of byUsername) {
        // Per-requester isolation — same reason as the new-episode loop: one
        // transient failure must not drop every remaining requester silently.
        try {
            const target = resolvedUsers.get(name);
            if (!target) continue;
            const users = await loadNotifiableUsers(sql, [target.id]);
            const user = users.get(target.id);
            if (!user) continue;

            // Cheap early-out only; the INSERT is the arbiter (see the top of
            // the file).
            if (
                await hasCoalescedNotificationToday(sql, {
                    userId: user.id,
                    kind: EVENT_KIND_REQUEST_AVAILABLE,
                    coalesceKey,
                })
            ) {
                continue;
            }
            // Per-recipient cost — see the identical comment in the
            // new-episode loop above; the candidate set here is the
            // requesters of one item, tens on a home install.
            const access = await resolveNotifiableAccess(user.username);
            if (!access) continue;
            if (!(await accessibleTo(sql, access, [staged.itemId, subjectId]))) continue;

            await publishUserEvent({
                userId: user.id,
                kind: EVENT_KIND_REQUEST_AVAILABLE,
                persist: true,
                data: {
                    mediaId: subjectId,
                    mediaType: publicType,
                    title: staged.title,
                    year: staged.year,
                    posterUrl: posterRef(subjectId),
                    requestId,
                    coalesceKey,
                },
            });
        } catch (err) {
            log.warn('request.available emit failed for user; continuing', {
                username: name,
                subjectId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Runs inside the dispatcher's per-row transaction. Best-effort per branch:
 * a Jellyseerr outage must not stop the new-episode notification, and neither
 * failure should make the dispatcher retry an event whose durable rows were
 * already written.
 *
 * Only the new-episode branch delivers here. The request branch STAGES (DB-only)
 * and is delivered by `drainRequestAvailableChecks()` after this transaction has
 * let go of its row lock — see `stageRequestAvailableCheck`.
 */
export async function handleUserNotifiableMediaBecamePlayable(
    sql: postgres.Sql,
    payload: PipelineEventPayload,
): Promise<void> {
    if (payload.event !== 'media.becamePlayable') return;

    // Flood gate. FIRST, before any hydration: during the initial import every
    // item in the library raises this event, and without this line each of them
    // becomes a notification for every user.
    if (await isInitializingWindow(sql)) return;

    const resolved = await resolveItem(sql, payload.mediaId);
    if (!resolved) return;

    if (resolved.series) {
        try {
            await emitNewEpisode(sql, resolved);
        } catch (err) {
            log.warn('library.new_episode emit failed', {
                mediaId: payload.mediaId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // `available: false` in the capabilities `kinds` list is this same
    // condition — an unconfigured Jellyseerr means the kind can never arrive.
    if (jellyseerrClient.isConfigured()) {
        try {
            await stageRequestAvailableCheck(sql, resolved);
        } catch (err) {
            log.warn('request.available staging failed', {
                mediaId: payload.mediaId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Registration shell, mirroring `MediaAddedNotifier`. There is no flush loop to
 * own here — notifications are written synchronously inside the handler — so
 * this class exists only to keep the orchestrator's wiring symmetrical and to
 * give the registration one call site.
 */
export class UserNotifier {
    /** Register the handler. Call once at module wiring time. */
    registerHandler(): void {
        registerPipelineEventHandler(
            'media.becamePlayable',
            handleUserNotifiableMediaBecamePlayable,
        );
    }
}
