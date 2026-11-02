// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media-neutral smart-download wire schemas.
 *
 * These deliberately duplicate `MusicDownload*` in `api-music-responses.ts`
 * rather than replacing it. Renaming a shipped `.meta({id})` rewrites the
 * generated Swift type on a surface tvOS already calls, for zero functional
 * gain; music can re-point at these ids at the next breaking bump. Every field
 * the music schemas carry is reproduced here verbatim so a client's pool
 * manager needs an adapter, not a rewrite.
 *
 * Two rules govern every field below:
 *
 * 1. Enum-ish values are OPEN strings. A generated Swift enum is @frozen with
 *    no unknown case, so adding one value later fails the decode of the ENTIRE
 *    response on every shipped client.
 * 2. Nullable, never optional. Absent and null collapse into one Swift
 *    Optional, so a field that is sometimes omitted and sometimes null is
 *    indistinguishable to the client that has to act on the difference.
 */

import { z } from 'zod';

/**
 * One candidate from a smart-downloads lane stream.
 *
 * `rank` is FETCH ORDERING ONLY. The client never persists it and it never
 * enters a keep-or-evict decision — only rescore output is comparable.
 */
export const DownloadCandidateSchema = z
    .object({
        mediaId: z.string(),
        /**
         * The `media_files` row an encode would be keyed on. POST this to
         * `/media/{mediaId}/renditions` as `fileId` so the rendition that gets
         * built is the one this row was budgeted against.
         */
        fileId: z.string(),
        /**
         * Every media id this one artifact satisfies, including `mediaId`
         * itself. Length 1 in the normal case; longer for a combined
         * multi-episode file, where one `media_files` row backs several episode
         * rows. The budget charges such a file ONCE, and the client must not
         * treat the item as graduated until EVERY id here has graduated —
         * deleting after the first half of a double episode destroys the
         * second half unwatched.
         */
        coversMediaIds: z.array(z.string()),
        /** Position in this response. Fetch ordering only; never persisted. */
        rank: z.number().int().min(0),
        /**
         * How many episodes ahead of the user's current position in THIS
         * series, counted positionally (0 = the next one up). Positional, not
         * an ordinal gap, so a missing episode row or a season boundary cannot
         * inflate it.
         */
        distance: z.number().int().min(0),
        seriesId: z.string(),
        seriesTitle: z.string(),
        seasonNumber: z.number().int(),
        episodeNumber: z.number().int(),
        /**
         * The rung the server has ALREADY clamped against the source height.
         * POST exactly this id — asking for a higher one yields the same
         * encode at a different budget, which is how the pool overshoots.
         * Open string.
         */
        rungId: z.string(),
        /** Estimated (or exact) size of the rendition at `rungId`, in bytes. */
        estBytes: z.number().int().min(0).nullable(),
        /** True only when a finished artifact of exactly this size already exists. */
        estBytesExact: z.boolean(),
        /** Open string, never an enum. `next_episode` | `upcoming_episode` today. */
        reason: z.string(),
        reasonSubject: z.object({ type: z.string(), id: z.string(), name: z.string() }).nullable(),
    })
    .meta({ id: 'DownloadCandidate' });

export const DownloadCandidatesResponseSchema = z
    .object({
        /** Open string. `series-next-up` for this endpoint. */
        lane: z.string(),
        /**
         * What the client must do with an item this lane reports as
         * `graduated`. OPEN STRING: `delete` (release the bytes) or `retain`
         * (keep them; the item has moved to another lane) today.
         *
         * This travels as DATA on purpose. A client that infers deletion policy
         * from the lane NAME needs an App Store release to learn about a new
         * lane, and gets it wrong for any lane it does not recognise. An
         * unrecognised policy must be treated as `retain` — misfiling a delete
         * as retain costs one budget slot; the other direction destroys a
         * user's offline content.
         */
        graduationPolicy: z.string(),
        candidates: z.array(DownloadCandidateSchema),
        /**
         * Byte transfers the client may run at once. `0` means no spare
         * capacity: start nothing until a later response advertises a nonzero
         * value.
         */
        maxConcurrentDownloads: z.number().int().min(0),
        /**
         * Renditions this user may hold in `queued`/`encoding` at once. A
         * PREPARE is not a transfer: it occupies an encode slot on the server
         * before a single byte moves, and there is only one such slot by
         * default. Exceeding this earns a 503 + `Retry-After` on the renditions
         * POST.
         */
        maxConcurrentPreparations: z.number().int().min(1),
        /**
         * Seconds to wait before re-POSTing a rendition that is still `queued`.
         *
         * THE LOAD-BEARING FIELD. Polling `GET /renditions/{id}` does NOT
         * advance a deferred rendition — nothing on the server does. Only a
         * re-POST to `POST /media/{id}/renditions`, after this many seconds,
         * makes a queued row reclaimable and restarts it. A client that only
         * polls stalls forever with no server-side recovery.
         */
        prepareRePostSeconds: z.number().int().min(1),
        /**
         * Server-wide count of renditions in `queued`/`encoding`, for a client
         * to back off BEFORE it POSTs rather than learning by 503.
         */
        prepareQueueDepth: z.number().int().min(0),
        /**
         * Candidates dropped because their duration is unknown and so their
         * size cannot be budgeted. A null estimate is affordable for a 4 MB
         * track and not for a 1–3 GB episode, so these are dropped rather than
         * emitted — this count is what keeps that loud instead of silent.
         */
        unbudgetableCount: z.number().int().min(0),
        scoreVersion: z
            .number()
            .int()
            .describe(
                'Version stamp for the rescore ordering function. Present here so a client ' +
                    'polling /candidates notices a ranking-function change without waiting ' +
                    'for its next rescore call. NOT a comparability token: two responses ' +
                    'sharing a scoreVersion does not make their ranks comparable.',
            ),
        rungVocabulary: z
            .array(z.string())
            .describe(
                'Every `rung` id this build of the endpoint accepts, highest quality first. ' +
                    'These are the ONLY values the `?rung=` query parameter accepts — requesting ' +
                    'anything else returns a 422, not an empty candidate list. Present on every ' +
                    'successful response, including an empty `candidates` array, because an ' +
                    'empty pool is exactly when a client most needs to learn the ladder rather ' +
                    'than hardcode or probe for it.',
            ),
    })
    .meta({ id: 'DownloadCandidatesResponse' });

export type DownloadCandidatesResponse = z.infer<typeof DownloadCandidatesResponseSchema>;

/**
 * One rescored pool member. EVERY submitted id comes back with a status —
 * absence is never a signal, because a truncated response would otherwise be
 * indistinguishable from "your whole pool was deleted", and the client's
 * reaction to that signal is mass deletion.
 */
export const DownloadRescoreResultSchema = z
    .object({
        mediaId: z.string(),
        status: z
            .string()
            .describe(
                "This id's lifecycle status within the submitted cohort. An OPEN string, " +
                    'never an enum. Three values are defined today: `ranked` — still ahead ' +
                    'of you; `rank` is set, `toLane` is null. `graduated` — you consumed it ' +
                    '(watched, past the completion threshold, or it fell behind a rewound ' +
                    "anchor); apply this lane's `graduationPolicy`, and for an item whose " +
                    '`coversMediaIds` had more than one entry, only once EVERY covered id ' +
                    'has graduated. `gone` — not a legitimate member for a non-progress ' +
                    'reason (deleted, no local file, access revoked); evict, and count it ' +
                    'separately, because `gone` at scale means the library is losing files. ' +
                    'CLIENT RULE (this is what prevents data loss): eviction requires an ' +
                    'explicit, RECOGNIZED status. An unrecognized status MUST be retained ' +
                    'and MUST NOT sort below a known `ranked` item — prefer overshooting ' +
                    'the budget by the count of unknowns over evicting them. Sorting them ' +
                    'worst would delete them on the next cycle, because a full pool at ' +
                    'budget is the steady state, not an edge case. If a hard ceiling must ' +
                    'be enforced, evict from the `ranked` tail first and touch unknowns ' +
                    'only once `ranked` is exhausted.',
            ),
        rank: z
            .number()
            .int()
            .min(0)
            .nullable()
            .describe(
                'Ordinal position WITHIN the submitted cohort, never a global position. ' +
                    'Non-null only when `status` is `ranked`.',
            ),
        toLane: z
            .string()
            .nullable()
            .describe(
                'Destination lane when a graduation hands off to another lane; null ' +
                    'otherwise. For `series-next-up`, graduation is TERMINAL and this is ' +
                    'always null. Open string.',
            ),
    })
    .meta({ id: 'DownloadRescoreResult' });

export const DownloadRescoreResponseSchema = z
    .object({
        /** Opaque, minted by rescore and by nothing else. Not a streamId. */
        generation: z.string(),
        results: z.array(DownloadRescoreResultSchema),
        scoreVersion: z
            .number()
            .int()
            .describe(
                'Version stamp for the ranking expression that produced these ranks. NOT a ' +
                    'comparability token — ranks are comparable only within one response, ' +
                    'keyed by its `generation`. A client seeing a scoreVersion different ' +
                    'from the one it stored must treat its stored ranks as stale.',
            ),
        statusVocabulary: z
            .array(z.string())
            .describe(
                'The full `status` vocabulary this server build can emit, across every ' +
                    'lane — not just the values present in `results`. Diff it against your ' +
                    'own allow-list on every call: a value here your client does not know ' +
                    'means YOUR VOCABULARY IS STALE. Silent retention is the correct ' +
                    'fallback but produces no error and nothing in any log.',
            ),
    })
    .meta({ id: 'DownloadRescoreResponse' });

export type DownloadRescoreResponse = z.infer<typeof DownloadRescoreResponseSchema>;
