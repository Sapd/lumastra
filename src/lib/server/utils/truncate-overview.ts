// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared `overview` truncation for rail/list cards.
 *
 * Moved out of `src/routes/+page.server.ts` (the homepage load) so `/browse`'s
 * SSR load and the internal `/api/browse*` endpoints can apply the SAME cut
 * without duplicating the constant or the slice logic. See that file's
 * `RAIL_OVERVIEW_MAX_CHARS` docblock (now here) for the full rationale —
 * nothing on a rail/list card renders more than this, and `MediaHoverCard`
 * re-truncates to the same 147 + "…" itself, so this is invisible to the user.
 *
 * IMPORTANT — apply this ONLY at internal, page/endpoint-boundary seams, same
 * rule as `stripAudiobookListArraysFromMetadata` in
 * `strip-audiobook-list-arrays.ts`: never from a module that also feeds
 * `/api/v1/*` (e.g. `browse.queries.ts`, a shared `defs/browse/*.ts` handler
 * body) — those must stay byte-identical for native clients. A dual-mounted
 * def instead gates the call on `ctx.surface === 'internal'` right before its
 * `json()` response.
 */

/**
 * Longest `overview` a rail/list card can actually render, plus the ellipsis.
 *
 * Nothing on a rail/list card shows a full synopsis: `MediaHoverCard`
 * re-truncates to 147 chars + "…" itself, and `UniversalMediaCard` only
 * renders `overview` in its `list` variant (clamped to two lines), which rail
 * carousels never resolve to. Shipping the full TMDB synopsis therefore paid
 * 250-650 B per item for text no layout can display.
 */
export const RAIL_OVERVIEW_MAX_CHARS = 150;

/**
 * Trim a rail/list item's synopsis to what the cards can render.
 *
 * Mirrors `MediaHoverCard`'s own rule (slice to 147 + "…") so the truncated
 * string is byte-identical to what that component would have produced from
 * the full text — the hover card re-applies the same cut, so this is
 * invisible to the user.
 */
export function truncateOverview(overview: string | undefined): string | undefined {
    if (!overview || overview.length <= RAIL_OVERVIEW_MAX_CHARS) return overview;
    return `${overview.substring(0, RAIL_OVERVIEW_MAX_CHARS - 3)}...`;
}

/**
 * Trim `overview` on a single item, returning the SAME reference when there
 * is nothing to change (no `overview`, or already short enough) so callers
 * can cheaply detect "unchanged". `overview` is typed nullish because several
 * browse response schemas declare it `.nullish()` — `null`/`undefined` both
 * pass through untouched.
 */
export function trimItemOverview<T extends { overview?: string | null }>(item: T): T {
    if (!item.overview) return item;
    const trimmed = truncateOverview(item.overview);
    return trimmed === item.overview ? item : { ...item, overview: trimmed };
}

/**
 * Apply {@link trimItemOverview} across every item of a `{ items: [...] }`
 * row (e.g. a browse genre row or a keyword section).
 */
export function trimRowItemOverviews<
    I extends { overview?: string | null },
    R extends { items: I[] },
>(row: R): R {
    return { ...row, items: row.items.map(trimItemOverview) };
}
