// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device-session liveness for OAuth device-flow access JWTs.
 *
 * An access JWT is stateless and used to stay valid until `exp` (default 1 h,
 * admin-configurable up to 24 h) after its device was logged out or revoked,
 * and the stream tokens the device had minted ran on for 24-72 h. This module
 * closes both:
 *
 *  - {@link checkDeviceSessionLiveness} is consulted by the JWT branch of
 *    `middleware/forward-auth.ts` (the only place an access JWT is verified;
 *    the HLS `?api_key=` form goes through the same branch) for every JWT that
 *    carries a `device_session_id` claim.
 *  - {@link handleDeviceSessionsRevoked} is called (via
 *    `device-session-revocation.ts`) by every path that revokes a device
 *    session. It tombstones the session locally, tells the other replicas
 *    (auth-cache bus + a Valkey marker), and ends the stream tokens minted
 *    under it.
 *
 * ## What "revoked" means
 *
 * A session is live while at least one of its `oauth_refresh_tokens` rows has
 * `revoked_at IS NULL` ({@link isDeviceSessionLiveInDb}). Refresh rotation
 * supersedes the presented row WITHOUT revoking it and inserts an unrevoked
 * successor, so a rotation never makes a session look revoked; only an
 * explicit revocation leaves zero unrevoked rows. Revocation and rotation are
 * serialized per session by an advisory lock, so a revoke cannot miss the
 * successor of a concurrent rotation. A revoked session id is never reused
 * (`findDeviceSessionIdForDevice` only reuses live ones, and
 * `RefreshTokenService.create` refuses a revoked one), so a "revoked" verdict
 * is final and is cached for the marker's lifetime.
 *
 * JWTs without the claim (legacy refresh rows with a NULL device_session_id)
 * are not checked: there is no session to look up.
 *
 * ## Per-request cost
 *
 * Per replica, per session: the DB is read at most once per
 * {@link LIVE_FRESH_MS}, the Valkey marker at most once per
 * {@link MARKER_RECHECK_MS} (bounded by {@link MARKER_READ_TIMEOUT_MS}; after a
 * failure Valkey is skipped for {@link MARKER_UNAVAILABLE_MEMO_MS}), and
 * concurrent checks of one session share one lookup.
 *
 * ## Failure modes
 *
 * - Valkey unavailable: the DB decides. A live verdict is re-read from the DB
 *   at most every {@link MARKER_RECHECK_MS}, so with Valkey down every active
 *   device session costs one indexed DB read per ~5 s per replica, and a DB
 *   error in that mode answers 503 (fail closed). Accepted trade-off
 *   (2026-10-07): Valkey outages are short and the read is a primary-key
 *   lookup; trusting the cache instead would let a revoked device keep working.
 * - Auth-cache bus not subscribed (Valkey was down at boot, or the pub/sub
 *   connection dropped — see `cache/auth-cache-bus.ts`): this replica could
 *   miss another replica's revocation event, so the cache is untrusted and
 *   the DB decides exactly as with Valkey down; a clean marker no longer
 *   confirms a live verdict. When the bus resubscribes (or a reconnect is
 *   noticed) every cached live verdict is dropped, since an event published
 *   during the gap is lost. A reconnect that falls between two bus probes is
 *   noticed within `SUBSCRIPTION_PROBE_INTERVAL_MS` (5 s); until then the
 *   marker re-read every {@link MARKER_RECHECK_MS} still catches a revocation
 *   whose marker write succeeded.
 * - DB error: a live verdict younger than {@link STALE_LIVE_MAX_MS} stands in
 *   only if the marker was readable and clean; otherwise the result is
 *   `unknown`, which forward-auth answers with 503 + Retry-After (not 401, so a
 *   client does not treat a DB outage as a sign-out). This is the same
 *   fail-closed posture as `resolveTokenUserAccess` on a cold cache.
 */

import type postgres from 'postgres';
import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';
import {
    isAuthCacheBusSubscribed,
    onAuthCacheBusResync,
    onRemoteDeviceSessionRevoked,
    publishAuthCacheInvalidation,
} from '../cache/auth-cache-bus';
import { getDb } from '../database/connection.js';
import { isDeviceSessionLiveInDb } from '../database/queries/oauth-refresh-tokens.queries.js';
import { Logger } from '../utils/logger';
import { warnRevocationMarkerUnavailable } from './revocation-marker-warning.js';

const logger = Logger.for('OAuth:DeviceSessionLiveness');

/**
 * - `live`: the session may be honoured.
 * - `revoked`: it was logged out / revoked — reject (401).
 * - `unknown`: neither the DB nor a usable cached verdict could decide —
 *   reject as temporarily unavailable (503), never as a credential failure.
 */
export type DeviceSessionLiveness = 'live' | 'revoked' | 'unknown';

/** A "live" verdict is trusted without a DB read for this long. */
export const LIVE_FRESH_MS = 60_000;
/** Within the fresh window the Valkey marker is re-read at most this often. */
export const MARKER_RECHECK_MS = 5_000;
/**
 * How old a DB-confirmed "live" verdict may be and still stand in while the DB
 * errors — and only when the marker was readable and clean.
 */
export const STALE_LIVE_MAX_MS = 2 * LIVE_FRESH_MS;
/** A marker GET slower than this counts as "Valkey unavailable". */
export const MARKER_READ_TIMEOUT_MS = 300;
/** After the marker could not be read, skip Valkey for this long. */
export const MARKER_UNAVAILABLE_MEMO_MS = 5_000;
/** Bound on the revoke-side marker write + stream-token end. */
export const REVOKE_SIDE_EFFECT_TIMEOUT_MS = 1_500;
/**
 * Marker lifetime: the longest access-JWT TTL the admin can configure
 * (86400 s), plus slack. After that every JWT of the session has expired.
 */
const MARKER_TTL_SECONDS = 86_400 + 60;
/** Revocation is final, so a "revoked" verdict lives as long as the marker. */
const TOMBSTONE_TTL_MS = MARKER_TTL_SECONDS * 1000;
const MARKER_KEY_PREFIX = 'device-session-revoked:v1:';

interface Verdict {
    live: boolean;
    /** When the DB last confirmed this verdict. */
    dbCheckedAt: number;
    /** When the verdict was last confirmed by the DB or a clean marker read. */
    confirmedAt: number;
    /** {@link busEpoch} at the time; a live verdict from an older epoch is stale. */
    epoch: number;
}

const verdicts = new LRUCache<Verdict>({
    maxSize: 5_000,
    defaultTTL: STALE_LIVE_MAX_MS,
    namespace: 'device-session-liveness',
});

standaloneCacheRegistry.register({
    name: 'device-session-liveness',
    description: 'Access-JWT device session liveness verdicts (revoked device = rejected JWT)',
    category: 'auth',
    cache: verdicts,
});

const inflight = new Map<string, Promise<DeviceSessionLiveness>>();
let markerUnavailableUntil = 0;

/**
 * Bumped whenever the auth-cache bus comes back after a gap in which a
 * revocation event may have been lost. Live verdicts carry the epoch they were
 * confirmed in; an older one counts as cold (DB re-read). Tombstones stay.
 */
let busEpoch = 0;
onAuthCacheBusResync(() => {
    busEpoch++;
});

function tombstone(ids: readonly string[]): void {
    const now = Date.now();
    for (const id of ids) {
        verdicts.set(
            id,
            { live: false, dbCheckedAt: now, confirmedAt: now, epoch: busEpoch },
            TOMBSTONE_TTL_MS,
        );
    }
}

const revokedListeners = new Set<(ids: readonly string[]) => void>();

/**
 * Register a callback run whenever device sessions are revoked — on this
 * replica (from {@link handleDeviceSessionsRevoked}) or on another one (via
 * the bus). Used to close the revoked devices' open SSE streams.
 */
export function onDeviceSessionsRevoked(fn: (ids: readonly string[]) => void): void {
    revokedListeners.add(fn);
}

function notifyRevoked(ids: readonly string[]): void {
    for (const fn of revokedListeners) {
        try {
            fn(ids);
        } catch (err) {
            logger.warn('device session revoked listener failed', { error: String(err) });
        }
    }
}

// Another replica revoked these sessions: reject their JWTs (and, via
// isDeviceSessionTombstoned, their cached stream tokens) here at once.
onRemoteDeviceSessionRevoked((ids) => {
    tombstone(ids);
    notifyRevoked(ids);
});

/**
 * Synchronous peek: has this replica learned that the session was revoked
 * (locally, via the bus, or via a marker / DB read)? No I/O. Used by the
 * stream-token validator so a revoked device's cached stream tokens stop on
 * every replica without waiting for its 60 s session cache.
 */
export function isDeviceSessionTombstoned(deviceSessionId: string): boolean {
    const entry = verdicts.get(deviceSessionId);
    return entry !== null && !entry.live;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function readMarker(deviceSessionId: string): Promise<'revoked' | 'clean' | 'unknown'> {
    if (Date.now() < markerUnavailableUntil) return 'unknown';
    try {
        const { cacheGetOrThrow, isCoordinationValkeyReady } = await import('../cache/valkey.js');
        if (!isCoordinationValkeyReady()) {
            markerUnavailableUntil = Date.now() + MARKER_UNAVAILABLE_MEMO_MS;
            return 'unknown';
        }
        const marker = await withTimeout(
            cacheGetOrThrow(MARKER_KEY_PREFIX + deviceSessionId),
            MARKER_READ_TIMEOUT_MS,
        );
        if (marker === 'timeout') throw new Error('marker read timed out');
        return marker !== null ? 'revoked' : 'clean';
    } catch (err) {
        markerUnavailableUntil = Date.now() + MARKER_UNAVAILABLE_MEMO_MS;
        warnRevocationMarkerUnavailable(err);
        return 'unknown';
    }
}

async function readDb(deviceSessionId: string): Promise<boolean | null> {
    try {
        const sql = getDb();
        if (!sql) return null;
        return await isDeviceSessionLiveInDb(sql, deviceSessionId);
    } catch (err) {
        logger.warn('Device session liveness lookup failed', {
            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
            error: String(err),
        });
        return null;
    }
}

async function computeLiveness(deviceSessionId: string): Promise<DeviceSessionLiveness> {
    const now = Date.now();
    const cached = verdicts.get(deviceSessionId);

    if (cached && !cached.live) return 'revoked';
    // A live verdict from before a bus gap may have missed a revocation event.
    const entry = cached && cached.epoch === busEpoch ? cached : null;
    // While the bus is down an event can be missed at any moment: only the DB
    // (or a revoked marker) decides, as with Valkey down.
    const busTrusted = isAuthCacheBusSubscribed();
    const epoch = busEpoch;

    let marker: 'revoked' | 'clean' | 'unknown';
    if (entry && now - entry.dbCheckedAt < LIVE_FRESH_MS) {
        if (now - entry.confirmedAt < MARKER_RECHECK_MS) return 'live';
        marker = await readMarker(deviceSessionId);
        if (marker === 'clean' && busTrusted) {
            // A revocation may have landed while the marker read was pending.
            if (isDeviceSessionTombstoned(deviceSessionId)) return 'revoked';
            entry.confirmedAt = now;
            return 'live';
        }
    } else {
        // Cold or stale: the marker first — it is how another replica's
        // revocation reaches us even if our DB read would be served late.
        marker = await readMarker(deviceSessionId);
    }
    if (marker === 'revoked') {
        tombstone([deviceSessionId]);
        return 'revoked';
    }

    const live = await readDb(deviceSessionId);
    if (live === null) {
        // DB unavailable. A recent live verdict stands in only when the marker
        // was actually read and clean; otherwise nothing can vouch for it.
        if (
            entry?.live &&
            now - entry.dbCheckedAt < STALE_LIVE_MAX_MS &&
            marker === 'clean' &&
            busTrusted
        ) {
            return 'live';
        }
        return 'unknown';
    }
    if (!live) {
        tombstone([deviceSessionId]);
        return 'revoked';
    }
    // A revocation may have landed (locally or via the bus) while we read.
    if (isDeviceSessionTombstoned(deviceSessionId)) return 'revoked';
    // A resync during the read: the verdict is still DB-confirmed, but tag it
    // with the epoch it was read in so the next check re-reads.
    verdicts.set(deviceSessionId, { live: true, dbCheckedAt: now, confirmedAt: now, epoch });
    return 'live';
}

/**
 * Whether access JWTs of this device session may still be honoured. Never
 * throws. Concurrent checks of one session share a single lookup.
 */
export function checkDeviceSessionLiveness(
    deviceSessionId: string,
): Promise<DeviceSessionLiveness> {
    // Before joining an in-flight lookup: a revocation this replica learned
    // after that lookup started must not be answered with its stale result.
    if (isDeviceSessionTombstoned(deviceSessionId)) return Promise.resolve('revoked');
    const pending = inflight.get(deviceSessionId);
    if (pending) return pending;
    const p = computeLiveness(deviceSessionId).finally(() => inflight.delete(deviceSessionId));
    inflight.set(deviceSessionId, p);
    return p;
}

const MARKER_WRITE_WARN_INTERVAL_MS = 30_000;
let lastMarkerWriteWarnAt = 0;

async function writeMarkers(ids: readonly string[]): Promise<void> {
    let ok: boolean;
    try {
        const { cacheSet, isCoordinationValkeyReady, connectValkey } =
            await import('../cache/valkey.js');
        if (!isCoordinationValkeyReady()) await connectValkey();
        const results = await Promise.all(
            ids.map((id) => cacheSet(MARKER_KEY_PREFIX + id, '1', MARKER_TTL_SECONDS)),
        );
        ok = results.every(Boolean);
    } catch {
        ok = false;
    }
    if (!ok && Date.now() - lastMarkerWriteWarnAt > MARKER_WRITE_WARN_INTERVAL_MS) {
        lastMarkerWriteWarnAt = Date.now();
        logger.warn(
            'Device session revocation marker write failed; other replicas rely on the bus and their DB re-read',
            { count: ids.length },
        );
    }
}

async function endStreams(ids: readonly string[], sql?: postgres.Sql): Promise<void> {
    try {
        const { getStreamingSessionService } = await import('./streaming-session.service.js');
        const sessions = getStreamingSessionService();
        if (sql) await sessions.endByDeviceSessionIds(ids, sql);
        else await sessions.endByDeviceSessionIds(ids);
    } catch (err) {
        logger.warn('Failed to end stream sessions of revoked device sessions', {
            count: ids.length,
            error: String(err),
        });
    }
}

/**
 * Cut off device sessions whose refresh tokens were revoked: their access JWTs
 * are rejected from the next request on (this replica at once, other replicas
 * via the bus, plus the Valkey marker as the backstop), their cached stream
 * tokens stop validating, and the stream tokens they minted are ended in the
 * DB.
 *
 * Call through `device-session-revocation.ts`, which only passes sessions it
 * established as the caller's: a device_session_id is not a secret. Idempotent.
 * Never throws. The local tombstone and the bus publish happen before the first
 * await; the marker write and the stream-token end are bounded by
 * {@link REVOKE_SIDE_EFFECT_TIMEOUT_MS} (they finish in the background), so a
 * logout never hangs on an unreachable Valkey.
 */
export async function handleDeviceSessionsRevoked(
    deviceSessionIds: readonly (string | null | undefined)[],
    sql?: postgres.Sql,
): Promise<void> {
    const ids = [...new Set(deviceSessionIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return;

    tombstone(ids);
    notifyRevoked(ids);
    try {
        publishAuthCacheInvalidation({ kind: 'device-session-revoked', deviceSessionIds: ids });
    } catch (err) {
        logger.debug('device session revocation publish failed', { error: String(err) });
    }

    // A transaction-bound stream write must finish before its caller commits.
    // Only cache side effects may outlive that transaction.
    if (sql) await endStreams(ids, sql);
    const settled = await withTimeout(
        sql
            ? writeMarkers(ids)
            : Promise.all([writeMarkers(ids), endStreams(ids)]).then(() => undefined),
        REVOKE_SIDE_EFFECT_TIMEOUT_MS,
    );
    if (settled === 'timeout') {
        logger.warn('Device session revocation side effects still running in the background', {
            count: ids.length,
        });
    }
}

/** Test hook: forget every cached verdict and the Valkey-unavailable memo. */
export function _resetDeviceSessionLivenessForTests(): void {
    verdicts.clear();
    inflight.clear();
    markerUnavailableUntil = 0;
    lastMarkerWriteWarnAt = 0;
    busEpoch = 0;
}
