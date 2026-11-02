// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for RateSession — the `/rate` swipe-trainer store.
 *
 * All network deps are stubs (no $lib/api mocking needed): the store takes
 * injected `fetchQueue`/`submit`/`clear` functions per {@link RateSessionDeps}.
 */

import { describe, it, expect, vi } from 'vitest';
import { RateSession, type RateSessionDeps } from './rate-session.svelte';
import type { RatingCandidate } from '$lib/schemas/api-ai-responses';

function makeItem(id: string, over: Partial<RatingCandidate> = {}): RatingCandidate {
    return {
        externalIds: { tmdb: id },
        mediaType: 'movie',
        title: `Title ${id}`,
        ...over,
    };
}

function makeDeps(over: Partial<RateSessionDeps> = {}): RateSessionDeps {
    return {
        fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [] }),
        submit: vi.fn().mockResolvedValue({ ok: true }),
        clear: vi.fn().mockResolvedValue({ ok: true }),
        ...over,
    };
}

describe('RateSession', () => {
    it('start() loads the first page without a cursor and sets phase ready', async () => {
        const items = [makeItem('a'), makeItem('b')];
        const fetchQueue = vi.fn().mockResolvedValue({ status: 'ready', items, nextCursor: 'c1' });
        const session = new RateSession(makeDeps({ fetchQueue }), 3);

        await session.start();

        expect(session.cards).toEqual(items);
        expect(session.phase).toBe('ready');
        expect(session.busy).toBe(false);
        expect(fetchQueue).toHaveBeenCalledTimes(1);
        const call = (fetchQueue.mock.calls[0] as [{ filter: string; cursor?: string }])[0];
        expect(call.filter).toBe('all'); // spec §5: default Everything
        expect(call.cursor).toBeUndefined();
    });

    it('rate() sets busy synchronously before the await (race rule)', async () => {
        const item = makeItem('a');
        let resolveSubmit: (v: { ok: boolean }) => void = () => {};
        const submit = vi.fn(
            () =>
                new Promise<{ ok: boolean }>((resolve) => {
                    resolveSubmit = resolve;
                }),
        );
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [item] }),
                submit,
            }),
            0,
        );
        await session.start();

        const pending = session.rate(8, 'quick');
        expect(session.busy).toBe(true); // true before the submit() promise settles

        resolveSubmit({ ok: true });
        await pending;
        expect(session.busy).toBe(false);
    });

    it('rate() success removes the front card, bumps counters from the response, and sets undoable', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        const submit = vi.fn().mockResolvedValue({ ok: true, totalRatings: 11, milestone: 5 });
        const session = new RateSession(
            makeDeps({
                // Once for start(); any background refill after the rate() (deck
                // drops to 1, below the threshold) returns nothing further so it
                // can't reintroduce 'a' as a "new" item under this naive stub.
                fetchQueue: vi
                    .fn()
                    .mockResolvedValueOnce({ status: 'ready', items: [a, b] })
                    .mockResolvedValue({ status: 'exhausted', items: [] }),
                submit,
            }),
            10,
        );
        await session.start();

        await session.rate(8, 'quick');

        expect(submit).toHaveBeenCalledWith(a, 8, 'quick');
        expect(session.cards).toEqual([b]);
        expect(session.totalRatings).toBe(11); // from response, not client-incremented
        expect(session.sessionCount).toBe(1);
        expect(session.milestone).toBe(5);
        expect(session.undoable).toEqual({ item: a, rating: 8 });
        expect(session.lastError).toBeNull();
    });

    it('rate() failure keeps the card in place, sets lastError, and clears busy', async () => {
        const a = makeItem('a');
        const submit = vi.fn().mockResolvedValue({ ok: false });
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [a] }),
                submit,
            }),
            0,
        );
        await session.start();

        await session.rate(2, 'quick');

        expect(session.cards).toEqual([a]);
        expect(session.lastError).not.toBeNull();
        expect(session.busy).toBe(false);
        expect(session.totalRatings).toBe(0);
        expect(session.sessionCount).toBe(0);
        expect(session.undoable).toBeNull();
    });

    it('skip() removes the front card locally without touching the network', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        const submit = vi.fn();
        const clear = vi.fn();
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [a, b] }),
                submit,
                clear,
            }),
            0,
        );
        await session.start();

        session.skip();

        expect(session.cards).toEqual([b]);
        expect(submit).not.toHaveBeenCalled();
        expect(clear).not.toHaveBeenCalled();
    });

    it('skip() invokes recordSkip with the front card exactly once, and still removes the card + refills', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        const recordSkip = vi.fn();
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [a, b] }),
                recordSkip,
            }),
            0,
        );
        await session.start();

        session.skip();

        expect(recordSkip).toHaveBeenCalledTimes(1);
        expect(recordSkip).toHaveBeenCalledWith(a);
        expect(session.cards).toEqual([b]);
    });

    it('skip() does not throw and still removes the card when recordSkip is absent', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [a, b] }),
                // recordSkip intentionally omitted (undefined)
            }),
            0,
        );
        await session.start();

        expect(() => session.skip()).not.toThrow();
        expect(session.cards).toEqual([b]);
    });

    it('skip() does not throw and still removes the card when recordSkip throws', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        const recordSkip = vi.fn(() => {
            throw new Error('boom');
        });
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [a, b] }),
                recordSkip,
            }),
            0,
        );
        await session.start();

        expect(() => session.skip()).not.toThrow();
        expect(recordSkip).toHaveBeenCalledTimes(1);
        expect(session.cards).toEqual([b]);
    });

    it('refills at <=5 cards using the stored cursor and dedupes against the current deck', async () => {
        const deck = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeItem(id));
        const fetchQueue = vi
            .fn()
            .mockResolvedValueOnce({ status: 'ready', items: deck, nextCursor: 'c1' })
            .mockResolvedValueOnce({
                status: 'ready',
                items: [makeItem('b'), makeItem('g')], // 'b' is a duplicate already in the deck
                nextCursor: 'c2',
            });
        const submit = vi.fn().mockResolvedValue({ ok: true });
        const session = new RateSession(makeDeps({ fetchQueue, submit }), 0);
        await session.start();
        expect(session.cards).toHaveLength(6);

        await session.rate(8, 'quick'); // drops to 5 -> triggers background refill

        await vi.waitFor(() => expect(fetchQueue).toHaveBeenCalledTimes(2));
        const secondCall = (fetchQueue.mock.calls[1] as [{ cursor?: string }])[0];
        expect(secondCall.cursor).toBe('c1');
        await vi.waitFor(() => expect(session.cards).toHaveLength(6)); // +1 new, duplicate 'b' dropped
        expect(session.cards.map((c) => c.title)).toEqual([
            'Title b',
            'Title c',
            'Title d',
            'Title e',
            'Title f',
            'Title g',
        ]);
    });

    it('exhausted is terminal until setFilter() is called', async () => {
        const fetchQueue = vi
            .fn()
            .mockResolvedValueOnce({ status: 'exhausted', items: [] })
            .mockResolvedValueOnce({ status: 'ready', items: [makeItem('z')] });
        const session = new RateSession(makeDeps({ fetchQueue }), 0);

        await session.start();
        expect(session.phase).toBe('exhausted');
        expect(session.cards).toHaveLength(0);

        // skip()/rate() can't do anything with an empty deck, and refill must
        // not fire while phase is 'exhausted' — only one fetchQueue call so far.
        session.skip();
        expect(fetchQueue).toHaveBeenCalledTimes(1);

        await session.setFilter('seen');
        expect(fetchQueue).toHaveBeenCalledTimes(2);
        expect(session.phase).toBe('ready');
        expect(session.cards).toHaveLength(1);
    });

    it('undo() clears server-side, reinserts the card at the front, and reconciles counters from the response', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        const submit = vi.fn().mockResolvedValue({ ok: true, totalRatings: 5 });
        const clear = vi.fn().mockResolvedValue({ ok: true, totalRatings: 4 });
        const session = new RateSession(
            makeDeps({
                // Once for start(); background refill (deck drops below the
                // threshold after rate()) returns nothing further so it can't
                // reintroduce 'a' as a "new" item under this naive stub.
                fetchQueue: vi
                    .fn()
                    .mockResolvedValueOnce({ status: 'ready', items: [a, b] })
                    .mockResolvedValue({ status: 'exhausted', items: [] }),
                submit,
                clear,
            }),
            4,
        );
        await session.start();
        await session.rate(8, 'quick');
        expect(session.cards).toEqual([b]);
        expect(session.sessionCount).toBe(1);

        await session.undo();

        expect(clear).toHaveBeenCalledWith(a);
        expect(session.cards).toEqual([a, b]);
        expect(session.totalRatings).toBe(4); // from clear() response, not client math
        expect(session.sessionCount).toBe(0);
        expect(session.undoable).toBeNull();
    });

    it('milestone surfaces from a rate() response and acknowledgeMilestone() clears it', async () => {
        const a = makeItem('a');
        const submit = vi.fn().mockResolvedValue({ ok: true, milestone: 25 });
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi.fn().mockResolvedValue({ status: 'ready', items: [a] }),
                submit,
            }),
            0,
        );
        await session.start();

        await session.rate(10, 'quick');
        expect(session.milestone).toBe(25);

        session.acknowledgeMilestone();
        expect(session.milestone).toBeNull();
    });

    it('setFilter() resets the deck and cursor, fetching the fresh filter without a cursor', async () => {
        const fetchQueue = vi
            .fn()
            .mockResolvedValueOnce({
                status: 'ready',
                items: [makeItem('a')],
                nextCursor: 'c1',
            })
            .mockResolvedValueOnce({ status: 'ready', items: [makeItem('z')] });
        const session = new RateSession(makeDeps({ fetchQueue }), 0);
        await session.start();
        expect(session.filter).toBe('all'); // spec §5: default Everything

        await session.setFilter('seen');

        expect(session.filter).toBe('seen');
        expect(session.cards).toEqual([makeItem('z')]);
        expect(fetchQueue).toHaveBeenCalledTimes(2);
        const secondCall = (fetchQueue.mock.calls[1] as [{ filter: string; cursor?: string }])[0];
        expect(secondCall.filter).toBe('seen');
        expect(secondCall.cursor).toBeUndefined();
    });

    it('setFilter() during an in-flight rate() is a no-op (busy gate): deck not corrupted, no stale undoable', async () => {
        const a = makeItem('a');
        const b = makeItem('b');
        let resolveSubmit: (v: { ok: boolean; totalRatings?: number }) => void = () => {};
        const submit = vi.fn(
            () =>
                new Promise<{ ok: boolean; totalRatings?: number }>((resolve) => {
                    resolveSubmit = resolve;
                }),
        );
        const fetchQueue = vi
            .fn()
            .mockResolvedValueOnce({ status: 'ready', items: [a, b] })
            .mockResolvedValue({ status: 'exhausted', items: [] });
        const session = new RateSession(makeDeps({ fetchQueue, submit }), 0);
        await session.start();

        const pendingRate = session.rate(8, 'quick');
        expect(session.busy).toBe(true);

        await session.setFilter('seen'); // gated: must be a NO-OP while rate() is in flight
        expect(session.filter).toBe('all'); // unchanged
        expect(fetchQueue).toHaveBeenCalledTimes(1); // no new page fetched
        expect(session.cards).toEqual([a, b]); // deck untouched mid-flight

        resolveSubmit({ ok: true, totalRatings: 1 });
        await pendingRate;

        // The rate() resolved against the SAME deck it started on: front card
        // 'a' removed, undoable points at the genuinely rated card.
        expect(session.cards).toEqual([b]);
        expect(session.undoable).toEqual({ item: a, rating: 8 });
        expect(session.totalRatings).toBe(1);
    });

    it('discards a stale background refill that resolves after setFilter() (generation token)', async () => {
        const deck = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeItem(id));
        let resolveRefill: (v: {
            status: 'ready';
            items: RatingCandidate[];
            nextCursor?: string;
        }) => void = () => {};
        const fetchQueue = vi
            .fn()
            // start(): full deck
            .mockResolvedValueOnce({ status: 'ready', items: deck, nextCursor: 'c1' })
            // background refill after rate(): held open so it resolves late
            .mockImplementationOnce(
                () =>
                    new Promise<{
                        status: 'ready';
                        items: RatingCandidate[];
                        nextCursor?: string;
                    }>((resolve) => {
                        resolveRefill = resolve;
                    }),
            )
            // setFilter('seen'): the new session's first page
            .mockResolvedValueOnce({ status: 'ready', items: [makeItem('z')], nextCursor: 'z1' });
        const submit = vi.fn().mockResolvedValue({ ok: true });
        const session = new RateSession(makeDeps({ fetchQueue, submit }), 0);
        await session.start();

        await session.rate(8, 'quick'); // deck -> 5, refill fires (held open)
        await vi.waitFor(() => expect(fetchQueue).toHaveBeenCalledTimes(2));

        await session.setFilter('seen'); // bumps generation; loads fresh deck
        expect(session.cards).toEqual([makeItem('z')]);

        resolveRefill({ status: 'ready', items: [makeItem('OLD')], nextCursor: 'stale' });
        await vi.waitFor(() => expect(fetchQueue).toHaveBeenCalledTimes(3));
        await Promise.resolve(); // let the stale .then() settle

        // Old-filter items never appear; phase/cursor untouched by the stale page.
        expect(session.cards).toEqual([makeItem('z')]);
        expect(session.phase).toBe('ready');
        // Next refill must use the NEW session's cursor, not the stale one.
        session.skip(); // deck -> 0, triggers refill with the current cursor
        await vi.waitFor(() => expect(fetchQueue).toHaveBeenCalledTimes(4));
        const lastCall = (fetchQueue.mock.calls[3] as [{ cursor?: string }])[0];
        expect(lastCall.cursor).toBe('z1');
    });

    it('a second start() while the first is in flight is a no-op (no duplicated cards)', async () => {
        const items = [makeItem('a'), makeItem('b')];
        let resolveFetch: (v: { status: 'ready'; items: RatingCandidate[] }) => void = () => {};
        const fetchQueue = vi.fn(
            () =>
                new Promise<{ status: 'ready'; items: RatingCandidate[] }>((resolve) => {
                    resolveFetch = resolve;
                }),
        );
        const session = new RateSession(makeDeps({ fetchQueue }), 0);

        const first = session.start();
        const second = session.start(); // gated by busy: no-op

        expect(fetchQueue).toHaveBeenCalledTimes(1);
        resolveFetch({ status: 'ready', items });
        await Promise.all([first, second]);

        expect(session.cards).toEqual(items); // not duplicated
        expect(session.phase).toBe('ready');
        expect(session.busy).toBe(false);
    });

    it('a background refill failure keeps the deck visible (phase stays ready, lastError set) — only an empty-deck failure is a hard error', async () => {
        const deck = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeItem(id));
        const submit = vi.fn().mockResolvedValue({ ok: true });
        const fetchQueue = vi
            .fn()
            .mockResolvedValueOnce({ status: 'ready', items: deck, nextCursor: 'c1' }) // start()
            .mockRejectedValueOnce(new Error('refill boom')); // background refill after rate()
        const session = new RateSession(makeDeps({ fetchQueue, submit }), 0);
        await session.start();

        await session.rate(8, 'quick'); // drops to 5 -> triggers background refill
        await vi.waitFor(() => expect(fetchQueue).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(session.lastError).not.toBeNull());

        // Cards are still visible — the page must not hide the deck behind the
        // error screen for a refill hiccup the user hasn't even noticed.
        expect(session.cards).toHaveLength(5);
        expect(session.phase).toBe('ready');
        expect(session.lastError).toBe('refill boom');
    });

    it('Undo restores the deck after an empty-deck refill error', async () => {
        const item = makeItem('a');
        const fetchQueue = vi
            .fn()
            .mockResolvedValueOnce({ status: 'ready', items: [item], nextCursor: 'c1' })
            .mockRejectedValueOnce(new Error('refill failed'));
        const session = new RateSession(makeDeps({ fetchQueue }), 0);
        await session.start();
        await session.rate(8, 'quick');
        await vi.waitFor(() => expect(session.phase).toBe('error'));

        await session.undo();

        expect(session.cards).toEqual([item]);
        expect(session.phase).toBe('ready');
        expect(session.lastError).toBeNull();
        expect(session.undoable).toBeNull();
    });

    it('a failed FIRST load (empty deck) is a hard error — phase flips to error', async () => {
        const fetchQueue = vi.fn().mockRejectedValueOnce(new Error('load boom'));
        const session = new RateSession(makeDeps({ fetchQueue }), 0);

        await session.start();

        expect(session.cards).toHaveLength(0);
        expect(session.phase).toBe('error');
        expect(session.lastError).toBe('load boom');
    });

    it('undo() without totalRatings in the clear response decrements totalRatings locally', async () => {
        const a = makeItem('a');
        const submit = vi.fn().mockResolvedValue({ ok: true, totalRatings: 5 });
        const clear = vi.fn().mockResolvedValue({ ok: true }); // no totalRatings
        const session = new RateSession(
            makeDeps({
                fetchQueue: vi
                    .fn()
                    .mockResolvedValueOnce({ status: 'ready', items: [a] })
                    .mockResolvedValue({ status: 'exhausted', items: [] }),
                submit,
                clear,
            }),
            4,
        );
        await session.start();
        await session.rate(8, 'quick');
        expect(session.totalRatings).toBe(5);
        expect(session.sessionCount).toBe(1);

        await session.undo();

        expect(session.totalRatings).toBe(4); // local -1 fallback, never left inflated
        expect(session.sessionCount).toBe(0); // decremented only because clear was ok + applied
        expect(session.cards[0]).toEqual(a);
        expect(session.undoable).toBeNull();
    });
});
