// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    previewSessionKey,
    acquirePreviewSession,
    releasePreviewSession,
    invalidatePreviewSession,
    markPreviewSessionReady,
    __resetPreviewSessionCacheForTests,
    type PreviewSessionValue,
} from './preview-session-cache';

const BASE = {
    internalId: 'item-1',
    startPositionSeconds: 120,
    isLiveTv: false,
    trailerPreferred: false,
    trailerRequired: false,
};

function value(id = 's1'): PreviewSessionValue {
    return {
        playSessionId: id,
        sessionItemId: 'item-1',
        streamUrl: `/api/playback/item-1/hls/master.m3u8?PlaySessionId=${id}`,
        deliveryKind: 'hls',
        hlsStartPosition: 0,
    };
}

beforeEach(() => __resetPreviewSessionCacheForTests());

describe('previewSessionKey', () => {
    it('separates trailerRequired from trailerPreferred', () => {
        // THE WRONG-VIDEO PIN. The server computes
        // trailerProbe = trailerPreferred || trailerRequired and branches on
        // each independently, so folding them together can serve a snippet
        // for a required-trailer request.
        expect(previewSessionKey({ ...BASE, trailerRequired: true })).not.toBe(
            previewSessionKey({ ...BASE, trailerRequired: false }),
        );
    });

    it('separates every other field that changes the returned stream', () => {
        const base = previewSessionKey(BASE);
        expect(previewSessionKey({ ...BASE, internalId: 'other' })).not.toBe(base);
        expect(previewSessionKey({ ...BASE, startPositionSeconds: 121 })).not.toBe(base);
        expect(previewSessionKey({ ...BASE, fileId: 'f2' })).not.toBe(base);
        expect(previewSessionKey({ ...BASE, isLiveTv: true })).not.toBe(base);
        expect(previewSessionKey({ ...BASE, heroSafeCodec: true })).not.toBe(base);
        expect(previewSessionKey({ ...BASE, trailerPreferred: true })).not.toBe(base);
    });

    it('is stable for identical input', () => {
        expect(previewSessionKey(BASE)).toBe(previewSessionKey({ ...BASE }));
    });
});

describe('acquire/release', () => {
    it('reuses a live entry without calling create again', async () => {
        const create = vi.fn(async () => value());
        const k = previewSessionKey(BASE);
        const a = await acquirePreviewSession(k, create);
        const b = await acquirePreviewSession(k, create);
        expect(create).toHaveBeenCalledTimes(1);
        expect(b.value.streamUrl).toBe(a.value.streamUrl);
    });

    it('single-flights concurrent acquires', async () => {
        let resolve!: (v: PreviewSessionValue) => void;
        const create = vi.fn(() => new Promise<PreviewSessionValue>((r) => (resolve = r)));
        const k = previewSessionKey(BASE);
        const p1 = acquirePreviewSession(k, create);
        const p2 = acquirePreviewSession(k, create);
        resolve(value());
        const [a, b] = await Promise.all([p1, p2]);
        expect(create).toHaveBeenCalledTimes(1);
        expect(a.value.playSessionId).toBe(b.value.playSessionId);
    });

    it('deletes immediately on last release when the session was never ready', async () => {
        const onDelete = vi.fn();
        const k = previewSessionKey(BASE);
        const h = await acquirePreviewSession(k, async () => value(), { onDelete });
        releasePreviewSession(h);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('retains a ready session on last release instead of deleting it', async () => {
        const onDelete = vi.fn();
        const k = previewSessionKey(BASE);
        const h = await acquirePreviewSession(k, async () => value(), { onDelete });
        markPreviewSessionReady(h);
        releasePreviewSession(h);
        expect(onDelete).not.toHaveBeenCalled();
        const again = await acquirePreviewSession(k, async () => value('s2'));
        expect(again.value.playSessionId).toBe('s1');
    });

    it('does not delete while another holder is still using it', async () => {
        const onDelete = vi.fn();
        const k = previewSessionKey(BASE);
        const h1 = await acquirePreviewSession(k, async () => value(), { onDelete });
        const h2 = await acquirePreviewSession(k, async () => value(), { onDelete });
        releasePreviewSession(h1);
        expect(onDelete).not.toHaveBeenCalled();
        releasePreviewSession(h2);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('a double release of the same handle cannot tear down a session another holder is still using', async () => {
        // Concrete shape this pins: a hero slot acquires h1, a hover popup
        // acquires h2 for the same key (refCount = 2). The hero's teardown
        // runs twice (e.g. an effect cleanup plus an explicit stop) and
        // calls releasePreviewSession(h1) twice. The bare refCount<=0 guard
        // on the ENTRY does not catch this: the first release takes
        // refCount 2 -> 1 (no transition, so no early return), and a naive
        // second release of the same handle would take it 1 -> 0 and tear
        // the session down while the popup (h2) is still playing it.
        const onDelete = vi.fn();
        const k = previewSessionKey(BASE);
        const h1 = await acquirePreviewSession(k, async () => value(), { onDelete });
        const h2 = await acquirePreviewSession(k, async () => value(), { onDelete });

        releasePreviewSession(h1);
        releasePreviewSession(h1); // duplicate release of the SAME handle object

        expect(onDelete).not.toHaveBeenCalled();
        // h2's session must still be live: a fresh acquire for the same key
        // must return the existing entry (same playSessionId), not a newly
        // created one, and onDelete still must not have fired.
        const again = await acquirePreviewSession(k, async () => value('should-not-be-created'));
        expect(again.value.playSessionId).toBe(h2.value.playSessionId);
        expect(onDelete).not.toHaveBeenCalled();
    });

    // RETAINED_MAX = 2, per the fix-round-3 correction: the hero carousel
    // mounts the ACTIVE slide and its NEXT neighbour simultaneously, so
    // every rotation retires exactly one player while the carousel still
    // holds another retained entry. A cap of 1 is a guaranteed no-op for
    // that exact case (rotate forward retains A, rotate back retains C and
    // evicts A before the user ever returns to it) -- see the constant's
    // comment. The two tests below pin the cap-2 FIFO eviction behaviour
    // that makes the hero case actually work.
    it('releasing a second ready entry evicts nothing (cap = 2)', async () => {
        const deleted: string[] = [];
        const k1 = previewSessionKey({ ...BASE, internalId: 'a' });
        const h1 = await acquirePreviewSession(k1, async () => value('a'), {
            onDelete: (v) => deleted.push(v.playSessionId),
        });
        markPreviewSessionReady(h1);
        releasePreviewSession(h1);
        expect(deleted).toEqual([]); // one retained entry, well under the cap

        const k2 = previewSessionKey({ ...BASE, internalId: 'b' });
        const h2 = await acquirePreviewSession(k2, async () => value('b'), {
            onDelete: (v) => deleted.push(v.playSessionId),
        });
        markPreviewSessionReady(h2);
        releasePreviewSession(h2);
        // Both a and b fit under the cap of 2 -- this is exactly what lets
        // the hero carousel survive one rotation: the slide it just left
        // stays retained alongside the slide it had pre-warmed as a
        // neighbour.
        expect(deleted).toEqual([]);
    });

    it('releasing a third ready entry evicts the first (oldest), preserving order', async () => {
        const deleted: string[] = [];
        for (const id of ['a', 'b', 'c']) {
            const k = previewSessionKey({ ...BASE, internalId: id });
            const h = await acquirePreviewSession(k, async () => value(id), {
                onDelete: (v) => deleted.push(v.playSessionId),
            });
            markPreviewSessionReady(h);
            releasePreviewSession(h);
        }
        // Cap of 2: only the oldest-by-release-order entry is evicted when
        // a third arrives; b and c remain retained. This FIFO ordering is
        // what survives a carousel rotation past the second neighbour.
        expect(deleted).toEqual(['a']);
    });

    it('deletes a retained entry once the ~20s retention window elapses', async () => {
        // RETENTION_WINDOW_MS is bounded by the server's 30s no-heartbeat
        // sweep (preview-session.service.ts:214), not the 5-minute
        // absolute TTL -- see the module doc comment. 20s is the real
        // window; this test must track the constant, not a round number.
        vi.useFakeTimers();
        try {
            const onDelete = vi.fn();
            const k = previewSessionKey(BASE);
            const h = await acquirePreviewSession(k, async () => value(), { onDelete });
            markPreviewSessionReady(h);
            releasePreviewSession(h);
            expect(onDelete).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(20_000);
            expect(onDelete).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-acquiring within the retention window cancels the deletion', async () => {
        vi.useFakeTimers();
        try {
            const onDelete = vi.fn();
            const k = previewSessionKey(BASE);
            const h = await acquirePreviewSession(k, async () => value(), { onDelete });
            markPreviewSessionReady(h);
            releasePreviewSession(h);

            // Still inside the 20s window: re-acquiring here must cancel
            // the pending delete rather than merely defer it.
            await vi.advanceTimersByTimeAsync(15_000);
            const again = await acquirePreviewSession(k, async () => value('s2'));
            expect(again.value.playSessionId).toBe('s1');

            // Advance past where the ORIGINAL timer would have fired
            // (15_000 + 10_000 = 25_000 > 20_000). onDelete staying unfired
            // proves cancellation, not just deferral.
            await vi.advanceTimersByTimeAsync(10_000);
            expect(onDelete).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('invalidate', () => {
    it('forces the next acquire to create a fresh session', async () => {
        const k = previewSessionKey(BASE);
        const h = await acquirePreviewSession(k, async () => value('s1'));
        invalidatePreviewSession(h);
        const next = await acquirePreviewSession(k, async () => value('s2'));
        expect(next.value.playSessionId).toBe('s2');
    });

    it('makes a stale holder release a no-op', async () => {
        const onDelete = vi.fn();
        const k = previewSessionKey(BASE);
        const h1 = await acquirePreviewSession(k, async () => value('s1'), { onDelete });
        const h2 = await acquirePreviewSession(k, async () => value('s1'), { onDelete });
        invalidatePreviewSession(h1);
        // h1 and h2 shared one entry before either call. Per FIX 2,
        // invalidating h1 marks that shared entry invalidated rather than
        // deleting it out from under h2 (onDelete must not fire while h2
        // still holds it) -- so h2's own release still finds and
        // decrements the SAME entry normally, rather than hitting a
        // replacement. Only the fresh acquire below sees the invalidated
        // flag and skips reusing it.
        expect(() => releasePreviewSession(h2)).not.toThrow();
        const fresh = await acquirePreviewSession(k, async () => value('s3'));
        expect(fresh.value.playSessionId).toBe('s3');
    });

    it('does not delete an entry another holder still uses, even though it drops it from future lookups', async () => {
        // FIX 2 (fix-round-3): two hover cards on the same item in
        // different rows produce an IDENTICAL key (the hover path passes
        // no heroSafeCodec, so both normalize to false). If holder A's
        // player hits its retry-cap fatal on a session holder B is still
        // playing happily, invalidating A's handle must not kill B's
        // stream. The epoch guard (which protects release) does not by
        // itself cover this -- invalidate needed its own refCount check.
        const onDelete = vi.fn();
        const k = previewSessionKey(BASE);
        const hA = await acquirePreviewSession(k, async () => value(), { onDelete });
        const hB = await acquirePreviewSession(k, async () => value(), { onDelete });
        // Mark ready so a naive fix that only special-cases the "not
        // ready -> immediate delete" branch doesn't accidentally pass this
        // test for the wrong reason: an invalidated entry must delete
        // immediately on last release REGARDLESS of ready state, not get
        // retained.
        markPreviewSessionReady(hA);

        invalidatePreviewSession(hA);
        expect(onDelete).not.toHaveBeenCalled();
        // Holder B's value is still usable: its own handle was untouched
        // by invalidating a sibling handle for the same entry.
        expect(hB.value.playSessionId).toBe('s1');

        releasePreviewSession(hA);
        expect(onDelete).not.toHaveBeenCalled(); // B still holds it
        releasePreviewSession(hB);
        expect(onDelete).toHaveBeenCalledTimes(1); // last holder gone -> deleted exactly once, not retained
    });
});
