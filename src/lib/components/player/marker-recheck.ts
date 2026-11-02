// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Series watch-marker re-check for an open player.
 *
 * A tab left paused on an episode goes stale while the viewer keeps watching
 * elsewhere. When it comes back after a long idle (or is reloaded) it asks the
 * server where the series marker is now — relative to this player's episode
 * and position, excluding this player's own play session — and moves forward
 * only:
 *
 * - continue intent: a later episode in another file → navigate there (with an
 *   undo toast); later in this same file → seek in place; series finished →
 *   the finished card.
 * - episode intent: later in this same file → seek; a later episode → a
 *   dismissible hint, never a move; a finished series → nothing.
 *
 * The decision is made on the client from `GET …/watch-marker` rather than by
 * navigating to `/watch/<seriesId>?from=`: every client-side navigation tears
 * the player down (VideoPlayer's onNavigate → stopAndCleanup), and a redirect
 * back to the same episode would not remount it (`{#key itemId}`), leaving a
 * dead player for the stay / seek outcomes. Only a real move navigates.
 *
 * Triggers: a return to the tab after a long hide (`installMarkerRecheck`), a
 * reload / history restore (`shouldRunMountRecheck`), a play-session rebuild
 * after the server killed or expired the session (`shouldRecheckOnRebuild`),
 * and pressing play after a long pause in a tab that stayed visible
 * (`PauseTracker`).
 *
 * A movie player gets the same triggers, but only the same-item position
 * refresh (M2): it reads the movie's own watch state (`GET …/watch-state/{id}`)
 * and seeks forward when another device got further (`decideMovieRecheck`).
 * Movies have no intent, marker, hint or finished card.
 *
 * The long-pause play is NOT held back until the answer arrives. Holding it
 * would move the element's `play()` behind an await, outside the click's
 * user activation, and Safari (iOS above all) then refuses to start unmuted
 * playback. So play proceeds at once and the check runs alongside it; its
 * seek or jump still applies if the answer arrives within
 * {@link RESUME_RECHECK_APPLY_WINDOW_MS} of the press, and is dropped after
 * that so a viewer already watching is never yanked. A jump lands paused with
 * the undo toast (like any marker jump), since the new page cannot rely on
 * the press's activation either.
 */

import type { WatchStateResponse } from '$lib/schemas/api-playback-responses';
import type { SeriesWatchMarker } from '$lib/schemas/api-series-responses';
import type { WatchIntent } from '$lib/stores/watch-intent';
import { buildEpisodeSlug } from '$lib/utils/url-slugs';

/** Longer than the 5 min paused-session freshness, so a short tab switch never moves a player. */
export const MARKER_RECHECK_IDLE_MS = 10 * 60_000;

/** A long-pause play's re-check may still seek or jump this long after the press. */
export const RESUME_RECHECK_APPLY_WINDOW_MS = 1500;

/** A movie seeks only to a server position at least this far past its own. */
export const MOVIE_RECHECK_MIN_FORWARD_MS = 30_000;

/** Which event asked for the re-check; see {@link resolveRecheck}. */
export type RecheckTrigger = 'return' | 'mount' | 'rebuild' | 'resume';

export interface RecheckContext {
    intent: () => WatchIntent;
    /** Episode on screen (read live: the page reuses one context across episodes). */
    episodeId: string;
    /** `S01E08` of the episode on screen — the undo label after a jump. */
    episodeCode: string | null;
    seriesId: string | null;
    /** The movie on screen; null for anything that is not a movie. */
    movieId: string | null;
    seriesTitle: string | null;
    /** This player's play-session id (reporter), excluded server-side (M8). */
    sessionId: () => string | null;
    positionMs: () => number;
    isPlaying: () => boolean;
    watchPartyActive: () => boolean;
}

export type RecheckDecision =
    | { kind: 'jump'; url: string }
    | { kind: 'seek'; positionMs: number; deviceName: string | null }
    | { kind: 'finished'; marker: SeriesWatchMarker }
    | { kind: 'hint'; marker: SeriesWatchMarker }
    | { kind: 'stay' };

const STAY: RecheckDecision = { kind: 'stay' };

export function episodeCode(seasonNumber: number, episodeNumber: number): string {
    return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

/** A series or a movie player has something to re-check; anything else does not. */
function hasRecheckTarget(ctx: RecheckContext): boolean {
    return ctx.seriesId !== null || ctx.movieId !== null;
}

/** A return from hiding re-checks only a paused, solo series or movie player after a long idle. */
export function shouldRecheck(ctx: RecheckContext, hiddenForMs: number): boolean {
    if (!hasRecheckTarget(ctx)) return false;
    if (ctx.isPlaying() || ctx.watchPartyActive()) return false;
    return hiddenForMs >= MARKER_RECHECK_IDLE_MS;
}

/** A play-session rebuild re-checks only a paused, solo series or movie player. */
export function shouldRecheckOnRebuild(ctx: RecheckContext): boolean {
    if (!hasRecheckTarget(ctx)) return false;
    return !ctx.isPlaying() && !ctx.watchPartyActive();
}

/** A play after a long pause re-checks a solo series or movie player. */
export function shouldRecheckOnResume(ctx: RecheckContext): boolean {
    return hasRecheckTarget(ctx) && !ctx.watchPartyActive();
}

/**
 * Tracks the player's pauses: {@link PauseTracker.update} reports true when a
 * play follows a pause of at least {@link MARKER_RECHECK_IDLE_MS}, whether or
 * not the tab was hidden meanwhile. Only a pause after playback counts; the
 * paused state before the first play does not.
 */
export class PauseTracker {
    private playing = false;
    private pausedAt: number | null = null;

    update(playing: boolean, now: number): boolean {
        if (playing === this.playing) return false;
        this.playing = playing;
        if (!playing) {
            this.pausedAt = now;
            return false;
        }
        const pausedFor = this.pausedAt === null ? 0 : now - this.pausedAt;
        this.pausedAt = null;
        return pausedFor >= MARKER_RECHECK_IDLE_MS;
    }

    /** Another re-check just ran for this pause: the idle clock restarts. */
    markChecked(now: number): void {
        if (!this.playing && this.pausedAt !== null) this.pausedAt = now;
    }

    /** A new episode: forget the previous one's pause. */
    reset(): void {
        this.playing = false;
        this.pausedAt = null;
    }
}

/** Path (under the internal API prefix) of this player's marker request. */
export function markerRequestPath(ctx: RecheckContext): string {
    const query = new URLSearchParams({
        from: ctx.episodeId,
        fromPositionMs: String(Math.max(0, Math.floor(ctx.positionMs()))),
    });
    const sid = ctx.sessionId();
    if (sid) query.set('excludeSessionId', sid);
    return `/series/${ctx.seriesId}/watch-marker?${query.toString()}`;
}

function jumpUrl(ctx: RecheckContext, marker: SeriesWatchMarker): string | null {
    const ep = marker.episode;
    if (!ep) return null;
    const query = new URLSearchParams();
    if (ctx.seriesTitle) {
        query.set('slug', buildEpisodeSlug(ctx.seriesTitle, ep.seasonNumber, ep.episodeNumber));
    }
    query.set('resolved', 'series');
    query.set('from', ctx.episodeId);
    query.set('fromPos', String(Math.max(0, Math.floor(ctx.positionMs()))));
    if (ctx.episodeCode) query.set('fmk', ctx.episodeCode);
    query.set('mk', episodeCode(ep.seasonNumber, ep.episodeNumber));
    if (marker.deviceName) query.set('dev', marker.deviceName);
    return `/watch/${ep.id}?${query.toString()}`;
}

export function decideRecheck(ctx: RecheckContext, marker: SeriesWatchMarker): RecheckDecision {
    const intent = ctx.intent();
    const continueMode = intent.kind === 'continue' && intent.seriesId === ctx.seriesId;
    const forward = marker.relation === 'forward' && marker.episode !== null;
    const inThisFile = forward && (marker.episode?.id === ctx.episodeId || marker.sameFileAsFrom);

    if (continueMode) {
        if (marker.state === 'finished') {
            return marker.relation === 'behind' ? STAY : { kind: 'finished', marker };
        }
        if (!forward) return STAY;
        if (inThisFile) {
            return { kind: 'seek', positionMs: marker.positionMs, deviceName: marker.deviceName };
        }
        const url = jumpUrl(ctx, marker);
        return url ? { kind: 'jump', url } : STAY;
    }

    // A finished series says nothing about a chosen episode: a rewatch of E1
    // is never pointed at the finale.
    if (marker.state === 'finished' || !forward) return STAY;
    if (inThisFile) {
        return { kind: 'seek', positionMs: marker.positionMs, deviceName: marker.deviceName };
    }
    return { kind: 'hint', marker };
}

/**
 * Fetch the marker and decide. Never throws and never blocks: a failed or
 * empty response stays (M14). A return or rebuild re-check that finds the
 * player playing by the time the answer arrives does not move it (M4); the
 * mount re-check runs while autoplay is starting and applies regardless; a
 * resume re-check (play after a long pause) runs while playing: it seeks or
 * jumps only within {@link RESUME_RECHECK_APPLY_WINDOW_MS} of its start and
 * never raises the finished card over the episode the viewer chose to play.
 */
export async function resolveRecheck(
    ctx: RecheckContext,
    fetchMarker: (path: string) => Promise<SeriesWatchMarker | null>,
    trigger: RecheckTrigger,
    now: () => number = Date.now,
): Promise<RecheckDecision> {
    if (!ctx.seriesId) return STAY;
    const episodeAtStart = ctx.episodeId;
    const startedAt = now();
    let marker: SeriesWatchMarker | null;
    try {
        marker = await fetchMarker(markerRequestPath(ctx));
    } catch {
        return STAY;
    }
    if (!marker) return STAY;
    if (ctx.episodeId !== episodeAtStart || ctx.watchPartyActive()) return STAY;
    const decision = decideRecheck(ctx, marker);
    const moves = decision.kind === 'jump' || decision.kind === 'seek';
    if (trigger === 'mount' || !ctx.isPlaying()) return decision;
    if (trigger === 'resume') {
        // The viewer chose to play this episode: no finished card over it.
        if (decision.kind === 'finished') return STAY;
        if (moves && now() - startedAt > RESUME_RECHECK_APPLY_WINDOW_MS) return STAY;
        return decision;
    }
    return moves ? STAY : decision;
}

/**
 * The one mount-time re-check: a restored arrival (reload, back/forward — see
 * the watch page's `isRestoredArrival`) in continue mode that the server did
 * not just resolve (`resolved` absent). Autoplay lands via a client-side goto
 * and must never bounce — Safari's autoplay gesture chain depends on that
 * navigation staying put.
 */
export function shouldRunMountRecheck(input: {
    restored: boolean;
    params: URLSearchParams;
    autoplay: boolean;
    intent: WatchIntent;
}): boolean {
    if (!input.restored || input.autoplay) return false;
    if (input.intent.kind !== 'continue') return false;
    return !input.params.has('resolved');
}

/**
 * A movie's mount-time re-check: a restored arrival (reload, back/forward),
 * never the autoplay landing.
 */
export function shouldRunMovieMountRecheck(input: {
    restored: boolean;
    autoplay: boolean;
    movieId: string | null;
}): boolean {
    return input.movieId !== null && input.restored && !input.autoplay;
}

/** Path (under the internal API prefix) of a movie's watch-state request. */
export function movieStateRequestPath(movieId: string): string {
    return `/watch-state/${encodeURIComponent(movieId)}`;
}

export type MovieRecheckDecision = { kind: 'seek'; positionMs: number } | { kind: 'stay' };

/**
 * Forward-only: seek to the server position when the movie is not finished
 * and the server is more than {@link MOVIE_RECHECK_MIN_FORWARD_MS} ahead.
 */
export function decideMovieRecheck(input: {
    localMs: number;
    serverPositionMs: number;
    serverWatched: boolean;
}): MovieRecheckDecision {
    if (input.serverWatched) return { kind: 'stay' };
    if (input.serverPositionMs <= input.localMs + MOVIE_RECHECK_MIN_FORWARD_MS) {
        return { kind: 'stay' };
    }
    return { kind: 'seek', positionMs: input.serverPositionMs };
}

/**
 * Fetch the movie's watch state and decide, with the same timing rules as
 * {@link resolveRecheck}: never throws (M14), a return or rebuild re-check
 * does not move a player that started meanwhile (M4), the mount re-check
 * applies regardless, a resume re-check only within
 * {@link RESUME_RECHECK_APPLY_WINDOW_MS}. The seek carries no device name.
 */
export async function resolveMovieRecheck(
    ctx: RecheckContext,
    fetchState: (
        path: string,
    ) => Promise<Pick<WatchStateResponse, 'positionMs' | 'watched'> | null>,
    trigger: RecheckTrigger,
    now: () => number = Date.now,
): Promise<RecheckDecision> {
    const movieId = ctx.movieId;
    if (!movieId) return STAY;
    const startedAt = now();
    let state: Pick<WatchStateResponse, 'positionMs' | 'watched'> | null;
    try {
        state = await fetchState(movieStateRequestPath(movieId));
    } catch {
        return STAY;
    }
    if (!state) return STAY;
    if (ctx.movieId !== movieId || ctx.watchPartyActive()) return STAY;
    const decision = decideMovieRecheck({
        localMs: ctx.positionMs(),
        serverPositionMs: state.positionMs,
        serverWatched: state.watched,
    });
    if (decision.kind === 'stay') return STAY;
    const seek: RecheckDecision = {
        kind: 'seek',
        positionMs: decision.positionMs,
        deviceName: null,
    };
    if (trigger === 'mount' || !ctx.isPlaying()) return seek;
    if (trigger === 'resume' && now() - startedAt <= RESUME_RECHECK_APPLY_WINDOW_MS) return seek;
    return STAY;
}

interface VisibilityTarget extends EventTarget {
    visibilityState: string;
}

/**
 * Calls `onDue` when the tab returns after a long hide: `visibilitychange` to
 * visible after ≥ MARKER_RECHECK_IDLE_MS hidden, or a bfcache restore
 * (`pageshow.persisted`, which counts as a long return unless a shorter hide
 * was recorded). Gated by `shouldRecheck`. Returns the uninstall function.
 */
export function installMarkerRecheck(
    ctx: RecheckContext,
    onDue: () => void,
    env: { doc: VisibilityTarget; win: EventTarget; now: () => number },
): () => void {
    // A tab opened in the background (middle-click) starts hidden: its first
    // view is a return like any other.
    let hiddenAt: number | null = env.doc.visibilityState === 'hidden' ? env.now() : null;

    const check = (hiddenForMs: number): void => {
        if (shouldRecheck(ctx, hiddenForMs)) onDue();
    };

    const onVisibility = (): void => {
        if (env.doc.visibilityState === 'hidden') {
            hiddenAt = env.now();
            return;
        }
        if (hiddenAt === null) return;
        const hiddenFor = env.now() - hiddenAt;
        hiddenAt = null;
        check(hiddenFor);
    };

    const onPageShow = (event: Event): void => {
        if (!('persisted' in event) || event.persisted !== true) return;
        const hiddenFor = hiddenAt === null ? MARKER_RECHECK_IDLE_MS : env.now() - hiddenAt;
        hiddenAt = null;
        check(hiddenFor);
    };

    env.doc.addEventListener('visibilitychange', onVisibility);
    env.win.addEventListener('pageshow', onPageShow);
    return () => {
        env.doc.removeEventListener('visibilitychange', onVisibility);
        env.win.removeEventListener('pageshow', onPageShow);
    };
}
