// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Request Status Module
 *
 * SINGLE SOURCE OF TRUTH for media-request status ordering and labels.
 * Importable by BOTH server and client code — must contain NO server-only
 * imports (no database, no node built-ins). It may import paraglide messages
 * because those are isomorphic.
 *
 * Two DISTINCT, legitimate intents exist for "priority":
 *
 *   (a) FURTHEST-ALONG / BEST-FIRST ordering — used for aggregate display and
 *       for sorting the notification list so the most actionable item (an
 *       available show ready to play) bubbles to the top. `available` is the
 *       best/furthest state.
 *
 *   (b) WORST-CASE aggregation — when collapsing many per-season statuses into
 *       a single headline status, we historically surfaced the LEAST-complete
 *       season (e.g. a show with 9 available + 1 downloading seasons reported
 *       "downloading") so the user knew work was still in flight.
 *
 * Both intents are derived from ONE canonical ordering (`STATUS_ORDER`,
 * furthest-along last). Do NOT hand-maintain a second inverted table.
 */

import * as m from '$lib/paraglide/messages';

/**
 * Canonical request-status union.
 *
 * This is the single definition consumed by:
 *  - server `StatusType` (request-status/types.ts re-exports it)
 *  - client `RequestStatus` (the Zod enum in notifications-types.ts mirrors it;
 *    keep the two in sync — this union is the human-authored source of truth,
 *    the Zod enum is the runtime-validation mirror)
 */
export type RequestStatusValue =
    | 'pending'
    | 'searching'
    | 'queued'
    | 'paused'
    | 'downloading'
    | 'importing'
    | 'synching'
    | 'available'
    | 'unavailable'
    | 'monitored';

/**
 * CANONICAL ORDERING — least-complete first, furthest-along last.
 *
 * Index in this array IS the canonical rank. Everything else (best-first,
 * worst-first) is derived from it so there is exactly one place to edit.
 *
 * Rationale for placement:
 *  - unavailable: dead end (failed / not found) — least useful
 *  - pending: request just submitted, nothing happening yet
 *  - monitored: waiting on a future release date / search
 *  - searching: actively looking for a release
 *  - queued → paused → downloading: download lifecycle
 *  - importing → synching: post-download processing into the library
 *  - available: ready to watch — furthest along / best
 */
export const STATUS_ORDER: readonly RequestStatusValue[] = [
    'unavailable',
    'pending',
    'monitored',
    'searching',
    'queued',
    'paused',
    'downloading',
    'importing',
    'synching',
    'available',
] as const;

/**
 * Canonical rank: higher number = further along / better.
 * `available` is the maximum. Derived from STATUS_ORDER.
 */
export const STATUS_RANK: Record<RequestStatusValue, number> = STATUS_ORDER.reduce(
    (acc, status, index) => {
        acc[status] = index;
        return acc;
    },
    {} as Record<RequestStatusValue, number>,
);

/**
 * Compare two statuses by canonical rank.
 * Returns positive if `a` is further along than `b`.
 */
export function compareStatusRank(a: RequestStatusValue, b: RequestStatusValue): number {
    return STATUS_RANK[a] - STATUS_RANK[b];
}

/**
 * Intent (a): pick the FURTHEST-ALONG / best status from a set.
 * Used for best-first sorting and "most actionable" aggregate display.
 */
export function getFurthestAlongStatus(statuses: RequestStatusValue[]): RequestStatusValue {
    if (statuses.length === 0) return 'pending';
    return statuses.reduce((best, current) =>
        STATUS_RANK[current] > STATUS_RANK[best] ? current : best,
    );
}

/**
 * Intent (b): pick the LEAST-COMPLETE / worst status from a set.
 * Used for worst-case aggregation (surface that work is still in flight).
 * Derived from the SAME canonical ordering — no separate inverted map.
 */
export function getLeastCompleteStatus(statuses: RequestStatusValue[]): RequestStatusValue {
    if (statuses.length === 0) return 'pending';
    return statuses.reduce((worst, current) =>
        STATUS_RANK[current] < STATUS_RANK[worst] ? current : worst,
    );
}

/**
 * Best-first sort comparator for status values (available first, unavailable
 * last). Suitable as the primary key for sorting the notification list.
 *
 * Returns negative when `a` should sort BEFORE `b` (i.e. `a` is further along).
 */
export function sortByStatusBestFirst(a: RequestStatusValue, b: RequestStatusValue): number {
    return STATUS_RANK[b] - STATUS_RANK[a];
}

// ============================================================================
// Status classification helpers
// ============================================================================

/**
 * Statuses that represent active download flight (download is queued or in
 * progress). Used for the "N downloading" season-breakdown count and similar
 * UI affordances. `paused` is intentionally excluded — it is in-flight but not
 * actively progressing; callers that want it should test explicitly.
 */
export const DOWNLOAD_FLIGHT_STATUSES: readonly RequestStatusValue[] = [
    'queued',
    'downloading',
] as const;

/**
 * True when a status represents active download flight (queued or downloading).
 */
export function isDownloadingStatus(status: RequestStatusValue): boolean {
    return DOWNLOAD_FLIGHT_STATUSES.includes(status);
}

/**
 * True when a status means the content is ready to watch.
 */
export function isAvailableStatus(status: RequestStatusValue): boolean {
    return status === 'available';
}

// ============================================================================
// Status → label keys
// ============================================================================

/**
 * Canonical status → paraglide message-key mapping.
 *
 * Returns the KEY (string), letting callers resolve the paraglide function
 * however they prefer. A resolved-label helper (`getStatusLabel`) is also
 * exported below for the common case.
 *
 * Note on `synching`: deliberately maps to `req_processing` (its user-facing
 * meaning is "processing into your library"), matching both the server's
 * previous getStatusMessage and the widget's previous getStatusText.
 */
export const STATUS_LABEL_KEY: Record<RequestStatusValue, string> = {
    available: 'req_available',
    unavailable: 'req_unavailable',
    downloading: 'req_downloading',
    synching: 'req_processing',
    searching: 'req_searching',
    pending: 'request_sending',
    queued: 'req_queued',
    paused: 'req_paused',
    importing: 'request_status_importing',
    monitored: 'request_status_monitored_searching',
};

/**
 * Resolve a status to its localized label string.
 *
 * Imports the paraglide namespace — fine for an isomorphic module. Both the
 * server resolver (`getStatusMessage`) and the client widget (`getStatusText`)
 * route through this so there is exactly one status→label table.
 */
export function getStatusLabel(status: RequestStatusValue): string {
    switch (status) {
        case 'available':
            return m.req_available();
        case 'unavailable':
            return m.req_unavailable();
        case 'downloading':
            return m.req_downloading();
        case 'synching':
            return m.req_processing();
        case 'searching':
            return m.req_searching();
        case 'pending':
            return m.request_sending();
        case 'queued':
            return m.req_queued();
        case 'paused':
            return m.req_paused();
        case 'importing':
            return m.request_status_importing();
        case 'monitored':
            return m.request_status_monitored_searching();
        default:
            return status;
    }
}
