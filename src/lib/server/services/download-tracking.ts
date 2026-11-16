// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Glue between a download route and (a) the per-user lease / bandwidth manager,
 * (b) the download log.
 *
 * `trackDownload` is called by a route once it knows which file it is about to
 * serve. It takes a lease (or answers 429), and returns a tracker whose `rate`
 * feeds the throttle and whose `observer` hooks the response body: bytes go to the
 * log and the lease on a 5 s tick (never per chunk), and the end of the body
 * (finished, client gone, read error) releases the lease exactly once.
 *
 * Log writes are fire-and-forget: a database outage costs log rows, never a
 * download. The lease manager has its own fail-open fallback.
 */

import type { RequestEvent } from '@sveltejs/kit';
import crypto from 'node:crypto';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    endDownloadEvent,
    recordRefusedDownload,
    startDownloadEvent,
    updateDownloadEvent,
    type DownloadEventInput,
    type DownloadOutcome,
    type DownloadSurface,
} from '$lib/server/database/queries/download-events.queries.js';
import {
    acquireDownloadLease,
    LEASE_REFRESH_INTERVAL_MS,
    type DownloadLease,
} from '$lib/server/services/download-leases.js';
import { config } from '$lib/server/config.js';
import { kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream.js';
import type { StreamObserver } from '$lib/server/utils/file-streaming.js';
import { Logger } from '$lib/server/utils/logger.js';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
import * as m from '$lib/paraglide/messages';

const log = Logger.for('DownloadTracking');

/** A stream that sends nothing for this long is ended as aborted so it cannot hold a slot forever. */
const STALL_LIMIT_MS = 10 * 60_000;

export type { DownloadSurface };

export interface DownloadTarget {
    mediaItemId: string;
    /** Original file id; for a rendition download leave it out and pass `renditionId`. */
    fileId?: string | null;
    renditionId?: string | null;
    surface: DownloadSurface;
    bytesTotal?: number | null;
    /** First byte of a Range request, when there is one. */
    rangeStart?: number | null;
}

export interface DownloadTracker {
    /** Current cap in bytes/sec (0 = unlimited); pass `() => tracker.rate()` to the throttle. */
    rate(): number;
    /** Hooks for the response body (see `serveFileByPath`). */
    observer: StreamObserver;
    onBytes(n: number): void;
    /** The transfer is over; releases the lease and closes the log row. Idempotent. */
    onEnd(outcome: 'completed' | 'aborted' | 'error'): void;
    /** The response turned out not to stream anything (416, 404): release without logging. */
    discard(): void;
}

export type TrackResult =
    { ok: true; tracker: DownloadTracker } | { ok: false; response: Response };

type TrackLocals = {
    user?: { userId?: string | null } | null;
    principal?: { credentialId?: string } | null;
    deviceSessionId?: string;
    jfDevice?: { deviceId?: string | null; clientName?: string | null } | null;
};

/**
 * Device key, in order: the Jellyfin device id, the credential id (API token id or
 * web session id), the bearer device-session id, a hash of the user agent. The last
 * one only applies to proxy-header identities, which have no credential row.
 */
export function deriveDeviceKey(event: Pick<RequestEvent, 'locals' | 'request'>): string {
    const locals = (event.locals ?? {}) as TrackLocals;
    const key =
        locals.jfDevice?.deviceId || locals.principal?.credentialId || locals.deviceSessionId;
    if (key) return String(key).slice(0, 200);
    const ua = event.request?.headers?.get('user-agent') ?? '';
    return `ua:${crypto.createHash('sha1').update(ua).digest('hex').slice(0, 16)}`;
}

export function deriveClientName(event: Pick<RequestEvent, 'locals' | 'request'>): string | null {
    const locals = (event.locals ?? {}) as TrackLocals;
    const name = locals.jfDevice?.clientName || event.request?.headers?.get('user-agent') || null;
    return name ? name.slice(0, 200) : null;
}

/** First byte of a `bytes=N-...` Range header, else null. */
export function parseRangeStart(rangeHeader: string | null | undefined): number | null {
    const match = /^bytes=(\d+)-/.exec(rangeHeader ?? '');
    return match ? Number(match[1]) : null;
}

function eventInput(
    event: Pick<RequestEvent, 'locals' | 'request'>,
    target: DownloadTarget,
): DownloadEventInput | null {
    const userId = (event.locals as unknown as TrackLocals | undefined)?.user?.userId;
    if (!userId || !UUID_RE_LOOSE.test(target.mediaItemId)) return null;
    return {
        userId,
        mediaItemId: target.mediaItemId,
        fileId: target.fileId ?? null,
        renditionId: target.renditionId ?? null,
        surface: target.surface,
        deviceKey: deriveDeviceKey(event),
        clientName: deriveClientName(event),
        bytesTotal: target.bytesTotal ?? null,
        rangeStart: target.rangeStart ?? null,
    };
}

function warn(what: string, err: unknown): void {
    log.warn(`download log: ${what} failed`, {
        err: err instanceof Error ? err.message : String(err),
    });
}

const REFUSAL_COALESCE_MS = 60_000;
const refusalSeen = new Map<string, number>();

/** Test hook. */
export function resetRefusalCoalescingForTests(): void {
    refusalSeen.clear();
}

/** True when an identical refusal was already logged in the last minute (and records this one). */
function refusalCoalesced(input: DownloadEventInput, outcome: string): boolean {
    const now = Date.now();
    if (refusalSeen.size > 1_000) {
        for (const [k, until] of refusalSeen) if (until <= now) refusalSeen.delete(k);
    }
    const key = [
        input.userId,
        input.fileId ?? input.renditionId ?? input.mediaItemId,
        input.deviceKey,
        outcome,
    ].join('|');
    const until = refusalSeen.get(key);
    if (until !== undefined && until > now) return true;
    refusalSeen.set(key, now + REFUSAL_COALESCE_MS);
    return false;
}

/** Write a `denied` row for a refused request. Never throws, never waits for the database. */
export function recordDownloadRefused(
    event: Pick<RequestEvent, 'locals' | 'request'>,
    target: DownloadTarget,
    outcome: 'denied' | 'rate_limited' = 'denied',
): void {
    try {
        const input = eventInput(event, target);
        const sql = getDb();
        if (!input || !sql || refusalCoalesced(input, outcome)) return;
        void Promise.resolve()
            .then(() => recordRefusedDownload(sql, input, outcome))
            .catch((err) => warn(outcome, err));
    } catch (err) {
        warn(outcome, err);
    }
}

/**
 * Take a lease for this download. On refusal, logs `rate_limited` and returns a 429
 * with `Retry-After`. Without a signed-in user (not reachable through the routes) the
 * download is served untracked at the plain per-download cap.
 */
export async function trackDownload(
    event: Pick<RequestEvent, 'locals' | 'request'>,
    target: DownloadTarget,
): Promise<TrackResult> {
    const input = eventInput(event, target);
    const userId = (event.locals as unknown as TrackLocals | undefined)?.user?.userId;
    const leaseFileId = target.renditionId ?? target.fileId;
    if (!input || !userId || !leaseFileId) {
        return { ok: true, tracker: untrackedDownload() };
    }

    let lease: DownloadLease | null = null;
    try {
        const acquired = await acquireDownloadLease({
            userId,
            fileId: leaseFileId,
            deviceKey: input.deviceKey,
        });
        if (!acquired.ok) {
            recordDownloadRefused(event, target, 'rate_limited');
            return {
                ok: false,
                response: ApiProblem.rateLimited(acquired.retryAfterSec, {
                    error: m.downloads_limit_reached(),
                    reason: 'download_limit_reached',
                }),
            };
        }
        lease = acquired.lease;
    } catch (err) {
        // The lease manager fails open itself; anything that still escapes must not stop a download.
        warn('lease acquire', err);
    }
    return { ok: true, tracker: createTracker(input, lease) };
}

/** A tracker that holds no lease and logs nothing: plain per-download cap. For HEAD requests. */
export function untrackedDownload(): DownloadTracker {
    const observer: StreamObserver = {};
    return {
        rate: () => kbpsToBytesPerSecond(config.DOWNLOAD_THROTTLE_KBPS),
        observer,
        onBytes: () => {},
        onEnd: () => {},
        discard: () => {},
    };
}

function createTracker(input: DownloadEventInput, lease: DownloadLease | null): DownloadTracker {
    let total = 0; // bytes sent by this stream
    let flushed = 0; // part of `total` already in the log
    let finished = false;
    let lastTickTotal = 0;
    let lastProgressAt = Date.now();
    let rowId: Promise<string | null> | null = null;
    // Log writes run strictly one after another so a late tick cannot overtake the end.
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (what: string, fn: () => Promise<unknown>): void => {
        chain = chain.then(fn).catch((err) => warn(what, err));
    };

    const ensureRow = (): Promise<string | null> => {
        if (!rowId) {
            rowId = Promise.resolve()
                .then(async () => {
                    const sql = getDb();
                    return sql ? await startDownloadEvent(sql, input) : null;
                })
                .catch((err) => {
                    warn('start', err);
                    return null;
                });
        }
        return rowId;
    };

    const releaseLease = (): void => {
        if (!lease) return;
        const l = lease;
        lease = null;
        void l.release().catch((err) => warn('lease release', err));
    };

    const flush = (): number => {
        const delta = total - flushed;
        flushed = total;
        return delta;
    };

    const timer = setInterval(() => {
        if (finished) return;
        if (total > lastTickTotal) {
            lastTickTotal = total;
            lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt >= STALL_LIMIT_MS) {
            // Nothing sent for 10 minutes: the client is gone without the stream noticing.
            onEnd('aborted');
            return;
        }
        if (lease) void lease.refresh(total).catch((err) => warn('lease refresh', err));
        const delta = flush();
        if (delta > 0) {
            const row = ensureRow();
            enqueue('update', async () => {
                const id = await row;
                const sql = getDb();
                if (id && sql) await updateDownloadEvent(sql, id, { bytesSentDelta: delta });
            });
        }
    }, LEASE_REFRESH_INTERVAL_MS);
    timer.unref?.();

    const stop = (): void => {
        finished = true;
        clearInterval(timer);
        releaseLease();
    };

    const onBytes = (n: number): void => {
        if (finished) return;
        total += n;
        if (!rowId) void ensureRow();
    };

    const onEnd = (outcome: DownloadOutcome): void => {
        if (finished) return;
        stop();
        const delta = flush();
        const row = ensureRow();
        enqueue('end', async () => {
            const id = await row;
            const sql = getDb();
            if (id && sql) await endDownloadEvent(sql, id, outcome, { bytesSentDelta: delta });
        });
    };

    const rateOf = (): number =>
        lease ? lease.rateBytesPerSec() : kbpsToBytesPerSecond(config.DOWNLOAD_THROTTLE_KBPS);

    const tracker: DownloadTracker = {
        rate: rateOf,
        observer: { onBytes, onEnd },
        onBytes,
        onEnd,
        discard: stop,
    };
    return tracker;
}
