// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline playback ingestion.
 *
 * An offline record is a back-dated terminal play-session report: the same
 * writes the live stop path makes, stamped with the real occurrence time. The
 * existing rebuilder arbitrates by occurred_at, so an older record can never
 * rewind a newer resume position set on another device.
 *
 * ## Why records are grouped by media and rebuilt ONCE
 *
 * `watchManager.reportProgress` / `appendEventAndRebuild` each do an insert
 * AND a full rebuild AND a possible compaction snapshot write per call.
 * `maybeWriteSnapshot` stamps that snapshot `occurred_at = now()`, and the
 * resume walk skips every event not strictly newer than the snapshot. So
 * calling either of those per-record — even inside one SQL transaction —
 * would let compaction fire after record 3 of a 12-record batch and strand
 * records 4-12 behind a now()-stamped snapshot: accepted, written to the
 * log, and completely inert to every future rebuild.
 *
 * This service instead writes each record's event(s) with the raw
 * `insertEvent` write query (insert only, no rebuild, no compaction — that
 * lives in a function private to the rebuilder module and is structurally
 * unreachable from here) and calls `rebuildStateFromEvents` exactly ONCE
 * per (user, media) group, after every record in it has been inserted.
 * `rebuildStateFromEvents` is a pure function of the stored event log, so
 * the materialized state comes out identical to what N separate rebuilds
 * would have produced, minus the mid-batch compaction hazard — because
 * compaction never runs during ingestion at all.
 *
 * ## Why audiobooks never get a 'completed'
 *
 * AudiobookShelf owns audiobook completion. A Lumastra completion would win
 * is_watched over audiobookshelf-sync; when the user then restarted the book,
 * the resulting pull would land audiobookshelf-sync in contradictedSources, its
 * progress would be skipped, resume would be zeroed, and decideSourceProgressEvent
 * would mute that source permanently — pinning the book at watched/position-zero
 * with every later listen discarded. Writing progress only avoids the chain:
 * the position is pushed to ABS, whose own near-end rule finishes the book, and
 * the pull brings isFinished back as an audiobookshelf-sync mark_watched.
 *
 * This is not just "skip the event": `watchHistoryService.recordCompletedSession`
 * is gated the same way. Otherwise an offline audiobook session past the local
 * threshold would inflate `personal-stats.service.ts`'s completed-books count
 * even though ABS — the documented completion authority — never marked it
 * finished, and `user_media_state.is_watched` correctly stayed untouched. Same
 * rule, same reason, applied to both surfaces.
 *
 * ## Why audiobook positions are pushed to ABS before this call returns
 *
 * An audiobook's resume point is NOT `user_media_state.resume_position_ms` —
 * the player reads it back from ABS's own progress row. So for audiobooks the
 * local write above is a mirror, not the durable store, and a flush that
 * stopped there would report success while the next listen still opened the
 * book where it was before.
 *
 * The watch-sync sweep does eventually push these ('lumastra-offline' is in
 * `PUSHABLE_SOURCES`, and an audiobook's progress-only queue routes to
 * `pushResumePosition`), but on its own schedule — leaving a window of minutes
 * in which a client has been told its record landed and the web player still
 * disagrees. `pushAudiobookProgressToAbs` closes that window synchronously,
 * session-lessly (`PATCH /api/me/progress/:itemId` — no stream slot, no paused-
 * deck supersede, no minted token), and best-effort: the sweep remains the
 * durable guarantee, so a failure here is logged and never fails ingestion.
 *
 * It runs AFTER the rebuild, and pushes the arbitrated
 * `user_media_state.resume_position_ms` rather than the record's raw
 * `positionMs`. ABS's progress row is last-write-wins with no history, so
 * pushing the raw value would let a back-dated record rewind a newer position
 * set on another device — exactly the failure this endpoint's occurrence-time
 * arbitration exists to prevent.
 *
 * ## Why each result reports `applied` as well as a status
 *
 * Writing a record's event and that record DECIDING the item's state are two
 * different outcomes, and only the first is what `accepted` ever meant. The
 * rebuild below arbitrates across every source afterwards, so a perfectly
 * valid record can be written and still lose — to a newer position another
 * device set, to the rebuilder's offline blind-spot guard, or to a decisive
 * mark that clears the resume point. Measured on prod 2026-08-27: two
 * audiobook records came back `{status: 'accepted'}` and both `user_media_state`
 * rows still read `resume_position_ms = 0`, with nothing in the response
 * telling those two cases apart. That made the endpoint unverifiable from
 * outside — a client could not warn, reconcile, or even know to re-read.
 *
 * So each result now carries the arbitration's own verdict. The rebuild
 * reports WHICH event set the resume point (`StateProvenance`), and a record
 * is `applied` when that event is its own — matched by `source_event_id`, not
 * by comparing positions, because two records can report the same position
 * and a completion legitimately stores 0.
 *
 * This changes NO arbitration. Every record that landed before still lands,
 * every record that lost still loses; the only difference is that the loss is
 * now stated instead of being reported as success.
 *
 * ## Combined-file sibling completions
 *
 * Offline records carry file-absolute positions, exactly like the live player
 * (`watchManager.reportProgress`, `watch-manager.service.ts` ~line 197-269),
 * which this mirrors: a combined multi-episode file (e.g. S02E24E25) is one
 * video, so completion is judged against the OPENED episode's own window
 * (`getEpisodeWindowsForFile`), not the whole file, and any later sibling
 * whose window is also crossed gets its own 'completed' event — otherwise
 * Next Up would send the viewer back into the file they just finished.
 *
 * Sibling completions are inserted into the SAME group transaction, before
 * the rebuild step — never a rebuild per sibling. A sibling's media id is
 * usually not the group's own `mediaId` (it's a different episode row backed
 * by the same physical file), so `rebuildStateFromEvents` runs once per
 * DISTINCT media id touched in the group (the group's own id, plus every
 * sibling that got a completed event) rather than once for the group's id
 * alone — otherwise a sibling's `user_media_state` row would sit stale until
 * something unrelated happened to rebuild it.
 */

import type postgres from 'postgres';
import type { OfflinePlaybackRecord } from '$lib/schemas/offline-playback.js';
import type { UserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import { withTx } from '../database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getMediaType, isMusicMediaType } from '../database/queries/media-type-cache.queries.js';
import { AUDIOBOOK_MEDIA_TYPE } from '../database/queries/audiobooks.queries.js';
import {
    insertEvent,
    type NewUserMediaEvent,
} from '../database/queries/user-media-events.queries.js';
import { getEpisodeWindowsForFile } from '../database/queries/file-segments.queries.js';
import { rebuildStateFromEvents, type StateProvenance } from './watch-state-rebuilder.service.js';
import { watchHistoryService } from './watch-history.service.js';
import {
    completionThresholdFor,
    engagementThresholdMs,
} from '$lib/server/utils/watch-constants.js';
import type { OfflineRejectionReason, OfflineResultDetail } from '$lib/schemas/offline-playback.js';
import { invalidateAllWatchedCaches } from './watched-cache.service.js';
import {
    pushAudiobookProgressToAbs,
    type AudiobookProgressPushDeps,
} from './audiobook-progress-push.service.js';

const logger = Logger.for('OfflinePlayback');

/** Media groups applied per transaction. Mirrors watch-manager's FANOUT_CHUNK_SIZE. */
const GROUP_CHUNK_SIZE = 25;

export type OfflineResultStatus = 'accepted' | 'duplicate' | 'rejected';

export interface OfflineSessionResult {
    eventId: string;
    status: OfflineResultStatus;
    /**
     * Typed against the published vocabulary, so adding a reason here without
     * adding it to `OFFLINE_REJECTION_REASONS` (and classifying its permanence)
     * is a compile error rather than a response that fails its own schema at
     * runtime.
     */
    reason?: OfflineRejectionReason;
    /**
     * Present only when `reason` is `'invalid'` — the Zod issue path(s) that
     * failed, populated by the endpoint handler (this service never produces
     * `'invalid'` itself; parsing happens before a record reaches it).
     */
    details?: OfflineResultDetail[];
    /**
     * Whether this record is the one that decides the item's current state —
     * see the wire schema's `applied` for the full contract. Absent here means
     * the record never reached arbitration (rejected, or too short to write);
     * the endpoint reports that as `false`.
     */
    applied?: boolean;
}

/**
 * `source_event_id` for a record's own progress event.
 *
 * Written at insert time and read back off the arbitration's provenance to
 * decide `applied`, so it lives in ONE function: were the two spellings ever
 * to drift, nothing would fail — every result would just quietly report
 * `applied: false`, which is the exact class of silent lie this field exists
 * to remove.
 */
function progressSourceEventId(eventId: string): string {
    return `offline:${eventId}`;
}

/** Same, for the derived completion event on the record's OWN media. */
function completedSourceEventId(eventId: string): string {
    return `offline:${eventId}:completed`;
}

/** Build the raw progress event for one offline record. */
/**
 * The client's knowledge stamp, bounded by what it can honestly assert.
 *
 * The stamp only ever WEAKENS the blind-spot guard as it moves later — at
 * `endedAt` it disables it outright — and it arrives from the client, so it
 * needs a server-side ceiling. `startedAt` is the honest one: the position in
 * this record was read off the device's local mirror when the stretch opened,
 * so no server state incorporated after that instant is reflected in it.
 *
 * Absent stays absent: NULL means "unbounded blind spot", which is the strict
 * reading, not the lenient one.
 */
function clampKnowledgeStamp(rec: OfflinePlaybackRecord): string | null {
    if (rec.knownAsOf == null) return null;
    const known = Date.parse(rec.knownAsOf);
    const started = Date.parse(rec.startedAt);
    if (!Number.isFinite(known) || !Number.isFinite(started)) return rec.knownAsOf;
    return known > started ? rec.startedAt : rec.knownAsOf;
}

function buildProgressEvent(
    userId: UserId,
    mediaId: string,
    rec: OfflinePlaybackRecord,
): NewUserMediaEvent {
    return {
        user_id: userId,
        media_id: mediaId,
        event_type: 'progress',
        source: 'lumastra-offline',
        position_ms: rec.positionMs,
        runtime_ms: rec.runtimeMs,
        source_event_id: progressSourceEventId(rec.eventId),
        session_id: null,
        event_seq: null,
        session_elapsed_ms: rec.sessionElapsedMs,
        // The position came from the device's own local mirror, which may not
        // have been refreshed since long before this stretch began — so
        // `occurred_at` (endedAt) says nothing about how current this claim
        // is. Carrying the client's own knowledge boundary is what lets the
        // rebuilder refuse a regression the reporter was blind to. Left NULL
        // by clients that don't report one, which the rebuilder deliberately
        // reads as "unbounded", not as "none".
        // Clamped to the stretch start, and this is a trust boundary, not a
        // tidy-up: `knownAsOf` is client-supplied and the guard weakens as it
        // moves later, so a client claiming it read the server at the moment
        // it stopped listening suppresses the guard entirely. It cannot
        // honestly be later than the stretch start — the position being
        // reported was resolved before the stretch began — so anything later
        // is either a bug or a claim we should not honour.
        knowledge_as_of: clampKnowledgeStamp(rec),
        occurred_at: rec.endedAt,
    };
}

/**
 * Build a derived completed event for one offline record — either the
 * primary media (`runtimeMs: rec.runtimeMs`, matching the live path's own
 * completed event) or a combined-file sibling (`runtimeMs` is that sibling's
 * own window size, not the file's). `position_ms` stays the raw file-absolute
 * value in both cases, exactly like `watchManager.reportProgress`. Never
 * called for audiobooks.
 */
function buildCompletedEvent(
    userId: UserId,
    mediaId: string,
    rec: OfflinePlaybackRecord,
    opts: { sourceEventId: string; runtimeMs: number },
): NewUserMediaEvent {
    return {
        user_id: userId,
        media_id: mediaId,
        event_type: 'completed',
        source: 'lumastra-offline',
        position_ms: rec.positionMs,
        runtime_ms: opts.runtimeMs,
        source_event_id: opts.sourceEventId,
        session_id: null,
        event_seq: null,
        session_elapsed_ms: rec.sessionElapsedMs,
        occurred_at: rec.endedAt,
    };
}

/**
 * Give every record in a group the same verdict.
 *
 * Exists so the reason is stated once per failure mode rather than inlined
 * per loop — the distinction between a PERMANENT reason and a retryable one
 * decides whether a client keeps the listening or throws it away, and that is
 * too easy to get wrong when the shape is copy-pasted.
 */
function rejectGroup(
    into: Map<string, OfflineSessionResult>,
    records: OfflinePlaybackRecord[],
    reason: OfflineRejectionReason,
): void {
    for (const rec of records) {
        into.set(rec.eventId, { eventId: rec.eventId, status: 'rejected', reason });
    }
}

export async function ingestOfflineSessions(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        user: UserContext | undefined;
        records: OfflinePlaybackRecord[];
        /** Test seam for the upstream AudiobookShelf progress push. */
        audiobookPushDeps?: AudiobookProgressPushDeps;
    },
): Promise<OfflineSessionResult[]> {
    const { userId, user, records } = params;
    const resultByEventId = new Map<string, OfflineSessionResult>();

    // Audiobooks whose local state committed this call, pushed upstream once
    // after the loop — see the module header. Collected rather than pushed
    // per group so one flush spanning several books makes one bounded fan-out
    // instead of a serial upstream round-trip inside the ingest loop.
    const audiobookMediaIds = new Set<string>();

    // Group by media so each (user, media) is rebuilt exactly once.
    const groups = new Map<string, OfflinePlaybackRecord[]>();
    for (const rec of records) {
        const bucket = groups.get(rec.mediaId);
        if (bucket) bucket.push(rec);
        else groups.set(rec.mediaId, [rec]);
    }

    const groupEntries = [...groups.entries()];
    let touchedAny = false;

    for (let i = 0; i < groupEntries.length; i += GROUP_CHUNK_SIZE) {
        const chunk = groupEntries.slice(i, i + GROUP_CHUNK_SIZE);

        for (const [mediaId, groupRecords] of chunk) {
            // Ascending by occurrence for log readability. Correctness does not
            // depend on this ordering — the single post-loop rebuild arbitrates
            // by occurred_at regardless of insertion order — but a monotonic
            // log is far easier to read.
            groupRecords.sort((a, b) =>
                a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0,
            );

            // A DB failure here is NOT the same answer as "you may not have
            // this". `not_found` is classified PERMANENT, so a transient blip
            // used to tell the client to stop retrying a perfectly good
            // record — losing the listening for good. Distinguished so the
            // outage becomes a retryable `write_failed` instead.
            let accessible: boolean;
            try {
                accessible = await checkMediaAccess(sql, mediaId, user);
            } catch (err) {
                logger.warn('Offline ingest could not resolve media access; asking for a retry', {
                    mediaId,
                    error: err instanceof Error ? err.message : String(err),
                });
                rejectGroup(resultByEventId, groupRecords, 'write_failed');
                continue;
            }
            if (!accessible) {
                rejectGroup(resultByEventId, groupRecords, 'not_found');
                continue;
            }

            // The whole prologue is wrapped: `getMediaType` and the title
            // SELECT have no internal error handling, and an exception here
            // escaped `ingestOfflineSessions` entirely — turning one group's
            // transient DB error into a 500 for the WHOLE batch, so every
            // other record in the request lost its per-record result too.
            let mediaType: Awaited<ReturnType<typeof getMediaType>>;
            let title: string | null;
            let windows: Awaited<ReturnType<typeof getEpisodeWindowsForFile>>;
            try {
                [mediaType, title, windows] = await Promise.all([
                    getMediaType(sql, mediaId),
                    sql<{ title: string }[]>`
                        SELECT title FROM media_items WHERE id = ${mediaId} AND status = 'active'
                    `.then((rows) => rows[0]?.title ?? null),
                    // Kept separate from the two above: an empty window list is
                    // a legitimate answer (most files are not combined
                    // multi-episode ones), so this one failing must not fail
                    // the group — but it must not be silent either, since the
                    // sibling completion fan-out then never runs.
                    getEpisodeWindowsForFile(sql, mediaId).catch((err) => {
                        logger.warn(
                            'Offline ingest could not read episode windows; treating the file as single-episode',
                            { mediaId, error: err instanceof Error ? err.message : String(err) },
                        );
                        return [];
                    }),
                ]);
            } catch (err) {
                logger.warn('Offline ingest could not resolve media metadata; asking for a retry', {
                    mediaId,
                    error: err instanceof Error ? err.message : String(err),
                });
                rejectGroup(resultByEventId, groupRecords, 'write_failed');
                continue;
            }
            if (!mediaType || title === null) {
                for (const rec of groupRecords) {
                    resultByEventId.set(rec.eventId, {
                        eventId: rec.eventId,
                        status: 'rejected',
                        reason: 'not_found',
                    });
                }
                continue;
            }
            if (isMusicMediaType(mediaType)) {
                for (const rec of groupRecords) {
                    resultByEventId.set(rec.eventId, {
                        eventId: rec.eventId,
                        status: 'rejected',
                        reason: 'unsupported_media_type',
                    });
                }
                continue;
            }

            const isAudiobook = mediaType === AUDIOBOOK_MEDIA_TYPE;

            // A combined file (S02E24E25) is ONE video holding several episodes,
            // and the offline record's position/runtime are file-absolute —
            // exactly like the live player. Judge completion against THIS
            // episode's own window when one exists (mirrors
            // watch-manager.service.ts's reportProgress): entering episode 25
            // at 692s is 0% of it, not 105% of a 660s file-absolute runtime.
            const window = windows.find((w) => w.mediaItemId === mediaId) ?? null;

            // Records too short to matter are trivially accepted without a
            // write — same runtime-scaled engagement gate as the live path,
            // preserving the terminal completion exceptions.
            const eligible: Array<{ rec: OfflinePlaybackRecord; crossedCompletion: boolean }> = [];
            for (const rec of groupRecords) {
                const positionForCompletion = window
                    ? rec.positionMs - window.startMs
                    : rec.positionMs;
                const runtimeForCompletion = window ? window.endMs - window.startMs : rec.runtimeMs;
                const crossedCompletion =
                    runtimeForCompletion > 0 &&
                    positionForCompletion >=
                        runtimeForCompletion *
                            completionThresholdFor(mediaType, runtimeForCompletion);
                const engaged = rec.sessionElapsedMs >= engagementThresholdMs(runtimeForCompletion);
                const shouldPersist =
                    engaged || crossedCompletion || rec.endReason === 'completion';

                if (!shouldPersist) {
                    resultByEventId.set(rec.eventId, { eventId: rec.eventId, status: 'accepted' });
                    continue;
                }
                eligible.push({ rec, crossedCompletion });
            }
            if (eligible.length === 0) continue;

            // One sink reused across this group's rebuilds; every field is
            // reassigned on each compute, so no verdict leaks between them.
            const provenance: StateProvenance = {
                resumePositionEventId: null,
                watchedVerdictEventId: null,
            };

            try {
                await withTx(sql, async (tx) => {
                    // Serialise every writer for this (user, media). The
                    // rebuild is read-then-upsert, so two concurrent flushes —
                    // two devices landing at once, or a flush racing a live
                    // beacon — can each read a state that predates the other's
                    // insert and the later commit silently drops the earlier
                    // one's event. For an audiobook that arbitrated position
                    // is then pushed to AudiobookShelf, where it is
                    // last-write-wins with no history.
                    //
                    // Transaction-scoped, so it releases on commit or abort
                    // with nothing to leak. hashtextextended keeps the key in
                    // one bigint namespace rather than colliding two ints.
                    await tx`
                        SELECT pg_advisory_xact_lock(
                            hashtextextended(${userId} || ':' || ${mediaId}, 0)
                        )
                    `;
                    // Every distinct (user, media) that gets an event written this
                    // group — the group's own id, plus any combined-file sibling
                    // that also crosses its own completion threshold. Rebuilt once
                    // each below, after every insert in the group has landed.
                    const touchedMediaIds = new Set<string>([mediaId]);

                    for (const { rec, crossedCompletion } of eligible) {
                        const progressInserted = await insertEvent.execute(tx, {
                            event: buildProgressEvent(userId, mediaId, rec),
                        });
                        const inserted = progressInserted.length > 0;

                        resultByEventId.set(rec.eventId, {
                            eventId: rec.eventId,
                            status: inserted ? 'accepted' : 'duplicate',
                        });
                        if (!inserted) continue;

                        const isCompletion = crossedCompletion || rec.endReason === 'completion';

                        // Audiobooks: progress only, on every surface. Never a
                        // 'completed' event and never a completed watch_history
                        // row — see the module header for the freeze (and the
                        // stat inflation) this prevents.
                        if (isCompletion && !isAudiobook) {
                            await insertEvent.execute(tx, {
                                event: buildCompletedEvent(userId, mediaId, rec, {
                                    sourceEventId: completedSourceEventId(rec.eventId),
                                    runtimeMs: rec.runtimeMs,
                                }),
                            });

                            // Combined-file fan-out: the player only ever reports
                            // the episode that was opened, so its neighbours would
                            // never complete on their own. Only forwards — a
                            // window starting before the opened episode's was
                            // skipped past, not watched.
                            if (window) {
                                for (const sibling of windows) {
                                    if (sibling.mediaItemId === mediaId) continue;
                                    if (sibling.startMs < window.startMs) continue;

                                    const siblingRuntimeMs = sibling.endMs - sibling.startMs;
                                    const siblingPositionMs = rec.positionMs - sibling.startMs;
                                    const siblingThreshold = completionThresholdFor(
                                        mediaType,
                                        siblingRuntimeMs,
                                    );
                                    const siblingCrossed =
                                        siblingRuntimeMs > 0 &&
                                        siblingPositionMs >= siblingRuntimeMs * siblingThreshold;
                                    if (!siblingCrossed) continue;

                                    await insertEvent.execute(tx, {
                                        event: buildCompletedEvent(
                                            userId,
                                            sibling.mediaItemId,
                                            rec,
                                            {
                                                sourceEventId: `offline:${rec.eventId}:sib:${sibling.mediaItemId}`,
                                                runtimeMs: siblingRuntimeMs,
                                            },
                                        ),
                                    });
                                    touchedMediaIds.add(sibling.mediaItemId);
                                }
                            }

                            await watchHistoryService
                                .recordCompletedSession(
                                    {
                                        userId,
                                        mediaId,
                                        mediaType,
                                        title,
                                        startedAt: new Date(rec.startedAt),
                                        stoppedAt: new Date(rec.endedAt),
                                        positionMs: rec.positionMs,
                                        runtimeMs: rec.runtimeMs,
                                        isCompleted: true,
                                    },
                                    tx,
                                )
                                .catch((err) =>
                                    logger.warn('watch_history write failed', err as Error),
                                );
                        }
                    }

                    // The one rebuild per distinct media touched this group — see
                    // module header.
                    for (const touchedId of touchedMediaIds) {
                        await rebuildStateFromEvents(
                            tx,
                            { userId, mediaId: touchedId },
                            undefined,
                            // Only the group's OWN media can tell a record
                            // whether its position won; a sibling rebuild
                            // settles a different item's state entirely.
                            touchedId === mediaId ? provenance : undefined,
                        );
                    }

                    // Writing the event and WINNING arbitration are different
                    // outcomes, and 'accepted' above only ever meant the
                    // first. Reported here, inside the transaction, so the
                    // verdict describes the rebuild that actually committed —
                    // a throw below rolls this back along with the write and
                    // the catch overwrites every one of these with
                    // `write_failed`.
                    for (const { rec } of eligible) {
                        const settled = resultByEventId.get(rec.eventId);
                        if (!settled || settled.status === 'rejected') continue;
                        resultByEventId.set(rec.eventId, {
                            ...settled,
                            applied:
                                provenance.resumePositionEventId ===
                                    progressSourceEventId(rec.eventId) ||
                                provenance.watchedVerdictEventId ===
                                    completedSourceEventId(rec.eventId),
                        });
                    }
                });
                touchedAny = true;
                if (isAudiobook) audiobookMediaIds.add(mediaId);
            } catch (err) {
                logger.warn('Offline group failed', { mediaId }, err as Error);
                // The whole group ran in one transaction, so a throw anywhere
                // in it rolled back every insert made so far this call —
                // including any 'accepted'/'duplicate' status already
                // recorded for an earlier record in this SAME (now-undone)
                // attempt. Overwrite unconditionally rather than only
                // filling gaps, or a rolled-back write would be reported to
                // the caller as having succeeded.
                for (const { rec } of eligible) {
                    resultByEventId.set(rec.eventId, {
                        eventId: rec.eventId,
                        status: 'rejected',
                        reason: 'write_failed',
                    });
                }
            }
        }
    }

    // Upstream first, then local cache bookkeeping: for an audiobook, ABS holds
    // the resume point the player actually reads, so it is the write worth
    // getting in before the response — the caches below only affect Lumastra's
    // own surfaces. Best-effort by contract (see the module header): the
    // watch-sync sweep re-pushes the same positions, so a failure costs
    // latency-to-visibility, never the record.
    if (audiobookMediaIds.size > 0) {
        await pushAudiobookProgressToAbs({
            sql,
            userId,
            mediaIds: [...audiobookMediaIds],
            deps: params.audiobookPushDeps,
        }).catch((err) => logger.warn('Audiobook progress push failed', { userId }, err as Error));
    }

    // invalidateAllWatchedCaches already invalidates the continue-watching
    // cache internally, so a single call after the loop covers both — this
    // mirrors the live stop path's cleanupAfterStop.
    if (touchedAny) {
        await invalidateAllWatchedCaches(userId).catch((e) =>
            logger.warn('Watched cache invalidation failed', e as Error),
        );

        // Debounced AI profile rebuild — the third hoisted-once-per-request
        // call (see this module's "Batch execution" precedent in the design
        // spec). Mirrors the live stop path's step 5
        // (play-session-lifecycle.service.ts:~646): fire-and-forget,
        // non-fatal on failure, since `rebuildUserProfileDebounced` is itself
        // Valkey-debounced and safe to invoke at most once here regardless of
        // how many groups/records this request touched.
        try {
            const { aiDbService } = await import('./database.service.js');
            const profileService = await aiDbService.getUserProfileService();
            if (profileService) {
                profileService.rebuildUserProfileDebounced(userId);
            }
        } catch (err) {
            logger.warn('Failed to schedule debounced profile rebuild', { userId }, err as Error);
        }
    }

    return records.map(
        (r) =>
            resultByEventId.get(r.eventId) ?? {
                eventId: r.eventId,
                status: 'rejected' as const,
                reason: 'not_processed',
            },
    );
}
