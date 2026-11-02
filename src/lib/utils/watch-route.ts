// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Canonical route IDs avoid base-path ambiguity and do not match /watchlist. */
export function isWatchRoute(routeId: string | null): boolean {
    return routeId === '/watch' || routeId?.startsWith('/watch/') === true;
}
