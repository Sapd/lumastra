// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Request parameter helpers
// Shared utilities for all Subsonic handler modules.

import type { RequestEvent } from '@sveltejs/kit';

// Param helpers read from both POST body (event.locals.subsonicBodyParams) and
// URL query string so that GET and POST clients work identically.
export function getParam(event: RequestEvent, key: string): string | null {
    return event.locals.subsonicBodyParams?.get(key) ?? event.url.searchParams.get(key);
}

export function getAllParam(event: RequestEvent, key: string): string[] {
    const body = event.locals.subsonicBodyParams?.getAll(key) ?? [];
    const url = event.url.searchParams.getAll(key);
    return body.length > 0 ? body : url;
}

export function getIntParam(event: RequestEvent, key: string, fallback: number): number {
    const raw = getParam(event, key);
    if (raw === null || raw === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

export function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Longest search term honoured; clients send what the user typed, so cut rather than reject. */
export const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * Normalize a search2/search3 `query` parameter.
 *
 * Subsonic has no "list everything" method, so clients enumerate a library by
 * asking search3 for a query that matches all of it. The spec's convention is
 * an empty query, but clients differ on how they express "empty": Symfonium
 * sends the two-character string `""` (`%22%22` on the wire) on every sync
 * page, and others send `''`. Comparing the raw value against `''` misses
 * those, the quoted literal falls through to a real full-text search, matches
 * nothing, and the client syncs an empty library.
 *
 * Unwrapping the pair also makes an ordinary quoted phrase (`"kind of dawn"`)
 * search its inner text instead of a term nothing can match.
 *
 * Returns the effective search term; an empty string means "match all".
 */
export function normalizeSearchQuery(raw: string): string {
    // Cut first: a 16 KB term per request is cheap to send and costly to match.
    const trimmed = raw.slice(0, MAX_SEARCH_QUERY_LENGTH + 2).trim();
    // Only a symmetric surrounding pair is a wrapper — a stray quote is part of
    // the term (`rock'n'roll`, `say "hello"`).
    const unwrapped =
        trimmed.length >= 2 &&
        (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
        trimmed.endsWith(trimmed[0])
            ? trimmed.slice(1, -1)
            : trimmed;
    return unwrapped.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
}
