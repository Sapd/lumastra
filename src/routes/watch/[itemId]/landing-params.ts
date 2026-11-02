// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { WATCH_LANDING_PARAMS } from '$lib/shared/watch-landing-params';

export { WATCH_LANDING_PARAMS };

/** `url` without the landing params, or null when it carries none. */
export function stripWatchLandingParams(url: URL): URL | null {
    const next = new URL(url);
    let changed = false;
    for (const key of WATCH_LANDING_PARAMS) {
        if (next.searchParams.has(key)) {
            next.searchParams.delete(key);
            changed = true;
        }
    }
    return changed ? next : null;
}

/**
 * The one notice a landing shows. `resolved=series` with `from` is a marker
 * jump away from an open player (undo target in `from`/`fromPos`, the left
 * episode's code in `fmk`); `seek` resumed the same file further on;
 * `finished` is the finished card; `stay` shows nothing. The server's `info`
 * text is shown only for landings that have no richer notice.
 */
export type WatchLanding =
    | { kind: 'none' }
    | { kind: 'info'; message: string }
    | {
          kind: 'continued';
          markerCode: string | null;
          device: string | null;
          fromEpisodeId: string;
          fromPositionMs: number | null;
          fromCode: string | null;
          /** Where the jump put the player (a resume handoff names it); else the server's resume. */
          seekMs: number | null;
      }
    | {
          kind: 'resumed';
          seekMs: number;
          device: string | null;
          /** A resume handoff in place: the spot to go back to. */
          fromPositionMs: number | null;
      }
    | { kind: 'finished'; device: string | null };

function nonNegativeInt(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function readWatchLanding(params: URLSearchParams): WatchLanding {
    const resolved = params.get('resolved');
    if (!resolved) return { kind: 'none' };
    const device = params.get('dev') || null;

    switch (resolved) {
        case 'stay':
            return { kind: 'none' };
        case 'finished':
            return { kind: 'finished', device };
        case 'seek': {
            const seekMs = nonNegativeInt(params.get('seekMs'));
            return seekMs === null
                ? { kind: 'none' }
                : {
                      kind: 'resumed',
                      seekMs,
                      device,
                      fromPositionMs: params.has('from')
                          ? nonNegativeInt(params.get('fromPos'))
                          : null,
                  };
        }
        case 'series': {
            const from = params.get('from');
            if (from) {
                return {
                    kind: 'continued',
                    markerCode: params.get('mk') || null,
                    device,
                    fromEpisodeId: from,
                    fromPositionMs: nonNegativeInt(params.get('fromPos')),
                    fromCode: params.get('fmk') || null,
                    seekMs: nonNegativeInt(params.get('seekMs')),
                };
            }
            break;
        }
    }

    const info = params.get('info');
    return info ? { kind: 'info', message: info } : { kind: 'none' };
}

/**
 * Landings that must not autoplay: the finished card waits for a choice, and
 * a marker jump or a resume handoff away from a paused player (`from` set)
 * lands paused too — the viewer was not watching when it happened.
 */
export function landingHoldsPlayback(params: URLSearchParams): boolean {
    const resolved = params.get('resolved');
    return (
        resolved === 'finished' ||
        ((resolved === 'series' || resolved === 'seek') && params.has('from'))
    );
}

/**
 * Start time for a freshly mounted player, in SECONDS (the unit of the
 * shells' `initialStartTime`): an explicit `?t=`, else the `seekMs` of a
 * `resolved=seek` landing or of a resume-handoff jump (`resolved=series`).
 */
export function landingStartSeconds(params: URLSearchParams): number | undefined {
    const t = Number.parseInt(params.get('t') ?? '', 10);
    if (!Number.isNaN(t) && t > 0) return t;
    const resolved = params.get('resolved');
    if (resolved === 'seek' || resolved === 'series') {
        const seekMs = nonNegativeInt(params.get('seekMs'));
        if (seekMs !== null && seekMs > 0) return seekMs / 1000;
    }
    return undefined;
}

/**
 * Whether an arrival restores an earlier visit rather than choosing something
 * new: the document's own entry when it was a reload or a back/forward
 * (`entryType` is `PerformanceNavigationTiming.type`), or a client-side
 * history pop. A client-side `goto` — autoplay, the episode picker — never is.
 */
export function isRestoredArrival(navType: string, entryType: string | undefined): boolean {
    if (navType === 'popstate') return true;
    return navType === 'enter' && (entryType === 'reload' || entryType === 'back_forward');
}
