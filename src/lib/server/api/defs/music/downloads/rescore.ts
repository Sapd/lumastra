// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/music/downloads/rescore
 *
 * Ordinal ranks for a bounded cohort of pool members, stamped with one
 * `generation`. This is the ONLY ranking the client persists or compares —
 * candidate ranks are fetch ordering and nothing else.
 *
 * Never chunked. A cohort split across two calls is a cohort split across two
 * orderings, which is precisely the incomparability the ordinal model exists
 * to prevent. The cap here is also the lane's membership cap, so one call
 * always covers a whole lane.
 *
 * Every submitted id comes back with an explicit status. Absence is never a
 * signal: encoding "gone" as omission would make a truncated response
 * indistinguishable from "your whole pool was deleted", and the client's
 * reaction to that signal is mass deletion.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    getRotationRescoreRanks,
    ROTATION_SCORE_VERSION,
    type RescoreRankRow,
} from '$lib/server/database/queries/music-downloads.queries.js';
import { MusicDownloadRescoreResponseSchema } from '$lib/schemas/api-music-responses.js';

/** Also the lane membership cap — see the module docstring. */
export const MAX_RESCORE_IDS = 5000;

/**
 * Raw request-shape ceiling, distinct from `MAX_RESCORE_IDS`.
 *
 * `MAX_RESCORE_IDS` is enforced by hand in the handler (see the cap check
 * below) so an over-cap request can get a structured 422 naming the overage
 * -- a client whose lane has grown past cap needs `submitted`/`cap`/
 * `shedRequired` to know how many members to drop, not just a generic "array
 * too long" from Zod. This schema-level `.max()` is only a backstop against a
 * pathological payload (e.g. a client bug submitting 200k ids): several times
 * the real cap, so every realistic overage -- a lane that quietly grew past
 * 5000 -- is caught by the handler's graceful path, not this one.
 *
 * Exported so rescore.test.ts can pin the boundary directly rather than
 * hardcoding it.
 */
export const SCHEMA_SAFETY_MAX_IDS = MAX_RESCORE_IDS * 4;

/** Rescore is the routine-cycle call, so it is allowed more often than candidates. */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_S = 3600;

/** Exported so rescore.def.test.ts can exercise the UUID validation directly. */
export const BodySchema = z.object({
    lane: z.string(),
    // Must be validated as UUIDs, not bare strings: getRotationRescoreRanks
    // casts this array with `::uuid[]` in SQL, so one non-UUID id would abort
    // the whole statement with `invalid input syntax for type uuid` -- a 500
    // that returns NO statuses at all, which the client must treat as an
    // error and which freezes the rotation lane.
    //
    // NOT capped at MAX_RESCORE_IDS here -- see SCHEMA_SAFETY_MAX_IDS. The
    // real cap is enforced in the handler so exceeding it returns a
    // structured 422 (submitted/cap/shedRequired) instead of a generic Zod
    // "array too long" validation error.
    mediaIds: z.array(z.string().uuid()).max(SCHEMA_SAFETY_MAX_IDS),
});

/**
 * The complete set of `status` values this server build can emit, across
 * every lane — not just what `buildRescoreResults` happens to produce for
 * `rotation` today. This is the single source of truth for the wire
 * vocabulary: the handler echoes it verbatim as `statusVocabulary` on the
 * rescore response (see api-music-responses.ts), and `RescoreResult.status`
 * below is typed from it, so a status added to `buildRescoreResults` without
 * a matching entry here fails to compile — and rescore.test.ts pins the
 * runtime values too, for a client-visible regression as well as a
 * type-level one.
 *
 * A client's protection against an unrecognized status is silent retention
 * (see MusicDownloadRescoreResultSchema's `status` description) — correct,
 * but with no error and nothing in any log. Publishing this array lets a
 * client diff it against its own allow-list on the first call and detect a
 * stale vocabulary as a LEADING indicator, before any item is actually
 * affected, instead of inferring it later from a pool that quietly stopped
 * shrinking.
 *
 * `graduated` is not reachable for the `rotation` lane — nothing graduates
 * out of it, since rotation has no notion of an item leaving while remaining
 * valid — but it is part of the published vocabulary because a future lane
 * (e.g. `continue_watching`) needs it, and the client must already know how
 * to handle it before that lane ships.
 */
export const RESCORE_STATUS_VOCABULARY = ['ranked', 'gone', 'graduated'] as const;

export type RescoreStatus = (typeof RESCORE_STATUS_VOCABULARY)[number];

export interface RescoreResult {
    mediaId: string;
    status: RescoreStatus;
    rank: number | null;
    toLane: string | null;
}

/**
 * Zip the submitted ids against the ranked rows, emitting one result per
 * submitted id in submission order.
 *
 * `graduated` is not reachable for rotation — nothing graduates out of it —
 * but the shape is carried here because discovery (Phase 2) and series
 * (Phase 3) both need it, and the client's handling differs per media type.
 */
export function buildRescoreResults(mediaIds: string[], ranks: RescoreRankRow[]): RescoreResult[] {
    const rankById = new Map(ranks.map((r) => [r.media_id, r.rank]));
    const emitted = new Set<string>();
    const out: RescoreResult[] = [];

    for (const mediaId of mediaIds) {
        if (emitted.has(mediaId)) continue;
        emitted.add(mediaId);
        const rank = rankById.get(mediaId);
        out.push(
            rank === undefined
                ? { mediaId, status: 'gone', rank: null, toLane: null }
                : { mediaId, status: 'ranked', rank, toLane: null },
        );
    }
    return out;
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { body: BodySchema },

    docs: {
        POST: {
            tags: ['Music'],
            summary: 'Recompute download priorities for a set of music items',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns an ordinal rank for every submitted id, within the submitted cohort, ' +
                'stamped with one `generation`. Ranks are comparable only within a ' +
                '`(lane, generation)` pair. Every submitted id is returned with a `status` — ' +
                'a response missing an id is an error, not a signal. Never chunk this call: ' +
                `the cap of ${MAX_RESCORE_IDS} is also the lane's MEMBERSHIP cap, and ` +
                'exceeding it does not degrade gracefully — there is no chunking fallback and ' +
                'no partial ranking by design. The whole call 422s with a `validation_failed` ' +
                'problem whose `details` name the overage as three entries — `submitted` (ids ' +
                'in this call), `cap` (the limit), and `shedRequired` (submitted minus cap) — ' +
                'so the client knows exactly how many members to drop from the lane before ' +
                'retrying, rather than guessing. This stops that lane rescoring entirely until ' +
                `the client brings its membership back at or under ${MAX_RESCORE_IDS}. ` +
                'CAPPING LANE MEMBERSHIP AT THAT VALUE IS THEREFORE A CLIENT OBLIGATION, not ' +
                'just a request-shape limit — a lane that is allowed to keep growing past the ' +
                'cap can never rescore again, and therefore can never rank, evict, or shrink ' +
                'itself back under the cap on its own. When a lane DOES end up over cap, shed ' +
                'by admission recency, MOST-RECENTLY-ADMITTED FIRST (LIFO) — the `details` on ' +
                'the 422 carry a `shedOrder: "admitted_desc"` hint alongside the prose for ' +
                'exactly this reason. The newest admissions are what pushed the lane over the ' +
                'cap, so dropping them first returns the lane to the last membership that was ' +
                'still rankable; any locally-stored rank is from a prior generation and is not ' +
                'a valid tie-breaker here, so every client must apply the SAME shed order or ' +
                "different clients will each protect a different subset of the user's content. " +
                '`status` and `toLane` are open strings, not ' +
                'enums. `graduated` is not reachable for the `rotation` lane today — nothing ' +
                'graduates out of it, since rotation has no notion of an item leaving while ' +
                'remaining valid — but the value is part of the shared vocabulary because a ' +
                'future lane where that IS possible (e.g. a `continue_watching` series lane) ' +
                'needs it, and the client must already know how to handle it. The response ' +
                'also carries `statusVocabulary` — every `status` value THIS BUILD can emit — ' +
                'so a client can diff it against its own allow-list and catch a stale ' +
                'vocabulary as a leading indicator, before silent retention quietly stops ' +
                'admitting anything.',
            body: BodySchema,
            responses: {
                200: {
                    schema: MusicDownloadRescoreResponseSchema,
                    description: 'One result per submitted id',
                },
                401: 'Authentication required',
                422: `Unknown lane, or more ids than the ${MAX_RESCORE_IDS} cap allows (details carry submitted/cap/shedRequired/shedOrder — shed most-recently-admitted first)`,
                429: 'Rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        POST: async (event, ctx) => {
            if (!event.locals.user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            // Validated body arrives on ctx.input.body — mount() has already
            // parsed it against BodySchema. See quick-picks.ts for the idiom.
            // Destructured here (before the rate-limit check below) because the
            // limit key now needs `lane` — see that comment.
            const { lane, mediaIds } = ctx.input!.body;

            // Rate limit AFTER the DB check: every request 503s while the DB is
            // down, so checking first would burn the caller's budget on
            // requests that can never succeed. Keyed per (user, lane), not just
            // user: with 3+ lanes (rotation, discovery, continue_watching)
            // sharing one limiter, keying on the user alone would make a
            // client's per-lane refresh budget a function of how many lanes the
            // server happens to expose — an implementation detail the client
            // should not have to pay for.
            const rl = await checkRateLimit(
                `music:dl-rescore:${event.locals.user.userId}:${lane}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            if (lane !== 'rotation') {
                return ApiProblem.validationFailed(`Unsupported lane: ${lane}`);
            }

            // Graceful stop, not a trapdoor: a lane that is stuck over cap can
            // never rescore, so it can never rank, evict, or shrink itself back
            // under the cap -- a permanent deadlock. So this 422 names the exact
            // overage (submitted/cap/shedRequired) rather than a generic
            // "too many ids", and the cohort is REJECTED WHOLESALE rather than
            // ranked partially: ranking only `MAX_RESCORE_IDS` of the submitted
            // ids would break the every-submitted-id-comes-back invariant, and a
            // partial ranking risks being consumed by the client as if it were
            // complete.
            if (mediaIds.length > MAX_RESCORE_IDS) {
                const submitted = mediaIds.length;
                const cap = MAX_RESCORE_IDS;
                const shedRequired = submitted - cap;
                return ApiProblem.validationFailed([
                    {
                        field: 'submitted',
                        message: `This call submitted ${submitted} ids, which exceeds the lane membership cap.`,
                        value: submitted,
                    },
                    {
                        field: 'cap',
                        message:
                            'Maximum ids accepted in a single rescore call (also the lane membership cap).',
                        value: cap,
                    },
                    {
                        field: 'shedRequired',
                        message: `Drop at least this many members from the lane before retrying — do not chunk this call.`,
                        value: shedRequired,
                    },
                    {
                        field: 'shedOrder',
                        // At this exact moment the client has no valid ranking to
                        // shed by -- any stored rank is from a prior generation
                        // and non-comparable. Shedding by admission recency
                        // (newest first) is self-consistent without one: the
                        // newest admissions are what pushed the lane over cap,
                        // so dropping them returns the lane to the last
                        // membership that WAS rankable. Every client must apply
                        // the same rule, or each will protect a different
                        // subset of the user's content.
                        message:
                            'Shed most-recently-admitted members first (LIFO admission order), ' +
                            'not by size, age, or a stale stored rank — the newest admissions ' +
                            'are what pushed the lane over cap, so dropping them first returns ' +
                            'the lane to the last membership that was still rankable.',
                        value: 'admitted_desc',
                    },
                ]);
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const ranks = await getRotationRescoreRanks(sql, event.locals.user.userId, mediaIds, {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            });

            // The generation is opaque to the client, which only ever tests it
            // for equality. A per-response identity is correct: one call is one
            // coherent ordering, and chunking is forbidden. Must be unique per
            // response, not just per (lane, cohort size, millisecond) --
            // randomUUID() guarantees that where a timestamp-derived token
            // could collide across two same-millisecond calls with the same
            // cohort size, minting an identical token the client would then
            // wrongly treat as the same ordering. Includes the lane rather
            // than a hardcoded prefix so a future non-rotation lane doesn't
            // have to touch this line.
            const generation = `${lane}:${randomUUID()}`;

            return withRateLimitHeaders(
                json(
                    MusicDownloadRescoreResponseSchema.parse({
                        generation,
                        results: buildRescoreResults(mediaIds, ranks),
                        scoreVersion: ROTATION_SCORE_VERSION,
                        statusVocabulary: [...RESCORE_STATUS_VOCABULARY],
                    }),
                ),
                rl,
            );
        },
    },
});
