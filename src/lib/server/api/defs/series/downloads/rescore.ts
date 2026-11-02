// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/series/downloads/rescore
 *
 * Ordinal ranks and lifecycle statuses for a bounded cohort of pool members,
 * stamped with one `generation`. This is the ONLY ranking the client persists
 * or compares — candidate ranks are fetch ordering and nothing else.
 *
 * NEVER CHUNKED. A cohort split across two calls is a cohort split across two
 * orderings, which is precisely the incomparability the ordinal model exists to
 * prevent. The cap is also the lane's membership cap, so one call always covers
 * a whole lane.
 *
 * THE SERVER STATES WHAT CHANGED, NEVER WHAT TO DO. `graduated` means the user
 * consumed it; what the client does about that is the lane's
 * `graduationPolicy`, advertised on the CANDIDATES response as data. For this
 * lane graduation is terminal — `toLane` is always null — where music's
 * `graduated` hands off to `rotation`. Same wire status, opposite consequence.
 *
 * Every submitted id comes back with an explicit status. Absence is never a
 * signal: encoding "gone" as omission would make a truncated response
 * indistinguishable from "your whole pool was deleted", and the client's
 * reaction to that signal is mass deletion.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import {
    getSeriesNextUpRescore,
    MAX_RESCORE_IDS,
    SERIES_LANE,
    SERIES_SCORE_VERSION,
    DEFAULT_SERIES_FREQUENCY_MODE,
    type SeriesRescoreRow,
} from '$lib/server/database/queries/series-downloads.queries.js';
import { DownloadRescoreResponseSchema } from '$lib/schemas/api-downloads.js';

export { MAX_RESCORE_IDS };

/**
 * Raw request-shape ceiling, distinct from `MAX_RESCORE_IDS`.
 *
 * The real cap is enforced by hand in the handler so an over-cap request gets a
 * structured 422 naming the overage — a client whose lane grew past the cap
 * needs to know how many members to shed, not a generic Zod "array too long".
 * This is a backstop against a pathological payload only.
 *
 * Deliberately much larger than `MAX_RESCORE_IDS`, not the same number: read
 * together as two caps on the wire, `MAX_RESCORE_IDS` (in the prose) and this
 * value (as the schema's `maxItems`) would look like a contradiction to a
 * client. They are not — see the `mediaIds` field description below, which is
 * the authoritative statement of which one governs. Exported so
 * `rescore.test.ts` can pin the multiple directly, and so a future edit that
 * collapses the two numbers together shows up as a diff to a named constant,
 * not a silent behaviour change.
 */
export const SCHEMA_SAFETY_MAX_IDS = MAX_RESCORE_IDS * 10;

/** Rescore is the routine-cycle call, so it is allowed more often than candidates. */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_S = 3600;

/**
 * The complete `status` vocabulary this server build can emit — echoed on every
 * response as `statusVocabulary` so a client can notice its own allow-list has
 * gone stale. Silent retention of an unknown status is the correct client
 * behaviour but produces no error and nothing in any log.
 *
 * `RescoreResult.status` below is typed FROM this array — mirroring
 * `RESCORE_STATUS_VOCABULARY` / `RescoreStatus` in music's rescore.ts — so
 * `buildSeriesRescoreResults` emitting a status not in this list is a COMPILE
 * error, not a runtime surprise. The WIRE schema (`DownloadRescoreResultSchema`
 * in api-downloads.ts) stays an open `z.string()`; only the server's emitted
 * set is constrained.
 */
export const RESCORE_STATUS_VOCABULARY = ['ranked', 'graduated', 'gone'] as const;

export type RescoreStatus = (typeof RESCORE_STATUS_VOCABULARY)[number];

export interface RescoreResult {
    mediaId: string;
    status: RescoreStatus;
    rank: number | null;
    toLane: string | null;
}

/**
 * Zip the submitted ids against the classified rows, one result per submitted
 * id, in submission order.
 *
 * Three-way, where music's is two-way. An id the query did not return is
 * `gone`: not a legitimate member for a NON-PROGRESS reason (deleted, no
 * default file, access revoked, no longer an episode). That distinction is
 * load-bearing — reporting `gone` where `graduated` belongs makes an ordinary
 * "you watched it" indistinguishable from "the file vanished", which suppresses
 * the telemetry that would reveal real library breakage.
 *
 * An unrecognised status from the query layer degrades to `gone` rather than
 * `ranked`: a status this build does not understand must not keep a dead item
 * in the pool forever.
 */
export function buildSeriesRescoreResults(
    mediaIds: string[],
    rows: SeriesRescoreRow[],
): RescoreResult[] {
    // Case-folded on both sides. Postgres renders a uuid column lowercase, but
    // the submitted ids are plain strings validated only as UUID-shaped — and
    // a client that round-trips one through a native UUID type (Swift's
    // `uuidString` is uppercase) submits a value that misses an exact-match
    // lookup. A miss here is not a harmless empty result: an unmatched id is
    // reported `gone`, and the documented client response to `gone` is to
    // evict the download.
    const byId = new Map(rows.map((r) => [r.media_id.toLowerCase(), r]));
    const emitted = new Set<string>();
    const out: RescoreResult[] = [];

    for (const mediaId of mediaIds) {
        const lookupId = mediaId.toLowerCase();
        if (emitted.has(lookupId)) continue;
        emitted.add(lookupId);

        const row = byId.get(lookupId);
        if (!row) {
            out.push({ mediaId, status: 'gone', rank: null, toLane: null });
            continue;
        }
        if (row.status === 'ranked') {
            out.push({ mediaId, status: 'ranked', rank: row.rank, toLane: null });
            continue;
        }
        if (row.status === 'graduated') {
            // Terminal for series: no hand-off lane. The client applies the
            // lane's advertised graduationPolicy instead.
            out.push({ mediaId, status: 'graduated', rank: null, toLane: null });
            continue;
        }
        out.push({ mediaId, status: 'gone', rank: null, toLane: null });
    }
    return out;
}

export const BodySchema = z.object({
    lane: z.string(),
    // Must be validated as UUIDs, not bare strings: the query casts this array
    // with `::uuid[]`, so one non-UUID id aborts the whole statement with
    // `invalid input syntax for type uuid` — a 500 that returns NO statuses at
    // all, which the client must treat as an error and which freezes the lane.
    mediaIds: z
        .array(z.string().uuid())
        .max(SCHEMA_SAFETY_MAX_IDS)
        .describe(
            `Ids to rescore in this cohort. The published maxItems (${SCHEMA_SAFETY_MAX_IDS}) ` +
                'is an absurd-payload guard against a malformed request, NOT the real limit — ' +
                `it is ${SCHEMA_SAFETY_MAX_IDS / MAX_RESCORE_IDS}x the actual lane membership cap ` +
                `on purpose, so it never fires for a legitimately-sized lane. The authoritative ` +
                `cap is ${MAX_RESCORE_IDS}, enforced by the handler: a call over that cap 422s ` +
                'with `details` carrying `submitted`/`cap`/`shedRequired`/`shedOrder`, not a ' +
                'generic schema validation error. Treat the 422 and its `details` as the source ' +
                'of truth for how many ids this lane may hold; do not infer a cap from maxItems.',
        ),
    /**
     * MUST match the `frequencyMode` the client's most recent `/candidates`
     * call used — the ordering equivalence between the two endpoints only
     * holds when both use the same mode. Defaults to `balanced`, the same
     * default `/candidates` applies, so a caller that always omits both
     * fields stays consistent automatically.
     */
    frequencyMode: z
        .enum(['off', 'balanced', 'frequency_first'])
        .optional()
        .default(DEFAULT_SERIES_FREQUENCY_MODE),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { body: BodySchema },

    docs: {
        POST: {
            tags: ['Series'],
            summary: 'Recompute download priorities for a set of series',
            stability: 'beta',
            auth: 'bearer',
            body: BodySchema,
            description:
                'Returns a status for every submitted id, and an ordinal rank for those still ' +
                'ahead of you, stamped with one `generation`. Ranks are comparable only within a ' +
                '`(lane, generation)` pair. Pass the SAME `frequencyMode` (default `balanced`) as ' +
                'your most recent `/series/downloads/candidates` call — the two endpoints only ' +
                'produce equivalent orderings when they agree on it. A response missing an id is ' +
                'an error, not a signal. ' +
                'Never chunk this call: the cap of ' +
                `${MAX_RESCORE_IDS} is also the lane membership cap, and two chunks are two ` +
                'orderings. When a lane DOES end up over cap, the whole call 422s — there is no ' +
                'chunking fallback and no partial ranking by design — and `details` name the ' +
                'overage as `submitted`, `cap`, and `shedRequired`, plus a `shedOrder: ' +
                '"admitted_desc"` entry: shed by admission recency, MOST-RECENTLY-ADMITTED ' +
                'FIRST (LIFO). At exactly this moment the client has no valid ranking to shed ' +
                'by — any stored rank is from a prior generation and non-comparable — so ' +
                'admission order is the only self-consistent rule: the newest admissions are ' +
                'what pushed the lane over the cap, so dropping them first returns the lane to ' +
                'the last membership that was still rankable. Every client must apply the SAME shed order, or each ' +
                "will protect a different subset of the user's content. `status` and `toLane` " +
                'are open strings, not enums; diff `statusVocabulary` against your own allow-list ' +
                'on every call. `graduated` means YOU CONSUMED IT — apply the `graduationPolicy` ' +
                'this lane advertised on `/series/downloads/candidates`, and for an item covering ' +
                'several media ids only once EVERY covered id has graduated. `gone` means the ' +
                'item is no longer a legitimate member for a non-progress reason; evict it and ' +
                'count it separately, because `gone` at scale means the library is losing files.',
            responses: {
                200: {
                    schema: DownloadRescoreResponseSchema,
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

            const { lane, mediaIds, frequencyMode } = ctx.input!.body;

            const rl = await checkRateLimit(
                `series:dl-rescore:${event.locals.user.userId}:${lane}`,
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

            // Dedupe BEFORE applying the cap. The cap is the lane MEMBERSHIP
            // cap, not a count of the raw submitted array — `mediaIds` is
            // whatever the client happened to send, which can contain an
            // accidental duplicate (e.g. two devices independently admitting
            // the same episode into their local view of the lane before
            // syncing). A lane at exactly 2000 unique members plus one
            // duplicate must NOT be rejected wholesale: its true membership
            // is within cap, and `buildSeriesRescoreResults` was already
            // going to collapse the duplicate anyway (see its own `emitted`
            // set) — checking the cap against the raw length just did that
            // collapsing too late to matter.
            const uniqueMediaIds = Array.from(new Set(mediaIds));

            // Graceful stop, not a trapdoor: a lane stuck over cap can never
            // rescore, so it can never rank, evict, or shrink itself back
            // under the cap. The cohort is REJECTED WHOLESALE rather than
            // ranked partially: ranking only MAX_RESCORE_IDS of the submitted
            // ids would break the every-submitted-id-comes-back invariant.
            if (uniqueMediaIds.length > MAX_RESCORE_IDS) {
                const submitted = uniqueMediaIds.length;
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
                        // At this exact moment the client has no valid ranking
                        // to shed by — any stored rank is from a prior
                        // generation and non-comparable. Shedding by admission
                        // recency (newest first) is self-consistent without
                        // one: the newest admissions are what pushed the lane
                        // over cap, so dropping them returns the lane to the
                        // last membership that WAS rankable. Every client must
                        // apply the same rule, or each will protect a
                        // different subset of the user's content.
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
            const rows = await getSeriesNextUpRescore(
                sql,
                event.locals.user.userId,
                uniqueMediaIds,
                { deniedGroupIds: accessCtx.deniedGroupIds, ageRating: accessCtx.ageRating },
                { maxAgeDays: config.CONTINUE_WATCHING_MAX_AGE_DAYS, frequencyMode },
            );

            // Opaque to the client, which only ever tests it for equality. A
            // per-response identity is correct: one call is one coherent
            // ordering, and chunking is forbidden.
            const generation = `${lane}:${randomUUID()}`;

            return json(
                DownloadRescoreResponseSchema.parse({
                    generation,
                    results: buildSeriesRescoreResults(uniqueMediaIds, rows),
                    scoreVersion: SERIES_SCORE_VERSION,
                    statusVocabulary: [...RESCORE_STATUS_VOCABULARY],
                }),
            );
        },
    },
});
