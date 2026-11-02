// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-tab watch entry: how the viewer opened what this tab plays, sent as
 * `entry` on every play-session start. An `explicit` session (an episode
 * pick, a start time, a playlist) never joins a resume-handoff chain, so no
 * other device follows it (docs/superpowers/specs/2026-10-22-implicit-resume-handoff.md).
 *
 * Kept apart from the watch intent (`watch-intent.ts`): a Next Up or Resume
 * landing is linear but keeps episode intent, so the 10-minute marker
 * re-check still only hints for it.
 *
 * Lives in `sessionStorage` like the intent: per tab, survives a reload and
 * the autoplay `goto`, never leaks into a copied URL. Storage failures read
 * as `explicit`.
 */

export type WatchEntry = 'continue' | 'next_up' | 'autoplay' | 'resume' | 'explicit';

const ENTRY_KEY = 'watchEntry';

/** The landing param linear surfaces put on `/watch/<id>` links. */
export const WATCH_ENTRY_PARAM = 'entry';

const LINKABLE_ENTRIES = new Set<WatchEntry>(['continue', 'next_up', 'resume']);

/** `resolved` values the `/watch/<seriesId>` redirect stamps (see watch-intent.ts). */
const CONTINUE_LANDINGS = new Set(['series', 'stay', 'seek', 'finished']);

/** Params that name an explicit spot: a start time, a playlist, a collection/event. */
const EXPLICIT_PARAMS = ['t', 'playlist', 'ctx'] as const;

function isWatchEntry(value: unknown): value is WatchEntry {
    return (
        value === 'continue' ||
        value === 'next_up' ||
        value === 'autoplay' ||
        value === 'resume' ||
        value === 'explicit'
    );
}

export function readWatchEntry(): WatchEntry {
    try {
        const raw = sessionStorage.getItem(ENTRY_KEY);
        return isWatchEntry(raw) ? raw : 'explicit';
    } catch {
        // best-effort: no storage means no handoff, never an error
        return 'explicit';
    }
}

export function setWatchEntry(entry: WatchEntry): void {
    try {
        sessionStorage.setItem(ENTRY_KEY, entry);
    } catch {
        // best-effort: without storage the tab is simply explicit next time
    }
}

export function isLinearEntry(entry: WatchEntry): boolean {
    return entry !== 'explicit';
}

/**
 * The entry a landing on `/watch/<id>` resolves to.
 *
 * Explicit spots (`t`, `playlist`, `ctx`) win; then the series redirect
 * (`continue`); then a linear `entry=` param; then autoplay, which is always
 * linear; then a reload / back-forward, which keeps the stored
 * entry. Anything else (an episode list, the picker, a link) is explicit.
 */
export function entryFromLanding(
    params: URLSearchParams,
    arrival: { autoplay: boolean; restored: boolean },
    stored: WatchEntry,
): WatchEntry {
    if (EXPLICIT_PARAMS.some((key) => params.has(key))) return 'explicit';
    const resolved = params.get('resolved');
    if (resolved && CONTINUE_LANDINGS.has(resolved)) {
        // A handoff jump carries the tab's own entry; the redirect itself is continue.
        const carried = params.get(WATCH_ENTRY_PARAM);
        return isWatchEntry(carried) && carried !== 'explicit' ? carried : 'continue';
    }
    const param = params.get(WATCH_ENTRY_PARAM);
    if (isWatchEntry(param) && LINKABLE_ENTRIES.has(param)) return param;
    // Autoplay into the next episode is linear watching, whatever opened the first one.
    if (arrival.autoplay) return 'autoplay';
    if (arrival.restored) return stored;
    return 'explicit';
}

/** Append `entry=<entry>` to a `/watch/...` href (no-op for explicit). */
export function withWatchEntry(href: string, entry: WatchEntry): string {
    if (!LINKABLE_ENTRIES.has(entry)) return href;
    return `${href}${href.includes('?') ? '&' : '?'}${WATCH_ENTRY_PARAM}=${entry}`;
}
