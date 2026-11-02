// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side memo for `POST /playback/previews` responses.
 *
 * Every homepage preview mount (a hero slide, a poster-hover popup) POSTs
 * `POST /playback/previews` and the server mints a fresh `playSessionId` that is
 * embedded in the returned `streamUrl` and propagated into every HLS
 * segment URL. Those segments are served `max-age=31536000, immutable`, so
 * they are maximally cacheable -- but a changing query string means the
 * browser cache never hits and identical bytes get re-downloaded on every
 * revisit. This module memoizes the session response per logical request so
 * a remount reuses the same `streamUrl`, and therefore byte-identical
 * segment URLs, whenever possible.
 *
 * This module is intentionally free of Svelte runes, `fetch`, and any DOM
 * dependency: `create` (how to mint a session) and `onDelete` (how to tear
 * one down, e.g. DELETE it server-side) are injected by the caller. That is
 * what makes it unit-testable with fake timers and no DOM.
 *
 * IMPORTANT: a memo hit does NOT imply a live server-side session. The
 * player stops heartbeating a session as soon as it stops using it
 * (`MediaPreviewPlayer.onDestroy` calls `stopHeartbeat()`), and the server
 * sweeps any session 30 seconds after its last heartbeat
 * (`PREVIEW_HEARTBEAT_TIMEOUT_MS`, `preview-session.service.ts:214`) --
 * separately from, and well before, its 5-minute absolute TTL. A retained
 * (unheartbeated) entry can therefore be dead server-side well inside this
 * module's own retention window; see `RETENTION_WINDOW_MS` below for how
 * that shapes the window's length. Recovery from a dead memo hit is NOT
 * this module's job -- it happens one layer up, where a dead `streamUrl`
 * 410s, hls.js goes fatal, and the caller invalidates the handle and
 * re-acquires. Do not add any logic here that assumes a cached entry is
 * still valid server-side.
 *
 * ## Why the epoch guard exists
 *
 * A single key can be held by more than one concurrent caller -- e.g. two
 * hover cards for the same item in different rows produce an IDENTICAL key
 * (the hover path passes no `heroSafeCodec`, so both normalize to
 * `false`). `invalidatePreviewSession()` can fire (from the self-heal path
 * described above) while a second holder still has the entry acquired. A
 * retention-evicted or fully-drained-and-invalidated entry is removed
 * outright, and a *new* entry may later occupy the same key. Every handle
 * remembers the epoch of the entry it was handed at acquire time, and
 * `release`/`invalidate` both no-op when `handle.epoch !== entry.epoch`.
 * Without this guard, a holder's later `release` (after its entry was
 * replaced) would silently operate on the replacement entry -- decrementing
 * a refcount, or even deleting, a session it was never handed.
 *
 * The epoch guard alone does NOT protect a *sibling* holder of the SAME
 * still-live entry, though -- invalidate is being asked to act on exactly
 * the entry that holder shares, so the epoch matches. That is a separate
 * problem `invalidatePreviewSession` solves itself: see its own comment
 * for why it must not delete (and must not fire `onDelete` for) an entry
 * that still has other holders.
 *
 * ## Why retention is ready-only, and time-boxed
 *
 * Holding a session alive holds a server-side refcount on its transcoded
 * artifact; artifact eviction only frees entries at refcount zero. A
 * session that never reached "ready" may still be warming (its FFmpeg job
 * may not have produced anything playable yet), so retaining it would pin
 * disk for content nobody has actually watched -- it is deleted immediately
 * on last release instead.
 *
 * A *ready* session is retained, but only for a bounded window
 * (`RETENTION_WINDOW_MS`), and at most `RETAINED_MAX` (2) at a time. That
 * window is NOT sized against the server's 5-minute absolute TTL -- it is
 * sized against the 30-second no-heartbeat sweep described above, because
 * the player stops heartbeating the moment it stops using a session, and a
 * retained entry is, by definition, not in use. We deliberately do NOT
 * keep heartbeating a retained session to buy a longer window: that would
 * mean a timer that outlives its component and keeps issuing network
 * requests for a session nobody is watching, purely to keep an artifact
 * warm on the off chance of reuse -- and since a retained session already
 * pins a server-side disk refcount, a shorter window is also a smaller
 * disk cost, not just a smaller network cost. See `RETENTION_WINDOW_MS`
 * for the exact margin and the coverage this buys (and does not buy).
 * Re-acquiring within the window cancels the pending delete and hands back
 * the same session.
 */

import type { ReportingBlock } from '$lib/schemas/play-reporting.js';

export interface PreviewSessionKeyInput {
    internalId: string;
    startPositionSeconds: number;
    fileId?: string;
    isLiveTv: boolean;
    heroSafeCodec?: boolean;
    trailerPreferred: boolean;
    trailerRequired: boolean;
}

export interface PreviewSessionValue {
    playSessionId: string;
    sessionItemId: string;
    streamUrl: string;
    deliveryKind: 'file' | 'hls';
    hlsStartPosition: number;
    reporting?: ReportingBlock;
}

export interface PreviewSessionHandle {
    key: string;
    epoch: number;
    value: PreviewSessionValue;
}

interface Entry {
    value: PreviewSessionValue;
    refCount: number;
    epoch: number;
    ready: boolean;
    /** Set when refCount drops to 0 for a ready entry; cleared on re-acquire. */
    releasedAt: number | null;
    onDelete?: (value: PreviewSessionValue) => void;
    retentionTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Set by invalidatePreviewSession when it is called while other
     * holders remain. A future acquire for this key must not reuse an
     * invalidated entry (it is known dead server-side); instead it falls
     * through to create() and replaces this entry's slot in `entries`.
     * The entry itself is left alone otherwise -- still reachable via
     * its key for any remaining holder's own release -- so refCount
     * keeps draining normally. Once it does reach zero, the
     * refCount-transition in releasePreviewSession deletes it
     * immediately rather than retaining it, since it is known dead.
     */
    invalidated: boolean;
}

/**
 * Why 2, specifically: the hero carousel mounts the ACTIVE slide AND its
 * NEXT neighbour simultaneously (pre-warming), so every rotation retires
 * exactly one player while the carousel is still holding another retained
 * entry. With a cap of 1 that second retained entry evicts the first
 * before the user ever rotates back to it -- a guaranteed no-op for the
 * exact case this cache was built for:
 *
 *   A active (slots A, B). Rotate to B (slots B, C): A's player unmounts,
 *   A is retained. Rotate back to A (slots A, B): C's player unmounts, C
 *   is retained -- and under a cap of 1 that evicts A. A mounts, memo
 *   misses, fresh POST. Exactly the reload this cache exists to prevent.
 *
 * A retained session pins a server-side disk refcount on its transcoded
 * artifact, so this cap is a real resource cost, not a free knob -- but 2
 * retained entries at the current 20s RETENTION_WINDOW_MS is 40
 * entry-seconds of pin time, cheaper than the 90s-window design this
 * replaced would have cost even at a cap of 1 (90 entry-seconds), let
 * alone the 180 entry-seconds two entries at 90s would have cost. 4.5x
 * less pin time than that earlier two-entries-at-90s shape.
 *
 * Known bound: `retainedOrder` is a single global list shared across every
 * surface, not one list per surface -- hero keys carry `heroSafeCodec: true`
 * and hover keys `false`, so a hero entry and a hover entry never collide on
 * the same cache key, but they DO compete for the same two retention slots.
 * Concretely: watching hero slide A, rotating to B (A retained), hovering a
 * poster card and leaving (that hover entry retained too -- now both slots
 * are full), then rotating the hero again evicts A to make room. The
 * carousel-only accounting above (2 retained entries = 1 rotation of
 * headroom) can therefore come up short if the user hovered a card in
 * between, and the exact no-op this cap was raised to prevent can
 * re-appear in that interleaved case. This is a known limitation of a
 * single shared cap, not a defect -- a per-surface cap would need its own
 * accounting and was not judged worth the extra retained (and
 * disk-pinning) entries.
 */
const RETAINED_MAX = 2;

/**
 * How long a ready entry is kept around after its last release, in case the
 * same key is re-acquired (e.g. the user navigates back to a hero slide).
 *
 * Bounded by the server's 30-second no-heartbeat sweep
 * (`PREVIEW_HEARTBEAT_TIMEOUT_MS`, `preview-session.service.ts:214`), NOT
 * by the 5-minute absolute session TTL -- see the module doc comment for
 * why. 20s sits 10s under that 30s sweep, leaving margin for the sweeper's
 * own polling interval and clock skew between client and server. Do not
 * raise this closer to 30s: a retained entry that survives past its
 * server-side session death just re-teaches the 410-fatal-invalidate path
 * a lesson it already has to know, for no benefit.
 *
 * Accepted limitation, stated plainly rather than left to be discovered as
 * a bug report: a full autoplay carousel loop back to the same slide
 * (roughly 50s for a five-slide hero) exceeds this window and lands cold
 * -- `create()` runs again rather than reusing the retained entry. This
 * window exists for manual A -> B -> A navigation and hover round-trips,
 * both well under 20s; it does not, and is not meant to, cover a full
 * autoplay loop.
 */
const RETENTION_WINDOW_MS = 20_000;

let nextEpoch = 1;
const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<PreviewSessionValue>>();
/** Keys of retained (refCount 0, ready) entries, oldest release first. */
const retainedOrder: string[] = [];

/**
 * Handles are inert `{key, epoch, value}` objects -- nothing marks one as
 * "already used" on its own. Two holders sharing a key (e.g. a hero slot
 * and a hover popup) each get a distinct handle object with a fresh
 * `refCount` decrement in mind, but a single handle can easily be released
 * more than once by its own owner (an effect cleanup *and* an explicit
 * stop is a very reachable shape). The entry-level `refCount <= 0` guard in
 * `releasePreviewSession` only catches a release once the count has
 * already reached zero -- it does NOT stop the SAME handle being counted
 * down twice while the count is still positive, which would decrement past
 * what that handle is entitled to and tear the session down out from under
 * a holder who has not released yet. Tracking release-by-object-identity
 * here closes that gap: every handle can only ever count down once.
 */
const releasedHandles = new WeakSet<PreviewSessionHandle>();

export function previewSessionKey(input: PreviewSessionKeyInput): string {
    // Field order is fixed and every field participates, including
    // trailerRequired *and* trailerPreferred separately: the server
    // computes `trailerProbe = trailerPreferred || trailerRequired` and
    // branches on each independently, so folding them into one boolean
    // would let a required-trailer request reuse a preferred-trailer memo
    // entry.
    //
    return JSON.stringify([
        input.internalId,
        input.startPositionSeconds,
        input.fileId ?? null,
        input.isLiveTv,
        input.heroSafeCodec ?? false,
        input.trailerPreferred,
        input.trailerRequired,
    ]);
}

function removeFromRetainedOrder(key: string): void {
    const idx = retainedOrder.indexOf(key);
    if (idx !== -1) retainedOrder.splice(idx, 1);
}

function deleteEntry(key: string, entry: Entry): void {
    if (entry.retentionTimer !== null) {
        clearTimeout(entry.retentionTimer);
        entry.retentionTimer = null;
    }
    // Guard re-entrancy: deleteEntry may be reached both from the retention
    // timer callback and, in principle, from an invalidate() racing it. The
    // map delete + onDelete call below must happen at most once.
    if (!entries.has(key) || entries.get(key) !== entry) return;
    entries.delete(key);
    removeFromRetainedOrder(key);
    entry.onDelete?.(entry.value);
}

/** Arms/re-arms the retention timer and enforces RETAINED_MAX by evicting
 * the oldest retained entry first. Called only on the refCount 1 -> 0
 * transition for a ready entry. */
function armRetention(key: string, entry: Entry): void {
    entry.releasedAt = Date.now();
    retainedOrder.push(key);
    entry.retentionTimer = setTimeout(() => {
        entry.retentionTimer = null;
        deleteEntry(key, entry);
    }, RETENTION_WINDOW_MS);

    while (retainedOrder.length > RETAINED_MAX) {
        const evictKey = retainedOrder.shift();
        if (evictKey === undefined) break;
        const evictEntry = entries.get(evictKey);
        if (evictEntry) deleteEntry(evictKey, evictEntry);
    }
}

export async function acquirePreviewSession(
    key: string,
    create: () => Promise<PreviewSessionValue>,
    opts?: { onDelete?: (v: PreviewSessionValue) => void },
): Promise<PreviewSessionHandle> {
    const existing = entries.get(key);
    if (existing && !existing.invalidated) {
        if (existing.releasedAt !== null) {
            // Re-acquiring a retained entry cancels its pending delete.
            if (existing.retentionTimer !== null) {
                clearTimeout(existing.retentionTimer);
                existing.retentionTimer = null;
            }
            existing.releasedAt = null;
            removeFromRetainedOrder(key);
        }
        existing.refCount += 1;
        return { key, epoch: existing.epoch, value: existing.value };
    }

    let pending = inFlight.get(key);
    const isCreator = !pending;
    if (!pending) {
        pending = create();
        inFlight.set(key, pending);
    }

    let value: PreviewSessionValue;
    try {
        value = await pending;
    } finally {
        if (isCreator) inFlight.delete(key);
    }

    // A concurrent acquire for the same key may have installed the entry
    // first (both callers share the single-flighted `pending` promise, and
    // resolve in call order) -- reuse it rather than creating a duplicate.
    // An INVALIDATED entry is never reused here either, for the same
    // reason as the `existing` check above: it may still have holders
    // (their own release drains it normally), but it is known dead
    // server-side, so a fresh acquire must not inherit it.
    let entry = entries.get(key);
    if (!entry || entry.invalidated) {
        entry = {
            value,
            refCount: 0,
            epoch: nextEpoch++,
            ready: false,
            releasedAt: null,
            onDelete: opts?.onDelete,
            retentionTimer: null,
            invalidated: false,
        };
        entries.set(key, entry);
    } else if (opts?.onDelete && !entry.onDelete) {
        entry.onDelete = opts.onDelete;
    }

    entry.refCount += 1;
    return { key, epoch: entry.epoch, value: entry.value };
}

export function releasePreviewSession(handle: PreviewSessionHandle): void {
    // A given handle object may only ever count down once, regardless of
    // refCount at the time -- see the releasedHandles doc comment above.
    // This must be checked (and set) before anything else so that every
    // call after the first genuinely no-ops, even the first call turns out
    // to itself be a no-op (unknown key / stale epoch).
    if (releasedHandles.has(handle)) return;
    releasedHandles.add(handle);

    const entry = entries.get(handle.key);
    if (!entry || entry.epoch !== handle.epoch) return;
    // Defense in depth: an entry whose refCount is already 0 (retained,
    // awaiting eviction) must not re-trigger the refCount-reaches-zero
    // transition -- that would re-arm the retention timer on top of an
    // existing one and double-push the retained-order list. In practice
    // the releasedHandles guard above already prevents the same handle
    // from reaching this point twice; this covers any other path that
    // could hand releasePreviewSession an already-zeroed entry.
    if (entry.refCount <= 0) return;

    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    // An invalidated entry is known dead server-side -- never retain it,
    // even if it was marked ready before invalidate() ran.
    if (entry.ready && !entry.invalidated) {
        armRetention(handle.key, entry);
    } else {
        deleteEntry(handle.key, entry);
    }
}

export function invalidatePreviewSession(handle: PreviewSessionHandle): void {
    const entry = entries.get(handle.key);
    if (!entry || entry.epoch !== handle.epoch) return;

    if (entry.refCount > 0) {
        // Other holders may still be using this entry -- e.g. two hover
        // cards for the same item in different rows share an identical
        // key (the hover path passes no heroSafeCodec, so both normalize
        // to false), and one hitting its retry-cap fatal must not kill a
        // session a sibling is still playing happily. The epoch guard
        // above protects `release`; it does nothing here, since this IS
        // the entry the caller is entitled to invalidate -- so this needs
        // its own refCount check.
        //
        // Leave the entry itself alone (still keyed, still draining
        // normally via any remaining holder's own release) so nothing
        // leaks: only mark it so a FUTURE acquire for this key -- which
        // would otherwise hand out a session we now know is dead
        // server-side -- creates a fresh one instead of reusing it. The
        // entry's eventual last release (see releasePreviewSession above)
        // deletes it immediately rather than retaining it, since it is
        // known dead.
        entry.invalidated = true;
        return;
    }

    deleteEntry(handle.key, entry);
}

export function markPreviewSessionReady(handle: PreviewSessionHandle): void {
    const entry = entries.get(handle.key);
    if (!entry || entry.epoch !== handle.epoch) return;
    entry.ready = true;
}

export function __resetPreviewSessionCacheForTests(): void {
    for (const entry of entries.values()) {
        if (entry.retentionTimer !== null) clearTimeout(entry.retentionTimer);
    }
    entries.clear();
    inFlight.clear();
    retainedOrder.length = 0;
    nextEpoch = 1;
}
