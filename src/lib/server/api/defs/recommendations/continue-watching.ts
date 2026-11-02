// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { recommendationPreviews } from '$lib/server/services/media-preview.service.js';
import { getDb as previewDb } from '$lib/server/database/connection.js';

/**
 * Tier-2 endpoint: GET /api/v1/continue-watching
 *                  DELETE /api/v1/continue-watching/{id}
 *
 * Collapses (§rename-map):
 *   for-you/watching         → continue-watching (merged)
 *   for-you/watching/sources → continue-watching?include=sources
 *   continue-watching/{itemId} DELETE → continue-watching/{id} DELETE (param rename)
 *
 * Query params (GET):
 *   include  — 'sources' to include watch-source breakdown
 *   limit    — page size (1–100, default 20)
 *   offset   — page offset (default 0)
 *   types    — CSV ALLOW-LIST of public media types (e.g. 'movie,series,episode')
 *
 * Response: { items: RecommendationItem[], page: PageBlock }
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { buildAccessContext } from './recommender.js';
import type { RecommendationItem, RecommendedMediaRef } from './recommender.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { type ApiSurface, entityImageUrl } from '$lib/shared/api-urls.js';
import { isAudiobook } from '$lib/server/utils/media-types.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import { presentContinueWatchingItem } from './continue-watching-presentation.js';
import type { ResolvedMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import { ContinueWatchingResponseSchema } from '$lib/schemas/api-recommender-responses';
import { type PublicMediaType, publicMediaTypeSchema } from '$lib/schemas/common';

/**
 * Every value the `?types=` allow-list accepts, derived from the ONE place the
 * public discriminator is declared. Deriving it (rather than re-typing the
 * tuple) is what makes the param forward-safe: a new public media type is
 * accepted by the filter the moment it joins `publicMediaTypeSchema`, and the
 * 422 detail below can never advertise a stale vocabulary.
 */
export const PUBLIC_MEDIA_TYPE_VALUES: readonly PublicMediaType[] =
    publicMediaTypeSchema.def.out.options;

/** Shared prose for both the runtime gate and the published spec. */
const TYPE_PARAM_DESCRIPTION =
    'Comma-separated ALLOW-LIST of public media types to return, e.g. `movie,series,episode`. ' +
    'Only the listed types are emitted; every other type is dropped BEFORE pagination, so ' +
    '`page.hasMore` and the page size describe the filtered list. Takes PUBLIC values ' +
    `(${PUBLIC_MEDIA_TYPE_VALUES.join(' | ')}) — use \`series\`, not the internal \`tv\` ` +
    '(accepted as a legacy alias and normalized). Omitted OR empty (`?types=`) means no ' +
    'filtering: every type is returned, exactly as before this param existed. An unknown ' +
    'value is rejected with 422 `validation_failed` rather than silently ignored. Clients with ' +
    'no audiobook UI should send an allow-list (forward-safe) instead of assuming the rail only ' +
    'carries video.';

const ContinueWatchingQuerySchemaFromDocs = z.strictObject({
    include: z
        .string()
        .optional()
        .meta({ description: '"sources" to include watch-source breakdown per item' }),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .meta({ description: 'Page size (default 20)' }),
    offset: z.number().int().min(0).optional().meta({ description: 'Page offset (default 0)' }),
    types: z.string().optional().describe(TYPE_PARAM_DESCRIPTION),
});

const ContinueWatchingQuerySchema = z.strictObject({
    include: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
    // Kept a bare optional string HERE on purpose: the allow-list is parsed by
    // `parseMediaTypeFilter` so an unknown value produces a 422 naming the
    // offending token(s) and the real vocabulary, which a `z.enum` inside a CSV
    // string cannot express. Leaving it out of this schema entirely would make
    // mount()'s gate strip it before the handler ever saw it.
    types: z.string().optional(),
});

/**
 * Convert a DB row to the recommendation item envelope.
 *
 * `surface` is passed explicitly rather than read from a module global: this def
 * is mounted on BOTH surfaces, so the poster href must follow the mount that is
 * actually serving the request.
 *
 * Returns `null` when the row's `media_type` has no public representation
 * ('tvchannel', 'home_video', … → `toPublicMediaType` returns null). It used to
 * emit `?? row.media_type ?? 'movie'`, i.e. leak the raw storage token or
 * silently relabel the row as a movie — both push the client down a playback
 * path the item cannot serve. The caller MUST drop it.
 */
export function rowToItem(
    row: ContinueWatchingRow,
    surface: ApiSurface,
): RecommendationItem | null {
    const extIds = createExternalIds({
        [getPrimaryExternalIdProvider()]: row.tmdb_id || null,
        internal: row.media_id,
    });

    const idsRecord: Record<string, string> = {};
    for (const [k, v] of Object.entries(extIds ?? {})) {
        if (v != null) idsRecord[k] = String(v);
    }

    const runtimeMs = row.runtime_ms ? Number(row.runtime_ms) : 0;
    const positionMs = Number(row.resume_position_ms ?? 0);
    const progress = runtimeMs > 0 ? Math.min((positionMs / runtimeMs) * 100, 100) : 0;
    const presentation = presentContinueWatchingItem({
        id: row.media_id,
        title: row.title,
        mediaType: row.media_type,
        watchProgress: progress,
        duration: runtimeMs > 0 ? runtimeMs / 1000 : undefined,
        resumePositionSeconds: positionMs / 1000,
        overview: row.overview ?? undefined,
        externalIds: extIds,
        seriesId: row.series_id ?? undefined,
        seriesName: row.series_name ?? undefined,
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        updatedAt: row.last_event_at ?? undefined,
    });
    if (!presentation) return null;

    const posterHref = entityImageUrl(row.media_id, 'poster', surface, { size: 'thumb' });

    const media: RecommendedMediaRef = {
        id: row.media_id,
        type: presentation.publicType,
        title: presentation.title,
        ids: idsRecord,
        images: posterHref ? { poster: { href: posterHref } } : undefined,
    };

    // Episode context: project the parent-series link the row already carries
    // (series_id/series_name/season_number/episode_number) so a native client
    // can resolve the series detail and render "S1 · E1 · Pilot" instead of
    // treating a bare episode as a one-off movie. Mirrors the search endpoint
    // and `?include=details`. Only meaningful for episodes — for movies these
    // columns are null and stay absent (never emit null/0 placeholders).
    if (presentation.publicType === 'episode') {
        // Gate the series *name* on the series *id*. In SQL `series_id` is the
        // grandparent (series) UUID, but `series_name` is
        // COALESCE(grandparent_title, parent_title) — so a broken series link
        // (orphaned season) leaves series_id null while series_name falls back
        // to the SEASON's title. Emitting that as `seriesName` with no
        // resolvable `seriesId` would mislabel a season as the series, so only
        // surface the name when we actually have the series to link to.
        if (presentation.seriesId) {
            media.seriesId = presentation.seriesId;
            if (presentation.seriesName) media.seriesName = presentation.seriesName;
        }
        if (presentation.seasonNumber != null) media.seasonNumber = presentation.seasonNumber;
        if (presentation.episodeNumber != null) media.episodeNumber = presentation.episodeNumber;
    }

    // Watch-state (not media metadata): let the client render "X min left" and
    // a precise progress bar. Both already local — no extra query work.
    // `runtime_ms`/`resume_position_ms` are milliseconds (int32-capped in SQL).
    return {
        media,
        progress: presentation.progress,
        ...(presentation.lastPlayedAt ? { lastPlayedAt: presentation.lastPlayedAt } : {}),
        reason: { kind: 'continue-watching' },
    };
}

/**
 * Order continue-watching rows most-recent-activity first (by `last_event_at`),
 * matching web Home. Returns a NEW array — never mutates the input.
 *
 * This deliberately re-orders at the HTTP layer rather than in
 * `getContinueWatchingFromDb`: that query's `sort_score DESC` order is shared
 * with server-side hero-lead selection, so re-ordering there would move the
 * hero slide. Sorting the supplied rows here changes only what this endpoint
 * returns. Rows with no event timestamp (e.g. legacy backfill) sort last, with
 * a stable `media_id` tiebreak so identical requests return an identical order.
 *
 * The Tier-2 endpoint drains `getContinueWatching` before calling this helper,
 * so its recency order is global rather than limited to a `sort_score` prefix.
 */
export function orderByLastActivity(rows: ContinueWatchingRow[]): ContinueWatchingRow[] {
    return [...rows].sort((a, b) => {
        const ta = a.last_event_at ? Date.parse(a.last_event_at) : Number.NEGATIVE_INFINITY;
        const tb = b.last_event_at ? Date.parse(b.last_event_at) : Number.NEGATIVE_INFINITY;
        if (tb !== ta) return tb - ta;
        if (a.media_id < b.media_id) return -1;
        if (a.media_id > b.media_id) return 1;
        return 0;
    });
}

// ── Stale / barely-started drop rules ──────────────────────────────────────
//
// Two independent rules, both applied to the assembled list (membership only
// — never reorders; see filterStaleContinueWatching below):
//
//   Rule A — barely started AND long forgotten, any media type: a fresh
//            "started 20 minutes ago" row survives even at 0% because it
//            isn't stale yet; a legitimately-abandoned show survives even
//            after months if the user got meaningfully far into it.
//   Rule B — stale audiobook, regardless of progress. An audiobook the user
//            hasn't touched in a month is exactly the kind of thing this
//            rail should stop nagging about, even mid-book — unlike a movie
//            where "78% in, watched 19 days ago" is still a live intent to
//            finish tonight.
//
// Percent-done is NOT a safe primitive on its own across media types: 0.3%
// of a 9.6-hour audiobook is ~2 minutes of real listening, but 0.3% of a
// 40-minute episode is under 8 seconds — both would look identically
// "barely started" by percentage alone. The AGE gate is what makes the
// percent threshold safe: a fresh 0.3% is just "the user pressed play a
// minute ago" (age low, rule doesn't fire); only once it's also been weeks
// since any activity does the low percentage become meaningful signal that
// the user isn't coming back.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Rule A: below this percent (of runtime/duration) counts as "barely started". */
export const CW_MIN_PROGRESS_PCT = 5;
/** Rule A: only barely-started items older than this (in days) are dropped. */
export const CW_STALE_AFTER_DAYS = 30;
/** Rule B: audiobooks untouched for longer than this (in days) are dropped outright. */
export const CW_AUDIOBOOK_STALE_AFTER_DAYS = 30;

export interface ContinueWatchingDropInput {
    /** Raw media type (any of the three case conventions — normalized internally). */
    mediaType: string | null | undefined;
    /**
     * Percent complete, 0–100. `undefined` when duration is zero/null/unknown
     * — NOT computed as 0%. A zero/unknown-duration item can never be proven
     * "barely started", so Rule A must not fire on it (guards the division).
     */
    pctDone: number | undefined;
    /** Milliseconds since the item's last playback activity. */
    ageMs: number;
}

/**
 * Pure membership predicate for the Continue Watching rail. Returns true when
 * the row should be DROPPED. Kept side-effect-free and dependency-free on the
 * row/item shapes so it can be unit-tested directly against fixed
 * (mediaType, pctDone, ageMs) triples without constructing a full DB row.
 */
export function shouldDropFromContinueWatching({
    mediaType,
    pctDone,
    ageMs,
}: ContinueWatchingDropInput): boolean {
    const ageDays = ageMs / MS_PER_DAY;

    // Rule B — stale audiobook, independent of progress.
    if (isAudiobook(mediaType) && ageDays > CW_AUDIOBOOK_STALE_AFTER_DAYS) {
        return true;
    }

    // Rule A — barely started and long forgotten, any media type.
    if (pctDone !== undefined && pctDone < CW_MIN_PROGRESS_PCT && ageDays > CW_STALE_AFTER_DAYS) {
        return true;
    }

    return false;
}

/**
 * Apply the drop rules to a fetched batch of Continue Watching rows.
 *
 * Must run on the full fetched collection before pagination is sliced off it.
 * Filtering only the post-slice page would silently shrink pages by however
 * many rows this drops out of the middle. The Tier-2 endpoint drains the DB
 * source before applying this membership rule, recency ordering, and slicing.
 *
 * Order is untouched — this only removes elements, matching the surviving
 * rows' relative order in `rows`.
 */
export function filterStaleContinueWatching(rows: ContinueWatchingRow[]): ContinueWatchingRow[] {
    const now = Date.now();
    return rows.filter((row) => {
        const runtimeMs = row.runtime_ms ?? 0;
        const positionMs = row.resume_position_ms ?? 0;
        const pctDone = runtimeMs > 0 ? (positionMs / runtimeMs) * 100 : undefined;
        const ageMs = row.last_event_at ? now - Date.parse(row.last_event_at) : 0;
        return !shouldDropFromContinueWatching({ mediaType: row.media_type, pctDone, ageMs });
    });
}

/**
 * The SAME drop rules, applied to the assembled `ContinueWatchingItem` shape
 * (`effectiveWatchingFor` / `arbitrateWatching`) instead of the raw DB row.
 *
 * `GET /feed`'s `watching` section is fed by the same
 * `watchManager.getContinueWatching` rows as this endpoint, so without this it
 * kept surfacing exactly the rows `GET /continue-watching` has already decided
 * to forget. The two surfaces share the PURE predicate
 * ({@link shouldDropFromContinueWatching}) rather than this filter's row-shaped
 * wrapper — which is what that predicate was factored out for — so the policy
 * and its constants live in one place and cannot drift.
 *
 * Pass ONLY Continue-Watching items. Next-Up items must not go through here:
 * their `updatedAt` is the last completion in the series and their
 * `watchProgress` is 0, so Rule A would read them as "0% and untouched for 30
 * days" and drop the whole point of Next Up.
 *
 * `pctDone` is left `undefined` when no runtime is known (same guard as the row
 * version — an unknown-duration item can never be PROVEN barely-started).
 * Membership only; never reorders, never mutates the input.
 */
export function filterStaleWatchingItems(items: ContinueWatchingItem[]): ContinueWatchingItem[] {
    const now = Date.now();
    return items.filter((item) => {
        // `resumeRatio` (0–1) is the exact position/runtime fraction and is the
        // CW rows' own field; `watchProgress` (0–100) is the fallback, and is
        // only trustworthy when a runtime actually backed it.
        const pctDone =
            item.resumeRatio != null
                ? item.resumeRatio * 100
                : item.duration != null && item.duration > 0
                  ? item.watchProgress
                  : undefined;
        const ageMs = item.updatedAt ? now - Date.parse(item.updatedAt) : 0;
        return !shouldDropFromContinueWatching({ mediaType: item.mediaType, pctDone, ageMs });
    });
}

// ── ?types= media-type allow-list ───────────────────────────────────────────
//
// A third-party tvOS client with no audiobook UI filed this: once an
// AudiobookShelf library is configured, `audiobook` rows join this rail and a
// client that assumes "everything here is a video" renders a book as a movie
// poster and routes it into the movie playback path. The fix is an ALLOW-LIST
// (`?types=movie,series,episode`) rather than a deny-list (`?exclude=audiobook`):
// an allow-list stays correct when a NEW media type lands, because a client that
// never heard of it never asked for it. A deny-list silently breaks again on the
// next media type.
//
// The param takes PUBLIC values — the same vocabulary the response's
// `media.type` carries (`series`, not the stored `tv`). Rows are therefore
// mapped through `toPublicMediaType` before comparison, never string-compared
// against `media_items.media_type`: conflating the storage token with the public
// discriminator is a documented recurring bug in this codebase, and here it
// would make `?types=series` silently return zero episodes-of-series rows.

/** Parsed `?types=` allow-list. `null` = no filtering (param absent or empty). */
export type MediaTypeAllowList = ReadonlySet<PublicMediaType> | null;

/** Map the public API vocabulary to the storage values accepted by the CW query. */
export function toContinueWatchingDatabaseTypes(allow: MediaTypeAllowList): string[] | null {
    if (allow === null) return null;
    const values = new Set<string>();
    for (const type of allow) {
        if (type === 'series') {
            values.add('tv');
            values.add('show');
            values.add('series');
        } else {
            values.add(type);
        }
    }
    return [...values];
}

export interface MediaTypeFilterParse {
    /** The allow-list, or `null` for "no filtering" (absent/empty param). */
    allow: MediaTypeAllowList;
    /** Verbatim tokens that are not public media types. Non-empty ⇒ reject the request. */
    invalid: string[];
}

/**
 * Parse the raw `?types=` value into an allow-list.
 *
 * Contract:
 *  - `null`/`undefined` (param absent) → `{ allow: null }` — no filtering.
 *  - EMPTY value (`?types=`, `?types=,`, `?types=%20`) → `{ allow: null }`, i.e.
 *    treated exactly like an absent param. Chosen deliberately over "allow
 *    nothing": a client that builds `?types=${selected.join(',')}` from an empty
 *    selection would otherwise get a 200 with an empty rail and no way to tell
 *    that apart from "you have nothing in progress". Preserving the
 *    absent-param behaviour keeps the invariant that only an EXPLICIT list ever
 *    narrows the result.
 *  - Tokens are trimmed, case-insensitive, and validated against
 *    `publicMediaTypeSchema` — which also folds the legacy storage tokens
 *    `tv`/`show` onto `series`, so a client that still sends `tv` is normalized
 *    rather than rejected.
 *  - ANY unknown token makes the whole request invalid (`invalid` non-empty and
 *    `allow: null`). An unknown type is a client bug — a typo'd
 *    `?types=movies` must not silently return everything (the leak) or nothing
 *    (an empty rail); the caller turns this into a 422.
 */
export function parseMediaTypeFilter(raw: string | null | undefined): MediaTypeFilterParse {
    if (raw === null || raw === undefined) return { allow: null, invalid: [] };

    const tokens = raw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    if (tokens.length === 0) return { allow: null, invalid: [] };

    const allow = new Set<PublicMediaType>();
    const invalid: string[] = [];
    for (const token of tokens) {
        const parsed = publicMediaTypeSchema.safeParse(token.toLowerCase());
        if (parsed.success) allow.add(parsed.data);
        else invalid.push(token);
    }

    if (invalid.length > 0) return { allow: null, invalid };
    return { allow, invalid };
}

/**
 * Keep only rows whose PUBLIC media type is on the allow-list.
 *
 * Runs on the fetched collection BEFORE ordering and the pagination slice — same
 * placement, and for the same reason, as `filterStaleContinueWatching`: the page
 * the client receives, and the `hasMore` it pages with, must both describe the
 * FILTERED list. The client's actual complaint was asking for 20 video items and
 * getting a page mostly of books; filtering after the slice would instead hand
 * back a 20-slot page with the books punched out of it.
 *
 * A row whose stored type has NO public representation (`tvchannel`, `home_video`,
 * … → `toPublicMediaType` returns null) is dropped whenever a filter is active:
 * it cannot be a member of a list of public types, and an allow-list means "emit
 * only what I asked for". With no filter (`allow === null`) the rows are returned
 * untouched — the array itself, so the no-param path is byte-identical to before.
 *
 * Membership only; never reorders, never mutates the input.
 */
export function filterContinueWatchingByType(
    rows: ContinueWatchingRow[],
    allow: MediaTypeAllowList,
): ContinueWatchingRow[] {
    return filterByPublicMediaType(rows, allow, (row) => row.media_type);
}

/** Apply the same public-type allow-list to any watching item representation. */
export function filterByPublicMediaType<T>(
    items: T[],
    allow: MediaTypeAllowList,
    getMediaType: (item: T) => string | null | undefined,
): T[] {
    if (!allow) return items;
    return items.filter((item) => {
        const publicType = toPublicMediaType(getMediaType(item));
        return publicType !== null && allow.has(publicType);
    });
}

/**
 * Per-user metadata-language overlay (multilingual-media-metadata spec §5).
 *
 * This endpoint isn't routed through `runRecommender` (it has its own
 * DB-backed pipeline via `watchManager.getContinueWatching`), so it doesn't
 * get that shared post-cache overlay for free — this mirrors the same
 * block. `langs` is `buildAccessContext`'s already-resolved-once-per-request
 * value (no extra prefs query). `getContinueWatching` is NOT cached —
 * `items` is always a freshly-built array via `rowToItem`/`.map`, so
 * overlaying in place is safe (nothing here is cache-resident, unlike
 * watching-sources.ts / search/episodes.ts).
 */
export async function overlayContinueWatchingItems(
    sql: postgres.Sql,
    items: RecommendationItem[],
    langs: ResolvedMetadataLanguages | undefined,
): Promise<void> {
    if (!langs || (!langs.titleLang && !langs.textLang) || items.length === 0) return;
    const { applyTranslationOverlay } = await import('$lib/server/utils/translation-overlay.js');
    // Pass 1 — localize each item's OWN title (episode/movie title), keyed by
    // the item's media id.
    await applyTranslationOverlay(sql, items, langs, {
        id: (it) => it.media.id || null,
        setTitle: (it, v) => {
            it.media.title = v;
        },
    });
    // Pass 2 — localize the parent-series NAME on episode items. `seriesName`
    // is the series' title, so it must be translated from the SERIES id, not
    // the episode id — a second pass keyed by `media.seriesId`. Without this an
    // episode's own title renders translated while its series subtitle stays in
    // the library's primary language. Non-episode items have no `seriesId`, so
    // the id accessor returns null and they're untouched. Best-effort like
    // pass 1 (a failed lookup leaves the primary-language name in place).
    await applyTranslationOverlay(sql, items, langs, {
        id: (it) => it.media.seriesId || null,
        setTitle: (it, v) => {
            it.media.seriesName = v;
        },
    });
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Continue Watching'],
            summary: 'Get continue-watching list',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Returns the authenticated user's continue-watching list (in-progress items). " +
                'Each item is a MediaPreview with an opaque id handle, catalogId, ImageSet and ' +
                'progress {positionMs, durationMs, fraction, finished, updatedAt}. Items are ordered ' +
                'by most recent activity, exposed as lastPlayedAt when known. ' +
                'score is reserved for ranking and is absent here. ' +
                'Supports pagination and optional `?include=sources` to expose watch-source breakdown. ' +
                'The rail carries EVERY in-progress media type this install has — including ' +
                '`audiobook` once an AudiobookShelf library is configured — so a client that only ' +
                'plays video must pass the `?types=` allow-list (e.g. `?types=movie,series,episode`) ' +
                'instead of assuming `type` is a video type. Filtering happens before ' +
                'pagination, so a filtered page is a full page.',
            query: ContinueWatchingQuerySchemaFromDocs,
            responses: {
                200: {
                    schema: ContinueWatchingResponseSchema,
                    description: 'Continue-watching list',
                },
                401: 'Authentication required',
                422: 'Validation failed (bad limit/offset, or an unknown value in `?types=`)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: ContinueWatchingQuerySchema,
    },
    handlers: {
        GET: async (event, { surface }) => {
            const raw = Object.fromEntries(event.url.searchParams);

            const parsed = ContinueWatchingQuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const q = parsed.data;

            // `?types=` allow-list. Rejected loudly (422) on an unknown value —
            // silently ignoring it would return the very audiobooks the caller
            // asked us to leave out, which is the bug this param exists to fix.
            const typeFilter = parseMediaTypeFilter(q.types);
            if (typeFilter.invalid.length > 0) {
                return ApiProblem.validationFailed([
                    {
                        field: 'types',
                        message:
                            `Unknown media type(s): ${typeFilter.invalid.join(', ')}. ` +
                            `Allowed: ${PUBLIC_MEDIA_TYPE_VALUES.join(', ')}.`,
                    },
                ]);
            }

            const ctx = await buildAccessContext(event);
            if (!ctx) return ApiProblem.unauthorized();

            const { getExactContinueWatchingPage } =
                await import('./continue-watching-page.query.js');
            const rows = await getExactContinueWatchingPage(
                ctx.userId,
                q.limit + 1,
                {
                    offset: q.offset,
                    mediaTypes: toContinueWatchingDatabaseTypes(typeFilter.allow),
                    staleAfterDays: CW_STALE_AFTER_DAYS,
                    audiobookStaleAfterDays: CW_AUDIOBOOK_STALE_AFTER_DAYS,
                    minProgressPercent: CW_MIN_PROGRESS_PCT,
                },
                {
                    deniedGroupIds: ctx.deniedGroupIds,
                    ageRating:
                        ctx.maxAgeRating != null
                            ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                            : null,
                },
            );
            const hasMore = rows.length > q.limit;
            const pageRows = rows.slice(0, q.limit);

            // `rowToItem` returns null for a row whose stored media_type has no
            // public representation, and those are dropped here. Unlike the
            // filters above this one runs POST-slice, so such a row shrinks the
            // page by one instead of being backfilled — deliberate: it is not a
            // volume filter (nothing resumable is a tvchannel/home_video, so it
            // fires ~never), and paying for another pre-pagination pass to
            // backfill an unreachable case would just be a second policy to keep
            // in sync. Same trade-off `mapBatch` documents in item-mapper.ts.
            const items: RecommendationItem[] = pageRows
                .map((row) => rowToItem(row, surface))
                .filter((item): item is RecommendationItem => item !== null);

            if (items.length > 0 && (ctx.langs?.titleLang || ctx.langs?.textLang)) {
                const { getDb } = await import('$lib/server/database/connection.js');
                const overlaySql = getDb();
                if (overlaySql) {
                    await overlayContinueWatchingItems(overlaySql, items, ctx.langs);
                }
            }

            // `total` stays absent for response compatibility. The helper now
            // drains the source and computes exact membership/order, so hasMore
            // is authoritative for paging even though this endpoint has never
            // published a total count.
            return json(
                paginate(await recommendationPreviews(previewDb()!, surface, items), {
                    limit: q.limit,
                    offset: q.offset,
                    hasMore,
                }),
            );
        },
    },
});
