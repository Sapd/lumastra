// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/series/downloads/candidates?lane=series-next-up&budgetBytes=<n>&rung=<id>
 *
 * Ordered candidates for the offline series pool. `rank` is FETCH ORDERING
 * ONLY — the client never persists it and it never enters a keep-or-evict
 * decision. Only `/series/downloads/rescore` output is comparable.
 *
 * DEPTH IS CONTROLLED IN BYTES, not item counts. Episodes span three orders of
 * magnitude in size, so a count is the wrong unit: `want=20` means 2 GB or
 * 60 GB depending on what the user watches. The SQL returns rows in ranking
 * order bounded only for query cost; the byte estimate and the budget cut are
 * the pure functions below, unit-tested independently, because the ladder
 * arithmetic lives in `$lib/shared/download-rungs.ts` and duplicating it as SQL
 * is how music's `clampBitrate` defect would be reintroduced.
 *
 * A parallel endpoint rather than a lane on the music def, for one concrete
 * reason: the music rate-limit key and its `maxConcurrentDownloads` are
 * music-specific, so a series lane sharing that def would silently starve the
 * music pool and derive its concurrency from the mp3 transcoder.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import {
    clampRungForHeight,
    estimateRenditionBytes,
    getDownloadRung,
    DOWNLOAD_RUNGS,
    type DownloadRung,
} from '$lib/shared/download-rungs.js';
import {
    getSeriesNextUpCandidates,
    getSeriesEtagInputs,
    SERIES_LANE,
    SERIES_SCORE_VERSION,
    DEFAULT_SERIES_FREQUENCY_MODE,
    type SeriesCandidateRow,
    type SeriesEtagInputs,
    type DownloadAccessLimits,
    type SeriesFrequencyMode,
} from '$lib/server/database/queries/series-downloads.queries.js';
import {
    readySizesForFiles,
    prepareQueueDepth,
    type ReadyRenditionSize,
} from '$lib/server/database/queries/download-renditions.queries.js';
import { DownloadCandidatesResponseSchema } from '$lib/schemas/api-downloads.js';

/**
 * What the client must do with an item this lane graduates.
 *
 * Travels as DATA on the response, not as a rule the client infers from the
 * lane name. Terminal for series: a consumed episode's bytes are released.
 * Music's lane will advertise `retain` when it re-points at the neutral
 * schema — same wire status, opposite consequence.
 */
export const SERIES_GRADUATION_POLICY = 'delete';

/** Hard ceiling on rows returned, independent of the budget. */
export const MAX_ROWS_RETURNED = 500;

/** Budget assumed when a client names none. ~7 episodes at 720p. */
export const DEFAULT_BUDGET_BYTES = 8 * 1024 ** 3;

/** Ceiling on a requested budget — a cost bound, not a product rule. */
export const MAX_BUDGET_BYTES = 512 * 1024 ** 3;

/**
 * Every `rung` id this endpoint accepts, highest quality first — echoed
 * verbatim on the response as `rungVocabulary`.
 *
 * Derived from `DOWNLOAD_RUNGS` (the same ladder `getDownloadRung` checks
 * against below) rather than a hardcoded literal, so the published
 * vocabulary cannot drift from what the server actually accepts: a rung
 * added to or removed from the ladder without updating this list is
 * impossible, because there is no separate list to forget.
 */
export const RUNG_VOCABULARY: readonly string[] = DOWNLOAD_RUNGS.map((rung) => rung.id);

export interface BudgetedCandidate {
    row: SeriesCandidateRow;
    /** The rung the ENCODER will use — already clamped against the source. */
    rung: DownloadRung;
    estBytes: number;
    estBytesExact: boolean;
}

/** Index finished-artifact sizes by file id for O(1) lookup during the walk. */
export function exactSizeIndex(rows: ReadyRenditionSize[]): Map<string, ReadyRenditionSize> {
    return new Map(rows.map((r) => [r.file_id, r]));
}

/**
 * Resolve one row's rung and byte size, or `null` if it cannot be budgeted.
 *
 * Size sources, in priority order — ALL from the database, never a probe
 * (`renditions.ts` resolves a source with a live ffprobe per call, and a query
 * over hundreds of episodes cannot do that even once):
 *
 *   1. A finished artifact for this (file, clamped rung). Exact — unless
 *      several audio tracks are ready, in which case the largest is taken and
 *      reported as inexact, because the client POSTs without an `audioIndex`
 *      and the server resolves the source default itself.
 *   2. `estimateRenditionBytes(rung, durationMs)` — bitrate x duration x 1.02.
 *   3. Neither → `null`, and the caller counts it into `unbudgetableCount`.
 *
 * Dropping an unbudgetable candidate rather than emitting `estBytes: null` is
 * a deliberate divergence from music. A null is affordable for a 4 MB track;
 * an unbudgetable episode is a 1–3 GB hole in a device budget. The failure is
 * bounded and visible: such episodes never auto-download (manual download still
 * works) and the count surfaces it as the data-quality problem it is.
 */
export function budgetCandidate(
    row: SeriesCandidateRow,
    requestedRungId: string,
    exact: Map<string, ReadyRenditionSize>,
): BudgetedCandidate | null {
    const rung = clampRungForHeight(requestedRungId, row.source_height);
    if (!rung) return null;

    const ready = exact.get(row.file_id);
    if (ready) {
        return {
            row,
            rung,
            estBytes: Number(ready.size_bytes),
            // More than one ready row means more than one audio track, and we
            // cannot know which the client's POST will resolve to.
            estBytesExact: ready.ready_count === 1,
        };
    }

    const durationMs = row.duration_ms === null ? null : Number(row.duration_ms);
    // No `hasAudio` argument: a candidate row carries no stream facts and this
    // path deliberately never probes, so it budgets audio — the pessimistic
    // direction. A silent episode is quoted slightly high rather than low.
    const estBytes = estimateRenditionBytes(rung, durationMs);
    if (estBytes === null) return null;

    return { row, rung, estBytes, estBytesExact: false };
}

/**
 * Walk the ordered candidates, emitting while the budget is not yet spent.
 *
 * The comparison is against the cumulative total BEFORE this row, so the last
 * row may straddle the boundary and the client chooses whether to take it.
 * Cutting strictly before the boundary would leave the budget permanently
 * under-filled whenever the next item is large, which for episodes is always.
 *
 * A combined multi-episode file arrives as ONE row (the query is `DISTINCT ON
 * (file_id)`), so it is charged once here too — re-expanding it per covered id
 * would double-charge the budget for a single artifact.
 */
export function cutToBudget(items: BudgetedCandidate[], budgetBytes: number): BudgetedCandidate[] {
    const out: BudgetedCandidate[] = [];
    let spent = 0;
    for (const item of items) {
        if (spent >= budgetBytes) break;
        out.push(item);
        spent += item.estBytes;
        if (out.length >= MAX_ROWS_RETURNED) break;
    }
    return out;
}

/**
 * Renditions this user may hold in `queued`/`encoding` at once.
 *
 * Read from the SAME getter the renditions POST enforces. A contract that
 * advertises a different number than it enforces hands a compliant client a
 * stream of 503s.
 */
export function maxConcurrentPreparations(): number {
    return Math.max(1, config.SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER);
}

/**
 * How long a client must wait before re-POSTing a still-queued rendition.
 *
 * The stale window plus a small margin. This number is load-bearing: a
 * deferred rendition is advanced by NOTHING on the server — polling
 * `GET /renditions/{id}` only reads and touches — so only a re-POST after the
 * stale window makes the row reclaimable. Under the margin the re-POST is a
 * no-op that still costs a request.
 */
export function prepareRePostSeconds(): number {
    return config.DOWNLOAD_RENDITION_STALE_SECONDS + 5;
}

/** Byte transfers the client may run at once. */
export function maxConcurrentDownloads(): number {
    return Math.max(0, config.SERIES_DOWNLOAD_MAX_CONCURRENT_TRANSFERS);
}

/** ~4 pool refreshes/day/device plus a deeper daily read, with room for two devices. */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_S = 3600;

export const QuerySchema = z.object({
    lane: z.string(),
    /**
     * Depth control, in BYTES. Not an item count: episodes span three orders of
     * magnitude, so `want=20` means 2 GB or 60 GB depending on what the user
     * watches, and a pool cannot budget against that.
     */
    budgetBytes: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_BUDGET_BYTES)
        .optional()
        .default(DEFAULT_BUDGET_BYTES),
    /** Requested quality. Clamped per candidate against the source height. */
    rung: z.string().optional(),
    /**
     * How heavily a series' recent watch FREQUENCY (not just its most recent
     * touch) influences which candidates come first. Defaults to `balanced`
     * for every caller, including a client that predates this field —
     * `off` is the pre-existing distance/recency-only ordering, for a
     * client that wants to opt back out of it explicitly.
     */
    frequencyMode: z
        .enum(['off', 'balanced', 'frequency_first'])
        .optional()
        .default(DEFAULT_SERIES_FREQUENCY_MODE),
});

/**
 * Coarse time bucket mixed into the ETag validator (see
 * `computeSeriesCandidatesEtag`) — the series analogue of music's constant of
 * the same name, for the same reason: `getSeriesEtagInputs` cannot see an
 * AVAILABILITY change (an episode's default file going missing, or a
 * metadata-only episode-ordering edit), because neither touches
 * `user_media_state` or `user_media_flags`. This bucket bounds how long a
 * stale ETag can outlive such a change — 15 minutes, not a correctness fix
 * for the blind spot itself.
 */
const ETAG_TIME_BUCKET_MS = 15 * 60 * 1000;

/**
 * Build the `/candidates` ETag from cheap per-user engagement aggregates, the
 * RESOLVED access context, every request parameter that changes the output
 * shape (`lane`, `budgetBytes`, the RESOLVED `rung`), and a coarse time
 * bucket (see `ETAG_TIME_BUCKET_MS`).
 *
 * Unlike music, library/access is mixed in DIRECTLY here rather than left to
 * the time bucket alone: `getSeriesNextUpCandidates`'s `forward` CTE applies
 * `buildDefaultFileLibraryFilter` and `buildAgeRatingFilter` to every row, so
 * a library-group revocation or an age-rating change must invalidate a cached
 * head immediately — waiting out a 15-minute bucket for something this cheap
 * to include would be a needless staleness window. `buildSearchAccessContext`
 * is documented cheap (L1-cached) and safe to call on every request, so
 * mixing its resolved output in costs nothing extra worth rate-limiting.
 *
 * `rung` MUST be the already-defaulted id (what the handler will actually
 * query with), not the raw optional query value — otherwise an explicit
 * `?rung=<default>` and an omitted `rung` would hash to two different
 * validators for what is provably the same query. `frequencyMode` needs no
 * such resolution step: `QuerySchema` already applies a zod-level default,
 * so `ctx.input!.query.frequencyMode` is resolved by the time it reaches
 * here (same pattern as `budgetBytes`, unlike `rung`'s manual default).
 *
 * A strong validator (no `W/` prefix) — same reasoning as music's: there is
 * no partial-content use case here that would require weak-comparison
 * semantics.
 */
export function computeSeriesCandidatesEtag(
    inputs: SeriesEtagInputs,
    params: { lane: string; budgetBytes: number; rung: string; frequencyMode: SeriesFrequencyMode },
    access: DownloadAccessLimits,
    now: number = Date.now(),
): string {
    const timeBucket = Math.floor(now / ETAG_TIME_BUCKET_MS);
    const raw = [
        params.lane,
        params.budgetBytes,
        params.rung,
        params.frequencyMode,
        inputs.engagementMaxLastEvent?.toISOString() ?? 'null',
        inputs.engagementResumeCount,
        inputs.engagementMaxLastWatched?.toISOString() ?? 'null',
        inputs.engagementWatchedCount,
        inputs.dismissedMaxCreated?.toISOString() ?? 'null',
        inputs.dismissedCount,
        access.deniedGroupIds ? [...access.deniedGroupIds].sort().join(',') : 'null',
        access.ageRating
            ? `${access.ageRating.maxAgeRating}:${access.ageRating.allowUnrated}`
            : 'null',
        timeBucket,
    ].join('|');
    return `"${createHash('sha256').update(raw).digest('hex')}"`;
}

/**
 * Whether a client's `If-None-Match` header already carries the current
 * validator. Byte-identical to music's `etagMatches` — duplicated locally
 * rather than imported across domains, matching this def's existing
 * convention of self-contained pure helpers (see `budgetCandidate` /
 * `cutToBudget` above, which duplicate no shared cross-domain module either).
 * Handles the header's comma-separated multi-value form and the `*` wildcard;
 * does not need weak-comparison (`W/...`) handling since this endpoint only
 * ever emits strong tags.
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
    return ifNoneMatch
        .split(',')
        .map((v) => v.trim())
        .some((v) => v === '*' || v === etag);
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Series'],
            summary: 'List series suggested for offline download',
            stability: 'beta',
            auth: 'bearer',
            query: QuerySchema,
            headers: z.object({
                'If-None-Match': z
                    .string()
                    .optional()
                    .meta({
                        description:
                            'A previously-received `ETag` value for this lane. When it still ' +
                            'matches the current list, the response is `304` with no body and ' +
                            'no rate-limit cost — see the description above.',
                    }),
            }),
            description:
                'Ordered download candidates for a series lane, cut to `budgetBytes`. Ordering is ' +
                "distance-major: every tracked series' next episode is emitted before any " +
                "series' second, so a small budget yields the next episode of several shows " +
                'rather than several episodes of one. `frequencyMode` (default `balanced`) layers ' +
                'a watch-frequency signal on top of that: a series watched often in the last few ' +
                'weeks earns a capped allowance of EXTRA episodes ahead of a barely-touched ' +
                "show's second, without ever displacing that show's first — pass `off` for the " +
                'pre-existing recency-only tiebreak, or `frequency_first` to let a heavily-binged ' +
                "show claim several episodes ahead of a barely-touched show's first outright. " +
                '`rank` is fetch ordering only and must not ' +
                'be persisted or used for eviction — call `/series/downloads/rescore` for that. ' +
                '`lane`, `reason` and `graduationPolicy` are open strings, never enums. ' +
                'POST back exactly the `rungId` on each row: it is already clamped to what the ' +
                'source can produce, and asking for a higher one yields the same encode at a ' +
                'different budget. `coversMediaIds` may name more than one episode when one file ' +
                'backs several — charge such an item once, and do not release it until every id ' +
                'it covers has graduated. The response also carries `rungVocabulary` — every ' +
                '`rung` id this build accepts, highest quality first — present even when ' +
                '`candidates` is empty, so a client can learn the ladder from the API instead of ' +
                'probing or hardcoding it; requesting a `rung` outside this list returns 422, not ' +
                'an empty list. ' +
                'Send back a previously-received `ETag` value as `If-None-Match`: an unchanged ' +
                'list returns `304` with no body and — unlike every other outcome — does NOT ' +
                'consume rate-limit budget, so polling to check for changes is free. ' +
                'PACING: `maxConcurrentPreparations` limits renditions you may hold in ' +
                '`queued`/`encoding`; exceeding it earns 503 + Retry-After on the renditions ' +
                'POST. Polling `GET /renditions/{id}` does NOT advance a queued rendition — only ' +
                'a re-POST to `POST /media/{id}/renditions`, no sooner than ' +
                '`prepareRePostSeconds`, does. A client that only polls stalls forever. ' +
                `Rate limited to ${RATE_LIMIT_MAX} requests per hour per (user, lane) — the ` +
                'budget is per lane, not a single pool shared across every lane.',
            responses: {
                200: {
                    schema: DownloadCandidatesResponseSchema,
                    description: 'Budget-cut candidates for the requested lane',
                    headers: {
                        ETag: {
                            description:
                                'Strong validator for this response. Send it back as ' +
                                '`If-None-Match` on the next poll to get a free `304` when the ' +
                                'list has not changed.',
                        },
                    },
                },
                304: {
                    description:
                        'Not modified — the ETag in If-None-Match still matches; no body, no rate-limit cost',
                    headers: {
                        ETag: { description: 'Echoes the validator that matched.' },
                    },
                },
                401: 'Authentication required',
                422: 'Unknown lane or unknown rung',
                429: 'Rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            if (!event.locals.user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { lane, budgetBytes, rung, frequencyMode } = ctx.input!.query;
            // `rung` is resolved to its default HERE (rather than at its
            // original call site further down) because the ETag hash below
            // must mix in the id the query will actually run with — an
            // explicit `?rung=<default>` and an omitted `rung` are the same
            // query and must hash to the same validator. Deliberately NOT
            // validated yet (see the 422 check below, unchanged in position):
            // an unvalidated id still hashes fine, and moving the validation
            // earlier would reorder the published 401→503→304→429→422 gate
            // sequence.
            const requestedRungId = rung ?? config.SERIES_DOWNLOAD_DEFAULT_RUNG;

            // Access context ahead of the ETag check (unlike music, which only
            // needs it for the real query): library/age restrictions gate
            // every row `getSeriesNextUpCandidates` returns, so they are
            // mixed into the validator below. buildSearchAccessContext is
            // documented cheap (L1-cached), so pulling it forward costs
            // nothing worth rate-limiting — same reasoning as the ETag inputs
            // themselves.
            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access: DownloadAccessLimits = {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            };

            // ETag check: cheap, INDEXED aggregates (see getSeriesEtagInputs),
            // deliberately un-limited because this is a small fraction of the
            // cost of the full candidate query below — the whole point is to
            // let a client poll the list for free when nothing changed.
            // Placed after the DB-availability check (nothing to compute with
            // no DB) and before the rate limiter (a 304 must not cost the
            // caller budget, or "poll to check for changes" isn't actually
            // free) — matching music's candidates.ts.
            const etagInputs = await getSeriesEtagInputs(sql, event.locals.user.userId);
            const etag = computeSeriesCandidatesEtag(
                etagInputs,
                { lane, budgetBytes, rung: requestedRungId, frequencyMode },
                access,
            );
            const ifNoneMatch = event.request.headers.get('if-none-match');
            if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
                return new Response(null, { status: 304, headers: { ETag: etag } });
            }

            const rl = await checkRateLimit(
                `series:dl-candidates:${event.locals.user.userId}:${lane}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            if (lane !== SERIES_LANE) {
                return ApiProblem.validationFailed([
                    { field: 'lane', message: `Unsupported lane: ${lane}` },
                ]);
            }

            if (!getDownloadRung(requestedRungId)) {
                return ApiProblem.validationFailed([
                    { field: 'rung', message: `Unknown rung '${requestedRungId}'` },
                ]);
            }

            const rows = await getSeriesNextUpCandidates(sql, event.locals.user.userId, access, {
                maxAgeDays: config.CONTINUE_WATCHING_MAX_AGE_DAYS,
                frequencyMode,
            });

            // Group the exact-size lookup by the CLAMPED rung: a 540p source
            // will be encoded at 540p however the request was phrased, so a
            // lookup keyed on the requested rung would miss the artifact that
            // actually exists.
            const clampedByRow = rows.map((row) => ({
                row,
                rungId: clampRungForHeight(requestedRungId, row.source_height)?.id ?? null,
            }));
            const exactByRung = new Map<string, Map<string, ReadyRenditionSize>>();
            for (const rungId of new Set(
                clampedByRow.map((c) => c.rungId).filter((id): id is string => id !== null),
            )) {
                const fileIds = clampedByRow
                    .filter((c) => c.rungId === rungId)
                    .map((c) => c.row.file_id);
                exactByRung.set(
                    rungId,
                    exactSizeIndex(await readySizesForFiles(sql, fileIds, rungId)),
                );
            }

            let unbudgetableCount = 0;
            const budgeted: BudgetedCandidate[] = [];
            for (const { row, rungId } of clampedByRow) {
                const exact = rungId ? (exactByRung.get(rungId) ?? new Map()) : new Map();
                const item = budgetCandidate(row, requestedRungId, exact);
                if (item === null) {
                    unbudgetableCount++;
                    continue;
                }
                budgeted.push(item);
            }

            const cut = cutToBudget(budgeted, budgetBytes);
            const queueDepth = await prepareQueueDepth(
                sql,
                config.DOWNLOAD_RENDITION_STALE_SECONDS,
            );

            return json(
                DownloadCandidatesResponseSchema.parse({
                    lane,
                    graduationPolicy: SERIES_GRADUATION_POLICY,
                    candidates: cut.map((item, index) => ({
                        mediaId: item.row.media_id,
                        fileId: item.row.file_id,
                        // Defence in depth: an empty array would tell the client
                        // the item covers nothing, and it would never graduate.
                        coversMediaIds:
                            item.row.covers_media_ids.length > 0
                                ? item.row.covers_media_ids
                                : [item.row.media_id],
                        rank: index,
                        distance: item.row.distance,
                        seriesId: item.row.series_id,
                        seriesTitle: item.row.series_title,
                        seasonNumber: item.row.season_number,
                        episodeNumber: item.row.episode_number,
                        rungId: item.rung.id,
                        estBytes: item.estBytes,
                        estBytesExact: item.estBytesExact,
                        reason: item.row.distance === 0 ? 'next_episode' : 'upcoming_episode',
                        reasonSubject: {
                            type: 'series',
                            id: item.row.series_id,
                            name: item.row.series_title,
                        },
                    })),
                    maxConcurrentDownloads: maxConcurrentDownloads(),
                    maxConcurrentPreparations: maxConcurrentPreparations(),
                    prepareRePostSeconds: prepareRePostSeconds(),
                    prepareQueueDepth: queueDepth,
                    unbudgetableCount,
                    scoreVersion: SERIES_SCORE_VERSION,
                    rungVocabulary: RUNG_VOCABULARY,
                }),
                { headers: { ETag: etag } },
            );
        },
    },
});
