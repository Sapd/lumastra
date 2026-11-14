// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Upper bound for one `/Shows/{id}/Episodes` page. Jellyfin has no default
 * Limit there: without one it returns every episode of the series, and Infuse
 * relies on that (it builds the season list from that single response).
 */
export const EPISODES_MAX_LIMIT = 10_000;

/** `Limit` of `/Shows/{id}/Episodes`: absent or unparsable means all episodes. */
export function parseEpisodesLimit(raw: string | null): number {
    const parsed = parseInt(raw ?? '', 10);
    if (Number.isNaN(parsed)) return EPISODES_MAX_LIMIT;
    return Math.min(Math.max(1, parsed), EPISODES_MAX_LIMIT);
}
