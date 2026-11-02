// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Job -> item binding predicate (fix plan 6, C1).
 *
 * Shared by the HLS segment handler and job-restoration.ts so the two places
 * that decide "does this transcode job/session belong to the item the
 * request's auth gate just checked?" make that decision the same way instead
 * of drifting apart.
 *
 * Every HLS mount (`/api/v1`, the `/api` cookie mirror, `/j/Videos`, and
 * `/showcase/hls`) resolves an internal `media_items.id` from the URL before
 * reaching the segment handler, but nothing used to compare that id against
 * the item the resident/persisted transcode job actually belongs to — a
 * PlaySessionId for someone else's item served someone else's job as long as
 * ownership (a different, weaker check) passed or was exempt (preview
 * sessions, showcase's anonymous principal).
 */

import { isUuid, normalizeUuid } from '../../utils/media-key-parser.js';

/** Lowercase + dash a UUID (either spelling); pass through any other id form
 *  unchanged (composite keys, Jellyfin-compat non-UUID ids never round-trip
 *  through this normalizer, so an exact string match is what's required). */
export function normalizeItemId(id: string): string {
    return isUuid(id) ? normalizeUuid(id) : id;
}

/**
 * The set of item-id spellings a job/session is allowed to belong to for
 * this request: the resolved internal id (what the route's auth gate
 * actually checked) and the raw URL id (safe to admit too — it resolved to
 * that same internal id, so a job keyed on the raw, pre-canonicalization
 * spelling still names the gated item).
 *
 * Returns `null` when `internalId` is missing or empty — callers MUST fail
 * closed in that case (an `/api/v1` request for an unknown-but-valid UUID
 * never gets an `internalId`, and both `withLibraryAccess`/`withAgeGate` skip
 * their checks on `null`, so refusing to bind is the only safe answer).
 */
export function buildBoundItemIds(
    internalId: string | undefined | null,
    rawItemId: string,
): ReadonlySet<string> | null {
    if (!internalId) return null;
    return new Set([normalizeItemId(internalId), normalizeItemId(rawItemId)]);
}

/** Is `candidateItemId` one of the spellings in `bound`? False when `bound`
 *  is null (fail-closed) or `candidateItemId` is missing. */
export function isBoundToItem(
    candidateItemId: string | undefined | null,
    bound: ReadonlySet<string> | null,
): boolean {
    if (!bound || !candidateItemId) return false;
    return bound.has(normalizeItemId(candidateItemId));
}

/** First 8 chars only — every binding-rejection log line truncates ids so a
 *  warn-level log can be left on in production without leaking full UUIDs. */
export function truncateForLog(id: string | undefined | null): string {
    return (id ?? '').slice(0, 8);
}

/**
 * Job-id prefix of the shared preview-cache artifact: its job runs under
 * `preview-cache-<cacheKey>` (`createPreview`, preview-session.service.ts),
 * and a cache-backed viewer's own `preview-<item>-…` id is translated to it
 * server-side. No client legitimately sends this literal value.
 */
export const PREVIEW_CACHE_JOB_PREFIX = 'preview-cache-';

/**
 * Is `playSessionId` a raw preview-cache artifact id? Every client-facing
 * entry point refuses one: the segment handler (`checkJobItemBinding`) and
 * `startHlsPlayback`'s seam guard (the master route of every mount). The
 * artifact is keyed by file, not item, so a request that reaches it under
 * another item either serves or tears down a job it was never gated for.
 *
 * Case-insensitive: `sessionKey()` (ffmpeg-transcode.service.ts) lowercases
 * every PlaySessionId before it keys the job registry, so an uppercase
 * `PREVIEW-CACHE-<hash>` would otherwise slip past a case-sensitive check and
 * still resolve to the artifact job.
 */
export function isRawPreviewCacheSessionId(playSessionId: string): boolean {
    return playSessionId.toLowerCase().startsWith(PREVIEW_CACHE_JOB_PREFIX);
}
