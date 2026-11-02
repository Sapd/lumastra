// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/offline-playback-sessions/index.ts — POST /offline-playback-sessions
 *
 * Batch ingestion for playback that happened while a client was offline. NOT a
 * replacement for the live play-session heartbeat/stop flow: this endpoint
 * exists so a back-dated record can be arbitrated by its real occurrence time.
 *
 * It is also the ONLY supported way to write a position with no live playback
 * behind it. `PATCH /watch-state/{id}` treats `position` as read-only, and the
 * alternative clients reach for — opening a play session purely as a write
 * vehicle and closing it — is wrong on both lanes: a session consumes a
 * concurrent-stream slot (so stream policy can REFUSE a bookkeeping write),
 * supersedes paused sessions on the same item, and mints a stream token. Worse
 * on the audiobook lane, `POST /play-sessions` reaches `user_media_state` and
 * stops there, while a book's resume point is AudiobookShelf's own
 * `currentTime` — so the write appeared to succeed and the next listen still
 * opened the book where it was. This endpoint fans out server-side to whichever
 * store actually owns the resume point, which is the mapping no client should
 * have to know.
 *
 * Skew, max-age, AND per-record shape violations (bad UUIDs, endedAt <
 * startedAt, an out-of-tolerance sessionElapsedMs, etc.) are all rejected PER
 * RECORD rather than failing the request — a client holding a queue must be
 * able to flush the valid records and drop only the bad ones. The runtime
 * request-body schema (`OfflineSessionsRequestSchema`) therefore validates
 * only the ENVELOPE (an array of 1-50 items); each item is re-validated with
 * `OfflinePlaybackRecordSchema` inside the handler below. A 422 is reserved for a
 * genuinely malformed envelope — see `OfflineSessionsRequestSchema`'s doc
 * comment in `$lib/schemas/offline-playback.js`.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    OfflinePlaybackRecordSchema,
    OfflineSessionsRequestSchema,
    OfflineSessionsBatch,
    type OfflinePlaybackRecord,
    OfflineSessionsResponseSchema,
    isRetryableOfflineResult,
    OFFLINE_MAX_SKEW_MS,
    OFFLINE_MAX_AGE_MS,
    OFFLINE_INVALID_DETAILS_MAX,
} from '$lib/schemas/offline-playback.js';
import {
    ingestOfflineSessions,
    type OfflineSessionResult,
} from '$lib/server/services/offline-playback.service.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },

    docs: {
        POST: {
            tags: ['Play Sessions'],
            summary: 'Upload playback records after the fact',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Submits playback that happened while the client was offline, and is the ' +
                'supported way to write a position with no live playback behind it — prefer it ' +
                'over opening a throwaway play session, which consumes a concurrent-stream slot ' +
                'and supersedes paused sessions on the same item. The server fans each record ' +
                'out to whichever store owns that resume point, so the client does not need to ' +
                "know the mapping: video settles in Lumastra's own watch state, while an " +
                "audiobook is also pushed to AudiobookShelf (the authority for a book's resume " +
                'position) before the response returns. Each record carries ' +
                'its real start/end time; the server arbitrates by occurrence time, so an older ' +
                'record can never rewind a newer resume position set on another device — note ' +
                'this means the position that reaches AudiobookShelf is the arbitrated one, ' +
                'which for a record that lost arbitration is the position it already held. ' +
                'Audiobooks are never marked finished from here: completion belongs to ' +
                "AudiobookShelf's own near-end rule and comes back on the next sync. Every result " +
                'carries `retryable`: true means resubmitting that exact record later can still ' +
                'succeed and the client should keep it queued (`write_failed` wrote nothing and ' +
                'rolled its group back; `too_far_future` becomes valid once server time catches ' +
                'up with a fast device clock). False means stop — either a terminal success ' +
                '(`accepted`, `duplicate`) or a permanently-bad record (`invalid`, `too_old`, ' +
                '`unsupported_media_type`, `not_found`). Treat `retryable` as authoritative ' +
                'rather than mapping `reason` yourself: permanence is an allow-list server-side, ' +
                'so an unrecognised future reason reports as retryable rather than silently ' +
                'discarding recoverable playback. ' +
                'Every result also carries `applied`, which answers the question `status` does ' +
                'NOT: `accepted` means the record was written to the event log, while `applied` ' +
                'means the resume point now in effect for that item is the one THIS record ' +
                "reported (or, for video, that this record's own completion is why the point is " +
                'cleared). The two differ because arbitration runs AFTER the write, across every ' +
                'source: a valid record can lose to a newer position another device set, to the ' +
                'offline blind-spot guard, or to a decisive mark. `applied: false` is a NORMAL, ' +
                'terminal outcome — `retryable` stays false and resubmitting changes nothing — ' +
                'but it is the cue to re-read the item rather than trust the local position. ' +
                'Expect it on records superseded by their own batch-mates: when several records ' +
                'cover one item, only the one that won reports true, and that is not a failure. ' +
                'Records too short to move a resume point are accepted without a write and ' +
                'report false for the same reason. `applied` is optional on the wire precisely ' +
                'so its absence stays meaningful — a server predating this field omits it, ' +
                'which is different from reporting false. Results ' +
                'are per record — a malformed record (or one that fails skew/age checks) is ' +
                "reported as that record's own `rejected` result and never discards the rest of " +
                'the batch. A 422 is reserved for a malformed envelope (not an array, empty, or ' +
                'over the batch cap) — never for a bad individual record. ' +
                'Each session is an OfflinePlaybackRecord, validated individually. ' +
                'Send `knownAsOf`: it is when your client last read server state for the item, ' +
                'and it is what stops a stale offline position from lowering a resume point ' +
                'another device set while you were offline. Omitting it is safe but blunt — ' +
                'the record is then treated as unable to see ANY other source, so it can only ' +
                'ever advance the resume point, never move it back.',
            body: OfflineSessionsBatch.docs,
            responses: {
                200: {
                    schema: OfflineSessionsResponseSchema,
                    description: 'Per-record ingestion results',
                },
                401: 'Authentication required',
                422: 'Malformed envelope',
            },
        },
    },

    request: { body: OfflineSessionsRequestSchema },

    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user?.userId) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const now = Date.now();
            // The envelope schema deliberately leaves each item unvalidated
            // (see the schema's doc comment) — validate per-record here so one
            // malformed record can be reported and skipped without 422ing the
            // whole batch.
            const rawSubmitted = ctx.input!.body.sessions;

            // Keep one result for every submitted position, including records
            // without a correlatable id (reported with eventId: null).
            const order: Array<string | null> = [];
            const parseRejected = new Map<string, OfflineSessionResult>();
            const parsedRecords: OfflinePlaybackRecord[] = [];

            // Every eventId already claimed by an earlier record in THIS
            // request. Results are keyed by eventId end to end, so two records
            // sharing one collapse into a single verdict: whichever landed
            // last silently overwrites the other, and the client zips that one
            // answer against two queued records. Rejecting the collision keeps
            // the key a key — and it is per-record, so the batch-mates are
            // unaffected.
            const claimedEventIds = new Set<string>();
            /**
             * Outcomes already decided for a specific POSITION in `order`,
             * rather than for an eventId. A missing id needs this, as does a duplicate — its
             * two positions share one key, so a keyed lookup cannot tell them
             * apart — but it is applied first for every position so the
             * distinction is impossible to lose later.
             */
            type PositionalResult = Omit<OfflineSessionResult, 'eventId'> & {
                eventId: string | null;
            };
            const positionOutcome: Array<PositionalResult | undefined> = [];

            for (const raw of rawSubmitted) {
                const parsed = OfflinePlaybackRecordSchema.safeParse(raw);
                if (parsed.success) {
                    if (claimedEventIds.has(parsed.data.eventId)) {
                        // Positional, NOT keyed: putting this in the
                        // eventId-keyed rejection map would make the FIRST
                        // record's genuine result resolve to this rejection
                        // too, since both positions look it up by the same id.
                        order.push(parsed.data.eventId);
                        positionOutcome[order.length - 1] = {
                            eventId: parsed.data.eventId,
                            status: 'rejected',
                            reason: 'invalid',
                            details: [
                                { field: 'eventId', message: 'duplicated within this request' },
                            ],
                        };
                        continue;
                    }
                    claimedEventIds.add(parsed.data.eventId);
                    order.push(parsed.data.eventId);
                    parsedRecords.push(parsed.data);
                    continue;
                }

                const rawEventId =
                    raw !== null && typeof raw === 'object' && 'eventId' in raw
                        ? (raw as Record<string, unknown>).eventId
                        : undefined;
                if (typeof rawEventId !== 'string') {
                    order.push(null);
                    positionOutcome[order.length - 1] = {
                        eventId: null,
                        status: 'rejected',
                        reason: 'invalid',
                        details: parsed.error.issues
                            .slice(0, OFFLINE_INVALID_DETAILS_MAX)
                            .map((issue) => ({
                                field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
                                message: issue.message,
                            })),
                    };
                    continue;
                }

                order.push(rawEventId);
                parseRejected.set(rawEventId, {
                    eventId: rawEventId,
                    status: 'rejected',
                    reason: 'invalid',
                    // Field path(s) that failed, so a client can tell a bad
                    // `eventId` apart from a bad timestamp instead of a
                    // single opaque `invalid`. Paths only — never the
                    // submitted value (these records carry user playback
                    // data and this response may be logged). Bounded so a
                    // record failing every field check cannot blow up the
                    // response.
                    details: parsed.error.issues
                        .slice(0, OFFLINE_INVALID_DETAILS_MAX)
                        .map((issue) => ({
                            field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
                            message: issue.message,
                        })),
                });
            }

            // Partition before hitting the service so an out-of-window record
            // never reaches the write path.
            const inWindow: OfflinePlaybackRecord[] = [];
            const preRejected = new Map<string, OfflineSessionResult>();

            for (const rec of parsedRecords) {
                const ended = Date.parse(rec.endedAt);
                if (ended > now + OFFLINE_MAX_SKEW_MS) {
                    preRejected.set(rec.eventId, {
                        eventId: rec.eventId,
                        status: 'rejected',
                        reason: 'too_far_future',
                    });
                    continue;
                }
                if (ended < now - OFFLINE_MAX_AGE_MS) {
                    preRejected.set(rec.eventId, {
                        eventId: rec.eventId,
                        status: 'rejected',
                        reason: 'too_old',
                    });
                    continue;
                }
                inWindow.push(rec);
            }

            const ingested =
                inWindow.length > 0
                    ? await ingestOfflineSessions(sql, {
                          userId: user.userId,
                          user,
                          records: inWindow,
                      })
                    : [];
            const ingestedById = new Map(ingested.map((r) => [r.eventId, r]));

            // Submission order, so a client can zip results against its queue.
            //
            // `retryable` is derived HERE and nowhere else. Every result funnels
            // through this one map regardless of which of the three stages
            // produced it, so a new rejection path cannot ship without a
            // retryability verdict — the failure mode that made a client drop
            // recoverable listening on `write_failed`.
            const results = order
                .map(
                    (eventId, index): PositionalResult =>
                        positionOutcome[index] ??
                        (eventId === null
                            ? undefined
                            : (parseRejected.get(eventId) ??
                              preRejected.get(eventId) ??
                              ingestedById.get(eventId))) ?? {
                            eventId,
                            status: 'rejected' as const,
                            reason: 'not_processed' as const,
                        },
                )
                .map((r) => ({
                    ...r,
                    retryable: isRetryableOfflineResult(r.status, r.reason),
                    // Always present, never omitted — an absent `applied` is
                    // the wire signal for "this server is too old to tell
                    // you", and a result that silently dropped the field
                    // would be indistinguishable from that. Only the three
                    // stages above can produce a record that reached
                    // arbitration; everything else never had a verdict, and
                    // false is the truthful answer for all of them.
                    applied: r.applied ?? false,
                }));

            const summary = {
                accepted: results.filter((r) => r.status === 'accepted').length,
                duplicate: results.filter((r) => r.status === 'duplicate').length,
                rejected: results.filter((r) => r.status === 'rejected').length,
            };

            return typedJson(OfflineSessionsResponseSchema, { results, summary });
        },
    },
});
