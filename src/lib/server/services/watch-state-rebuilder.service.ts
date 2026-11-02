// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch-State Rebuilder Service
 *
 * Derives `user_media_state` rows from the append-only
 * `user_media_events` log. Everything in this module is the load-
 * bearing arbitration logic for Continue Watching, history, stats,
 * and AI profiles — do not let writers update `user_media_state`
 * directly.
 *
 * Shape of the world:
 *   - Events flow in from multiple sources (player, user marks,
 *     Jellyfin sync, etc.). They are never mutated after insert.
 *   - A "tick" of the rebuilder runs `computeStateFromEvents` over
 *     all live events for a (user, media) and upserts the result.
 *   - `null` means "no events left" — the state row is deleted so
 *     stale rebuild artifacts don't linger after a repudiation.
 *
 * Concurrency:
 *   The rebuilder itself does not take locks — callers who need
 *   serialized writes should wrap `appendEventAndRebuild` in a
 *   transaction. For lumastra-player progress specifically we apply
 *   `shouldAcceptLumastraProgressEvent` as a pre-insert guard so a
 *   stale tab cannot silently overwrite the active session's
 *   position.
 *
 * Compaction (snapshots):
 *   A heavy binger emitting progress heartbeats every 30s can produce
 *   tens of thousands of events per (user, media). To keep rebuild
 *   cost bounded we compact the log inline:
 *
 *     1. The rebuild path reads via `getEventsSinceLastSnapshot`,
 *        which returns the most recent live `'state_snapshot'`
 *        event (if any) plus everything newer. Older history is
 *        ignored; the snapshot's stored state IS the authoritative
 *        summary of everything before it.
 *     2. `computeStateFromEvents` recognizes a snapshot in the input
 *        and uses it as a base case — events newer than the snapshot
 *        arbitrate among themselves and against the snapshot's
 *        cached state.
 *     3. After every successful `appendEventAndRebuild`, we count
 *        the live non-snapshot events newer than the latest snapshot.
 *        When that count crosses `COMPACTION_THRESHOLD` we write a
 *        fresh `'state_snapshot'` event (`source = 'compaction'`)
 *        carrying the just-computed state in `snapshot_state`.
 *     4. `repudiateEvents` cascades: when any base event is
 *        repudiated, every live snapshot for the same (user, media)
 *        is repudiated too so the rebuilder cannot read a snapshot
 *        whose payload depended on now-repudiated history. The next
 *        rebuild falls back to a full-history compute, which is
 *        correct.
 *
 * Compaction events use `'compaction'` as their source and `0` as
 * their priority in `SOURCE_PRIORITY`. Snapshots are filtered out of
 * the per-source arbitration loop anyway, but the explicit zero
 * priority keeps things safe if a future change accidentally lets
 * one through.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    insertEvent,
    getEventsForMedia,
    getEventsSinceLastSnapshot,
    getEventsSinceLastSnapshotForUser,
    countEventsSinceLastSnapshot,
    getLatestLumastraSessionInfo,
    type UserMediaEvent,
    type EventSource,
    type EventType,
    type NewUserMediaEvent,
    type SnapshotState,
    type LumastraSessionInfo,
} from '$lib/server/database/queries/user-media-events.queries.js';
import {
    upsertState,
    deleteState,
    getState,
    type UserMediaStateUpsert,
} from '$lib/server/database/queries/user-media-state.queries.js';
import {
    removeFlagIfOlderThan,
    resolveDismissalTarget,
    userHasAnyFlag,
} from '$lib/server/database/queries/user-media-flags.queries.js';

const IS_DEV = process.env.NODE_ENV !== 'production';

const logger = Logger.for('WatchStateRebuilder');

// =============================================================================
// Arbitration constants
// =============================================================================

/**
 * Priority ordering for watched/unwatched arbitration. Higher number
 * wins when two sources disagree. User marks inside Lumastra outrank
 * everything because they represent deliberate intent (sole exception:
 * a newer lumastra-player completion beats an older user mark_unwatched,
 * see computeStateFromEvents). Remote syncs share a lower priority;
 * equal-priority decisive sources use stable source-name ordering. Migration is the
 * floor so historical imports never override live user action;
 * `compaction` is zero because snapshot events are filtered out of
 * arbitration anyway — the priority only matters as a defensive
 * fallback if a snapshot ever leaks into the per-source loop.
 */
export const SOURCE_PRIORITY = {
    'lumastra-user-mark': 100,
    'lumastra-player': 90,
    // Ties with 'lumastra-player': an offline record is the same player's
    // evidence, just uploaded late. Safe at equal priority because
    // 'lumastra-player' never writes a negative event, so the two can only
    // agree on is_watched and the alphabetical tiebreak never decides anything.
    'lumastra-offline': 90,
    'jellyfin-sync': 10,
    'plex-sync': 10,
    'mal-sync': 10,
    'trakt-sync': 10,
    // Tied with the other remote syncs: ABS is an ordinary upstream source, so
    // a position it reports must not outrank one Lumastra's own player wrote.
    'audiobookshelf-sync': 10,
    migration: 5,
    compaction: 0,
} as const satisfies Record<EventSource, number>;

/**
 * Compaction policy: after each successful rebuild, count the live
 * non-snapshot events newer than the latest snapshot. When the count
 * reaches this threshold we write a fresh snapshot inline and the
 * next rebuild can use it as a base case.
 *
 * 100 is small enough that bingewatcher heartbeat storms are
 * compacted within a single session and large enough that we don't
 * write a snapshot for every casual progress tick. Tune in tests if
 * needed.
 */
export const COMPACTION_THRESHOLD = 100;

/** Event types that assert "this was watched". */
const POSITIVE_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['completed', 'mark_watched']);

/** Event types that assert "this was NOT watched". */
const NEGATIVE_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['mark_unwatched']);

/**
 * Sources that have no writer for a negative verdict: the player and the
 * offline uploader only ever write `progress` / `completed`, and migrations
 * only ever imported `mark_watched`. A stored "is_watched=false, decided by
 * <one of these>" is therefore never evidence — it can only have been
 * fabricated, and {@link snapshotVerdictSource} refuses to replay it.
 */
const SOURCES_WITHOUT_NEGATIVE_VERDICTS: ReadonlySet<EventSource> = new Set<EventSource>([
    'lumastra-player',
    'lumastra-offline',
    'migration',
]);

// =============================================================================
// Pure arbitration helpers
// =============================================================================

/**
 * Result of arbitrating over an event log. Shape matches
 * `UserMediaStateRow` minus the (user_id, media_id) pair that the
 * caller injects on upsert, plus an `is_watched_source` pointer used
 * exclusively by the snapshot writer (it's not persisted to
 * `user_media_state`).
 */
export interface ComputedState {
    is_watched: boolean;
    /**
     * Source whose latest decisive event drove `is_watched` for this
     * compute. Carried into `state_snapshot.snapshot_state` so the
     * next rebuild can correctly arbitrate the snapshot's verdict
     * against any back-dated event in the post-snapshot window.
     * Materialised state rows do not store this field.
     */
    is_watched_source: string | null;
    jellyfin_unwatch_acknowledged_at?: string | null;
    resume_position_ms: number;
    runtime_ms: number | null;
    watch_count: number;
    first_watched_at: string | null;
    last_watched_at: string | null;
    last_event_at: string | null;
    last_event_source: string | null;
    /**
     * Highest cumulative-playing-time observed across all lumastra-player
     * progress events in the input. NULL when no event carries the
     * field — typical for legacy state, jellyfin-sync only items, or
     * mark-only items. The CW filter prefers this when present and
     * falls back to the legacy position+percent heuristic when NULL.
     *
     * The upsertState query GREATEST-merges this with the row's
     * existing value, so this field represents "engagement contributed
     * by events visible to THIS compute" rather than the global max
     * over all history. The materialised column is the global max.
     */
    highest_session_elapsed_ms: number | null;
}

/**
 * Which event each arbitrated field actually came from.
 *
 * Exists because the OUTCOME of arbitration is not derivable from its inputs
 * by a caller: an event can be written, be perfectly valid, and still lose —
 * to a newer position from another device, to the blind-spot guard, or to a
 * decisive verdict that clears the resume point. A writer that wants to tell
 * its caller "your position is the one in effect" cannot answer that by
 * comparing numbers (two events can report the same position, and a
 * completion legitimately stores 0), so the arbitration reports who won.
 *
 * Passed as an optional OUT-PARAM rather than folded into
 * {@link ComputedState}, deliberately: `ComputedState` is spread verbatim
 * into the `user_media_state` upsert row AND stored as a snapshot payload, so
 * a field added there becomes a column-shaped thing that has to be migrated,
 * validated by `snapshotToComputedState`, and kept out of the upsert by hand.
 * Provenance is about the compute, not about the state.
 *
 * Every field is (re)assigned on every call, so one sink object may be reused
 * across calls without carrying a stale verdict into a later one.
 */
export interface StateProvenance {
    /**
     * `source_event_id` of the event whose `position_ms` IS the returned
     * `resume_position_ms`. Null when no event set it: the value fell back to
     * a snapshot, or an authoritative decisive event cleared it to 0, or the
     * event that won carried no `source_event_id` of its own.
     */
    resumePositionEventId: string | null;
    /**
     * `source_event_id` of the decisive event that settled `is_watched`. Null
     * when the bit came from a snapshot's stored verdict, from the synthetic
     * snapshot event, or from the default.
     */
    watchedVerdictEventId: string | null;
}

/**
 * Compare two ISO timestamps. Avoids Date allocations inside hot
 * loops; lexicographic comparison is correct for ISO-8601 strings.
 */
/**
 * Sentinel for "this event has no blind spot at all" — distinct from `null`,
 * which means "it has one and we don't know how far back it goes".
 */
const NO_BLIND_SPOT = Symbol('noBlindSpot');

/**
 * How far back an event's view of the world may be stale, if at all.
 *
 * Returns:
 *  - `NO_BLIND_SPOT` — the event was written by something that was talking to
 *    this server at the time, so it IS the current knowledge. Every live
 *    player beacon and every sync source. No guard applies.
 *  - a timestamp — the reporter told us when it last incorporated server
 *    state for this item. Anything written after that instant was invisible
 *    to it.
 *  - `null` — the reporter is known to have been offline but did not say for
 *    how long (a client older than 2026-08-22). Treated as unbounded: it may
 *    not be trusted over ANY other source's position.
 *
 * Only `lumastra-offline` has a blind spot. The distinction between the two
 * NULL readings is the whole reason this is a function and not a field read:
 * `knowledge_as_of` is NULL on virtually every row in the table, and reading
 * that as "unbounded blind spot" everywhere would apply the guard to the live
 * player — turning every ordinary rewind into a no-op.
 */
/**
 * Whether two events came from the same reporting client, as far as anything
 * stored can tell.
 *
 * There is no device id on `user_media_events`, and every offline device
 * writes the same `lumastra-offline` source — so source equality answers "same
 * lane", not "same reporter". `knowledge_as_of` is the closest thing to an
 * identity that exists here: it is stamped from when THAT client last read the
 * server, so one device's records within a single offline stretch all carry
 * the identical value while two devices practically never do.
 *
 * Deliberately conservative: when both stamps are absent (older clients) the
 * two are treated as the same reporter, which only ever suppresses a raise.
 * Suppressing a raise is the recoverable direction — the listener resumes
 * where a device actually got to. The alternative would let one device's
 * earlier, higher record undo another's deliberate rewind.
 */
function sharesReporterIdentity(a: UserMediaEvent, b: UserMediaEvent): boolean {
    if (a.source !== b.source) return false;
    // Identity-matching needs an identity. Two events with NO stamp are not
    // evidence of one reporter — every client older than 2026-08-22 sends
    // none, so treating them as the same device made two legacy phones
    // indistinguishable and excused the staler one's regression, which is the
    // exact cross-device case the guard exists for.
    //
    // Their blind spot is declared UNBOUNDED, and that is the whole meaning of
    // an unbounded blind spot: such a record may only ever advance a resume
    // point. The cost is that one legacy device cannot rewind past its own
    // earlier report either — accepted, and documented, because the
    // alternative silently destroys another device's position.
    if (a.knowledge_as_of === null || b.knowledge_as_of === null) return false;
    return a.knowledge_as_of === b.knowledge_as_of;
}

function blindSpotBoundary(ev: UserMediaEvent): string | null | typeof NO_BLIND_SPOT {
    if (ev.source !== 'lumastra-offline') return NO_BLIND_SPOT;
    return ev.knowledge_as_of;
}

function isoBefore(a: string, b: string): boolean {
    return a < b;
}

/**
 * The source whose verdict a snapshot's `is_watched` may be replayed as, or
 * null when the stored bit was not decided by any source and must stay a
 * plain default that any real decisive event can overturn.
 *
 * `is_watched_source: null` is a positive statement — "no decisive event
 * existed" — and has been written on every snapshot since the field was
 * added. Only a snapshot that predates the field (key ABSENT) falls back to
 * `last_event_source`. Reading an explicit null through that fallback is how
 * a never-watched item's snapshot (last event: a player heartbeat) turned into
 * a synthetic `mark_unwatched` from `lumastra-player` (90), which then outranked
 * every `jellyfin-sync` mark (10) and was re-recorded as the verdict source of
 * every later snapshot. Prod 2026-09-30: 17 items stuck unwatched, the pull
 * re-appending a mark_watched every 5 min (~166k rows since July).
 *
 * A negative attributed to a source that cannot emit one is discarded too:
 * that heals the snapshots the fallback already poisoned, without a rewrite.
 */
function snapshotVerdictSource(
    snapshot: UserMediaEvent,
    snapshotState: ComputedState,
): EventSource | null {
    const stored = snapshot.snapshot_state as unknown as Record<string, unknown>;
    const raw =
        'is_watched_source' in stored
            ? snapshotState.is_watched_source
            : snapshotState.last_event_source;
    // 'compaction' is the snapshot row's own source, never an arbitrating one.
    if (!raw || !(raw in SOURCE_PRIORITY) || raw === 'compaction') return null;
    const source = raw as EventSource;
    if (!snapshotState.is_watched && SOURCES_WITHOUT_NEGATIVE_VERDICTS.has(source)) return null;
    return source;
}

/**
 * Unpack a `state_snapshot` event's stored payload into the
 * `ComputedState` shape. The payload is a 1:1 mirror minus the
 * (user_id, media_id) pair, so this is just a shape rename.
 *
 * Returns `null` when the snapshot is absent OR malformed (e.g. NULL,
 * an array, a string, or missing required keys). Callers treat null
 * as "no snapshot available" and fall through to a full-history
 * compute, which is correct: a corrupt snapshot must not feed garbage
 * into ComputedState. The shape check is intentionally narrow — we
 * only validate the load-bearing fields used by arbitration; the
 * nullable history pointers are coerced to null when they fail
 * shape checks.
 */
function snapshotToComputedState(snapshot: UserMediaEvent): ComputedState | null {
    const s = snapshot.snapshot_state as unknown;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const o = s as Record<string, unknown>;
    if (typeof o.is_watched !== 'boolean') return null;
    if (typeof o.resume_position_ms !== 'number') return null;
    if (typeof o.watch_count !== 'number') return null;
    return {
        is_watched: o.is_watched,
        ...(typeof o.jellyfin_unwatch_acknowledged_at === 'string'
            ? { jellyfin_unwatch_acknowledged_at: o.jellyfin_unwatch_acknowledged_at }
            : {}),
        // Old snapshots (written before verdict-source tracking) leave
        // this null; the compute path falls back to `last_event_source`
        // as a heuristic when reconstructing the synthetic verdict event.
        is_watched_source: typeof o.is_watched_source === 'string' ? o.is_watched_source : null,
        resume_position_ms: o.resume_position_ms,
        runtime_ms: typeof o.runtime_ms === 'number' ? o.runtime_ms : null,
        watch_count: o.watch_count,
        first_watched_at: typeof o.first_watched_at === 'string' ? o.first_watched_at : null,
        last_watched_at: typeof o.last_watched_at === 'string' ? o.last_watched_at : null,
        last_event_at: typeof o.last_event_at === 'string' ? o.last_event_at : null,
        last_event_source: typeof o.last_event_source === 'string' ? o.last_event_source : null,
        // Old snapshots (pre-12.53.0) don't carry engagement; null falls
        // through to the upsertState GREATEST merge with whatever is
        // already on the materialised state row. Reject NaN / Infinity
        // / negative — they'd poison both the gate (NaN compares false
        // everywhere → row hidden forever) and the snapshot's stored
        // signal (infinite values would lock the GREATEST ratchet).
        highest_session_elapsed_ms:
            typeof o.highest_session_elapsed_ms === 'number' &&
            Number.isFinite(o.highest_session_elapsed_ms) &&
            o.highest_session_elapsed_ms >= 0
                ? o.highest_session_elapsed_ms
                : null,
    };
}

/**
 * Core arbitration rule. Returns `null` when the event log is empty
 * so the caller knows to delete the materialized row.
 *
 * The algorithm is intentionally pure — no DB access — so it can be
 * unit-tested exhaustively. The shape of the computation is:
 *
 *   0. If a `state_snapshot` event is present, treat it as the BASE
 *      and arbitrate only over the events strictly newer than it.
 *      The snapshot replaces the historical scan: its stored state
 *      IS the authoritative summary of everything before it.
 *   1. Index events by source, retaining the latest per source.
 *   2. Walk sources in priority order; the first one with a decisive
 *      (positive or negative) latest event determines `is_watched`.
 *      If no decisive event arbitrates, fall back to the snapshot's
 *      `is_watched` (or `false` when there is no snapshot).
 *   3. `resume_position_ms` is the latest non-null position across
 *      ALL sources in the post-snapshot subset — progress is
 *      informational regardless of who "wins" arbitration — zeroed
 *      when is_watched is true. Falls back to the snapshot's value
 *      when no progress event exists in the subset.
 *  3b. Blind-spot guard: if the progress event that won step 3 came
 *      from a client that was OFFLINE (`lumastra-offline`), it could
 *      not have seen anything written after `knowledge_as_of` — so a
 *      higher position from another source in that interval wins
 *      instead. Raises only, never lowers, and never applies to an
 *      online reporter. See `blindSpotBoundary`.
 *   4. `runtime_ms` is the most recent non-null runtime reported in
 *      the subset, falling back to the snapshot's value.
 *   5. `watch_count` = snapshot.watch_count + (positives − negatives)
 *      from the post-snapshot subset, floored at 0 and floored again
 *      at 1 when is_watched is true.
 *   6. `first_watched_at` is the snapshot's value when set; otherwise
 *      the earliest positive event in the subset. `last_watched_at`
 *      is the most recent un-revoked positive event in the subset,
 *      falling back to the snapshot's value when the subset is empty
 *      or has no surviving positive.
 *   7. `last_event_at` / `last_event_source` reflect the absolute
 *      newest input event (snapshot or post-snapshot, whichever is
 *      later by occurred_at). For the no-events-newer case the
 *      snapshot itself is the last event.
 */
export function computeStateFromEvents(
    events: UserMediaEvent[],
    /**
     * Optional sink for {@link StateProvenance}. Reset on entry and fully
     * assigned on every path that returns a state, so a caller may reuse one
     * object across calls. Purely observational — passing it changes nothing
     * about the computed result.
     */
    provenance?: StateProvenance,
): ComputedState | null {
    if (provenance) {
        provenance.resumePositionEventId = null;
        provenance.watchedVerdictEventId = null;
    }
    if (events.length === 0) return null;

    // ---- 0: split snapshot from real events ----
    // We expect at most one snapshot in the input because
    // `getEventsSinceLastSnapshot` filters to the most recent live
    // snapshot. If multiple snapshots somehow leak in we keep the
    // newest by occurred_at — older ones are subsumed by it. Ties
    // on occurred_at break on recorded_at (newer wins) so two
    // snapshots written in the same logical instant resolve
    // deterministically — matches the post-snapshot subset sort
    // tiebreak below.
    let snapshot: UserMediaEvent | null = null;
    for (const ev of events) {
        if (ev.event_type !== 'state_snapshot') continue;
        if (snapshot === null) {
            snapshot = ev;
            continue;
        }
        if (isoBefore(snapshot.occurred_at, ev.occurred_at)) {
            snapshot = ev;
        } else if (
            snapshot.occurred_at === ev.occurred_at &&
            isoBefore(snapshot.recorded_at, ev.recorded_at)
        ) {
            snapshot = ev;
        }
    }
    const snapshotState = snapshot ? snapshotToComputedState(snapshot) : null;

    // Corrupt-snapshot signal: a snapshot row exists but its payload
    // failed shape validation. Returning null lets the caller's
    // full-history fallback (in rebuildStateFromEvents) re-run the
    // compute over the entire log instead of silently producing a
    // truncated result that loses pre-snapshot history.
    if (snapshot && !snapshotState) {
        return null;
    }

    // Real (non-snapshot) events available to arbitrate. We used to
    // filter by `occurred_at > snapshot.occurred_at` here, but that
    // silently dropped back-dated events whose `occurred_at` predates
    // the snapshot — e.g. a Jellyfin sync inserting a historical
    // mark_unwatched after the snapshot was written. The query layer
    // (`getEventsSinceLastSnapshot`) already scopes by `recorded_at`,
    // so anything reaching us was written after the snapshot and is
    // legitimate new knowledge. We exclude only the snapshot itself
    // (identity comparison) — chronological ordering is handled by
    // the sort below using `occurred_at DESC` with `recorded_at DESC`
    // as the tiebreak, so a back-dated event slots correctly into the
    // arbitration timeline.
    const subset = events.filter((ev) => {
        if (ev.event_type === 'state_snapshot') return false;
        if (!snapshot) return true;
        return ev !== snapshot;
    });

    const snapshotVerdict =
        snapshotState && snapshot ? snapshotVerdictSource(snapshot, snapshotState) : null;

    // Pure-snapshot case: nothing newer to arbitrate, return the
    // snapshot's stored state as-is (minus a fabricated verdict source).
    if (snapshotState && subset.length === 0) {
        return { ...snapshotState, is_watched_source: snapshotVerdict };
    }

    // No snapshot AND no real events — defensive; happens only if the
    // input was a single corrupted snapshot. Fall back to null so the
    // caller deletes the materialized row.
    if (!snapshotState && subset.length === 0) {
        return null;
    }

    // Sort descending by occurred_at, with recorded_at as tiebreaker
    // so rows inserted in the same logical instant remain stable.
    // A defensive copy keeps the caller's array untouched.
    const sorted = [...subset].sort((a, b) => {
        if (a.occurred_at !== b.occurred_at) {
            return isoBefore(a.occurred_at, b.occurred_at) ? 1 : -1;
        }
        if (a.recorded_at !== b.recorded_at) {
            return isoBefore(a.recorded_at, b.recorded_at) ? 1 : -1;
        }
        return 0;
    });

    // ---- 1/2: decide is_watched via source priority ----
    // Keep the latest DECISIVE event per source. A newer progress event from
    // the same source must not mask an immediately preceding
    // mark_watched/mark_unwatched verdict, or live sync writes like
    // "mark_unwatched + progress" will stay stuck on the old watched bit.
    const latestDecisiveBySource = new Map<EventSource, UserMediaEvent>();
    for (const ev of sorted) {
        if (!POSITIVE_EVENTS.has(ev.event_type) && !NEGATIVE_EVENTS.has(ev.event_type)) {
            continue;
        }
        // `sorted` is DESC so the first decisive occurrence per source is
        // already the latest.
        if (!latestDecisiveBySource.has(ev.source)) {
            latestDecisiveBySource.set(ev.source, ev);
        }
    }

    // Inject the snapshot's verdict as a synthetic event so priority
    // arbitration sees the snapshot's source alongside any real
    // post-snapshot events. Without this, a back-dated jellyfin-sync
    // mark_unwatched arriving after a lumastra-user-mark snapshot would
    // otherwise be the ONLY decisive entry and could silently flip
    // is_watched=false, even though the user-mark (priority 100)
    // should outrank jellyfin-sync (priority 10).
    //
    // The synthetic event uses snapshot.occurred_at so that a real
    // event from the same source with a later occurred_at correctly
    // supersedes it (the sorted-DESC ordering makes the real event
    // the first occurrence per source, and the synthetic only lands
    // in the map when no real event from that source is present or
    // the real event predates the snapshot).
    //
    // Source resolution: see `snapshotVerdictSource` — no synthetic event
    // when the snapshot's bit was a default rather than a verdict.
    if (snapshotState && snapshot) {
        if (snapshotVerdict) {
            const verdictSource = snapshotVerdict;
            const existing = latestDecisiveBySource.get(verdictSource);
            if (!existing || isoBefore(existing.occurred_at, snapshot.occurred_at)) {
                const synthetic: UserMediaEvent = {
                    id: '<synthetic-snapshot-verdict>',
                    user_id: snapshot.user_id,
                    media_id: snapshot.media_id,
                    event_type: snapshotState.is_watched ? 'mark_watched' : 'mark_unwatched',
                    source: verdictSource,
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    repudiated_at: null,
                    snapshot_state: null,
                    session_elapsed_ms: null,
                    // A decisive verdict, never a progress position — the
                    // blind-spot guard only ever inspects progress events, so
                    // this is unreachable by it either way.
                    knowledge_as_of: null,
                    pushed_to_providers: [],
                    sync_delivery: snapshotState.jellyfin_unwatch_acknowledged_at
                        ? {
                              jellyfin: {
                                  acknowledged_at: snapshotState.jellyfin_unwatch_acknowledged_at,
                              },
                          }
                        : {},
                    occurred_at: snapshot.occurred_at,
                    recorded_at: snapshot.recorded_at,
                };
                latestDecisiveBySource.set(verdictSource, synthetic);
            }
        }
    }

    // Stable ordering for deterministic tiebreaks when two sources
    // share a priority: higher priority first, then source name A-Z.
    const sourcesByPriority = [...latestDecisiveBySource.keys()].sort((a, b) => {
        const pa = SOURCE_PRIORITY[a];
        const pb = SOURCE_PRIORITY[b];
        if (pa !== pb) return pb - pa;
        return a < b ? -1 : a > b ? 1 : 0;
    });

    // The one exception to priority-over-recency: the user un-marks an item,
    // then watches it through in Lumastra's own player. That completion is the
    // same user's later first-party evidence, so it outranks their older
    // mark_unwatched. Without this the rewatch never counted (no Next Up
    // advance; CI 2026-10-02) — handleStop's markWatched fallback stays silent
    // because the session already has its completion. Only a strictly newer
    // `lumastra-player` positive qualifies (server-stamped occurred_at; the
    // player never writes a negative; ties break on recorded_at like `sorted`):
    // sync sources, and `lumastra-offline` with its client-stamped endedAt,
    // still cannot override a user mark.
    //
    // Not for a mark that CARRIES a position — the audiobook un-finish. That
    // position may sit inside the book's finish window, so merely reopening it
    // writes a `completed` on the first heartbeat, which would silently undo
    // the un-finish before anything was listened to.
    const userMark = latestDecisiveBySource.get('lumastra-user-mark');
    const playerVerdict = latestDecisiveBySource.get('lumastra-player');
    if (
        userMark &&
        playerVerdict &&
        NEGATIVE_EVENTS.has(userMark.event_type) &&
        typeof userMark.position_ms !== 'number' &&
        POSITIVE_EVENTS.has(playerVerdict.event_type) &&
        (isoBefore(userMark.occurred_at, playerVerdict.occurred_at) ||
            (userMark.occurred_at === playerVerdict.occurred_at &&
                isoBefore(userMark.recorded_at, playerVerdict.recorded_at)))
    ) {
        sourcesByPriority.splice(sourcesByPriority.indexOf('lumastra-player'), 1);
        sourcesByPriority.unshift('lumastra-player');
    }

    // A stale upstream echo cannot override an unacknowledged local reset.
    // Once Jellyfin acknowledges it, a strictly later upstream play is a new
    // user act. Require its own timestamp; receipt time is not play evidence.
    const acknowledgement = userMark?.sync_delivery?.jellyfin?.acknowledged_at;
    const upstreamVerdict = latestDecisiveBySource.get('jellyfin-sync');
    if (
        userMark &&
        NEGATIVE_EVENTS.has(userMark.event_type) &&
        acknowledgement &&
        upstreamVerdict &&
        POSITIVE_EVENTS.has(upstreamVerdict.event_type) &&
        toEpochMs(acknowledgement) < toEpochMs(upstreamVerdict.occurred_at)
    ) {
        sourcesByPriority.splice(sourcesByPriority.indexOf('jellyfin-sync'), 1);
        sourcesByPriority.unshift('jellyfin-sync');
    }

    // Default to the snapshot's is_watched (or false) so a subset
    // composed entirely of non-decisive 'progress' events doesn't
    // silently flip the bit.
    let is_watched = snapshotState?.is_watched ?? false;
    // The sanitised source, not the stored one: carrying a fabricated source
    // forward is what re-poisoned every later snapshot.
    let is_watched_source: string | null = snapshotVerdict;
    for (const source of sourcesByPriority) {
        const ev = latestDecisiveBySource.get(source);
        if (!ev) continue;
        if (POSITIVE_EVENTS.has(ev.event_type)) {
            is_watched = true;
            is_watched_source = source;
            if (provenance) provenance.watchedVerdictEventId = ev.source_event_id;
            break;
        }
        if (NEGATIVE_EVENTS.has(ev.event_type)) {
            is_watched = false;
            is_watched_source = source;
            if (provenance) provenance.watchedVerdictEventId = ev.source_event_id;
            break;
        }
    }

    // Sources whose OWN latest decisive verdict disagrees with the arbitration
    // outcome. Their view of this item has been overruled, so none of their
    // events may influence the derived timestamps or the resume point.
    //
    // The concrete failure this prevents: Jellyfin holds a stale copy of an
    // episode the user just finished in Lumastra, and the next pull emits
    // `mark_unwatched` + `progress` (an old resume position, stamped
    // occurred_at = now because Jellyfin gives no timestamp for a resume
    // point). `jellyfin-sync` (10) loses is_watched arbitration to
    // `lumastra-user-mark` (100), so the row stays watched — but before this
    // guard the losing negative still revoked `last_watched_at` (leaving NULL
    // on a watched row) and the losing progress still restored a resume
    // position. That produced `is_watched=true AND resume_position_ms>0 AND
    // last_watched_at IS NULL`, which surfaced finished episodes in Continue
    // Watching and flooded the rail.
    //
    // A source that says "unwatched at position X" while we have decided the
    // item IS watched is describing a state we already rejected; its resume
    // point is part of the same rejected claim.
    const contradictedSources = new Set<string>();
    for (const [source, ev] of latestDecisiveBySource) {
        if (source === is_watched_source) continue;
        const positive = POSITIVE_EVENTS.has(ev.event_type);
        const negative = NEGATIVE_EVENTS.has(ev.event_type);
        if ((is_watched && negative) || (!is_watched && positive)) {
            contradictedSources.add(source);
        }
    }

    /**
     * True when `ev` comes from an overruled source AND is not newer than that
     * source's contradicting verdict — i.e. it is part of the rejected claim
     * rather than later, independent activity from the same client.
     */
    function isContradictedAt(ev: UserMediaEvent): boolean {
        if (!contradictedSources.has(ev.source)) return false;
        const contradictionAt = latestDecisiveBySource.get(ev.source)?.occurred_at;
        if (!contradictionAt) return true;
        // Inclusive: `ev` newer than the verdict survives, equal does not.
        return !isoBefore(contradictionAt, ev.occurred_at);
    }

    // ---- 3: resume position ----
    // Zeroed on watched; otherwise latest progress event's position
    // across ALL sources so e.g. a Jellyfin resume point still shows
    // in Continue Watching even if we also have older Lumastra
    // progress. Falls back to the snapshot's stored position when
    // no progress event exists in the post-snapshot subset.
    //
    // Chronology gate: a back-dated progress event (occurred_at older
    // than the snapshot) does NOT override the snapshot's stored
    // resume_position_ms. The snapshot reflects the most recent
    // playback state at compaction time; back-dated progress is
    // historical knowledge that predates that state and shouldn't
    // regress the user's resume point.
    // Latest-event-wins for resume_position_ms — but ONLY decisive events
    // from the source that won is_watched arbitration count as "the user
    // transitioned the watched bit." A lower-priority sync's mark_unwatched
    // that lost arbitration must not zero a valid rewatch resume.
    //
    // Walk the post-snapshot subset desc by occurred_at:
    //   - hit a `progress` event → use its position (re-watch case: post-
    //     mark progress events are after the mark in time, so the desc
    //     walk hits them first)
    //   - hit a decisive event (mark_watched / completed / mark_unwatched)
    //     from `is_watched_source` → resume = 0 (the authoritative source
    //     toggled the bit; older progress is stale intent)
    //   - hit a decisive event from any OTHER source → ignore. It already
    //     lost is_watched arbitration; it must not influence resume either.
    //
    // This replaces the older "zero on is_watched=true" gate which broke
    // re-watches (resume zeroed even when current heartbeats had recorded
    // the post-mark position). CW filtering excludes is_watched=true rows
    // separately, so a non-zero resume on a watched re-watch row is
    // harmless for the home strip but load-bearing for /watch/[id]
    // bootstrap.
    //
    // Blind-spot guard (see step 3b below): an offline report's position was
    // read off the reporting device's own local mirror, so `occurred_at`
    // says nothing about how CURRENT the claim is. Winning latest-wins with
    // a stale position is how a phone that was offline overnight erases a
    // position another device set in the meantime — irrecoverably for
    // audiobooks, whose arbitrated position is pushed to AudiobookShelf's
    // history-free progress row. Resolved after the walk so the walk itself
    // keeps its single, readable rule.
    let resume_position_ms = 0;
    let foundResume = false;
    let resumeEvent: UserMediaEvent | null = null;
    for (const ev of sorted) {
        if (snapshot && !isoBefore(snapshot.occurred_at, ev.occurred_at)) {
            continue;
        }
        // Overruled source — its events up to and including its contradicting
        // verdict describe the same rejected claim (see contradictedSources).
        //
        // Bounded at that verdict rather than blanket-skipping the source: if
        // the user genuinely resumes on that client afterwards, its LATER
        // progress is real and must still set the resume point. The bound is
        // inclusive because the stale-pull case emits the negative and the
        // resume position with an IDENTICAL occurred_at (Jellyfin supplies no
        // timestamp for a resume point, so both are stamped "now") — an
        // exclusive bound would let that progress through and reinstate the bug.
        if (isContradictedAt(ev)) continue;
        if (POSITIVE_EVENTS.has(ev.event_type) || NEGATIVE_EVENTS.has(ev.event_type)) {
            // Decisive event from a source that did NOT win is_watched
            // arbitration — ignore (it didn't change the watched bit, so
            // it shouldn't change resume either). Continue looking for an
            // older decisive event from the winning source or a progress.
            if (ev.source !== is_watched_source) continue;
            // Authoritative decisive event settles resume. It CLEARS it unless
            // the event carries a position of its own, in which case that
            // position is the answer.
            //
            // The carried-position case exists for audiobooks. "Mark unwatched"
            // on a film means "I have not seen this", so dropping the resume is
            // the whole gesture. On a 21-hour book the position IS the value and
            // recovering it is the only reason anyone taps un-finish — zeroing
            // it there hands the user a strictly worse outcome than the bug they
            // were escaping. Measured on prod 2026-08-27: PUT watch-state
            // {watched:false} took an audiobook from positionMs 51733 to 0, and
            // because the arbitrated position is pushed to AudiobookShelf's
            // history-free progress row, the upstream copy was destroyed too
            // (ABS currentTime 0.0, same timestamp). Exactly the irreversibility
            // the blind-spot note below warns about.
            //
            // Encoded in the EVENT, not at the write site, on purpose: state is
            // derived from the log, so a fix applied anywhere else is undone by
            // the next rebuild. Video callers keep passing a null position and
            // keep getting 0 — byte-identical behaviour.
            foundResume = true;
            if (typeof ev.position_ms === 'number' && ev.position_ms >= 0) {
                resume_position_ms = ev.position_ms;
                resumeEvent = ev;
            }
            break;
        }
        if (
            ev.event_type === 'progress' &&
            typeof ev.position_ms === 'number' &&
            ev.position_ms >= 0
        ) {
            resume_position_ms = ev.position_ms;
            resumeEvent = ev;
            foundResume = true;
            break;
        }
    }
    if (!foundResume && snapshotState) {
        resume_position_ms = snapshotState.resume_position_ms;
    }
    /**
     * The event whose `position_ms` is the value `resume_position_ms` now
     * holds — tracked separately from `resumeEvent` because 3b can replace
     * the position without replacing the blind-spot subject the guard is
     * reasoning about. Null means no event set it (snapshot fallback, or a
     * decisive event that cleared the point).
     */
    let resumePositionSetBy: UserMediaEvent | null = resumeEvent;

    // ---- 3b: offline blind-spot guard ----
    // Only ever raises the resume point, and only when the winner is an
    // offline report that provably could not have seen a further-ahead
    // position. Everything else — every live beacon, every sync source, and
    // an offline report that IS the freshest knowledge — is untouched.
    if (resumeEvent !== null) {
        const blindTo = blindSpotBoundary(resumeEvent);
        if (blindTo !== NO_BLIND_SPOT) {
            // Each other source's LATEST view inside the blind spot, not every
            // position it ever held there. `sorted` is descending, so the
            // first hit per source is that source's newest.
            //
            // Taking a plain maximum over all candidates undid a rewind the
            // other device made INSIDE the window: web reaches 3h, the user
            // rewinds it to 1h, and an offline record landing later would be
            // raised back to 3h — the guard reinstating a position its owner
            // had deliberately abandoned.
            const latestBySource = new Map<string, UserMediaEvent>();
            for (const ev of sorted) {
                if (ev === resumeEvent) continue;
                // Same reporting client, same blind spot. EVERY offline device
                // shares the one source string `lumastra-offline`, so excluding
                // by source alone would make a second device invisible here —
                // the exact cross-device case the guard exists for. The
                // knowledge stamp is what actually distinguishes them: two
                // devices practically never share a millisecond-resolution
                // boundary, while one device's own records in the same offline
                // stretch all carry the identical one.
                //
                // Excluding them is what keeps a deliberate single-device
                // offline rewind working: listen to 3h, rewind to 1h, both
                // records carry the same stamp, and without this the earlier
                // 3h record would raise the resume point straight back.
                if (sharesReporterIdentity(ev, resumeEvent)) continue;
                if (ev.event_type !== 'progress') continue;
                if (typeof ev.position_ms !== 'number' || ev.position_ms < 0) continue;
                if (snapshot && !isoBefore(snapshot.occurred_at, ev.occurred_at)) continue;
                if (isContradictedAt(ev)) continue;
                // `blindTo === null` is an unbounded blind spot: every other
                // source counts, whenever it wrote.
                if (blindTo !== null && !isoBefore(blindTo, ev.occurred_at)) continue;
                if (!latestBySource.has(ev.source)) latestBySource.set(ev.source, ev);
            }
            for (const ev of latestBySource.values()) {
                if (typeof ev.position_ms === 'number' && ev.position_ms > resume_position_ms) {
                    resume_position_ms = ev.position_ms;
                    // The guard replaced the winner's position with this
                    // event's, so this event — not the offline report — is
                    // now the provenance of the stored resume point.
                    resumePositionSetBy = ev;
                }
            }
            // The snapshot is a candidate too. Compaction folds older events
            // into it and they stop appearing in `sorted`, so a position set
            // by another device before the last compaction is invisible to the
            // loop above — and a blind offline record would regress straight
            // past it. Only usable when the snapshot postdates the reporter's
            // knowledge; an older snapshot is something it could have seen.
            if (
                snapshotState &&
                snapshot &&
                (blindTo === null || isoBefore(blindTo, snapshot.occurred_at)) &&
                snapshotState.resume_position_ms > resume_position_ms
            ) {
                resume_position_ms = snapshotState.resume_position_ms;
                // Came from the compacted snapshot, not from any event still
                // in `sorted` — there is no event id to attribute it to.
                resumePositionSetBy = null;
            }
        }
    }
    if (provenance) {
        provenance.resumePositionEventId = resumePositionSetBy?.source_event_id ?? null;
    }

    // ---- 4: runtime ----
    // Most recent non-null runtime wins. We prefer any source's
    // runtime over none so a Jellyfin report still lands even if the
    // last Lumastra event didn't carry it. Falls back to the
    // snapshot's stored runtime when the subset has none.
    let runtime_ms: number | null = null;
    for (const ev of sorted) {
        if (typeof ev.runtime_ms === 'number' && ev.runtime_ms > 0) {
            runtime_ms = ev.runtime_ms;
            break;
        }
    }
    if (runtime_ms === null && snapshotState) {
        runtime_ms = snapshotState.runtime_ms;
    }

    // ---- 5: watch count ----
    // Start from the snapshot's count and apply post-snapshot deltas.
    // Without a snapshot the base is 0, matching the original behaviour.
    let positives = 0;
    let negatives = 0;
    for (const ev of sorted) {
        if (POSITIVE_EVENTS.has(ev.event_type)) positives += 1;
        else if (NEGATIVE_EVENTS.has(ev.event_type)) negatives += 1;
    }
    const baseCount = snapshotState?.watch_count ?? 0;
    let watch_count = Math.max(0, baseCount + positives - negatives);
    if (is_watched && watch_count < 1) watch_count = 1;

    // ---- 6: first/last watched ----
    // `last_watched_at`: most recent positive event in the subset
    // with no later mark_unwatched. Scan DESC — once we pass a
    // mark_unwatched we know nothing before it can survive
    // revocation. If the subset has no surviving positive, fall back
    // to the snapshot's stored last_watched_at — UNLESS the subset
    // contained a mark_unwatched newer than the snapshot, in which
    // case the snapshot's last_watched_at is also revoked.
    //
    // Chronology gate: only events newer than the snapshot influence
    // last_watched_at. A back-dated mark_unwatched (occurred_at older
    // than the snapshot) is historical knowledge that predates the
    // snapshot's verdict and must not revoke the snapshot's stored
    // last_watched_at. Back-dated positives likewise can't be the new
    // "most recent" completion.
    let last_watched_at: string | null = null;
    let sawNewerNegative = false;
    for (const ev of sorted) {
        if (snapshot && !isoBefore(snapshot.occurred_at, ev.occurred_at)) {
            continue;
        }
        // Overruled source — a negative that lost is_watched arbitration must
        // not revoke the completion timestamp either, or a watched row ends up
        // with last_watched_at NULL (see contradictedSources above).
        //
        // Scoped to negatives: that source's own earlier POSITIVE event is not
        // itself contradicted, and it may legitimately be the most recent
        // evidence of completion.
        if (isContradictedAt(ev) && NEGATIVE_EVENTS.has(ev.event_type)) continue;
        if (NEGATIVE_EVENTS.has(ev.event_type)) {
            sawNewerNegative = true;
            continue;
        }
        if (POSITIVE_EVENTS.has(ev.event_type)) {
            if (!sawNewerNegative) {
                last_watched_at = ev.occurred_at;
            }
            break;
        }
    }
    if (last_watched_at === null && snapshotState) {
        // If the post-snapshot subset contained a mark_unwatched (with
        // no later surviving positive), the snapshot's last_watched_at
        // is also revoked. Otherwise the snapshot's stored value stands.
        if (!sawNewerNegative) {
            last_watched_at = snapshotState.last_watched_at;
        }
    }

    // `first_watched_at`: snapshot's value when set, otherwise the
    // earliest positive event in the subset. Historical "I did
    // complete this at some point" is the most useful semantic for
    // personal stats even when later unwatched.
    let first_watched_at: string | null = snapshotState?.first_watched_at ?? null;
    if (first_watched_at === null) {
        for (let i = sorted.length - 1; i >= 0; i--) {
            const ev = sorted[i];
            if (POSITIVE_EVENTS.has(ev.event_type)) {
                first_watched_at = ev.occurred_at;
                break;
            }
        }
    }

    // ---- engagement ----
    // max(session_elapsed_ms) over progress events visible to this compute,
    // merged with the snapshot's stored value (which captures pre-snapshot
    // history that this window can't see).
    //
    // Lumastra-player events carry the canonical signal: actual cumulative
    // playing time from the player tick accumulator. External sources
    // (jellyfin-sync, plex-sync, migration) don't emit session telemetry —
    // their sync engines fill `session_elapsed_ms` with `position_ms` as a
    // coarse floor (to reach minute X the user committed at least to
    // seeking there). We accept that floor so jellyfin-sourced rows can
    // participate in engagement-aware CW filters; without it a user who
    // exclusively watches via Jellyfin would have NULL engagement on every
    // row and be permanently stuck on the legacy heuristic.
    //
    // NULL when no event of any source carries the field — e.g. a (user,
    // media) where every progress event predates 12.53.0 (and the engine
    // backfill). The upsertState query GREATEST-merges this with the
    // materialised column as a third defense, so historical engagement
    // persists across compaction even if a future snapshot writer regresses.
    //
    // Only count strictly-positive finite values. Zero is rejected (a
    // future non-gating client that always sent 0 would otherwise transition
    // the materialised column from NULL to 0, which behaves identically
    // under the OR-formulated CW filter but pollutes the signal for anyone
    // reading user_media_state.highest_session_elapsed_ms for analytics).
    // NaN / Infinity are typeof === 'number' so we must explicitly reject them.
    let highest_session_elapsed_ms: number | null =
        snapshotState?.highest_session_elapsed_ms ?? null;
    for (const ev of sorted) {
        if (
            ev.event_type === 'progress' &&
            typeof ev.session_elapsed_ms === 'number' &&
            Number.isFinite(ev.session_elapsed_ms) &&
            ev.session_elapsed_ms > 0
        ) {
            if (
                highest_session_elapsed_ms === null ||
                ev.session_elapsed_ms > highest_session_elapsed_ms
            ) {
                highest_session_elapsed_ms = ev.session_elapsed_ms;
            }
        }
    }

    // ---- last event pointer ----
    // The newest input event by occurred_at — picked from real events
    // in the subset OR the snapshot itself, whichever is later. Since
    // the subset can contain back-dated events (sort DESC puts the
    // newest occurred_at first, which may still predate the snapshot),
    // we must compare against snapshot.occurred_at to avoid regressing
    // last_event_at on a back-dated arrival.
    let last_event_at: string;
    let last_event_source: string;
    const newestSubsetEvent =
        sorted.length > 0 && (!snapshot || isoBefore(snapshot.occurred_at, sorted[0].occurred_at))
            ? sorted[0]
            : null;
    if (newestSubsetEvent) {
        last_event_at = newestSubsetEvent.occurred_at;
        last_event_source = newestSubsetEvent.source;
    } else if (snapshot && snapshotState) {
        // Snapshot is the newest input — preserve its stored
        // last_event_source rather than overwriting with a back-dated
        // event's source. The snapshot's occurred_at IS the latest
        // recorded activity timestamp at compaction time.
        last_event_at = snapshot.occurred_at;
        last_event_source = snapshotState.last_event_source ?? snapshot.source;
    } else {
        // Pure-snapshot case is handled at the top; this branch
        // exists only to satisfy the type system for the no-snapshot
        // case where sorted must be non-empty (otherwise we returned
        // null above).
        last_event_at = sorted[0].occurred_at;
        last_event_source = sorted[0].source;
    }

    return {
        is_watched,
        is_watched_source,
        ...(is_watched_source === 'lumastra-user-mark' && !is_watched && acknowledgement
            ? { jellyfin_unwatch_acknowledged_at: acknowledgement }
            : {}),
        resume_position_ms,
        runtime_ms,
        watch_count,
        first_watched_at,
        last_watched_at,
        last_event_at,
        last_event_source,
        highest_session_elapsed_ms,
    };
}

/**
 * Modulus that folds any event_seq into the int4 range required by the
 * user_media_events.event_seq column. The /j Jellyfin-compat routes send
 * Date.now() (~1.75e12, which overflows int4); native playback sends small
 * per-session counters. Modulo keeps the value monotonic within any single
 * session (wrap period ~23 days >> a playback session).
 */
const EVENT_SEQ_MODULUS = 2_000_000_000; // < int4 max (2_147_483_647)

/**
 * Stale-tab guard for 'lumastra-player' 'progress' events. Returns
 * true when the incoming event should be accepted.
 *
 * Accept rules (any one suffices):
 *   - there's no prior session for this (user, media);
 *   - it's the same session and the incoming seq is strictly higher;
 *   - it's a different session AND the new session started later
 *     than the tracked session.
 *
 * Everything else is a stale heartbeat — silently ignore so the
 * active tab isn't clobbered. This is exported for unit testing.
 *
 * PRECONDITION — this is a LIVE-SESSION guard, not a general ordering
 * rule. It decides admission by session identity, while
 * `computeStateFromEvents` decides the outcome by `occurred_at`. Two
 * ordering authorities over the same data only stay consistent because
 * every live heartbeat stamps `occurred_at = now()`, so time alone
 * cannot distinguish a dead tab from the active one — session identity
 * is the only signal that can.
 *
 * A back-dated event breaks that assumption in both directions, so it
 * must NOT reach this guard:
 *   - it carries a real (older) `session_started_at`, so the
 *     different-session rule below would reject it as "stale" even
 *     though it is legitimate new history;
 *   - and once written under 'lumastra-player' it becomes a candidate
 *     for `getLatestLumastraSessionInfo`, where a newer `occurred_at`
 *     would make it the tracked session and reject a genuinely live
 *     tab's remaining heartbeats.
 *
 * Back-dated ingestion therefore belongs under its own `EventSource`
 * (as every provider sync already does), which this guard's caller
 * filters on — not under 'lumastra-player' with an opt-out flag.
 */
export type LumastraProgressVerdict =
    /** Admit the event: it is the live session's next heartbeat. */
    | 'accept'
    /** A DIFFERENT, newer session owns this (user, media) — this one lost. */
    | 'superseded'
    /**
     * Same session, but the seq is not ahead: a duplicate or out-of-order
     * heartbeat. The session is still the live one and MUST NOT be told it
     * was superseded — see `EventAppendOutcome`.
     */
    | 'stale_seq';

/** A Date keeps its milliseconds; `String(date)` would round them away. */
function toEpochMs(value: string | Date): number {
    return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * The verdict behind `shouldAcceptLumastraProgressEvent`. Split out because
 * "rejected" has two causes that call for opposite client behaviour, and
 * collapsing them into one boolean is what let a duplicate heartbeat present
 * as a supersede. See `EventAppendOutcome`.
 */
export function classifyLumastraProgressEvent(
    current: LumastraSessionInfo | null,
    incoming: {
        session_id: string | null;
        event_seq: number | null;
        session_started_at: string | Date | null;
    },
): LumastraProgressVerdict {
    // No prior state — accept unconditionally.
    if (!current || !current.session_id) return 'accept';

    // Missing identifiers on the incoming event — accept rather than
    // lose data; callers that want strict rejection should validate
    // upstream.
    if (!incoming.session_id) return 'accept';

    if (incoming.session_id === current.session_id) {
        const curSeq = current.event_seq;
        const incSeq = incoming.event_seq;
        // Missing seq on either side: preserve the simple sentinel comparison.
        if (curSeq == null || incSeq == null) {
            return (incSeq ?? -1) > (curSeq ?? -1) ? 'accept' : 'stale_seq';
        }
        // Wrap-aware comparison. event_seq is folded into [0, EVENT_SEQ_MODULUS)
        // at ingestion (normalizeEventSeq), and the /j routes derive it from
        // Date.now(); when that fold wraps (value snaps from ~modulus to ~0), a
        // plain `incSeq > curSeq` would read the wrap as a huge backward jump and
        // wedge the session. Treat a small forward distance (< half the modulus)
        // as "ahead" (accept); a large one is a genuinely stale/duplicate
        // heartbeat (reject). Equal seq → forward distance 0 → reject (unchanged).
        const forwardDistance =
            (((incSeq - curSeq) % EVENT_SEQ_MODULUS) + EVENT_SEQ_MODULUS) % EVENT_SEQ_MODULUS;
        return forwardDistance > 0 && forwardDistance < EVENT_SEQ_MODULUS / 2
            ? 'accept'
            : 'stale_seq';
    }

    // Different session: newer session start wins. If we can't
    // compare (missing timestamps) fall back to accepting — a caller
    // that knows the session really is stale should have filtered
    // before this point.
    if (!incoming.session_started_at || !current.session_started_at) {
        return 'accept';
    }
    const currentStartedAt = toEpochMs(current.session_started_at);
    const incomingStartedAt = toEpochMs(incoming.session_started_at);
    if (Number.isNaN(currentStartedAt) || Number.isNaN(incomingStartedAt)) {
        return 'accept';
    }
    return currentStartedAt < incomingStartedAt ? 'accept' : 'superseded';
}

/**
 * Boolean form of `classifyLumastraProgressEvent`, kept for callers (and
 * tests) that only need admit/reject.
 */
export function shouldAcceptLumastraProgressEvent(
    current: LumastraSessionInfo | null,
    incoming: {
        session_id: string | null;
        event_seq: number | null;
        session_started_at: string | Date | null;
    },
): boolean {
    return classifyLumastraProgressEvent(current, incoming) === 'accept';
}

// =============================================================================
// Service entry points
// =============================================================================

/**
 * Rebuild the materialized state row for one (user, media) from the
 * live event log. Safe to call repeatedly — it's a pure function of
 * the events plus a single UPSERT/DELETE.
 *
 * Reads via `getEventsSinceLastSnapshot` to bound cost: when a live
 * snapshot exists, only the snapshot + events newer than it are
 * returned. The compute function uses the snapshot as the base case.
 *
 * Corrupt-snapshot fallback: a single corrupt snapshot in the scoped
 * window can cause `computeStateFromEvents` to return null even
 * though events exist. Naively deleting the state row in that case
 * would wipe legitimate user history. We detect this (non-empty
 * input but null result) and re-run the compute over the FULL event
 * history; only when even that returns null do we delete. The full-
 * history path is more expensive but only fires when the scoped
 * window is degenerate, which should be vanishingly rare.
 */
export async function rebuildStateFromEvents(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string },
    // H18: callers rebuilding many media at once (rebuildAllStatesForUser) can
    // batch-fetch all events in one round-trip and pass this media's slice here,
    // skipping the per-media read. Semantics are identical — the batch query uses
    // the same per-media snapshot boundary + ordering as getEventsSinceLastSnapshot.
    prefetchedEvents?: UserMediaEvent[],
    /**
     * Optional sink describing WHICH event each arbitrated field came from —
     * see {@link StateProvenance}. Reflects the compute whose result was
     * actually persisted, including the corrupt-snapshot fallback below.
     * Left untouched when the state row is deleted (nothing was arbitrated).
     */
    provenance?: StateProvenance,
): Promise<ComputedState | null> {
    const events = prefetchedEvents ?? (await getEventsSinceLastSnapshot.all(sql, params));
    let computed = computeStateFromEvents(events, provenance);

    if (!computed && events.length > 0) {
        logger.error(
            'Scoped rebuild returned null with non-empty input — likely corrupt snapshot. Falling back to full history.',
            undefined,
            {
                userId: params.userId,
                mediaId: params.mediaId,
                eventCount: events.length,
            },
        );
        // Fallback: re-compute from full history MINUS snapshot events.
        // We include them otherwise the same corrupt payload would cause
        // computeStateFromEvents to return null again (and the caller
        // would delete the state row, wiping legitimate user history).
        // The full event log is enough on its own — snapshots are an
        // optimisation, not a source of truth.
        const full = await getEventsForMedia.all(sql, params);
        const fullWithoutSnapshots = full.filter((e) => e.event_type !== 'state_snapshot');
        // Re-runs against the same sink, so the provenance reported is the
        // one belonging to the compute that actually gets persisted.
        computed = computeStateFromEvents(fullWithoutSnapshots, provenance);
    }

    if (!computed) {
        await deleteState(sql, params);
        return null;
    }

    // is_watched_source lives only in the snapshot payload, never on
    // the materialised state row — strip it before upsert so the
    // table schema stays narrow.
    const {
        is_watched_source: _verdictSource,
        jellyfin_unwatch_acknowledged_at: _acknowledgement,
        ...stateRow
    } = computed;
    void _verdictSource;
    void _acknowledgement;
    const row: UserMediaStateUpsert = {
        user_id: params.userId,
        media_id: params.mediaId,
        ...stateRow,
    };
    await upsertState.execute(sql, { state: row });

    if (IS_DEV) {
        const verifyEvents = await getEventsSinceLastSnapshot.all(sql, params);
        const verifyComputed = computeStateFromEvents(verifyEvents);
        const verifyStored = await getState.one(sql, {
            userId: params.userId,
            mediaId: params.mediaId,
        });
        if (verifyComputed && verifyStored) {
            if (
                verifyComputed.is_watched !== verifyStored.is_watched ||
                verifyComputed.resume_position_ms !== verifyStored.resume_position_ms ||
                verifyComputed.watch_count !== verifyStored.watch_count
            ) {
                logger.error('State parity drift detected after rebuild', undefined, {
                    userId: params.userId,
                    mediaId: params.mediaId,
                    computed: verifyComputed,
                    stored: verifyStored,
                });
            }
        }
    }

    return computed;
}

/**
 * Compaction hook. Reads the just-rebuilt materialized state, counts
 * the live non-snapshot events newer than the latest snapshot, and
 * writes a fresh `'state_snapshot'` event when the count crosses
 * `COMPACTION_THRESHOLD`.
 *
 * The snapshot's payload is the materialized state itself — the same
 * row the rebuilder just upserted — so we don't recompute. The
 * snapshot's `occurred_at` is "now" rather than the latest event's
 * timestamp; this is intentional: the snapshot represents "everything
 * up to and including this moment", and using NOW() avoids a race
 * where a later-arriving event with an earlier occurred_at (e.g. a
 * Jellyfin backfill of historical sessions) ends up before the
 * snapshot in the visible window.
 *
 * Best-effort: failures are logged and swallowed. The caller's write
 * succeeded and a missed compaction just means the next tick will
 * try again.
 */
async function maybeWriteSnapshot(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string },
    computed: ComputedState,
): Promise<void> {
    try {
        const countRow = await countEventsSinceLastSnapshot.one(sql, params);
        const count = countRow?.count ?? 0;
        if (count < COMPACTION_THRESHOLD) return;

        // Use the just-computed state directly — `computed` carries
        // is_watched_source, which the materialised state row doesn't
        // store. Reading from getState would lose that field.
        const snapshotState: SnapshotState = {
            is_watched: computed.is_watched,
            is_watched_source: computed.is_watched_source,
            jellyfin_unwatch_acknowledged_at: computed.jellyfin_unwatch_acknowledged_at,
            resume_position_ms: computed.resume_position_ms,
            runtime_ms: computed.runtime_ms,
            watch_count: computed.watch_count,
            first_watched_at: computed.first_watched_at,
            last_watched_at: computed.last_watched_at,
            last_event_at: computed.last_event_at,
            last_event_source: computed.last_event_source,
            highest_session_elapsed_ms: computed.highest_session_elapsed_ms,
        };

        await insertEvent.execute(sql, {
            event: {
                user_id: params.userId,
                media_id: params.mediaId,
                event_type: 'state_snapshot',
                source: 'compaction',
                position_ms: null,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
                snapshot_state: snapshotState,
            },
        });

        logger.debug('Compacted event log via state_snapshot', {
            userId: params.userId,
            mediaId: params.mediaId,
            tailEventCount: count,
        });
    } catch (err) {
        // Compaction is best-effort. The user-facing write already
        // succeeded; logging here surfaces persistent failures
        // without breaking ingestion.
        logger.warn('Compaction snapshot write failed', {
            userId: params.userId,
            mediaId: params.mediaId,
            error: (err as Error).message,
        });
    }
}

/**
 * Auto-clear Continue-Watching dismissal when the user re-engages with
 * hidden media — "I started watching this again" is a strong "put it
 * back in my row" signal, without which a hidden series would stay
 * hidden forever.
 *
 * Admitted sources: `lumastra-player`, `lumastra-user-mark` — both are
 * direct results of an interactive action in this app. Excluded:
 * `migration` (bulk import is not engagement), `compaction` (internal
 * snapshot rewrites), `plex-sync` (stub today; revisit when
 * implemented), and `jellyfin-sync`.
 *
 * `jellyfin-sync` is deliberately excluded even though it can carry
 * genuine watch progress: `watch-sync-pull` polls Jellyfin's resume
 * list every 5 minutes with no user present, and small position drift
 * (a re-scrub, another client nudging Jellyfin's own resume state,
 * jitter across poll cycles) is enough to pass jellyfin-sync's
 * POSITION_DIFF_TOLERANCE_MS gate and read as "engagement" even when
 * the user hasn't touched anything. That silently resurrected items
 * users had just hidden (reported 2026-07-13). Jellyfin sync still
 * updates progress/watched state normally — it just can't undo a
 * dismissal on its own; only playing it in Lumastra or explicitly
 * un-hiding it (`DELETE /api/continue-watching/dismissals`) can.
 *
 * `removeFlagIfOlderThan` also rejects when `event.occurred_at <
 * flag.created_at`, so a backfill pull catching up with PRE-hide
 * activity can't undo a deliberate dismiss.
 *
 * Best-effort: a failure here must not break the write path. Worst
 * case the user re-hides the series.
 */
async function maybeClearDismissalOnEngagement(
    sql: postgres.Sql,
    event: NewUserMediaEvent,
): Promise<void> {
    const isUserEngagement =
        (event.event_type === 'progress' ||
            event.event_type === 'mark_watched' ||
            event.event_type === 'completed') &&
        (event.source === 'lumastra-player' || event.source === 'lumastra-user-mark');

    if (!isUserEngagement) return;

    try {
        // Cheap perf gate: skip the resolveDismissalTarget + delete
        // round-trips entirely when this user has no dismissed_cw flags
        // at all. A 10k-event Jellyfin sync would otherwise issue 20k
        // pointless queries for the common case of a user with zero
        // dismissals.
        const hasAny = await userHasAnyFlag(sql, {
            userId: event.user_id,
            flagType: 'dismissed_cw',
        });
        if (!hasAny) return;

        const target = await resolveDismissalTarget(sql, event.media_id);
        if (!target) return;

        await removeFlagIfOlderThan(sql, {
            userId: event.user_id,
            targetId: target.id,
            flagType: 'dismissed_cw',
            createdBefore: event.occurred_at,
        });
    } catch (err) {
        logger.warn('Auto-clear dismissal failed', {
            userId: event.user_id,
            mediaId: event.media_id,
            error: (err as Error).message,
        });
    }
}

/**
 * Coerce an event_seq into [0, EVENT_SEQ_MODULUS) so it fits the int4 column.
 * Non-negative-safe (defensive; Date.now() is always positive).
 */
export function normalizeEventSeq(seq: number): number {
    return ((seq % EVENT_SEQ_MODULUS) + EVENT_SEQ_MODULUS) % EVENT_SEQ_MODULUS;
}

/**
 * Insert an event and rebuild state in one go. This is the canonical
 * write path for new events — direct use of `insertEvent` leaves
 * `user_media_state` stale and should be avoided outside of the
 * migration backfill.
 *
 * Lumastra-player progress events go through
 * `shouldAcceptLumastraProgressEvent` first; rejected events return
 * silently (no throw, no state change).
 *
 * Caller responsibility: wrap in a transaction if the rest of the
 * request depends on atomicity. The helper uses `sql` as-is so the
 * txn boundary is whatever the caller passes.
 */
export type EventAppendOutcome =
    /** Inserted, and the materialized state was rebuilt. */
    | 'accepted'
    /** Rejected: a DIFFERENT, newer session owns this (user, media). */
    | 'superseded'
    /** Rejected: same session, seq not ahead (duplicate / out-of-order). */
    | 'stale_seq'
    /** Insert collapsed on the idempotency unique index (replayed batch). */
    | 'duplicate';

/**
 * `appendEventAndRebuild`, but reporting WHY a write did not land.
 *
 * The boolean wrapper below cannot distinguish "a newer session took over"
 * from "this session sent the same heartbeat twice", and
 * `play-session-lifecycle.service.ts` used to map every falsy result onto
 * `action: 'superseded'` — a signal clients treat as terminal. A retried or
 * reordered heartbeat therefore presented to the player as a supersede and
 * stopped playback on a session that was still the live one. Callers that
 * surface anything to a client MUST branch on this outcome, not on the
 * boolean.
 */
export async function appendEventAndRebuildWithOutcome(
    sql: postgres.Sql,
    rawEvent: NewUserMediaEvent,
): Promise<EventAppendOutcome> {
    // Coerce event_seq into the int4 range user_media_events.event_seq requires
    // (see normalizeEventSeq). Done once here so the stale-tab ordering gate and
    // the insert below use the identical clamped value.
    const event: NewUserMediaEvent =
        rawEvent.event_seq == null
            ? rawEvent
            : { ...rawEvent, event_seq: normalizeEventSeq(rawEvent.event_seq) };

    // Stale-tab guard: only for lumastra-player progress events, the
    // only source that runs inside a volatile browser tab. Returns
    // false when the event is rejected so callers can skip any
    // dependent follow-up writes (e.g. a derived 'completed' event
    // after a 'progress' that's been rejected as stale).
    if (event.source === 'lumastra-player' && event.event_type === 'progress') {
        const current = await getLatestLumastraSessionInfo.one(sql, {
            userId: event.user_id,
            mediaId: event.media_id,
        });
        const verdict = classifyLumastraProgressEvent(current, {
            session_id: event.session_id,
            event_seq: event.event_seq,
            session_started_at: event.session_started_at ?? event.occurred_at,
        });
        if (verdict !== 'accept') {
            logger.debug('Rejected stale lumastra-player progress event', {
                userId: event.user_id,
                mediaId: event.media_id,
                verdict,
                incomingSessionId: event.session_id,
                incomingSeq: event.event_seq,
                currentSessionId: current?.session_id ?? null,
                currentSeq: current?.event_seq ?? null,
            });
            return verdict;
        }
    }

    const inserted = await insertEvent.execute(sql, { event });
    // ON CONFLICT DO NOTHING returns zero rows for an idempotent replay. Report
    // that to the caller so a batch ingest can answer "duplicate" — and so a
    // replayed record does not re-emit its derived completion.
    //
    // Folding "duplicate" in with the rejections is deliberate for the gating
    // callers do off this value — skipping the derived completion on a replay
    // is exactly right, and it is what keeps watch_count from inflating. It is
    // reported as its own outcome so a caller answering a live client can tell
    // a replay apart from a genuine supersede.
    if (inserted.length === 0) return 'duplicate';

    const computed = await rebuildStateFromEvents(sql, {
        userId: event.user_id,
        mediaId: event.media_id,
    });

    // Inline compaction: if enough non-snapshot events have piled up
    // since the last snapshot, write a fresh snapshot so future
    // rebuilds stay bounded. Best-effort — a snapshot-write failure
    // must NOT fail the user-facing append. Worst case we try again
    // next tick. Skipped when the rebuild deleted the state row
    // (computed === null) — there's nothing to snapshot.
    if (computed) {
        await maybeWriteSnapshot(sql, { userId: event.user_id, mediaId: event.media_id }, computed);
    }

    await maybeClearDismissalOnEngagement(sql, event);

    return 'accepted';
}

/**
 * Boolean form of `appendEventAndRebuildWithOutcome` — true only when the
 * event was written and state rebuilt. Callers that report to a live client
 * want the outcome form instead.
 */
export async function appendEventAndRebuild(
    sql: postgres.Sql,
    rawEvent: NewUserMediaEvent,
): Promise<boolean> {
    return (await appendEventAndRebuildWithOutcome(sql, rawEvent)) === 'accepted';
}

/**
 * Rebuild every materialized row for a user. Used by:
 *   - migration backfill after bulk-inserting historical events;
 *   - the admin repudiation tool after walking back a bad sync.
 *
 * Streams distinct (media_id) values from `user_media_events` plus
 * any orphaned `user_media_state` rows (so rows that lost all their
 * events via repudiation are cleaned up too).
 *
 * Returns the number of rows processed — useful for progress
 * reporting and assertion in tests.
 */
export async function rebuildAllStatesForUser(
    sql: postgres.Sql,
    userId: UserId,
    onProgress?: (done: number, total: number) => void,
): Promise<number> {
    // Union of "media with live events" and "media that already has
    // a state row" so repudiation cleanup doesn't leave orphans.
    const rows = await sql<{ media_id: string }[]>`
        SELECT DISTINCT media_id FROM (
            SELECT media_id FROM user_media_events
                WHERE user_id = ${userId} AND repudiated_at IS NULL
            UNION
            SELECT media_id FROM user_media_state
                WHERE user_id = ${userId}
        ) AS combined
    `;

    const total = rows.length;
    const mediaIds = rows.map((r) => r.media_id);

    // H18: batch-fetch every media's events-since-snapshot in ONE round-trip
    // (was one read per media → N+1 down to 1 read), then group by media_id.
    // Writes + state computation + the corrupt-snapshot fallback stay per-media
    // in rebuildStateFromEvents, so behaviour is unchanged. Runs inside the
    // caller's transaction, so this is sequential single statements (no parallel
    // queries on one connection).
    const allEvents = await getEventsSinceLastSnapshotForUser(sql, userId, mediaIds);
    const eventsByMedia = new Map<string, UserMediaEvent[]>();
    for (const ev of allEvents) {
        const bucket = eventsByMedia.get(ev.media_id);
        if (bucket) bucket.push(ev);
        else eventsByMedia.set(ev.media_id, [ev]);
    }

    let done = 0;
    for (const row of rows) {
        await rebuildStateFromEvents(
            sql,
            { userId, mediaId: row.media_id },
            eventsByMedia.get(row.media_id) ?? [],
        );
        done += 1;
        if (onProgress) onProgress(done, total);
    }
    return done;
}
