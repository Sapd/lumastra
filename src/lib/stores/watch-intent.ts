// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-tab watch intent: what "keep watching" means for the player in this tab.
 *
 * - `continue(seriesId)`: "wherever I am in this series" — the player follows
 *   the server's series watch marker (forward only) when it comes back from a
 *   long idle or a reload.
 * - `episode`: "exactly this episode" — the player never moves on its own, at
 *   most it hints at the marker.
 *
 * The intent enters through the href (`/watch/<seriesId>` stamps
 * `resolved=series`), so it lives in `sessionStorage`: per tab, survives a
 * reload and the autoplay `goto`, and never leaks into a copied URL. Every
 * storage access is guarded — private mode or a throwing storage degrades to
 * the episode intent, never to an error.
 */

export type WatchIntent = { kind: 'continue'; seriesId: string } | { kind: 'episode' };

const INTENT_KEY = 'watchIntent';
const HINT_DISMISSED_KEY = 'watchMarkerHintDismissed';
const HINT_DISMISSED_CAP = 50;

const EPISODE_INTENT: WatchIntent = { kind: 'episode' };

/** Landing values the `/watch/<seriesId>` redirect stamps for continue mode. */
const CONTINUE_LANDINGS = new Set(['series', 'stay', 'seek', 'finished']);

/** Params that name an explicit episode context (deep link, playlist, collection/event). */
const EPISODE_CONTEXT_PARAMS = ['t', 'playlist', 'ctx'] as const;

function storageGet(key: string): string | null {
    try {
        return sessionStorage.getItem(key);
    } catch {
        // best-effort: no/blocked storage reads as "nothing stored"
        return null;
    }
}

function storageSet(key: string, value: string): void {
    try {
        sessionStorage.setItem(key, value);
    } catch {
        // best-effort: without storage the tab simply falls back to episode intent
    }
}

export function readWatchIntent(): WatchIntent {
    const raw = storageGet(INTENT_KEY);
    if (!raw) return EPISODE_INTENT;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === 'object' &&
            'kind' in parsed &&
            parsed.kind === 'continue' &&
            'seriesId' in parsed &&
            typeof parsed.seriesId === 'string' &&
            parsed.seriesId.length > 0
        ) {
            return { kind: 'continue', seriesId: parsed.seriesId };
        }
    } catch {
        // malformed value: treated as the default below
    }
    return EPISODE_INTENT;
}

export function setWatchIntent(intent: WatchIntent): void {
    storageSet(INTENT_KEY, JSON.stringify(intent));
}

/**
 * The intent a landing on `/watch/<episode>` resolves to.
 *
 * `resolved=series|stay|seek|finished` (the series redirect) enters continue
 * mode for `seriesId`; `t` / `playlist` / `ctx` name an explicit episode
 * context; anything else keeps `current` only while it is continue mode for
 * this same series.
 */
export function intentFromLanding(
    params: URLSearchParams,
    seriesId: string | null,
    current: WatchIntent,
): WatchIntent {
    const resolved = params.get('resolved');
    if (resolved && CONTINUE_LANDINGS.has(resolved)) {
        return seriesId ? { kind: 'continue', seriesId } : EPISODE_INTENT;
    }
    if (EPISODE_CONTEXT_PARAMS.some((key) => params.has(key))) return EPISODE_INTENT;
    if (current.kind === 'continue' && current.seriesId === seriesId) return current;
    return EPISODE_INTENT;
}

/**
 * The stored intent a landing may inherit. Only autoplay to the next episode
 * and a restored document (reload, back/forward) carry the tab's intent; any
 * other arrival — the in-player episode picker, an episode list, a link — is a
 * person choosing an episode, which is episode intent.
 */
export function carriedIntent(
    stored: WatchIntent,
    arrival: { autoplay: boolean; restored: boolean },
): WatchIntent {
    return arrival.autoplay || arrival.restored ? stored : EPISODE_INTENT;
}

function readDismissed(): string[] {
    const raw = storageGet(HINT_DISMISSED_KEY);
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((v): v is string => typeof v === 'string')
            : [];
    } catch {
        return [];
    }
}

/**
 * Remember that the marker hint was shown (or dismissed) for `episodeId` in
 * this tab: it appears at most once per (tab, episode).
 */
export function markHintDismissed(episodeId: string): void {
    const list = readDismissed().filter((id) => id !== episodeId);
    list.push(episodeId);
    storageSet(HINT_DISMISSED_KEY, JSON.stringify(list.slice(-HINT_DISMISSED_CAP)));
}

export function isHintDismissed(episodeId: string): boolean {
    return readDismissed().includes(episodeId);
}
