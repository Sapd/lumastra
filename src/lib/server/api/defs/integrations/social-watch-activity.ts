// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/social/watch-activity/[id]
 *
 * Returns which users have watched/rated a specific piece of content.
 * Only includes users who have not hidden their activity.
 *
 * ID formats:
 *   - Composite: tmdb:550:movie
 *   - UUID:      550e8400-e29b-41d4-a716-446655440000
 *
 * Response (bare object): { activities: ActivityItem[] }
 */

import { loadPublicAuthors } from '$lib/server/utils/public-author.js';
import { buildPublicAuthor } from '$lib/shared/public-author.js';
import type postgres from 'postgres';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { features } from '$lib/server/config.js';
import type { SocialWatchActivityResponse } from '$lib/schemas/api-integrations-responses.js';
import {
    isAudiobook,
    isEpisode,
    isSeason,
    isMovie,
    isSeries,
} from '$lib/server/utils/media-types.js';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import {
    parseMediaId,
    validateParsedMediaId,
    describeParsedMediaId,
} from '$lib/server/utils/media-key-parser.js';
import { resolveMediaIdByProvider } from '$lib/server/database/queries/media-queries.js';
import { getAnnotations } from '$lib/server/database/queries/media-annotations.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getMediaTypeAndParent,
    resolveExternalIdToMediaId,
    getRatedActivities,
    getWatchedActivities,
    getAudiobookListeningActivities,
    getOwnAudiobookListening,
    getAudiobookChapterTable,
    type RatedActivityRow,
} from '$lib/server/database/queries/social-activity.queries.js';
import {
    buildAudiobookListeningEntries,
    type AudiobookListeningInput,
} from '$lib/server/utils/audiobook-listening-rows.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import * as m from '$lib/paraglide/messages.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';

const logger = Logger.for('SocialWatchActivity');

// ---------------------------------------------------------------------------
// Rating / progress description helpers
// ---------------------------------------------------------------------------

function getRatingDescription(rating: number, name: string | null): string {
    const firstName = name ?? m.social_someone();

    if (rating >= 9) {
        const phrases = [
            m.social_rating_excellent_1({ name: firstName }),
            m.social_rating_excellent_2({ name: firstName }),
            m.social_rating_excellent_3({ name: firstName }),
            m.social_rating_excellent_4({ name: firstName }),
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    } else if (rating >= 7) {
        const phrases = [
            m.social_rating_good_1({ name: firstName }),
            m.social_rating_good_2({ name: firstName }),
            m.social_rating_good_3({ name: firstName }),
            m.social_rating_good_4({ name: firstName }),
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    } else if (rating >= 5) {
        const phrases = [
            m.social_rating_okay_1({ name: firstName }),
            m.social_rating_okay_2({ name: firstName }),
            m.social_rating_okay_3({ name: firstName }),
            m.social_rating_okay_4({ name: firstName }),
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    } else if (rating >= 3) {
        const phrases = [
            m.social_rating_poor_1({ name: firstName }),
            m.social_rating_poor_2({ name: firstName }),
            m.social_rating_poor_3({ name: firstName }),
            m.social_rating_poor_4({ name: firstName }),
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    } else {
        const phrases = [
            m.social_rating_bad_1({ name: firstName }),
            m.social_rating_bad_2({ name: firstName }),
            m.social_rating_bad_3({ name: firstName }),
            m.social_rating_bad_4({ name: firstName }),
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }
}

/**
 * Wording scope for the "has watched this" line.
 *
 * Episodes are deliberately NOT rolled up to their series (see the resolver
 * below), so an episode-scoped line describes activity on that single episode
 * and can honestly say "this episode". Seasons still roll up, and therefore
 * describe themselves as the series.
 *
 * `'audiobook'` is not just different wording — it selects a different QUERY and
 * a different visibility regime (trust circle rather than `hide_streams` alone).
 * See {@link loadAudiobookSection}.
 */
type WatchScope = 'movie' | 'series' | 'episode' | 'audiobook';

/**
 * The scopes this wording covers. Excludes `'audiobook'` so the compiler rejects
 * routing a book through the watch copy — "{name} has watched this" for a 40-hour
 * book someone is 12 chapters into.
 */
type WatchedWordingScope = Exclude<WatchScope, 'audiobook'>;

function getWatchedDescription(name: string | null, scope: WatchedWordingScope): string {
    const firstName = name ?? m.social_someone();
    const phrases =
        scope === 'series'
            ? [
                  m.social_watched_series_1({ name: firstName }),
                  m.social_watched_series_2({ name: firstName }),
                  m.social_watched_series_3({ name: firstName }),
              ]
            : scope === 'episode'
              ? [
                    m.social_watched_episode_1({ name: firstName }),
                    m.social_watched_episode_2({ name: firstName }),
                    m.social_watched_episode_3({ name: firstName }),
                ]
              : [
                    m.social_watched_1({ name: firstName }),
                    m.social_watched_2({ name: firstName }),
                    m.social_watched_3({ name: firstName }),
                ];
    return phrases[Math.floor(Math.random() * phrases.length)];
}

function getTvProgressDescription(
    name: string | null,
    episodesWatched: number | null,
    totalEpisodes: number | null,
): string {
    const firstName = name ?? m.social_someone();

    if (episodesWatched && totalEpisodes && totalEpisodes > 0) {
        const percentage = Math.round((episodesWatched / totalEpisodes) * 100);

        if (percentage >= 100) {
            const phrases = [
                m.social_tv_complete_1({ name: firstName }),
                m.social_tv_complete_2({ name: firstName }),
                m.social_tv_complete_3({ name: firstName }),
            ];
            return phrases[Math.floor(Math.random() * phrases.length)];
        } else if (percentage >= 75) {
            const phrases = [
                m.social_tv_progress_high({ name: firstName, percent: percentage }),
                m.social_tv_progress_episodes({
                    name: firstName,
                    watched: episodesWatched,
                    total: totalEpisodes,
                }),
                m.social_tv_progress_percent({ name: firstName, percent: percentage }),
            ];
            return phrases[Math.floor(Math.random() * phrases.length)];
        } else if (percentage >= 50) {
            const phrases = [
                m.social_tv_half_1({ name: firstName }),
                m.social_tv_half_2({
                    name: firstName,
                    watched: episodesWatched,
                    total: totalEpisodes,
                }),
                m.social_tv_half_3({ name: firstName, count: episodesWatched }),
            ];
            return phrases[Math.floor(Math.random() * phrases.length)];
        } else if (percentage >= 25) {
            const phrases = [
                m.social_tv_quarter({ name: firstName, count: episodesWatched }),
                m.social_tv_half_2({
                    name: firstName,
                    watched: episodesWatched,
                    total: totalEpisodes,
                }),
                m.social_tv_started_2({ name: firstName }),
            ];
            return phrases[Math.floor(Math.random() * phrases.length)];
        } else if (episodesWatched >= 1) {
            const episodeText =
                episodesWatched === 1
                    ? m.social_one_episode()
                    : m.social_episodes({ count: episodesWatched });
            const phrases = [
                m.social_tv_started_1({ name: firstName, count: episodeText }),
                m.social_tv_started_2({ name: firstName }),
                m.social_tv_started_3({ name: firstName }),
            ];
            return phrases[Math.floor(Math.random() * phrases.length)];
        } else {
            return m.social_tv_started_3({ name: firstName });
        }
    }

    // No usable episode counters — fall back to the plain line, but keep it
    // series-specific. This is the path that used to render the vague
    // "{name} has watched this" on a series.
    return getWatchedDescription(name, 'series');
}

/** A media reference normalized to the row we query plus the wording to use. */
interface ResolvedTarget {
    mediaId: string;
    /**
     * Handed to getWatchedActivities, where it selects the progress columns
     * rather than the row filter. `'episode'` suppresses the series counters.
     *
     * **`null` for an audiobook**, which does not go through
     * getWatchedActivities at all. Nullable rather than a harmless default so
     * the compiler — not a reviewer — is what stops a future edit from feeding
     * an audiobook to the movie/TV query.
     */
    queryType: 'movie' | 'tv' | 'episode' | null;
    scope: WatchScope;
}

/**
 * Normalize a media_items row to the id to query and the wording to use.
 *
 * Both the UUID branch and the composite-id branch route through here, so an
 * episode arriving as `tmdb:123:episode` is scoped exactly like the same
 * episode arriving as a UUID. Keeping this in one place is deliberate: when
 * the two branches each carried their own copy, the composite one silently
 * missed episode scoping entirely.
 *
 * Returns null when a season cannot be traced to a movie/series ancestor. The
 * season row carries no watch state of its own, so querying it would render an
 * empty list under a header confidently naming a series we never found.
 */
async function resolveTarget(
    sql: postgres.Sql,
    row: { id: string; media_type: string; parent_id: string | null },
): Promise<ResolvedTarget | null> {
    // Audiobooks branch FIRST, ahead of the toTmdbType fallback at the bottom
    // that would otherwise classify them as movies and hand them to
    // getWatchedActivities — which filters `is_watched = true` and so renders
    // nothing at all for a book in progress, and renders a FINISHED book to
    // everyone with hide_streams = false rather than to the trust circle.
    if (isAudiobook(row.media_type)) {
        return { mediaId: row.id, queryType: null, scope: 'audiobook' };
    }

    // Episodes stay themselves — user_media_state carries per-episode
    // is_watched rows, so "watched this episode" is literally true.
    if (isEpisode(row.media_type)) {
        return { mediaId: row.id, queryType: 'episode', scope: 'episode' };
    }

    if (isSeason(row.media_type)) {
        // Seasons roll up; there is no per-season watch row to point at. The
        // walk is bounded because a season sits one hop from its series —
        // anything deeper is broken data, and a parent_id cycle must not spin.
        let currentId = row.parent_id;
        for (let i = 0; i < 2 && currentId; i++) {
            const parent = await getMediaTypeAndParent(sql, currentId);
            if (!parent) break;
            // Positive check on purpose. Excluding only episode/season would
            // adopt ANY other row a corrupted parent_id happens to point at —
            // a music album, say — and then describe it as "this series".
            if (isMovie(parent.media_type)) {
                return { mediaId: parent.id, queryType: 'movie', scope: 'movie' };
            }
            if (isSeries(parent.media_type)) {
                return { mediaId: parent.id, queryType: 'tv', scope: 'series' };
            }
            currentId = parent.parent_id;
        }
        return null;
    }

    return toTmdbType(row.media_type) === 'tv'
        ? { mediaId: row.id, queryType: 'tv', scope: 'series' }
        : { mediaId: row.id, queryType: 'movie', scope: 'movie' };
}

// ---------------------------------------------------------------------------
// Extraction seam
// ---------------------------------------------------------------------------

/**
 * Result of building the watch-activity payload for a media id.
 *
 * `ok: false` covers every failure branch the route used to handle inline —
 * one return channel, two presentations. The route maps each `reason` to an
 * `ApiProblem`; `context` (which cannot call this route over HTTP, since the
 * internal `/api/*` surface rejects bearer tokens) treats every failure the
 * same way: omit the section.
 *
 * `'unresolved'` specifically means the media id never resolved to a row we
 * could query. It is NOT `{ ok: true, activities: [] }`: `context` lists every
 * `ok: true` section in `included[]`, which the API contract defines as
 * "requested, honored, and turned up nothing". Saying that after a failed
 * lookup tells the client "nobody watched this" when the true answer is
 * unknown.
 */
export type WatchActivityOutcome =
    | { ok: true; body: SocialWatchActivityResponse }
    | { ok: false; reason: 'invalid-id' | 'not-found' | 'unavailable' | 'unresolved' };

/**
 * Resolve an id our own PK lookup missed, via the shared media-id resolver
 * (internal PK first, then an `external_ids` / Jellyfin lookup).
 *
 * `context` resolves its route param through `resolveCatalogInternalId`, which
 * has that external_ids fallback. Without the same fallback here, a Jellyfin
 * external UUID — a documented, supported id form — resolved for
 * details/rating/watched and came back empty for social alone.
 */
async function resolveViaExternalIds(rawId: string): Promise<string | null> {
    try {
        const { mediaIdResolver } = await import('$lib/server/services/media-id-resolver.js');
        const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
        return resolved.internalId ?? null;
    } catch (err) {
        logger.debug('external_ids fallback failed for social activity', {
            error: err instanceof Error ? err.message : 'unknown',
        });
        return null;
    }
}

/**
 * The audiobook half of the section: in-progress rows (§4.1) and shared-listen
 * detection (§4.2).
 *
 * Three reads, one round trip. They are independent — other people's rows, the
 * viewer's own row, and the book's chapter table — and the projection needs all
 * three, so a sequential chain would pay three latencies for nothing.
 *
 * **Assumes the caller has already run `checkMediaAccess` on `mediaId`.** That is
 * true at the single call site (`buildWatchActivity`, which checks before choosing
 * a branch) and it is what keeps this from being an existence oracle for books
 * outside the viewer's libraries — the trust-circle predicate answers "may I see
 * this PERSON", never "may I see this BOOK", and the chapter table read would
 * otherwise confirm any book by UUID.
 */
async function loadAudiobookSection(
    sql: postgres.Sql,
    mediaId: string,
    viewerId: App.Locals['user']['userId'],
): Promise<Omit<AudiobookListeningInput, 'displayNameFor'> | null> {
    const [rows, viewer, chapterTable] = await Promise.all([
        getAudiobookListeningActivities(sql, mediaId, viewerId),
        getOwnAudiobookListening(sql, mediaId, viewerId),
        getAudiobookChapterTable(sql, mediaId),
    ]);

    // No trust circle configured -> the predicate emitted `AND false` -> no rows.
    // The feature is dark, and the two other reads have nothing to say.
    if (rows.length === 0) return null;

    return {
        rows,
        viewer,
        chapters: chapterTable?.chapters ?? [],
        bookDurationMs: chapterTable?.duration_ms ?? null,
    };
}

/**
 * Build the "who watched/rated this" payload for a media id.
 *
 * `rawId` is the RAW route param (composite key or UUID), not a pre-resolved
 * UUID — parsing and the season→series roll-up (`resolveTarget`) stay inside
 * this function so a caller can never accidentally bypass them and render an
 * empty list under a series header.
 *
 * Access is ALWAYS checked here, against the row this function actually
 * resolved. There is deliberately no "the caller already checked" opt-out: the
 * caller checks the id IT resolved, this function resolves `rawId`
 * independently, and the two are not necessarily the same row. `context`
 * proved that concretely — it resolved `?externalId=` to item A, checked A,
 * then passed the PATH id (item B) here, so the opt-out suppressed B's only
 * access check and leaked B's viewer activity to a caller with no access to B.
 * One extra cheap check per request is worth removing that class of error.
 */
export async function buildWatchActivity(
    sql: postgres.Sql,
    rawId: string,
    user: App.Locals['user'],
    surface: ApiSurface = 'internal',
): Promise<WatchActivityOutcome> {
    if (!features.social) {
        return { ok: false, reason: 'unavailable' };
    }

    const currentUser = user.userId;
    const parsed = parseMediaId(rawId);

    if (!validateParsedMediaId(parsed)) {
        return { ok: false, reason: 'invalid-id' };
    }

    let resolvedMediaId: string | null = null;
    let queryType: 'movie' | 'tv' | 'episode' | null = 'movie';
    let scope: WatchScope = 'movie';

    if (parsed.type === 'uuid') {
        let typeRow = await getMediaTypeAndParent(sql, parsed.uuid!);
        if (!typeRow) {
            // A UUID-shaped id is not necessarily our internal PK — it may be a
            // Jellyfin external id. Resolve it the same way every other section
            // of `context` does before giving up.
            const internalId = await resolveViaExternalIds(parsed.uuid!);
            if (internalId) typeRow = await getMediaTypeAndParent(sql, internalId);
        }
        if (typeRow) {
            const target = await resolveTarget(sql, typeRow);
            if (!target) {
                logger.debug('Season has no movie/series ancestor', {
                    id: describeParsedMediaId(parsed),
                });
                return { ok: false, reason: 'unresolved' };
            }
            resolvedMediaId = target.mediaId;
            queryType = target.queryType;
            scope = target.scope;
        }
    } else {
        // parseMediaId accepts 'episode' and 'season' tokens too, so this
        // is NOT necessarily movie|tv. external_ids stores the same token
        // verbatim, so it doubles as the resolution key.
        const token = parsed.mediaType ?? 'movie';

        if (parsed.provider === 'tmdb') {
            resolvedMediaId = await resolveExternalIdToMediaId(sql, parsed.externalId!, token);
        } else {
            resolvedMediaId =
                (await resolveMediaIdByProvider(
                    sql,
                    parsed.provider!,
                    parsed.externalId!,
                    token,
                )) || null;
        }

        if (token === 'episode' || token === 'season') {
            // Route composite episode/season keys through the same
            // normalization as UUIDs. Without this they fell through to
            // the movie default and rendered the generic "watched this".
            const typeRow = resolvedMediaId
                ? await getMediaTypeAndParent(sql, resolvedMediaId)
                : null;
            const target = typeRow ? await resolveTarget(sql, typeRow) : null;
            if (!target) {
                logger.debug('Composite episode/season did not normalize', {
                    id: describeParsedMediaId(parsed),
                });
                return { ok: false, reason: 'unresolved' };
            }
            resolvedMediaId = target.mediaId;
            queryType = target.queryType;
            scope = target.scope;
        } else {
            queryType = token === 'tv' ? 'tv' : 'movie';
            scope = token === 'tv' ? 'series' : 'movie';
        }
    }

    if (!resolvedMediaId) {
        logger.debug('Could not resolve media ID for social activity', {
            id: describeParsedMediaId(parsed),
        });
        return { ok: false, reason: 'unresolved' };
    }

    // Checked against the row we RESOLVED, unconditionally — see the doc
    // comment. `resolvedMediaId` may differ from anything the caller saw, both
    // via the season→series roll-up and via the external-id fallbacks above.
    if (!(await checkMediaAccess(sql, resolvedMediaId, user))) {
        return { ok: false, reason: 'not-found' };
    }

    const ratedActivities = await getRatedActivities(sql, resolvedMediaId, currentUser);

    // Audiobooks take a different query, a different visibility regime and a
    // different row shape — see loadAudiobookSection. `queryType` is null on that
    // path, which is what stops the movie/TV query from running on a book.
    const listeningInput =
        scope === 'audiobook'
            ? await loadAudiobookSection(sql, resolvedMediaId, currentUser)
            : null;
    const watchedActivities =
        queryType === null
            ? []
            : await getWatchedActivities(
                  sql,
                  resolvedMediaId,
                  // 'episode' suppresses the series progress columns, which live on
                  // the series row and would be meaningless against an episode id.
                  queryType,
                  currentUser,
              );

    const ratedUserIds = new Set(
        ratedActivities.map((a: RatedActivityRow) => a.user_id.toLowerCase()),
    );

    const reviews = await getAnnotations(sql, {
        mediaId: resolvedMediaId,
        type: 'review',
        limit: 20,
        currentUser,
    });
    const authors = await loadPublicAuthors(
        [
            ...ratedActivities.map((a) => a.user_id),
            ...watchedActivities.map((a) => a.user_id),
            ...(listeningInput?.rows.map((a) => a.user_id) ?? []),
            ...reviews.map((r) => r.user_id),
        ],
        surface,
    );
    const authorById = new Map([...authors].map(([id, author]) => [id.toLowerCase(), author]));
    const authorFor = (userId: string): SocialWatchActivityResponse['activities'][number]['author'] =>
        authorById.get(userId.toLowerCase()) ?? buildPublicAuthor(userId, null, surface);

    const listeningEntries = listeningInput
        ? buildAudiobookListeningEntries({
              ...listeningInput,
              displayNameFor: (userId) => authorFor(userId).displayName,
          })
        : [];

    const result: SocialWatchActivityResponse['activities'] = ratedActivities.map(
        (activity: RatedActivityRow) => ({
            author: authorFor(activity.user_id),
            description: getRatingDescription(activity.rating, authorFor(activity.user_id).displayName),
            rating: activity.rating,
            // Validated narrow — legacy rows are null, anything unexpected → undefined.
            ratingStyle:
                activity.rating_style === 'quick' || activity.rating_style === 'stars'
                    ? activity.rating_style
                    : undefined,
            ratedAt: activity.created_at.toISOString(),
        }),
    );

    // Guarded rather than filtered inside: `watchedActivities` is already empty on
    // the audiobook path, so this restates that invariant in a form the compiler
    // checks — it is what narrows `scope` for getWatchedDescription, whose type
    // refuses 'audiobook'.
    if (scope !== 'audiobook') {
        for (const watched of watchedActivities) {
            if (!ratedUserIds.has(watched.user_id.toLowerCase())) {
                // Episode scope never takes the progress branch: the episode
                // counters describe the series, not this episode.
                const description =
                    scope === 'series'
                        ? getTvProgressDescription(
                              authorFor(watched.user_id).displayName,
                              watched.episodes_watched,
                              watched.total_episodes,
                          )
                        : getWatchedDescription(authorFor(watched.user_id).displayName, scope);

                result.push({
                    author: authorFor(watched.user_id),
                    description,
                    watchedOnly: true,
                    ...(scope === 'series' && watched.episodes_watched && watched.total_episodes
                        ? {
                              progress: {
                                  episodesWatched: watched.episodes_watched,
                                  totalEpisodes: watched.total_episodes,
                                  percentage: Math.round(
                                      (watched.episodes_watched / watched.total_episodes) * 100,
                                  ),
                              },
                          }
                        : {}),
                });
            }
        }
    }

    // Audiobook rows MERGE onto an existing rating row rather than being skipped
    // for anyone who rated the book. The movie rule ("a rating supersedes 'watched
    // this'") holds because both statements are binary and the rating is the richer
    // one. Here the position is the live, evolving half — dropping it for raters
    // would hide the whole point of the feature from the people most engaged with
    // the book. The rating survives: `rating`/`ratedAt`/`review` are untouched and
    // the client renders the stars from `rating`, not from `description`.
    for (const entry of listeningEntries) {
        const { userId, description, ...fields } = entry;
        const existing = result.find((r) => r.author.userId.toLowerCase() === userId.toLowerCase());
        if (existing) {
            Object.assign(existing, fields);
            existing.description = description;
        } else {
            result.push({ author: authorFor(userId), description, watchedOnly: true, ...fields });
        }
    }

    result.sort((a, b) => {
        if (a.rating && !b.rating) return -1;
        if (!a.rating && b.rating) return 1;
        return 0;
    });

    const reviewMap = new Map(
        reviews.map((r) => [r.user_id.toLowerCase(), { id: r.id, content: r.content }]),
    );
    for (const activity of result) {
        const r = reviewMap.get(activity.author.userId.toLowerCase());
        if (r) {
            activity.review = r.content;
            activity.reviewId = r.id;
        }
    }

    const knownUserIds = new Set(result.map((a) => a.author.userId.toLowerCase()));
    for (const r of reviews) {
        if (
            !knownUserIds.has(r.user_id.toLowerCase()) &&
            r.user_id.toLowerCase() !== (currentUser ?? '').toLowerCase()
        ) {
            result.push({
                author: authorFor(r.user_id),
                description: m.social_reviewed({
                    name: authorFor(r.user_id).displayName ?? m.social_someone(),
                }),
                review: r.content,
                reviewId: r.id,
            });
        }
    }

    const currentUserOwnReview = reviews.find(
        (r) => r.user_id.toLowerCase() === (currentUser ?? '').toLowerCase(),
    );
    if (currentUserOwnReview) {
        result.push({
            author: authorFor(currentUserOwnReview.user_id),
            description: '',
            review: currentUserOwnReview.content,
            reviewId: currentUserOwnReview.id,
            isSelf: true,
        });
    }

    const limitedResult = result.slice(0, 10);

    logger.debug('Social watch activity', {
        id: describeParsedMediaId(parsed),
        queryType,
        scope,
        ratedCount: ratedActivities.length,
        watchedOnlyCount: limitedResult.filter((r) => r.watchedOnly).length,
        totalActivities: limitedResult.length,
    });

    return { ok: true, body: { activities: limitedResult } };
}

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const socialWatchActivityDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        params: z.object({ id: z.string().min(1) }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return json({ activities: [] });

            const out = await buildWatchActivity(
                sql,
                event.params.id!,
                event.locals.user,
                ctx.surface,
            );
            if (out.ok) return json(out.body);
            switch (out.reason) {
                case 'invalid-id':
                    return ApiProblem.validationFailed(
                        `Could not parse media ID: ${event.params.id}. Use format: tmdb:550:movie or a valid UUID`,
                    );
                case 'unavailable':
                    return ApiProblem.forbidden('Social features are disabled');
                case 'not-found':
                    return ApiProblem.notFound();
                case 'unresolved':
                    // This route's long-standing contract: an id we cannot
                    // resolve renders as an empty list, not an error. Only
                    // `context` needs the distinction, and it reads the
                    // outcome directly rather than this response.
                    return json({ activities: [] });
            }
        },
    },
});
