// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScrollRestorer, RESTORE_TIMEOUT_MS, SETTLE_MS } from './scroll-restoration.js';

/** A scroller whose content height the test controls (happy-dom has no layout). */
function fakeScroller(initialHeight: number) {
    const state = { scrollHeight: initialHeight, clientHeight: 800, top: 0 };
    const el = {
        get scrollHeight() {
            return state.scrollHeight;
        },
        get clientHeight() {
            return state.clientHeight;
        },
        get scrollTop() {
            return state.top;
        },
        set scrollTop(v: number) {
            state.top = Math.max(0, Math.min(v, state.scrollHeight - state.clientHeight));
        },
    } as unknown as HTMLElement;
    return { el, state };
}

const u = (p: string): URL => new URL(p, 'https://example.test');

describe('createScrollRestorer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('Back restores the offset the page was left at', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 1500;
        r.save(u('/browse'));
        r.afterNavigate(u('/browse'), u('/browse/filter?genre=Comedy'), 'link');
        expect(state.top).toBe(0);

        r.save(u('/browse/filter?genre=Comedy'));
        r.afterNavigate(u('/browse/filter?genre=Comedy'), u('/browse'), 'popstate');
        expect(state.top).toBe(1500);
    });

    it('waits for client-loaded content to grow tall enough, then restores', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 1500;
        r.save(u('/browse'));

        state.scrollHeight = 1200; // the page re-mounted with rows still loading
        r.afterNavigate(u('/browse/filter?genre=X'), u('/browse'), 'popstate');
        expect(state.top).toBe(400); // clamped for now

        state.scrollHeight = 4000; // rows arrived
        vi.advanceTimersByTime(100);
        expect(state.top).toBe(1500);
    });

    it('keeps holding the offset while content above it is still settling', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 1500;
        r.save(u('/browse'));

        state.scrollHeight = 3000; // already tall enough on arrival
        r.afterNavigate(u('/browse/filter?genre=X'), u('/browse'), 'popstate');
        expect(state.top).toBe(1500);

        // Skeletons above swap for real rows; scroll anchoring drags the offset.
        vi.advanceTimersByTime(200);
        state.scrollHeight = 3400;
        state.top = 725;
        vi.advanceTimersByTime(100);
        expect(state.top).toBe(1500);

        // Settled: the restore lets go, and a later offset is the user's own.
        vi.advanceTimersByTime(SETTLE_MS + 100);
        state.top = 300;
        vi.advanceTimersByTime(500);
        expect(state.top).toBe(300);
    });

    it('stops restoring once the user scrolls themselves', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 1500;
        r.save(u('/browse'));

        state.scrollHeight = 1200;
        r.afterNavigate(u('/other'), u('/browse'), 'popstate');
        window.dispatchEvent(new Event('wheel'));
        state.scrollHeight = 4000;
        state.top = 50;
        vi.advanceTimersByTime(200);
        expect(state.top).toBe(50);
    });

    it('gives up after the timeout if the page never grows', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 3000;
        r.save(u('/browse'));
        state.scrollHeight = 1000;
        r.afterNavigate(u('/other'), u('/browse'), 'popstate');
        vi.advanceTimersByTime(RESTORE_TIMEOUT_MS + 100);
        state.scrollHeight = 5000;
        vi.advanceTimersByTime(200);
        expect(state.top).toBe(200);
    });

    it('leaves same-page (query-only) navigations to the page', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 900;
        r.save(u('/browse/filter?genre=A'));
        r.afterNavigate(
            u('/browse/filter?genre=A'),
            u('/browse/filter?genre=A&sort=year_desc'),
            'goto',
        );
        expect(state.top).toBe(900);
        r.afterNavigate(u('/browse?modal=x'), u('/browse'), 'popstate');
        expect(state.top).toBe(900);
    });

    it.each(['/docs#section', '/browse?sort=year_desc'])(
        'cancels a pending restore before navigating to %s',
        (target) => {
            const { el, state } = fakeScroller(4000);
            const r = createScrollRestorer(() => el);
            state.top = 1500;
            r.save(u('/browse'));
            r.afterNavigate(u('/other'), u('/browse'), 'popstate');
            r.afterNavigate(u('/browse'), u(target), 'goto');
            state.top = 250;
            vi.advanceTimersByTime(200);
            expect(state.top).toBe(250);
        },
    );

    it('does nothing on the initial load or toward an anchor', () => {
        const { el, state } = fakeScroller(4000);
        const r = createScrollRestorer(() => el);
        state.top = 700;
        r.afterNavigate(null, u('/browse'), 'enter');
        r.afterNavigate(u('/a'), u('/docs#section'), 'link');
        expect(state.top).toBe(700);
    });
});
