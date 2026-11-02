// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * request-dismissal-sync.service.ts — ONE place that keeps the three
 * "I've seen this fulfilled request" surfaces agreeing with each other.
 *
 * ## What this exists to fix
 *
 * `docs/architecture/user-events.md` ("The request popup moves into the inbox")
 * says `read_at` becomes the truth and the `request_dismissed` flag path
 * retires. **That instruction is wrong and is deliberately not followed here.**
 * The flag has a SECOND consumer the doc missed:
 *
 *   - `api/defs/for-you/fulfilled-requests.ts` anti-joins the For-You
 *     "fulfilled requests" rail on `getActiveFlagTargets(flagType:'request_dismissed')`
 *   - `api/defs/for-you/dismiss.ts` writes that flag
 *
 * Retiring the flag would silently empty that anti-join and resurrect every
 * previously-dismissed card in the rail. So the goal is CONSISTENCY, not
 * retirement: a dismissal in any one surface must land in all three.
 *
 * ## The key mapping — the whole hazard in one table
 *
 * `user_media_flags(flag_type='request_dismissed')` is written today in TWO
 * incompatible key shapes, by two different surfaces, and each reader
 * understands only its own:
 *
 * | Shape      | `target_id`                          | `target_type`         | Written by                                     | Read by                                                   |
 * | ---------- | ------------------------------------ | --------------------- | ---------------------------------------------- | --------------------------------------------------------- |
 * | **K-EXT**  | `tmdb:550:movie`, `tmdb:1399:tv`     | `'request'`           | `request-status/dismissals.ts#upsertDismissal` | `getDismissalsForUser()` → the popup's `dismissedMap`     |
 * | **K-UUID** | `media_items.id` (bare UUID)         | `'movie'` / `'series'`| `defs/for-you/dismiss.ts`                      | `fulfilled-requests.ts`'s anti-join (matches internal ids) |
 *
 * K-EXT is `buildExternalIdKey(externalIds, mediaType, { includeUuids:false })`
 * — the provider-priority chain (tmdb → imdb → tvdb → …) with UUIDs
 * deliberately EXCLUDED, because the popup rebuilds its notification ids from
 * Jellyseerr's TMDB-only payload and a UUID key would never match there. Note
 * the media-type spelling in K-EXT is the storage vocabulary `'tv'`, never the
 * public `'series'` — stored rows depend on it.
 *
 * The durable inbox row is keyed by neither: `user_notifications.id`, with the
 * media identity carried in `payload.mediaId`, a **UUID**.
 *
 * **The reconciliation is therefore: canonicalize every dismissal to the PAIR
 * `{ uuid, extKey }` and write BOTH flag rows.** There is no single key that
 * both readers understand, and picking one would break the other reader — the
 * same failure mode as retiring the flag, one level down. Writing both is what
 * makes `payload.mediaId` (UUID-only) and the popup's `dismissedMap`
 * (external-id-only) able to see the same dismissal.
 *
 * ## What cannot round-trip (stated, not silently no-op'd)
 *
 *  - **No local catalog row** (a Jellyseerr request for media not in
 *    `media_items`): no UUID exists, so only K-EXT is written and no inbox row
 *    can be located. `unmapped: 'no-uuid'`. This is benign — the For-You rail
 *    already skips unmatched rows, and there is no inbox row for media the
 *    notifier never saw.
 *  - **No external provider id** (a local-only item with just an internal
 *    UUID): K-EXT is underivable, so the popup's `dismissedMap` can never see
 *    this dismissal. `unmapped: 'no-external-id'`. The inbox row and the
 *    For-You rail are still reconciled.
 *  - **Neither** → `unmapped: 'nothing'`, nothing is written at all.
 *
 * ## Contract
 *
 * Best-effort and non-throwing by construction. A dismissal is a user action
 * that already succeeded by the time this runs; a sync failure must degrade to
 * "one surface is stale until the next dismissal", never to a failed dismiss.
 * Every call site therefore fires this WITHOUT awaiting
 * (`scheduleRequestDismissalSync`) and the function itself resolves a result
 * object rather than rejecting.
 *
 * ## Ordering — why fire-and-forget needs an intent sequence
 *
 * Firing without awaiting is right (the reconcile must never add latency to a
 * dismiss), but it means two OPPOSITE intents for the same `(user, media)` —
 * a dismiss and the un-dismiss a re-request triggers — are two independent
 * async chains racing each other. Each one reads (resolve the key pair) then
 * writes, so their writes can interleave and the surviving DB state is decided
 * by whichever chain happened to finish last, not by what the user asked for
 * last. The visible bug: an item hidden again immediately after a fresh
 * re-request, or visible again immediately after a dismissal, and it stays
 * wrong until something else rewrites those rows.
 *
 * The fix is `runLatestIntentOnly` below — see its doc comment for why a
 * per-key *sequence* (not merely a mutex, and not `pg_advisory_xact_lock`) is
 * what this particular bug needs.
 */

import type postgres from 'postgres';
import { toUserId, isUserId, type UserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import { setFlag, removeFlag } from '$lib/server/database/queries/user-media-flags.queries.js';
import {
    getExternalIdsByMediaId,
    buildExternalIdsObject,
    getMediaItemSummaryById,
    resolveExternalIdToUuid,
} from '$lib/server/database/queries/media-lookup.queries.js';
import { markRequestAvailableReadByMediaId } from '$lib/server/database/queries/user-notifications.queries.js';
import { getExternalIdFor, getPreferredExternalId } from '$lib/utils/external-ids.js';
import { buildRequestDismissalExtKey } from '$lib/shared/request-dismissal-key.js';
import { KIND_REQUEST_AVAILABLE } from '$lib/shared/user-event-kinds.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import type { ExternalIdProvider as QueryableProvider } from '$lib/server/utils/provider-config.js';
import type { ExternalIds } from '$lib/types/api-common.js';

/**
 * The providers the query layer can look up. Kept as a `satisfies`-checked
 * literal set over `QueryableProvider` so that widening THAT union is a
 * compile error here rather than a silently-narrower runtime filter — the
 * failure mode being a provider that resolves fine in theory and is skipped
 * in practice, which is invisible.
 */
const QUERYABLE_PROVIDERS = new Set<QueryableProvider>([
    'internal',
    'tmdb',
    'imdb',
    'tvdb',
    'trakt',
    'mal',
    'jellyfin',
] satisfies QueryableProvider[]);

/** Narrows the wider client-side provider union to what the query layer models. */
function isQueryableProvider(provider: string): provider is QueryableProvider {
    return QUERYABLE_PROVIDERS.has(provider as QueryableProvider);
}

const logger = Logger.for('RequestDismissalSync');

/** Which surface the user actually clicked. Logged, never branched on. */
export type RequestDismissalOrigin = 'inbox' | 'for-you' | 'popup';

/**
 * Whatever identity the calling surface happens to hold. Every field is
 * optional because no surface has all of them:
 *   - the inbox has `mediaId` (+ `mediaType`) and nothing else
 *   - For-You has `mediaId` only (its `targetId` IS the internal UUID)
 *   - the popup has `externalIds` + `mediaType`, usually with no UUID at all
 */
export interface RequestDismissalIdentity {
    /** `media_items.id`. */
    mediaId?: string | null;
    /** Provider ids as the popup carries them. May include `internal`. */
    externalIds?: ExternalIds | null;
    /** Any case/vocabulary: 'movie' | 'tv' | 'series' | 'Series' | …. */
    mediaType?: string | null;
}

export interface RequestDismissalSyncResult {
    /** The K-UUID flag target that was ensured, when derivable. */
    uuidKey: string | null;
    /** The K-EXT flag target that was ensured, when derivable. */
    extKey: string | null;
    /** Inbox rows this call flipped to read. */
    inboxRowsMarkedRead: number;
    /** Set when one (or both) halves of the key pair could not be derived. */
    unmapped: 'no-uuid' | 'no-external-id' | 'nothing' | null;
    /**
     * True when a LATER-requested intent for the same `(user, media)` had
     * already been enqueued, so this one wrote nothing. Not a failure — the
     * writes it would have made are exactly the ones the winner is about to
     * overwrite. See `runLatestIntentOnly`.
     */
    superseded: boolean;
}

const EMPTY_RESULT: RequestDismissalSyncResult = {
    uuidKey: null,
    extKey: null,
    inboxRowsMarkedRead: 0,
    unmapped: 'nothing',
    superseded: false,
};

// ---------------------------------------------------------------------------
// Per-(user, media) intent ordering — see "Ordering" in the module doc.
// ---------------------------------------------------------------------------

/**
 * Monotonic stamp handed out at the moment a surface ASKS for a sync, i.e.
 * before the first `await` in `syncRequestDismissal` / `syncRequestUndismissal`.
 * That is what makes it request order rather than completion order — the whole
 * point of the exercise.
 */
let intentSequence = 0;

/**
 * How long a drained key keeps its high-water mark. The window only has to
 * outlast a single in-flight sync (a handful of DB round trips), so this is
 * generous; it exists because the LOSING intent can be the slow one and must
 * still find the winner's mark when it finally gets here.
 */
const INTENT_KEY_RETENTION_MS = 60_000;

/** Belt-and-braces bound on the retained-marks map. */
const INTENT_KEY_MAX_ENTRIES = 1000;

interface IntentQueue {
    /** Serializes execution: every intent for this key runs behind this. */
    tail: Promise<void>;
    /** Highest seq ever ENQUEUED for this key — the latest-requested intent. */
    highestSeq: number;
    /** Enqueued-but-unfinished intents; a key is only sweepable at zero. */
    pending: number;
    /** Last enqueue time, for the retention sweep. */
    touchedAt: number;
}

const intentQueues = new Map<string, IntentQueue>();

/**
 * The canonical serialization key. The UUID is preferred because it is the one
 * identity every surface can eventually reach (the popup resolves one via
 * `resolveExternalIdToUuid`), so a dismiss from For-You and the un-dismiss from
 * the popup land on the SAME queue. K-EXT is the fallback for media with no
 * catalog row, where there is no UUID to agree on.
 *
 * Residual: if one leg resolves a UUID and the other does not (the catalog row
 * appeared between the two calls), the two use different keys and are not
 * ordered against each other. That window is a single catalog insert wide and
 * self-heals on the next dismiss; closing it would need a key that does not
 * exist yet at the time it is needed.
 */
function intentKey(userId: UserId, uuid: string | null, extKey: string | null): string {
    return `${userId}::${uuid ?? extKey ?? ''}`;
}

/** Drop drained keys whose high-water mark is older than the retention window. */
function sweepIntentQueues(now: number): void {
    for (const [key, queue] of intentQueues) {
        if (queue.pending === 0 && now - queue.touchedAt > INTENT_KEY_RETENTION_MS) {
            intentQueues.delete(key);
        }
    }
    if (intentQueues.size <= INTENT_KEY_MAX_ENTRIES) return;
    // Pathological rate: evict drained keys oldest-first. Map preserves
    // insertion order, and a re-touched key is not re-inserted, so this is
    // approximate — which is fine, an evicted mark only costs us the ordering
    // guarantee for a key nobody has touched in a while.
    for (const [key, queue] of intentQueues) {
        if (intentQueues.size <= INTENT_KEY_MAX_ENTRIES) break;
        if (queue.pending === 0) intentQueues.delete(key);
    }
}

/**
 * Run `run` under the key's queue, but ONLY if no later-requested intent for
 * the same key has been enqueued in the meantime; otherwise resolve
 * `superseded()` without touching the database.
 *
 * ### Why not `pg_advisory_xact_lock`, which the reviewer suggested first
 *
 * An advisory lock buys mutual exclusion, and mutual exclusion alone does not
 * fix this bug. Two opposite intents serialized by a lock still land in
 * whichever order they happen to grab it — the item is just as likely to end
 * up hidden after a re-request, only now without interleaved writes. What is
 * missing is *which intent the user asked for last*, and no lock knows that.
 *
 * It is also a poor fit for this file specifically:
 *   - The repo's own helper, `database/with-advisory-lock.ts`, is a TRY lock
 *     that returns `{ acquired: false }` and runs nothing on contention. Here
 *     the loser is a user action, so dropping it silently is the failure we
 *     are trying to remove, not an acceptable outcome.
 *   - A blocking `pg_advisory_xact_lock` only holds for the life of a
 *     transaction, so the whole sync would have to move inside `sql.begin`
 *     (that helper's file header is explicit that a bare `SELECT` releases the
 *     lock immediately). This service is handed whatever Sql variant the
 *     caller has — including a `ReservedSql`, which has neither `.begin` nor
 *     `.savepoint` at runtime; that is the documented `withTx` hazard, and it
 *     would turn a best-effort reconcile into a throw.
 *
 * ### Why an in-process sequence is enough here, despite multiple pods
 *
 * The multi-pod objection is real and is the reason this is documented rather
 * than waved away: two mutations for one media item CAN land on two pods, and
 * nothing below orders those. What makes it acceptable is the shape of the
 * race. The pair that collides is a dismiss and the re-request that follows it
 * — consecutive actions from ONE client session, milliseconds apart, and each
 * surface's own authoritative row is written SYNCHRONOUSLY by the caller
 * before this reconcile is ever scheduled. So the cross-pod residual is
 * confined to the mirrored row, needs the two requests to be balanced onto
 * different pods inside a sub-second window, and is repaired by the next
 * dismiss or re-request. Buying the remaining sliver would mean a Valkey lease
 * or a version column on `user_media_flags` — a schema change and a new
 * failure mode, for an install measured in tens of users.
 */
async function runLatestIntentOnly<T>(
    key: string,
    seq: number,
    run: () => Promise<T>,
    superseded: () => T,
): Promise<T> {
    const now = Date.now();
    sweepIntentQueues(now);

    const existing = intentQueues.get(key);
    // `const` so the closure below reads a definitely-assigned handle rather
    // than a `let` TypeScript has to widen back to `| undefined`.
    const queue: IntentQueue = existing ?? {
        tail: Promise.resolve(),
        highestSeq: 0,
        pending: 0,
        touchedAt: now,
    };
    if (!existing) intentQueues.set(key, queue);

    // Registered at ENQUEUE time and read at EXECUTION time, so a slow intent
    // that gets here late still sees the mark a faster, later-requested one
    // left behind.
    queue.highestSeq = Math.max(queue.highestSeq, seq);
    queue.pending++;
    queue.touchedAt = now;

    const settled = queue.tail.then(async (): Promise<T> => {
        if (seq < queue.highestSeq) return superseded();
        return run();
    });

    // The chain must never carry a rejection forward: one failed sync must not
    // reject every later intent for the same media.
    queue.tail = settled.then(
        () => undefined,
        () => undefined,
    );

    try {
        return await settled;
    } finally {
        queue.pending--;
    }
}

/**
 * Normalize any media-type spelling to the STORAGE vocabulary used inside
 * K-EXT keys (`'tv'`, never `'series'`) — see the note in `buildDismissalKey`
 * in `request-status/dismissals.ts`. Returns null for anything that is not a
 * requestable kind; a request only ever exists for a movie or a series.
 */
function toStorageRequestType(value: string | null | undefined): 'movie' | 'tv' | null {
    if (!value) return null;
    if (isSeries(value)) return 'tv';
    return value.toLowerCase() === 'movie' ? 'movie' : null;
}

/** K-UUID rows use the dismissal taxonomy, matching `defs/for-you/dismiss.ts`. */
function toFlagTargetType(storageType: 'movie' | 'tv'): 'movie' | 'series' {
    return storageType === 'tv' ? 'series' : 'movie';
}

/**
 * Build the K-EXT composite key EXACTLY as every other surface builds it —
 * by calling the one shared builder rather than a third local copy of the
 * rule. Stored rows carry the storage token `'tv'`; producing `'series'` here
 * would silently yield keys that match nothing.
 */
function buildExtKey(externalIds: ExternalIds, storageType: 'movie' | 'tv'): string | null {
    return buildRequestDismissalExtKey(externalIds, storageType);
}

/** Both halves of the canonical key pair, plus the type they were built with. */
interface DismissalKeyPair {
    uuid: string | null;
    extKey: string | null;
    storageType: 'movie' | 'tv' | null;
}

/**
 * Canonicalize whatever identity a surface holds into the `{ uuid, extKey }`
 * pair. Shared by the dismiss and un-dismiss legs so the two can never disagree
 * about which rows belong to one dismissal.
 */
async function resolveDismissalKeyPair(
    sql: postgres.Sql,
    identity: RequestDismissalIdentity,
): Promise<DismissalKeyPair> {
    // --- 1. The UUID half ------------------------------------------------
    // The internal UUID counts: the popup sometimes carries it even though its
    // own key builder throws it away. Read via the explicit accessor rather
    // than `externalIds.internal` — `getPreferredExternalId` is wrong here,
    // since it deliberately prefers provider ids over the UUID we want.
    let uuid = identity.mediaId ?? getExternalIdFor(identity.externalIds, 'internal') ?? null;

    // --- 2. The media type ------------------------------------------------
    // Prefer what the caller said; fall back to the catalog row, which stores
    // the storage vocabulary already ('movie' / 'tv').
    let storageType = toStorageRequestType(identity.mediaType);
    if (!storageType && uuid) {
        const summary = await getMediaItemSummaryById(sql, uuid);
        storageType = toStorageRequestType(summary?.media_type);
    }

    // --- 3. The external-id half -----------------------------------------
    // From the caller when it has one (popup), else read the catalog's
    // provider rows for the UUID (inbox / For-You).
    let externalIds: ExternalIds | null = identity.externalIds ?? null;
    if (!externalIds && uuid) {
        const records = await getExternalIdsByMediaId(sql, uuid);
        externalIds = records.length > 0 ? buildExternalIdsObject(records) : {};
    }

    const extKey = externalIds && storageType ? buildExtKey(externalIds, storageType) : null;

    // --- 4. Close the loop the other way ----------------------------------
    // A popup-originated dismissal usually has no UUID. Resolve one from the
    // same provider id the K-EXT key was built on, so the For-You rail and the
    // inbox row can be reached at all.
    if (!uuid && externalIds && storageType) {
        const preferred = getPreferredExternalId(externalIds, { includeUuids: false });
        // Two DIFFERENT `ExternalIdProvider` unions exist and they are not
        // interchangeable: the client-side one ($lib/types/api-common) also
        // carries 'anilist' and 'audiobookshelf', which the query layer's
        // ($lib/server/utils/provider-config) does not model.
        //
        // Casting across them would be worse than it looks. `provider` is
        // OPTIONAL on resolveExternalIdToUuid and defaults to the PRIMARY
        // provider when omitted — so smuggling an unmodelled provider through
        // (or dropping it) would look up, say, an Audiobookshelf id under
        // `provider = 'tmdb'` and could resolve to an unrelated row. Skipping
        // is the only correct answer: the caller already treats a missing uuid
        // as `unmapped: 'no-uuid'`, which is exactly what this is.
        if (preferred && isQueryableProvider(preferred.provider)) {
            uuid = await resolveExternalIdToUuid(
                sql,
                preferred.id,
                storageType,
                preferred.provider,
            );
        }
    }

    return { uuid, extKey, storageType };
}

/**
 * Reconcile one dismissal across the inbox row, the popup's flag key and the
 * For-You rail's flag key.
 *
 * Never throws. Awaitable for tests; production call sites use
 * `scheduleRequestDismissalSync`.
 */
export async function syncRequestDismissal(
    sql: postgres.Sql,
    userId: string,
    identity: RequestDismissalIdentity,
    origin: RequestDismissalOrigin,
): Promise<RequestDismissalSyncResult> {
    // Stamped BEFORE the first await so it records when this dismissal was
    // asked for, not when its key lookups happened to finish.
    const seq = ++intentSequence;
    try {
        if (!isUserId(userId)) return EMPTY_RESULT;
        const uid: UserId = toUserId(userId);

        const { uuid, extKey, storageType } = await resolveDismissalKeyPair(sql, identity);

        if (!uuid && !extKey) {
            logger.debug('Dismissal sync had nothing to key on', { origin });
            return EMPTY_RESULT;
        }

        const unmapped: RequestDismissalSyncResult['unmapped'] = !uuid
            ? 'no-uuid'
            : !extKey
              ? 'no-external-id'
              : null;

        if (unmapped) {
            // Say so rather than silently no-op — this is the case the design
            // note above documents, and it should be visible in logs when a
            // user reports "still showing on the TV".
            logger.debug('Dismissal sync could not map both key shapes', {
                origin,
                unmapped,
                uuid,
                extKey,
            });
        }

        return await runLatestIntentOnly<RequestDismissalSyncResult>(
            intentKey(uid, uuid, extKey),
            seq,
            async () => {
                // --- 5. Ensure both flag shapes exist ---------------------
                // `setFlag` is ON CONFLICT DO NOTHING, i.e. "ensure present".
                // That is right for a MIRROR write: the originating surface has
                // already written (and, on the popup path, refreshed) its own
                // row, and a mirror must never move a `created_at` the popup
                // compares `requestedAt` against.
                if (uuid && storageType) {
                    await setFlag.execute(sql, {
                        userId: uid,
                        targetId: uuid,
                        targetType: toFlagTargetType(storageType),
                        flagType: 'request_dismissed',
                    });
                }
                if (extKey) {
                    await setFlag.execute(sql, {
                        userId: uid,
                        targetId: extKey,
                        targetType: 'request',
                        flagType: 'request_dismissed',
                    });
                }

                // --- 6. Retire the durable inbox row ----------------------
                // Only reachable via the UUID: `request.available` payloads
                // carry `mediaId` and no provider id.
                const markedRead = uuid
                    ? await markRequestAvailableReadByMediaId(sql, uid, uuid)
                    : [];

                // --- 7. Drop the rail's cached page -----------------------
                await invalidateFulfilledRequestsCache(uid);

                return {
                    uuidKey: uuid && storageType ? uuid : null,
                    extKey,
                    inboxRowsMarkedRead: markedRead.length,
                    unmapped,
                    superseded: false,
                };
            },
            () => {
                logger.debug('Dismissal sync superseded by a later intent', { origin, uuid });
                return {
                    uuidKey: uuid && storageType ? uuid : null,
                    extKey,
                    inboxRowsMarkedRead: 0,
                    unmapped,
                    superseded: true,
                };
            },
        );
    } catch (error) {
        // Best-effort by contract: the user's dismiss already succeeded.
        logger.warn('Dismissal sync failed; surfaces may disagree until the next dismiss', {
            origin,
            error,
        });
        return EMPTY_RESULT;
    }
}

/**
 * Fire-and-forget wrapper for request handlers.
 *
 * The sync is a reconciliation, not part of the user's action, so it must not
 * add latency to (or ever fail) the dismiss response. `syncRequestDismissal`
 * already swallows its own errors; the `.catch` here is belt-and-braces against
 * a future throw escaping before the try block.
 */
export function scheduleRequestDismissalSync(
    sql: postgres.Sql,
    userId: string,
    identity: RequestDismissalIdentity,
    origin: RequestDismissalOrigin,
): void {
    void syncRequestDismissal(sql, userId, identity, origin).catch((error: unknown) => {
        logger.warn('Dismissal sync rejected unexpectedly', { origin, error });
    });
}

/**
 * The inverse: clear BOTH flag shapes for one item.
 *
 * Required for symmetry, not as a nicety. `deleteDismissal()` (called when the
 * user re-requests media) removes only the K-EXT row, and `defs/for-you/dismiss.ts`'s
 * DELETE removes only the K-UUID row. Once this service starts mirroring writes,
 * a one-sided delete would leave the mirror behind and the item would stay hidden
 * on the other surface forever — the same "dismissed here, still hidden there"
 * bug with the polarity flipped.
 *
 * It deliberately does NOT un-read any inbox row. `read_at` is monotonic and a
 * re-request produces a NEW `request.available` row when the media next becomes
 * playable; resurrecting the old row would show a stale "ready" notification for
 * a download that has not happened yet.
 *
 * Never throws.
 */
export async function syncRequestUndismissal(
    sql: postgres.Sql,
    userId: string,
    identity: RequestDismissalIdentity,
    origin: RequestDismissalOrigin,
): Promise<void> {
    // Same stamp-before-first-await rule as the dismiss leg — the two share one
    // sequence, which is what lets them order against each other.
    const seq = ++intentSequence;
    try {
        if (!isUserId(userId)) return;
        const uid: UserId = toUserId(userId);
        const { uuid, extKey } = await resolveDismissalKeyPair(sql, identity);

        if (!uuid && !extKey) return;

        await runLatestIntentOnly<void>(
            intentKey(uid, uuid, extKey),
            seq,
            async () => {
                if (uuid) {
                    await removeFlag(sql, {
                        userId: uid,
                        targetId: uuid,
                        flagType: 'request_dismissed',
                    });
                }
                if (extKey) {
                    await removeFlag(sql, {
                        userId: uid,
                        targetId: extKey,
                        flagType: 'request_dismissed',
                    });
                }
                await invalidateFulfilledRequestsCache(uid);
            },
            () => {
                logger.debug('Un-dismissal sync superseded by a later intent', { origin, uuid });
            },
        );
    } catch (error) {
        logger.warn('Un-dismissal sync failed; a mirror flag may still hide the item', {
            origin,
            error,
        });
    }
}

/** Fire-and-forget wrapper for {@link syncRequestUndismissal}. */
export function scheduleRequestUndismissalSync(
    sql: postgres.Sql,
    userId: string,
    identity: RequestDismissalIdentity,
    origin: RequestDismissalOrigin,
): void {
    void syncRequestUndismissal(sql, userId, identity, origin).catch((error: unknown) => {
        logger.warn('Un-dismissal sync rejected unexpectedly', { origin, error });
    });
}

/**
 * Adapter for the inbox leg: take a `user_notifications` row that was just
 * marked read or deleted and, if it is a `request.available` row, reconcile the
 * dismissal outward to the flag surfaces.
 *
 * It lives here rather than in the three notification endpoints so the payload
 * shape (`mediaId` / `mediaType`) is read in exactly ONE place — the same
 * reason `deriveViewItem` is the only client-side payload reader. Rows of any
 * other kind (today `library.new_episode`) are ignored: reading a new-episode
 * notification is not a request dismissal and must not write a flag.
 */
export function scheduleDismissalSyncForInboxRow(
    sql: postgres.Sql,
    userId: string,
    row: { kind: string; payload: Record<string, unknown> | null },
): void {
    if (row.kind !== KIND_REQUEST_AVAILABLE) return;
    const payload = row.payload ?? {};
    const mediaId = typeof payload.mediaId === 'string' ? payload.mediaId : null;
    const mediaType = typeof payload.mediaType === 'string' ? payload.mediaType : null;
    if (!mediaId) {
        logger.debug('request.available row carried no mediaId; nothing to reconcile');
        return;
    }
    scheduleRequestDismissalSync(sql, userId, { mediaId, mediaType }, 'inbox');
}

/**
 * Drop the For-You fulfilled-requests cache for this user.
 *
 * The rail's def caches the mapped page BEFORE the anti-join is applied on the
 * next request, so without this a fresh dismissal is invisible until the entry
 * expires. The key is `${locale}:fulfilled-requests:v2:${userId}` and the cache
 * exposes no prefix delete, so every UI locale is deleted explicitly. The
 * legacy un-prefixed key is deleted too, because `defs/for-you/dismiss.ts` has
 * been writing that spelling (and only that spelling) since before the key
 * gained its locale prefix.
 */
async function invalidateFulfilledRequestsCache(userId: UserId): Promise<void> {
    try {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
        const { locales } = await import('$lib/paraglide/runtime.js');
        const cache = cacheManager.for(CACHE_NAMESPACES.fulfilledRequests);
        await Promise.all([
            cache.delete(`fulfilled-requests:${userId}`),
            ...locales.map((locale) => cache.delete(`${locale}:fulfilled-requests:v2:${userId}`)),
        ]);
    } catch {
        // A cache that refuses to forget is a stale rail, not a failed dismiss.
    }
}
