// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Time-window selector for the runs page's Failed/All views — without a
 * filter, a single failing task 31 days ago sits in the same list as one
 * that failed a minute ago.
 *
 * When the selector was introduced it defaulted to `'all'` so that adding it
 * didn't silently change what existing views showed. That deference turned
 * out to be the wrong call for a first-time operator: on any install older
 * than a week the Failed tab opened onto every failure the server had ever
 * had, which reads as catastrophe next to the /admin rollup's bounded
 * "3 failed runs, last 24 h". The page now defaults to `'24h'` so the
 * surfaces agree; `'all'` remains one click away for real archaeology.
 */

export type RunWindow = '24h' | '7d' | 'all';

const WINDOW_MS: Record<Exclude<RunWindow, 'all'>, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Converts a `RunWindow` into the ISO `since` timestamp the `/api/runs`
 * endpoint accepts, relative to `nowMs`. Returns `undefined` for `'all'` —
 * callers should omit the `since` query param entirely rather than send it.
 */
export function sinceParamFor(window: RunWindow, nowMs: number = Date.now()): string | undefined {
    if (window === 'all') return undefined;
    return new Date(nowMs - WINDOW_MS[window]).toISOString();
}

const LIVE_STATES: ReadonlySet<string> = new Set(['pending', 'active', 'cancelling']);

/**
 * True when a state filter selects only live runs (the Running tab). The
 * window bounds `started_at`, so applying it there hid exactly what an
 * operator opens that tab for: a run started 30 h ago that is still active,
 * or one stuck in 'cancelling'. Live views ignore the window.
 */
export function isLiveOnlyFilter(stateFilter: readonly string[] | undefined): boolean {
    return (
        stateFilter !== undefined &&
        stateFilter.length > 0 &&
        stateFilter.every((s) => LIVE_STATES.has(s))
    );
}

/** The `since` for a request: none for live-only views, else the window's. */
export function sinceParamForView(
    window: RunWindow,
    stateFilter: readonly string[] | undefined,
    nowMs: number = Date.now(),
): string | undefined {
    return isLiveOnlyFilter(stateFilter) ? undefined : sinceParamFor(window, nowMs);
}
