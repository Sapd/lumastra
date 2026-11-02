// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Records forward-auth identity headers (USERHEADER / GROUPHEADER) that arrived
 * from a TRUSTED_PROXY_IPS peer while FORWARD_AUTH_ENABLED is off, so they were
 * ignored.
 *
 * Two readers:
 * - the request path logs one WARN per window (never the header values: from a
 *   proxy that does not strip them they are client-chosen text);
 * - the security self-check (admin system health) warns while the last sighting
 *   is recent, which is either a forward-auth install that missed the upgrade
 *   step or a proxy that passes client-sent identity headers through.
 *
 * State is per process: on a multi-replica install each replica reports only
 * what it saw. Kept free of config/forward-auth imports so the self-check can
 * read it cheaply.
 */

import { Logger } from './logger';

const logger = Logger.for('ForwardAuth');

/** One WARN per this window, however many requests carry the headers. */
export const DISABLED_HEADER_LOG_INTERVAL_MS = 10 * 60 * 1000;
/** The self-check reports a sighting for this long after the last one. */
export const DISABLED_HEADER_RECENT_MS = 24 * 60 * 60 * 1000;

export interface DisabledForwardAuthSighting {
    /** Requests seen since the process started. */
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
    /** TCP peer of the most recent sighting (a trusted proxy, not the client). */
    lastPeer: string;
    /** Header NAMES present on the most recent sighting, never values. */
    lastHeaders: string[];
}

let sighting: DisabledForwardAuthSighting | null = null;
let lastLoggedAt = 0;
let lastUntrustedLoggedAt = 0;
// One request can pass several readers (session arbitration, the hook, the
// /setup load); count it once.
const notedRequests = new WeakSet<object>();

/** Window check that also reopens when the clock stepped backwards. */
function windowOpen(now: number, last: number): boolean {
    return last === 0 || now < last || now - last >= DISABLED_HEADER_LOG_INTERVAL_MS;
}

/**
 * Note one request whose identity headers were ignored because forward auth is
 * off. `headerNames` are the configured names that were present.
 */
export function noteIgnoredForwardAuthHeaders(input: {
    peer: string;
    path: string;
    headerNames: string[];
    now?: number;
    /** The request, to count it once however many readers see it. */
    request?: object;
}): void {
    if (input.request) {
        if (notedRequests.has(input.request)) return;
        notedRequests.add(input.request);
    }
    const now = input.now ?? Date.now();
    sighting = {
        count: (sighting?.count ?? 0) + 1,
        firstSeenAt: sighting?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastPeer: input.peer,
        lastHeaders: input.headerNames,
    };
    if (!windowOpen(now, lastLoggedAt)) return;
    lastLoggedAt = now;
    logger.warn(
        'Forward-auth identity headers from a trusted proxy were ignored: FORWARD_AUTH_ENABLED is off',
        {
            peer: input.peer,
            path: input.path,
            headers: input.headerNames,
            ignoredSinceStart: sighting.count,
            hint: 'If you sign in through a forward-auth proxy (Authentik, Authelia, oauth2-proxy), set FORWARD_AUTH_ENABLED=true. Otherwise make your reverse proxy strip these headers from client requests. Logged at most once every 10 minutes.',
        },
    );
}

/**
 * Whether to log identity headers from an UNTRUSTED peer while forward auth is
 * off. With forward auth on that is a per-request forgery warning; with it off
 * the headers could not have signed anyone in anyway, so anonymous scanners
 * must not be able to flood the log. Not recorded as a sighting (the peer is
 * not a proxy this server trusts).
 */
export function shouldLogUntrustedWhileDisabled(now: number = Date.now()): boolean {
    if (!windowOpen(now, lastUntrustedLoggedAt)) return false;
    lastUntrustedLoggedAt = now;
    return true;
}

/** The current sighting, or null when none happened since start. */
export function getIgnoredForwardAuthSighting(): DisabledForwardAuthSighting | null {
    return sighting ? { ...sighting, lastHeaders: [...sighting.lastHeaders] } : null;
}

/** Test seam. */
export function resetIgnoredForwardAuthSighting(): void {
    sighting = null;
    lastLoggedAt = 0;
    lastUntrustedLoggedAt = 0;
}
