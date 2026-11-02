// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { SeriesWatchMarker } from '$lib/schemas/api-series-responses';
import type { WatchIntent } from '$lib/stores/watch-intent';
import {
    MARKER_RECHECK_IDLE_MS,
    MOVIE_RECHECK_MIN_FORWARD_MS,
    PauseTracker,
    RESUME_RECHECK_APPLY_WINDOW_MS,
    decideMovieRecheck,
    decideRecheck,
    installMarkerRecheck,
    markerRequestPath,
    movieStateRequestPath,
    resolveMovieRecheck,
    resolveRecheck,
    shouldRecheck,
    shouldRecheckOnRebuild,
    shouldRecheckOnResume,
    shouldRunMountRecheck,
    shouldRunMovieMountRecheck,
    type RecheckContext,
} from './marker-recheck';

const SERIES = '11111111-1111-4111-8111-111111111111';
const E8 = '22222222-2222-4222-8222-222222222208';
const E10 = '22222222-2222-4222-8222-222222222210';
const CONTINUE: WatchIntent = { kind: 'continue', seriesId: SERIES };
const EPISODE: WatchIntent = { kind: 'episode' };

function ctx(overrides: Partial<RecheckContext> = {}): RecheckContext {
    return {
        intent: () => CONTINUE,
        episodeId: E8,
        episodeCode: 'S01E08',
        seriesId: SERIES,
        movieId: null,
        seriesTitle: 'Show',
        sessionId: () => 'sess-own',
        positionMs: () => 61_500.7,
        isPlaying: () => false,
        watchPartyActive: () => false,
        ...overrides,
    };
}

function marker(overrides: Partial<SeriesWatchMarker> = {}): SeriesWatchMarker {
    return {
        state: 'in_progress',
        episode: { id: E10, seasonNumber: 1, episodeNumber: 10, title: 'Ten', orderKey: 10_010 },
        progress: {
            positionMs: 1_320_000,
            durationMs: 2_640_000,
            fraction: 0.5,
            finished: false,
            updatedAt: '2026-09-23T10:00:00.000Z',
        },
        positionMs: 1_320_000,
        updatedAt: '2026-09-23T10:00:00.000Z',
        deviceName: 'iPhone',
        relation: 'forward',
        sameFileAsFrom: false,
        ...overrides,
    };
}

describe('shouldRecheck', () => {
    const long = MARKER_RECHECK_IDLE_MS + 1;

    it('rechecks a paused player after a long hide', () => {
        expect(shouldRecheck(ctx(), long)).toBe(true);
    });

    it('never while playing (M4)', () => {
        expect(shouldRecheck(ctx({ isPlaying: () => true }), long)).toBe(false);
    });

    it('never in a watch party (M11)', () => {
        expect(shouldRecheck(ctx({ watchPartyActive: () => true }), long)).toBe(false);
    });

    it('never after a short hide (M5)', () => {
        expect(shouldRecheck(ctx(), MARKER_RECHECK_IDLE_MS - 1)).toBe(false);
        expect(shouldRecheck(ctx(), 2 * 60_000)).toBe(false);
    });

    it('never without a series or a movie', () => {
        expect(shouldRecheck(ctx({ seriesId: null }), long)).toBe(false);
    });
});

describe('shouldRecheckOnRebuild', () => {
    it('a paused solo series player rechecks after its session was rebuilt', () => {
        expect(shouldRecheckOnRebuild(ctx())).toBe(true);
    });

    it('never while playing, in a watch party, or without a series', () => {
        expect(shouldRecheckOnRebuild(ctx({ isPlaying: () => true }))).toBe(false);
        expect(shouldRecheckOnRebuild(ctx({ watchPartyActive: () => true }))).toBe(false);
        expect(shouldRecheckOnRebuild(ctx({ seriesId: null }))).toBe(false);
    });
});

describe('PauseTracker (visible tab, long pause then play)', () => {
    const T0 = 1_000_000;

    it('a play after a pause of at least the idle threshold is due', () => {
        const t = new PauseTracker();
        expect(t.update(true, T0)).toBe(false);
        expect(t.update(false, T0 + 60_000)).toBe(false);
        expect(t.update(true, T0 + 60_000 + MARKER_RECHECK_IDLE_MS)).toBe(true);
    });

    it('a short pause is not due', () => {
        const t = new PauseTracker();
        t.update(true, T0);
        t.update(false, T0 + 1000);
        expect(t.update(true, T0 + 1000 + MARKER_RECHECK_IDLE_MS - 1)).toBe(false);
    });

    it('the paused state before the first play never counts', () => {
        const t = new PauseTracker();
        expect(t.update(true, T0 + 5 * MARKER_RECHECK_IDLE_MS)).toBe(false);
    });

    it('repeated updates with the same state change nothing', () => {
        const t = new PauseTracker();
        t.update(true, T0);
        t.update(false, T0);
        t.update(false, T0 + MARKER_RECHECK_IDLE_MS);
        expect(t.update(true, T0 + MARKER_RECHECK_IDLE_MS)).toBe(true);
    });

    it('a return re-check during the pause restarts the idle clock', () => {
        const t = new PauseTracker();
        t.update(true, T0);
        t.update(false, T0);
        t.markChecked(T0 + MARKER_RECHECK_IDLE_MS);
        expect(t.update(true, T0 + MARKER_RECHECK_IDLE_MS + 60_000)).toBe(false);
    });

    it('reset forgets the previous episode pause', () => {
        const t = new PauseTracker();
        t.update(true, T0);
        t.update(false, T0);
        t.reset();
        expect(t.update(true, T0 + 2 * MARKER_RECHECK_IDLE_MS)).toBe(false);
    });

    it('shouldRecheckOnResume: a solo series player only', () => {
        expect(shouldRecheckOnResume(ctx({ isPlaying: () => true }))).toBe(true);
        expect(shouldRecheckOnResume(ctx({ watchPartyActive: () => true }))).toBe(false);
        expect(shouldRecheckOnResume(ctx({ seriesId: null }))).toBe(false);
    });
});

describe('markerRequestPath', () => {
    it('carries from, the integer position and the own session id (M8)', () => {
        expect(markerRequestPath(ctx())).toBe(
            `/series/${SERIES}/watch-marker?from=${E8}&fromPositionMs=61500&excludeSessionId=sess-own`,
        );
    });

    it('omits excludeSessionId without a session', () => {
        expect(markerRequestPath(ctx({ sessionId: () => null }))).toBe(
            `/series/${SERIES}/watch-marker?from=${E8}&fromPositionMs=61500`,
        );
    });
});

describe('decideRecheck — continue intent', () => {
    it('M1: forward to another file jumps, with undo + toast params', () => {
        const d = decideRecheck(ctx(), marker());
        expect(d.kind).toBe('jump');
        if (d.kind !== 'jump') return;
        const url = new URL(d.url, 'http://x');
        expect(url.pathname).toBe(`/watch/${E10}`);
        expect(url.searchParams.get('resolved')).toBe('series');
        expect(url.searchParams.get('from')).toBe(E8);
        expect(url.searchParams.get('fromPos')).toBe('61500');
        expect(url.searchParams.get('fmk')).toBe('S01E08');
        expect(url.searchParams.get('mk')).toBe('S01E10');
        expect(url.searchParams.get('dev')).toBe('iPhone');
        expect(url.searchParams.get('slug')).toBeTruthy();
        expect(url.searchParams.has('sid')).toBe(false);
    });

    it('a jump without a device name carries no dev', () => {
        const d = decideRecheck(ctx(), marker({ deviceName: null }));
        expect(d.kind === 'jump' && new URL(d.url, 'http://x').searchParams.has('dev')).toBe(false);
    });

    it('M2: same episode further on seeks', () => {
        const d = decideRecheck(
            ctx(),
            marker({ episode: { ...marker().episode!, id: E8 }, positionMs: 900_000 }),
        );
        expect(d).toEqual({ kind: 'seek', positionMs: 900_000, deviceName: 'iPhone' });
    });

    it('M7: the sibling episode of a combined file seeks, never navigates', () => {
        const d = decideRecheck(ctx(), marker({ sameFileAsFrom: true }));
        expect(d).toEqual({ kind: 'seek', positionMs: 1_320_000, deviceName: 'iPhone' });
    });

    it.each(['behind', 'same', 'none'] as const)('M3: relation %s stays', (relation) => {
        expect(decideRecheck(ctx(), marker({ relation }))).toEqual({ kind: 'stay' });
    });

    it('M6: finished shows the finished card', () => {
        const m = marker({ state: 'finished', positionMs: 0 });
        expect(decideRecheck(ctx(), m)).toEqual({ kind: 'finished', marker: m });
    });

    it('finished behind the player stays', () => {
        expect(decideRecheck(ctx(), marker({ state: 'finished', relation: 'behind' }))).toEqual({
            kind: 'stay',
        });
    });

    it('a continue intent for another series behaves as episode intent', () => {
        const other: WatchIntent = { kind: 'continue', seriesId: 'other' };
        const m = marker();
        expect(decideRecheck(ctx({ intent: () => other }), m)).toEqual({
            kind: 'hint',
            marker: m,
        });
    });
});

describe('decideRecheck — episode intent', () => {
    const ep = (o: Partial<RecheckContext> = {}) => ctx({ intent: () => EPISODE, ...o });

    it('M1: forward to another episode only hints', () => {
        const m = marker();
        expect(decideRecheck(ep(), m)).toEqual({ kind: 'hint', marker: m });
    });

    it('M2/M7: same file further on seeks', () => {
        expect(decideRecheck(ep(), marker({ sameFileAsFrom: true })).kind).toBe('seek');
    });

    it('not forward stays', () => {
        expect(decideRecheck(ep(), marker({ relation: 'behind' }))).toEqual({ kind: 'stay' });
    });

    it('finished never hints: a rewatch paused early is not told about the finale', () => {
        const finale = marker({
            state: 'finished',
            episode: {
                id: E10,
                seasonNumber: 7,
                episodeNumber: 26,
                title: 'End',
                orderKey: 70_026,
            },
            positionMs: 0,
        });
        expect(decideRecheck(ep({ positionMs: () => 30_000 }), finale)).toEqual({
            kind: 'stay',
        });
    });

    it('finished in this same file stays rather than seeking', () => {
        expect(decideRecheck(ep(), marker({ state: 'finished', sameFileAsFrom: true }))).toEqual({
            kind: 'stay',
        });
    });
});

describe('resolveRecheck', () => {
    it('fetches the marker for this player and decides', async () => {
        const fetchMarker = vi.fn().mockResolvedValue(marker());
        const d = await resolveRecheck(ctx(), fetchMarker, 'return');
        expect(fetchMarker).toHaveBeenCalledWith(markerRequestPath(ctx()));
        expect(d.kind).toBe('jump');
    });

    it('M14: a failed request stays silently', async () => {
        const fetchMarker = vi.fn().mockRejectedValue(new Error('offline'));
        await expect(resolveRecheck(ctx(), fetchMarker, 'return')).resolves.toEqual({
            kind: 'stay',
        });
    });

    it('M14: no marker (non-2xx) stays', async () => {
        const fetchMarker = vi.fn().mockResolvedValue(null);
        await expect(resolveRecheck(ctx(), fetchMarker, 'return')).resolves.toEqual({
            kind: 'stay',
        });
    });

    it('a player started during the request is not moved (M4)', async () => {
        let playing = false;
        const fetchMarker = vi.fn().mockImplementation(async () => {
            playing = true;
            return marker();
        });
        const d = await resolveRecheck(ctx({ isPlaying: () => playing }), fetchMarker, 'return');
        expect(d).toEqual({ kind: 'stay' });
    });

    it('the mount check applies even though autoplay has started', async () => {
        const fetchMarker = vi.fn().mockResolvedValue(marker());
        const d = await resolveRecheck(ctx({ isPlaying: () => true }), fetchMarker, 'mount');
        expect(d.kind).toBe('jump');
    });

    it('a watch party joined during the request stays', async () => {
        let party = false;
        const fetchMarker = vi.fn().mockImplementation(async () => {
            party = true;
            return marker();
        });
        const d = await resolveRecheck(
            ctx({ watchPartyActive: () => party }),
            fetchMarker,
            'return',
        );
        expect(d).toEqual({ kind: 'stay' });
    });

    it('an episode change during the request (autoplay) stays', async () => {
        const c = ctx();
        const fetchMarker = vi.fn().mockImplementation(async () => {
            c.episodeId = E10;
            return marker();
        });
        await expect(resolveRecheck(c, fetchMarker, 'return')).resolves.toEqual({
            kind: 'stay',
        });
    });

    it('a rebuild re-check does not move a player that started playing', async () => {
        let playing = false;
        const fetchMarker = vi.fn().mockImplementation(async () => {
            playing = true;
            return marker();
        });
        const d = await resolveRecheck(ctx({ isPlaying: () => playing }), fetchMarker, 'rebuild');
        expect(d).toEqual({ kind: 'stay' });
    });

    it('resume: a fast answer jumps / seeks the now-playing player', async () => {
        let now = 0;
        const clock = () => now;
        const playing = ctx({ isPlaying: () => true });
        const fast = vi.fn().mockImplementation(async () => {
            now += RESUME_RECHECK_APPLY_WINDOW_MS;
            return marker();
        });
        expect((await resolveRecheck(playing, fast, 'resume', clock)).kind).toBe('jump');

        const seek = vi
            .fn()
            .mockResolvedValue(marker({ episode: { ...marker().episode!, id: E8 } }));
        expect((await resolveRecheck(playing, seek, 'resume', clock)).kind).toBe('seek');
    });

    it('resume: a slow answer no longer moves the player', async () => {
        let now = 0;
        const fetchMarker = vi.fn().mockImplementation(async () => {
            now += RESUME_RECHECK_APPLY_WINDOW_MS + 1;
            return marker();
        });
        const d = await resolveRecheck(
            ctx({ isPlaying: () => true }),
            fetchMarker,
            'resume',
            () => now,
        );
        expect(d).toEqual({ kind: 'stay' });
    });

    it('resume: a finished series shows no card over the chosen episode', async () => {
        const fetchMarker = vi.fn().mockResolvedValue(marker({ state: 'finished' }));
        const d = await resolveRecheck(ctx({ isPlaying: () => true }), fetchMarker, 'resume');
        expect(d).toEqual({ kind: 'stay' });
    });

    it('resume: an episode-mode hint still shows', async () => {
        const fetchMarker = vi.fn().mockResolvedValue(marker());
        const d = await resolveRecheck(
            ctx({ intent: () => EPISODE, isPlaying: () => true }),
            fetchMarker,
            'resume',
        );
        expect(d.kind).toBe('hint');
    });

    it.each(['mount', 'return', 'rebuild', 'resume'] as const)(
        '%s: an episode-mode finished marker stays',
        async (trigger) => {
            const fetchMarker = vi.fn().mockResolvedValue(marker({ state: 'finished' }));
            const d = await resolveRecheck(ctx({ intent: () => EPISODE }), fetchMarker, trigger);
            expect(d).toEqual({ kind: 'stay' });
        },
    );

    it('no series → no request', async () => {
        const fetchMarker = vi.fn();
        await resolveRecheck(ctx({ seriesId: null }), fetchMarker, 'return');
        expect(fetchMarker).not.toHaveBeenCalled();
    });
});

describe('shouldRunMountRecheck', () => {
    const base = {
        restored: true,
        params: new URLSearchParams(''),
        autoplay: false,
        intent: CONTINUE,
    };

    it('a reload / history restore in continue mode rechecks', () => {
        expect(shouldRunMountRecheck(base)).toBe(true);
    });

    it('the autoplay landing never rechecks', () => {
        // Autoplay is a client goto (not restored) and a continuation.
        expect(shouldRunMountRecheck({ ...base, restored: false, autoplay: true })).toBe(false);
        // Even a continuation flag on a restored entry is not re-checked.
        expect(shouldRunMountRecheck({ ...base, autoplay: true })).toBe(false);
    });

    it('a fresh arrival does not recheck', () => {
        expect(shouldRunMountRecheck({ ...base, restored: false })).toBe(false);
    });

    it('a landing that the server just resolved does not recheck', () => {
        expect(
            shouldRunMountRecheck({ ...base, params: new URLSearchParams('resolved=series') }),
        ).toBe(false);
    });

    it('episode intent does not recheck on mount', () => {
        expect(shouldRunMountRecheck({ ...base, intent: EPISODE })).toBe(false);
    });
});

describe('installMarkerRecheck', () => {
    function harness(c: RecheckContext = ctx()) {
        const doc = new EventTarget() as EventTarget & { visibilityState: string };
        doc.visibilityState = 'visible';
        const win = new EventTarget();
        let now = 1_000_000;
        const onDue = vi.fn();
        const uninstall = installMarkerRecheck(c, onDue, { doc, win, now: () => now });
        const hide = () => {
            doc.visibilityState = 'hidden';
            doc.dispatchEvent(new Event('visibilitychange'));
        };
        const show = () => {
            doc.visibilityState = 'visible';
            doc.dispatchEvent(new Event('visibilitychange'));
        };
        const pageshow = (persisted: boolean) => {
            const e = new Event('pageshow') as Event & { persisted: boolean };
            e.persisted = persisted;
            win.dispatchEvent(e);
        };
        return {
            onDue,
            uninstall,
            hide,
            show,
            pageshow,
            advance: (ms: number) => (now += ms),
        };
    }

    it('hidden → 11 min → visible fires once', () => {
        const h = harness();
        h.hide();
        h.advance(11 * 60_000);
        h.show();
        expect(h.onDue).toHaveBeenCalledTimes(1);
        h.show();
        expect(h.onDue).toHaveBeenCalledTimes(1);
    });

    it('hidden → 2 min → visible does not fire', () => {
        const h = harness();
        h.hide();
        h.advance(2 * 60_000);
        h.show();
        expect(h.onDue).not.toHaveBeenCalled();
    });

    it('a visible event without a recorded hide does not fire', () => {
        const h = harness();
        h.advance(60 * 60_000);
        h.show();
        expect(h.onDue).not.toHaveBeenCalled();
    });

    it('pageshow.persisted (bfcache) fires even without a recorded hide', () => {
        const h = harness();
        h.pageshow(true);
        expect(h.onDue).toHaveBeenCalledTimes(1);
    });

    it('pageshow.persisted after a short recorded hide does not fire', () => {
        const h = harness();
        h.hide();
        h.advance(60_000);
        h.pageshow(true);
        expect(h.onDue).not.toHaveBeenCalled();
    });

    it('a non-persisted pageshow does not fire', () => {
        const h = harness();
        h.pageshow(false);
        expect(h.onDue).not.toHaveBeenCalled();
    });

    it('a playing player is never rechecked on return', () => {
        const h = harness(ctx({ isPlaying: () => true }));
        h.hide();
        h.advance(30 * 60_000);
        h.show();
        expect(h.onDue).not.toHaveBeenCalled();
    });

    it('a tab opened in the background rechecks on its first long-delayed view', () => {
        const doc = new EventTarget() as EventTarget & { visibilityState: string };
        doc.visibilityState = 'hidden';
        let now = 1_000_000;
        const onDue = vi.fn();
        installMarkerRecheck(ctx(), onDue, { doc, win: new EventTarget(), now: () => now });
        now += 11 * 60_000;
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(onDue).toHaveBeenCalledTimes(1);
    });

    it('a background tab viewed soon after opening does not recheck', () => {
        const doc = new EventTarget() as EventTarget & { visibilityState: string };
        doc.visibilityState = 'hidden';
        let now = 1_000_000;
        const onDue = vi.fn();
        installMarkerRecheck(ctx(), onDue, { doc, win: new EventTarget(), now: () => now });
        now += 30_000;
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(onDue).not.toHaveBeenCalled();
    });

    it('uninstall removes the listeners', () => {
        const h = harness();
        h.uninstall();
        h.hide();
        h.advance(30 * 60_000);
        h.show();
        h.pageshow(true);
        expect(h.onDue).not.toHaveBeenCalled();
    });
});

// ---- Movies: same-item position refresh (M2) ----

const MOVIE = '33333333-3333-4333-8333-333333333333';

function movieCtx(overrides: Partial<RecheckContext> = {}): RecheckContext {
    return ctx({
        intent: () => EPISODE,
        episodeId: MOVIE,
        episodeCode: null,
        seriesId: null,
        movieId: MOVIE,
        seriesTitle: null,
        positionMs: () => 600_000,
        ...overrides,
    });
}

describe('decideMovieRecheck', () => {
    const local = 600_000;

    it('seeks when the server is more than 30 s ahead and not watched', () => {
        expect(
            decideMovieRecheck({
                localMs: local,
                serverPositionMs: local + MOVIE_RECHECK_MIN_FORWARD_MS + 1,
                serverWatched: false,
            }),
        ).toEqual({ kind: 'seek', positionMs: local + MOVIE_RECHECK_MIN_FORWARD_MS + 1 });
        expect(
            decideMovieRecheck({ localMs: 0, serverPositionMs: 3_600_000, serverWatched: false }),
        ).toEqual({ kind: 'seek', positionMs: 3_600_000 });
    });

    it.each([
        ['exactly 30 s ahead', local + MOVIE_RECHECK_MIN_FORWARD_MS],
        ['a little ahead', local + 5_000],
        ['the same position', local],
        ['behind (never backward, M3)', local - 120_000],
        ['at zero', 0],
    ])('stays when the server is %s', (_label, serverPositionMs) => {
        expect(
            decideMovieRecheck({ localMs: local, serverPositionMs, serverWatched: false }),
        ).toEqual({ kind: 'stay' });
    });

    it('stays when the movie was finished elsewhere', () => {
        expect(
            decideMovieRecheck({
                localMs: local,
                serverPositionMs: 5_000_000,
                serverWatched: true,
            }),
        ).toEqual({ kind: 'stay' });
    });
});

describe('movie trigger gating', () => {
    const long = MARKER_RECHECK_IDLE_MS + 1;

    it('a long return re-checks a paused solo movie player', () => {
        expect(shouldRecheck(movieCtx(), long)).toBe(true);
        expect(shouldRecheck(movieCtx(), MARKER_RECHECK_IDLE_MS - 1)).toBe(false);
        expect(shouldRecheck(movieCtx({ isPlaying: () => true }), long)).toBe(false);
        expect(shouldRecheck(movieCtx({ watchPartyActive: () => true }), long)).toBe(false);
    });

    it('a session rebuild re-checks a paused solo movie player', () => {
        expect(shouldRecheckOnRebuild(movieCtx())).toBe(true);
        expect(shouldRecheckOnRebuild(movieCtx({ isPlaying: () => true }))).toBe(false);
        expect(shouldRecheckOnRebuild(movieCtx({ watchPartyActive: () => true }))).toBe(false);
    });

    it('a play after a long pause re-checks a solo movie player', () => {
        expect(shouldRecheckOnResume(movieCtx({ isPlaying: () => true }))).toBe(true);
        expect(shouldRecheckOnResume(movieCtx({ watchPartyActive: () => true }))).toBe(false);
    });

    it('a background-opened movie tab re-checks on its first long-delayed view', () => {
        const doc = new EventTarget() as EventTarget & { visibilityState: string };
        doc.visibilityState = 'hidden';
        let now = 1_000_000;
        const onDue = vi.fn();
        installMarkerRecheck(movieCtx(), onDue, { doc, win: new EventTarget(), now: () => now });
        now += MARKER_RECHECK_IDLE_MS + 1;
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(onDue).toHaveBeenCalledTimes(1);
    });
});

describe('shouldRunMovieMountRecheck', () => {
    it('a reload / history restore of a movie re-checks', () => {
        expect(
            shouldRunMovieMountRecheck({ restored: true, autoplay: false, movieId: MOVIE }),
        ).toBe(true);
    });

    it('never for autoplay, a fresh arrival, or a non-movie', () => {
        expect(shouldRunMovieMountRecheck({ restored: true, autoplay: true, movieId: MOVIE })).toBe(
            false,
        );
        expect(
            shouldRunMovieMountRecheck({ restored: false, autoplay: false, movieId: MOVIE }),
        ).toBe(false);
        expect(shouldRunMovieMountRecheck({ restored: true, autoplay: false, movieId: null })).toBe(
            false,
        );
    });
});

describe('resolveMovieRecheck', () => {
    const ahead = { positionMs: 3_000_000, watched: false };

    it("fetches this movie's watch state and seeks forward without a device", async () => {
        const fetchState = vi.fn().mockResolvedValue(ahead);
        const d = await resolveMovieRecheck(movieCtx(), fetchState, 'return');
        expect(fetchState).toHaveBeenCalledWith(movieStateRequestPath(MOVIE));
        expect(movieStateRequestPath(MOVIE)).toBe(`/watch-state/${MOVIE}`);
        expect(d).toEqual({ kind: 'seek', positionMs: 3_000_000, deviceName: null });
    });

    it('M14: a failed or empty request stays silently', async () => {
        const failing = vi.fn().mockRejectedValue(new Error('offline'));
        await expect(resolveMovieRecheck(movieCtx(), failing, 'return')).resolves.toEqual({
            kind: 'stay',
        });
        const empty = vi.fn().mockResolvedValue(null);
        await expect(resolveMovieRecheck(movieCtx(), empty, 'return')).resolves.toEqual({
            kind: 'stay',
        });
    });

    it('decides against the position at answer time (never backward)', async () => {
        let localMs = 600_000;
        const fetchState = vi.fn().mockImplementation(async () => {
            localMs = 2_990_000;
            return ahead;
        });
        const d = await resolveMovieRecheck(
            movieCtx({ positionMs: () => localMs }),
            fetchState,
            'return',
        );
        expect(d).toEqual({ kind: 'stay' });
    });

    it('a player started during a return request is not moved (M4)', async () => {
        let playing = false;
        const fetchState = vi.fn().mockImplementation(async () => {
            playing = true;
            return ahead;
        });
        const d = await resolveMovieRecheck(
            movieCtx({ isPlaying: () => playing }),
            fetchState,
            'return',
        );
        expect(d).toEqual({ kind: 'stay' });
    });

    it('the mount check applies even though playback has started', async () => {
        const fetchState = vi.fn().mockResolvedValue(ahead);
        const d = await resolveMovieRecheck(
            movieCtx({ isPlaying: () => true }),
            fetchState,
            'mount',
        );
        expect(d.kind).toBe('seek');
    });

    it('resume: a fast answer seeks, a slow one no longer moves the player', async () => {
        let now = 0;
        const playing = movieCtx({ isPlaying: () => true });
        const fast = vi.fn().mockImplementation(async () => {
            now += RESUME_RECHECK_APPLY_WINDOW_MS;
            return ahead;
        });
        expect((await resolveMovieRecheck(playing, fast, 'resume', () => now)).kind).toBe('seek');
        const slow = vi.fn().mockImplementation(async () => {
            now += RESUME_RECHECK_APPLY_WINDOW_MS + 1;
            return ahead;
        });
        expect(await resolveMovieRecheck(playing, slow, 'resume', () => now)).toEqual({
            kind: 'stay',
        });
    });

    it('a watch party joined, or another item loaded, during the request stays', async () => {
        let party = false;
        const joins = vi.fn().mockImplementation(async () => {
            party = true;
            return ahead;
        });
        expect(
            await resolveMovieRecheck(movieCtx({ watchPartyActive: () => party }), joins, 'return'),
        ).toEqual({ kind: 'stay' });

        const live = { movieId: MOVIE as string | null };
        const c = movieCtx();
        Object.defineProperty(c, 'movieId', { get: () => live.movieId });
        const switches = vi.fn().mockImplementation(async () => {
            live.movieId = '44444444-4444-4444-8444-444444444444';
            return ahead;
        });
        expect(await resolveMovieRecheck(c, switches, 'return')).toEqual({ kind: 'stay' });
    });

    it('no movie → no request', async () => {
        const fetchState = vi.fn();
        await resolveMovieRecheck(ctx(), fetchState, 'return');
        expect(fetchState).not.toHaveBeenCalled();
    });
});
