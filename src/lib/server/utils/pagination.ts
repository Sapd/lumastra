// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uniform pagination parameter parser for API routes.
 *
 * Replaces ~25 hand-rolled `Number.parseInt(url.searchParams.get('limit'))`
 * + ad-hoc clamping snippets that drifted in bounds, defaults, and
 * negative-handling. Centralizes the safety guards so a missing or
 * malformed query string can't trigger unbounded queries.
 *
 * The defaults are conservative; routes that need different bounds pass
 * them via `opts`. Callers should still document their expected page
 * size in the route's OpenAPI schema.
 */

import { parseInteger } from '$lib/utils/data-extraction.js';

export interface PaginationOptions {
    /** Default page size when the caller omits `limit`. */
    defaultLimit?: number;
    /** Hard upper bound on `limit`. Clamped silently. */
    maxLimit?: number;
    /** Hard lower bound on `limit`. Clamped silently. */
    minLimit?: number;
    /** Query parameter name for limit (default `'limit'`). */
    limitParam?: string;
    /** Query parameter name for offset (default `'offset'`). */
    offsetParam?: string;
}

export interface Pagination {
    limit: number;
    offset: number;
}

/**
 * Parse `?limit=N&offset=M` from a SvelteKit `URL`, clamped to safe bounds.
 *
 * @example
 *   const { limit, offset } = parsePagination(url);
 *   const { limit, offset } = parsePagination(url, { maxLimit: 100 });
 */
export function parsePagination(url: URL, opts: PaginationOptions = {}): Pagination {
    const {
        defaultLimit = 20,
        maxLimit = 500,
        minLimit = 1,
        limitParam = 'limit',
        offsetParam = 'offset',
    } = opts;

    const rawLimit = parseInteger(url.searchParams.get(limitParam)) ?? defaultLimit;
    const limit = Math.min(Math.max(minLimit, rawLimit), maxLimit);

    const rawOffset = parseInteger(url.searchParams.get(offsetParam)) ?? 0;
    const offset = Math.max(0, rawOffset);

    return { limit, offset };
}
