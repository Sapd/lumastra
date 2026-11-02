// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    isRestoredArrival,
    landingHoldsPlayback,
    landingStartSeconds,
    readWatchLanding,
    stripWatchLandingParams,
    WATCH_LANDING_PARAMS,
} from './landing-params.js';

const EP = '22222222-2222-4222-8222-222222222210';

describe('stripWatchLandingParams', () => {
    it('M10: removes every landing param and keeps slug', () => {
        const url = new URL(
            `http://localhost/watch/${EP}?slug=show-s01e10&resolved=series&info=Playing&dev=iPhone&mk=S01E10&seekMs=5&from=x&fromPos=1&sid=s`,
        );
        const stripped = stripWatchLandingParams(url);
        expect(stripped?.toString()).toBe(`http://localhost/watch/${EP}?slug=show-s01e10`);
    });

    it('keeps playback params that are not landing-only', () => {
        const url = new URL(
            `http://localhost/watch/${EP}?resolved=stay&t=90&playlist=3&position=2&fileId=f&ctx=col`,
        );
        const stripped = stripWatchLandingParams(url);
        expect(stripped?.searchParams.has('resolved')).toBe(false);
        for (const key of ['t', 'playlist', 'position', 'fileId', 'ctx']) {
            expect(stripped?.searchParams.has(key)).toBe(true);
        }
    });

    it('returns null when there is nothing to strip', () => {
        expect(stripWatchLandingParams(new URL(`http://localhost/watch/${EP}?slug=a`))).toBeNull();
    });

    it('does not mutate its input', () => {
        const url = new URL(`http://localhost/watch/${EP}?resolved=series`);
        stripWatchLandingParams(url);
        expect(url.searchParams.get('resolved')).toBe('series');
    });

    it('covers exactly the params the series redirect emits, plus the entry of linear links', () => {
        expect([...WATCH_LANDING_PARAMS].sort()).toEqual(
            [
                'age',
                'dev',
                'entry',
                'fmk',
                'from',
                'fromPos',
                'hchain',
                'hn',
                'info',
                'mk',
                'resolved',
                'seekMs',
                'sid',
            ].sort(),
        );
    });
});

const FROM = '22222222-2222-4222-8222-222222222208';
const q = (query: string) => new URLSearchParams(query);

describe('readWatchLanding — exactly one notice per landing', () => {
    it('no params → none', () => {
        expect(readWatchLanding(q(''))).toEqual({ kind: 'none' });
    });

    it('resolved=series without from → the info toast', () => {
        expect(readWatchLanding(q('resolved=series&info=Playing+S01E10&mk=S01E10'))).toEqual({
            kind: 'info',
            message: 'Playing S01E10',
        });
    });

    it('resolved=series with from → continued (undo target, no info toast)', () => {
        expect(
            readWatchLanding(
                q(
                    `resolved=series&from=${FROM}&fromPos=61000&fmk=S01E08&mk=S01E10&dev=iPhone&info=x`,
                ),
            ),
        ).toEqual({
            kind: 'continued',
            markerCode: 'S01E10',
            device: 'iPhone',
            fromEpisodeId: FROM,
            fromPositionMs: 61_000,
            fromCode: 'S01E08',
            seekMs: null,
        });
    });

    it('a resume-handoff jump carries where it put the player', () => {
        expect(readWatchLanding(q(`resolved=series&from=${FROM}&mk=S01E10&seekMs=3000`))).toMatchObject({
            kind: 'continued',
            seekMs: 3000,
        });
    });

    it('continued tolerates a missing fromPos / fmk / dev', () => {
        expect(readWatchLanding(q(`resolved=series&from=${FROM}&mk=S01E10`))).toEqual({
            kind: 'continued',
            markerCode: 'S01E10',
            device: null,
            fromEpisodeId: FROM,
            fromPositionMs: null,
            fromCode: null,
            seekMs: null,
        });
    });

    it('resolved=seek → resumed at seekMs', () => {
        expect(readWatchLanding(q('resolved=seek&seekMs=1320000&dev=iPhone'))).toEqual({
            kind: 'resumed',
            seekMs: 1_320_000,
            device: 'iPhone',
            fromPositionMs: null,
        });
    });

    it('a resume handoff in place (resolved=seek with from) has an undo target', () => {
        expect(
            readWatchLanding(q(`resolved=seek&seekMs=1500000&from=${FROM}&fromPos=600000&dev=TV`)),
        ).toEqual({ kind: 'resumed', seekMs: 1_500_000, device: 'TV', fromPositionMs: 600_000 });
    });

    it('resolved=seek with a bad seekMs → none', () => {
        expect(readWatchLanding(q('resolved=seek&seekMs=abc'))).toEqual({ kind: 'none' });
        expect(readWatchLanding(q('resolved=seek&seekMs=-5'))).toEqual({ kind: 'none' });
    });

    it('resolved=stay → none, even with info', () => {
        expect(readWatchLanding(q('resolved=stay&info=x'))).toEqual({ kind: 'none' });
    });

    it('resolved=finished → the finished card, never the info toast', () => {
        expect(readWatchLanding(q('resolved=finished&info=Series+finished&dev=iPad'))).toEqual({
            kind: 'finished',
            device: 'iPad',
        });
    });

    it('other resolved values with info keep the info toast (season, episode-query)', () => {
        expect(readWatchLanding(q('resolved=season&info=Opened+S02E01'))).toEqual({
            kind: 'info',
            message: 'Opened S02E01',
        });
    });

    it('info without resolved is ignored', () => {
        expect(readWatchLanding(q('info=x'))).toEqual({ kind: 'none' });
    });
});

describe('landingHoldsPlayback', () => {
    it('holds a finished landing and a re-check jump paused', () => {
        expect(landingHoldsPlayback(q('resolved=finished'))).toBe(true);
        expect(landingHoldsPlayback(q(`resolved=series&from=${FROM}`))).toBe(true);
    });

    it('autoplays every other landing', () => {
        expect(landingHoldsPlayback(q(''))).toBe(false);
        expect(landingHoldsPlayback(q('resolved=series&info=x'))).toBe(false);
        expect(landingHoldsPlayback(q('resolved=seek&seekMs=5'))).toBe(false);
        expect(landingHoldsPlayback(q('t=30'))).toBe(false);
    });

    it('a resume handoff in place away from a paused player holds', () => {
        expect(landingHoldsPlayback(q(`resolved=seek&seekMs=5&from=${FROM}`))).toBe(true);
    });
});

describe('landingStartSeconds', () => {
    it('uses a positive t', () => {
        expect(landingStartSeconds(q('t=270'))).toBe(270);
    });

    it('ignores a zero / invalid t', () => {
        expect(landingStartSeconds(q('t=0'))).toBeUndefined();
        expect(landingStartSeconds(q('t=abc'))).toBeUndefined();
    });

    it('a seek landing starts at seekMs, in SECONDS', () => {
        expect(landingStartSeconds(q('resolved=seek&seekMs=1320500'))).toBe(1320.5);
    });

    it('t wins over seekMs', () => {
        expect(landingStartSeconds(q('t=10&resolved=seek&seekMs=1320000'))).toBe(10);
    });

    it('a resume-handoff jump starts at its seekMs', () => {
        expect(landingStartSeconds(q(`resolved=series&from=${FROM}&seekMs=3000`))).toBe(3);
    });

    it('seekMs without resolved=seek is ignored', () => {
        expect(landingStartSeconds(q('seekMs=1320000'))).toBeUndefined();
    });
});

describe('isRestoredArrival', () => {
    it('a document reload or back/forward entry is a restore', () => {
        expect(isRestoredArrival('enter', 'reload')).toBe(true);
        expect(isRestoredArrival('enter', 'back_forward')).toBe(true);
    });

    it('a fresh document entry is not', () => {
        expect(isRestoredArrival('enter', 'navigate')).toBe(false);
        expect(isRestoredArrival('enter', undefined)).toBe(false);
    });

    it('a client-side history pop is a restore', () => {
        expect(isRestoredArrival('popstate', undefined)).toBe(true);
    });

    it('a client-side goto / link (autoplay, picker) is not, whatever the document entry', () => {
        expect(isRestoredArrival('goto', 'reload')).toBe(false);
        expect(isRestoredArrival('link', 'back_forward')).toBe(false);
    });
});
