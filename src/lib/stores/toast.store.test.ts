// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign, spec §6/§7: on `/admin` pages, error toasts require
 * acknowledge-to-dismiss — they must never auto-time-out there, regardless
 * of the timeout the caller passes (or the shared 5s default every other
 * toast type gets). This store is a single global singleton also used by
 * the consumer-facing (non-admin) app, which is explicitly out of this
 * redesign's scope (spec §8) — so the rule must not leak there.
 *
 * This suite runs under vitest's default `node` environment (no `window`),
 * which `isAdminRoute()` treats as the safe/sticky default — the same
 * behavior as an actual `/admin` page. The route-scoping itself is verified
 * below by stubbing `window.location.pathname`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportUserFacingFailure = vi.hoisted(() => vi.fn());
vi.mock('$lib/client-diagnostics/web-reporter.js', () => ({ reportUserFacingFailure }));

import { CALM_ERROR_TIMEOUT_MS, toasts, type Toast } from './toast.store.svelte.js';

function currentToasts(): Toast[] {
    let snapshot: Toast[] = [];
    const unsub = toasts.subscribe((v) => {
        snapshot = v;
    });
    unsub();
    return snapshot;
}

describe('toasts store — error acknowledge-to-dismiss', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        toasts.clear();
    });

    afterEach(() => {
        toasts.clear();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('an error toast is never auto-removed, even after a long time', () => {
        toasts.error('Something broke');
        expect(currentToasts().length).toBe(1);

        vi.advanceTimersByTime(10 * 60 * 1000);

        expect(currentToasts().length).toBe(1);
    });

    it('an error toast ignores a caller-supplied timeout — still never auto-dismisses', () => {
        toasts.error('Something broke', { timeout: 1000 });
        vi.advanceTimersByTime(5000);

        expect(currentToasts().length).toBe(1);
    });

    it('a non-error toast still auto-dismisses on its timeout', () => {
        toasts.success('Saved');
        expect(currentToasts().length).toBe(1);

        vi.advanceTimersByTime(5000);

        expect(currentToasts().length).toBe(0);
    });

    it('an error toast is dismissed by explicit remove() (the acknowledge action)', () => {
        const id = toasts.error('Something broke');
        expect(currentToasts().length).toBe(1);

        toasts.remove(id);

        expect(currentToasts().length).toBe(0);
    });

    it('on an /admin page, an error toast is still never auto-removed', () => {
        vi.stubGlobal('window', { location: { pathname: '/admin/tasks' } });

        toasts.error('Something broke');
        vi.advanceTimersByTime(10 * 60 * 1000);

        expect(currentToasts().length).toBe(1);
    });

    it('on a non-admin (main app) page, an error toast auto-dismisses on the default timeout — spec §8 scopes the sticky rule to /admin', () => {
        vi.stubGlobal('window', { location: { pathname: '/movie/123' } });

        toasts.error('Could not add to watchlist');
        expect(currentToasts().length).toBe(1);

        vi.advanceTimersByTime(5000);

        expect(currentToasts().length).toBe(0);
    });

    it('on a non-admin page, an error toast still honors an explicit caller timeout', () => {
        vi.stubGlobal('window', { location: { pathname: '/search' } });

        toasts.error('Search failed', { timeout: 1000 });
        vi.advanceTimersByTime(1000);

        expect(currentToasts().length).toBe(0);
    });
});

describe('toasts store — calm mode (Live TV simple mode)', () => {
    afterEach(() => {
        toasts.clear();
        vi.unstubAllGlobals();
    });

    it('drops non-error toasts while held, keeps errors up longer, and nests', () => {
        vi.stubGlobal('window', { location: { pathname: '/livetv' } });
        const releaseA = toasts.setCalm(true);
        const releaseB = toasts.setCalm(true);
        expect(toasts.info('hello')).toBe(0);
        expect(toasts.success('saved')).toBe(0);
        let list: Toast[] = [];
        const unsub = toasts.subscribe((v) => (list = v));
        toasts.error('broken', 1000);
        expect(list.at(-1)?.timeout).toBeGreaterThanOrEqual(CALM_ERROR_TIMEOUT_MS);
        toasts.error('sticky', 0);
        expect(list.at(-1)?.timeout).toBe(0);
        releaseA();
        releaseA();
        expect(toasts.info('still calm')).toBe(0);
        releaseB();
        expect(toasts.info('back')).toBeGreaterThan(0);
        unsub();
    });
});

describe('toasts store — diagnostics', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        toasts.clear();
        reportUserFacingFailure.mockClear();
    });
    afterEach(() => {
        toasts.clear();
        vi.useRealTimers();
    });

    it('reports every error toast with its key and error, never its text', () => {
        const err = new Error('boom');
        toasts.error('Could not play "My Private Title"', {
            diagnosticKey: 'music_playback_failed',
            diagnosticError: err,
        });
        toasts.error('untagged failure');
        toasts.show('shown as error', 'error');
        expect(reportUserFacingFailure.mock.calls).toEqual([
            [{ key: 'music_playback_failed', error: err }],
            [{ key: undefined, error: undefined }],
            [{ key: undefined, error: undefined }],
        ]);
        expect(JSON.stringify(reportUserFacingFailure.mock.calls)).not.toContain('Private');
    });

    it('does not report success, info or warning toasts', () => {
        toasts.success('saved');
        toasts.info('fyi');
        toasts.warning('careful');
        expect(reportUserFacingFailure).not.toHaveBeenCalled();
    });
});
