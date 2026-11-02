// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/music/downloads/candidates?lane=rotation&want=<n>&bitrateKbps=<n>
 *
 * Fetch ordering for one smart-downloads lane. The ranks returned here are
 * FETCH ORDERING ONLY — the client never persists them and they never enter a
 * keep-or-evict decision. See the design doc §3.
 *
 * Rotation has NO cursor by design. Its value sits at the head of the
 * ordering, so the client re-reads the head and diffs against what it holds;
 * `want` is the only depth control. A persisted frontier cursor would walk
 * monotonically away from value and produce 0% turnover.
 *
 * Rotation is multi-source: a play-count keyset cannot surface a
 * rated-never-played track, which has no `user_music_state` row at all.
 *
 * Auth: {kind:'user'} — bearer-reachable; `/api/v1/*` is admitted by
 * `hooks.server.ts` for any request carrying an Authorization header, so no
 * forward-auth wiring is needed.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import { clampBitrate } from '$lib/server/services/music-transcode/index.js';
import {
    getRotationHeadByPlayCount,
    getRotationHeadByRating,
    getRotationEtagInputs,
    ROTATION_SCORE_VERSION,
    type DownloadCandidateRow,
    type RotationEtagInputs,
} from '$lib/server/database/queries/music-downloads.queries.js';
import { EMBEDDING_PROJECTION_VERSION } from '$lib/server/database/queries/music-embedding-projection.queries.js';
import { selectServableProjectedVector } from '$lib/server/services/music-embedding-projection/quantize.js';
import { MusicDownloadCandidatesResponseSchema } from '$lib/schemas/api-music-responses.js';

const DEFAULT_WANT = 100;
/**
 * `want` is the lane's ONLY depth control: rotation has no cursor (see the
 * module docstring), so the client re-reads the head at whatever depth it
 * needs. The design targets an ~8 GB pool with a ~1200-track rotation lane,
 * so this cap must be able to reach lane capacity, not just a single-page
 * "more results" size the way a normal `limit` would be. 2000 comfortably
 * clears the ~1200-track target with headroom for future lane growth.
 */
export const MAX_WANT = 2000;
const MIN_WANT = 1;

/** One reserved slot in every three output positions, so a small `want` still surfaces both sources. */
const RATING_INTERLEAVE_EVERY = 3;

/** ~4 refreshes/day/device plus a deeper daily read, with room for two devices. */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_S = 3600;

/** Exported so pagination-bounds.test.ts can guard the `want` cap directly. */
export const QuerySchema = z.object({
    lane: z.string(),
    want: z.coerce.number().int().min(MIN_WANT).max(MAX_WANT).optional().default(DEFAULT_WANT),
    bitrateKbps: z.coerce.number().int().min(32).max(320).optional().default(128),
});

/**
 * Byte estimate for a transcoded CBR rung. mp3 is `-c:a libmp3lame -b:a {n}k`
 * with no VBR flag, so duration x bitrate holds -- PROVIDED bitrate is what
 * the encoder will actually use, not the raw requested value.
 *
 * The real download route always runs the requested rate through
 * `clampBitrate('mp3', requested)` before handing it to ffmpeg (see
 * route-handler.ts), which snaps to the mp3 ladder `[64, 96, 128, 160, 192,
 * 256, 320]` -- picking the largest rung <= requested, or falling back to 64
 * when nothing qualifies (this def's `QuerySchema` allows `bitrateKbps` down
 * to 32, below the ladder's floor). Estimating off the raw requested value
 * instead of the clamped one under-budgets by up to 2x for a 32-63 kbps
 * request, so the clamp must happen here too or the client overshoots
 * whatever budget it computed from this estimate.
 */
export function estimateBytes(runtimeSeconds: number | null, bitrateKbps: number): number | null {
    if (runtimeSeconds === null || !Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0) {
        return null;
    }
    const actualKbps = clampBitrate('mp3', bitrateKbps);
    return Math.round((runtimeSeconds * actualKbps * 1000) / 8);
}

/**
 * Build the wire pair for one candidate's quantized embedding projection.
 * Routes through `selectServableProjectedVector` -- the single version-match
 * choke point -- rather than comparing versions inline here, so there is
 * exactly one place in the codebase that can get the mismatch guard wrong.
 * Always returns both fields null together (never a version without a
 * vector or vice versa) -- see the wire schema's field descriptions.
 */
export function buildEmbeddingProjectionFields(row: DownloadCandidateRow): {
    embeddingProjection: string | null;
    embeddingProjectionVersion: number | null;
} {
    const stored =
        row.projection_version !== null && row.projected_vector !== null
            ? { version: row.projection_version, vector: row.projected_vector }
            : null;
    const servable = selectServableProjectedVector(stored, EMBEDDING_PROJECTION_VERSION);
    return servable
        ? {
              embeddingProjection: servable.toString('base64'),
              embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
          }
        : { embeddingProjection: null, embeddingProjectionVersion: null };
}

/**
 * Merge the two rotation sources into one ordered list.
 *
 * Interleaved rather than concatenated: appending the ratings stream would
 * bury every favourite behind the entire play-count head, so any `want`
 * smaller than the head could never surface one — which is the whole reason
 * the second source exists. Every `RATING_INTERLEAVE_EVERY`-th output slot,
 * starting at position 0, is reserved for a rating-source row (when one is
 * still available) rather than a play-count row. Reserving from position 0 —
 * rather than only after a full play-count group has been emitted — is what
 * lets a favourite surface even when the play-count head is itself shorter
 * than one interleave group.
 *
 * A track present in both sources keeps its play_count row: the id is
 * dropped from the ratings stream up front, so the play_count entry's data
 * and ordering position always win the tie.
 */
export function mergeRotationSources(
    byPlayCount: DownloadCandidateRow[],
    byRating: DownloadCandidateRow[],
): DownloadCandidateRow[] {
    const playIds = new Set(byPlayCount.map((row) => row.media_id));
    const dedupedRating = byRating.filter((row) => !playIds.has(row.media_id));

    const out: DownloadCandidateRow[] = [];
    let playIdx = 0;
    let ratingIdx = 0;

    while (playIdx < byPlayCount.length || ratingIdx < dedupedRating.length) {
        const wantRating = out.length % RATING_INTERLEAVE_EVERY === 0;

        if (wantRating && ratingIdx < dedupedRating.length) {
            out.push(dedupedRating[ratingIdx++]!);
        } else if (playIdx < byPlayCount.length) {
            out.push(byPlayCount[playIdx++]!);
        } else {
            out.push(dedupedRating[ratingIdx++]!);
        }
    }
    return out;
}

/**
 * Coarse time bucket mixed into the ETag validator (see `computeCandidatesEtag`).
 *
 * The cheap aggregates in `getRotationEtagInputs` cover `user_music_state` and
 * `user_ratings` only -- they cannot see an AVAILABILITY change (a track
 * losing `has_files`, or a library-access revocation), because neither touches
 * either table. Without a ceiling, a stale ETag could outlive such a change
 * indefinitely, leaving the client offering a download for an item that now
 * 404s and burning its terminal-attempt budget. This bucket bounds how long
 * that staleness window can last -- 15 minutes, not a correctness fix for the
 * blind spot itself.
 */
const ETAG_TIME_BUCKET_MS = 15 * 60 * 1000;

/**
 * Build the `/candidates` ETag from cheap per-user aggregates plus every
 * request parameter that changes the output shape (`lane`, `want`,
 * `bitrateKbps`) and a coarse time bucket (see `ETAG_TIME_BUCKET_MS`).
 *
 * Deliberately excludes wall-clock ordering concerns: `/candidates` orders by
 * `(play_count DESC, track_id DESC)`, which is NOW()-free by design (see the
 * module docstring), so the ordering itself cannot drift between two calls in
 * the same time bucket. Only availability can, which is exactly what the time
 * bucket bounds.
 *
 * A strong validator (no `W/` prefix) -- there is no partial-content use case
 * here that would require weak-comparison semantics.
 */
export function computeCandidatesEtag(
    inputs: RotationEtagInputs,
    params: { lane: string; want: number; bitrateKbps: number },
    now: number = Date.now(),
): string {
    const timeBucket = Math.floor(now / ETAG_TIME_BUCKET_MS);
    const raw = [
        params.lane,
        params.want,
        params.bitrateKbps,
        inputs.musicStateMaxLastPlayed?.toISOString() ?? 'null',
        inputs.musicStateCount,
        inputs.musicStatePlayCountSum,
        inputs.ratingsMaxUpdated?.toISOString() ?? 'null',
        inputs.ratingsCount,
        timeBucket,
    ].join('|');
    return `"${createHash('sha256').update(raw).digest('hex')}"`;
}

/**
 * Whether a client's `If-None-Match` header already carries the current
 * validator. Handles the header's comma-separated multi-value form and the
 * `*` wildcard; does not need weak-comparison (`W/...`) handling since this
 * endpoint only ever emits strong tags.
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
    return ifNoneMatch
        .split(',')
        .map((v) => v.trim())
        .some((v) => v === '*' || v === etag);
}

/**
 * How many transfers the client may run at once.
 *
 * Derived from the server's own per-user transcode cap and deliberately
 * conservative: playback itself holds up to two slots (the active stream plus
 * the next-track preload), so the pool must leave room or the user's own
 * downloads stall their own playback.
 *
 * Below 2, there is no spare per-user capacity to hand a download at all --
 * an operator-set `MUSIC_TRANSCODE_MAX_PER_USER` of 0 or 1 means the server
 * cannot run a download alongside playback (or, at 0, cannot run anything),
 * so advertising 1 here (the old `Math.max(1, ...)` floor did, unconditionally)
 * would defeat the very guarantee this function exists to provide: telling
 * the pool it may start a transfer the server has no room to actually serve.
 *
 * `perUser` defaults to the live config value and is only ever overridden by
 * tests -- callers in this module always call it with no argument.
 */
export function maxConcurrentDownloads(
    perUser: number = config.MUSIC_TRANSCODE_MAX_PER_USER,
): number {
    if (perUser < 2) return 0;
    return Math.min(2, Math.floor(perUser / 2));
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List music suggested for offline download',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Ordered candidates for a smart-downloads lane. The `rank` field is fetch ' +
                'ordering only and must not be persisted or used for eviction — call ' +
                '`/music/downloads/rescore` for that. The `rotation` lane has no cursor: ' +
                'its value is at the head of the ordering, so re-read the head and diff ' +
                'against what you already hold. `reason` is an open string, not an enum. ' +
                'Send back a previously-received `ETag` value as `If-None-Match`: an ' +
                'unchanged head returns `304` with no body and — unlike every other outcome — ' +
                'does NOT consume rate-limit budget, so polling to check for changes is free. ' +
                `Rate limited to ${RATE_LIMIT_MAX} requests per hour per (user, lane) for ` +
                'everything else — the budget is per lane, not a single pool shared across ' +
                'every lane, so it does not shrink as lanes are added.',
            query: QuerySchema,
            headers: z.object({
                'If-None-Match': z
                    .string()
                    .optional()
                    .meta({
                        description:
                            'A previously-received `ETag` value for this lane. When it still ' +
                            'matches the current head, the response is `304` with no body and ' +
                            'no rate-limit cost — see the description above.',
                    }),
            }),
            responses: {
                200: {
                    schema: MusicDownloadCandidatesResponseSchema,
                    description: 'Ordered candidates for the requested lane',
                    headers: {
                        ETag: {
                            description:
                                'Strong validator for this response. Send it back as ' +
                                '`If-None-Match` on the next poll to get a free `304` when ' +
                                'the head has not changed.',
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
                422: 'Unknown lane',
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

            // mount() has already validated the query against QuerySchema —
            // re-parsing the URL by hand would be a second source of truth.
            // Destructured here (before the ETag/rate-limit checks below)
            // because both now need `lane`: the ETag mixes it into the
            // validator, and the limiter key includes it — see those
            // comments. Only the destructuring moved; the unsupported-lane
            // check below keeps its original relative position, after the
            // rate limiter.
            const { lane, want, bitrateKbps } = ctx.input!.query;

            // ETag check: cheap, INDEXED aggregates (see getRotationEtagInputs),
            // deliberately un-limited because this is a small fraction of the
            // cost of the full join+sort+projection below — the whole point is
            // to let a client poll the head for free when nothing changed.
            // Placed after the DB-availability check (nothing to compute with no
            // DB) and before the rate limiter (a 304 must not cost the caller
            // budget, or "poll to check for changes" isn't actually free).
            const etagInputs = await getRotationEtagInputs(sql, event.locals.user.userId);
            const etag = computeCandidatesEtag(etagInputs, { lane, want, bitrateKbps });
            const ifNoneMatch = event.request.headers.get('if-none-match');
            if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
                return new Response(null, { status: 304, headers: { ETag: etag } });
            }

            // Rate limit AFTER the DB-availability AND ETag checks: every
            // request 503s while the DB is down, so checking first would burn
            // the caller's budget on requests that can never succeed; a 304
            // similarly must not burn budget (see above). Keyed per (user,
            // lane), not just user: with 3+ lanes (rotation, discovery,
            // continue_watching) sharing one limiter, keying on the user alone
            // would make a client's per-lane refresh budget a function of how
            // many lanes the server happens to expose — an implementation
            // detail the client should not have to pay for.
            const rl = await checkRateLimit(
                `music:dl-candidates:${event.locals.user.userId}:${lane}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            // Phase 1 ships rotation only. Discovery is Phase 2 and is gated on
            // hnsw.iterative_scan — see the design doc §13.
            if (lane !== 'rotation') {
                return ApiProblem.validationFailed(`Unsupported lane: ${lane}`);
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            };

            const ratingWant = Math.max(1, Math.ceil(want / RATING_INTERLEAVE_EVERY));
            const [byPlayCount, byRating] = await Promise.all([
                getRotationHeadByPlayCount(sql, event.locals.user.userId, want, access),
                getRotationHeadByRating(sql, event.locals.user.userId, ratingWant, access),
            ]);

            const merged = mergeRotationSources(byPlayCount, byRating).slice(0, want);

            return withRateLimitHeaders(
                json(
                    MusicDownloadCandidatesResponseSchema.parse({
                        lane,
                        candidates: merged.map((row, index) => ({
                            id: row.media_id,
                            rank: index,
                            estBytes: estimateBytes(row.runtime_seconds, bitrateKbps),
                            estBytesExact: false,
                            reason: row.source === 'rating' ? 'favourite' : 'heavy_rotation',
                            reasonSubject: row.artist_id
                                ? { type: 'artist', id: row.artist_id, name: row.artist_title }
                                : null,
                            ...buildEmbeddingProjectionFields(row),
                        })),
                        maxConcurrentDownloads: maxConcurrentDownloads(),
                        scoreVersion: ROTATION_SCORE_VERSION,
                    }),
                    { headers: { ETag: etag } },
                ),
                rl,
            );
        },
    },
});
