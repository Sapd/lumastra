// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { pickEvictionVictim } from './preview-eviction';

type S = Parameters<typeof pickEvictionVictim>[0][number];

function session(over: Partial<S> & { playSessionId: string }): S {
    return {
        playSessionId: over.playSessionId,
        createdAt: over.createdAt ?? new Date(0),
        lastHeartbeatAt: over.lastHeartbeatAt,
        isTrailer: over.isTrailer ?? false,
    } as S;
}

describe('pickEvictionVictim', () => {
    it('spares a heartbeated session and evicts the idle one, even if the idle one is newer', () => {
        // THE REGRESSION PIN. Under the old createdAt sort this picked `old`.
        const old = session({
            playSessionId: 'old-but-alive',
            createdAt: new Date(1_000),
            lastHeartbeatAt: new Date(90_000),
        });
        const idle = session({
            playSessionId: 'new-but-idle',
            createdAt: new Date(50_000),
            lastHeartbeatAt: new Date(50_000),
        });
        expect(pickEvictionVictim([old, idle]).playSessionId).toBe('new-but-idle');
    });

    it('falls back to createdAt when a session has never heartbeated', () => {
        const a = session({ playSessionId: 'a', createdAt: new Date(1_000) });
        const b = session({ playSessionId: 'b', createdAt: new Date(2_000) });
        expect(pickEvictionVictim([a, b]).playSessionId).toBe('a');
    });

    it('prefers evicting a snippet over a comparably-cold playing trailer (original protection)', () => {
        // FIX 3, direction (b): the property the old snippets-first
        // pre-filter existed to protect. Both are live and similarly
        // recent (5s apart, well inside the one-heartbeat-cycle tiebreak
        // window) -- hovering a card must not cut the trailer's sound.
        const trailer = session({
            playSessionId: 'trailer',
            isTrailer: true,
            lastHeartbeatAt: new Date(90_000),
        });
        const snippet = session({
            playSessionId: 'snippet',
            lastHeartbeatAt: new Date(95_000),
        });
        expect(pickEvictionVictim([trailer, snippet]).playSessionId).toBe('snippet');
    });

    it('evicts a trailer only when there is no snippet to take', () => {
        const t1 = session({
            playSessionId: 't1',
            isTrailer: true,
            lastHeartbeatAt: new Date(1_000),
        });
        const t2 = session({
            playSessionId: 't2',
            isTrailer: true,
            lastHeartbeatAt: new Date(9_000),
        });
        expect(pickEvictionVictim([t1, t2]).playSessionId).toBe('t1');
    });

    it('evicts an ice-cold retained trailer rather than the one live hover snippet (FIX 3 regression)', () => {
        // FIX 3, direction (a) -- the reported scenario. 4 hero trailer
        // sessions (2 live, 2 retained/cold) plus 1 live hover snippet.
        // The old `pool = snippets.length > 0 ? snippets : sessions`
        // pre-filter collapsed the pool to the ONE live snippet before
        // coldness was ever considered, killing the visible preview while
        // two dead retained trailers survived. Coldness must be primary:
        // one of the ice-cold retained trailers should be picked, not the
        // live snippet.
        const liveTrailerA = session({
            playSessionId: 'live-trailer-a',
            isTrailer: true,
            lastHeartbeatAt: new Date(100_000),
        });
        const liveTrailerB = session({
            playSessionId: 'live-trailer-b',
            isTrailer: true,
            lastHeartbeatAt: new Date(101_000),
        });
        const retainedTrailerA = session({
            playSessionId: 'retained-trailer-a',
            isTrailer: true,
            lastHeartbeatAt: new Date(20_000), // long unheartbeated, retained
        });
        const retainedTrailerB = session({
            playSessionId: 'retained-trailer-b',
            isTrailer: true,
            lastHeartbeatAt: new Date(21_000),
        });
        const liveSnippet = session({
            playSessionId: 'live-snippet',
            lastHeartbeatAt: new Date(102_000),
        });
        const victim = pickEvictionVictim([
            liveTrailerA,
            liveTrailerB,
            retainedTrailerA,
            retainedTrailerB,
            liveSnippet,
        ]);
        expect(victim.playSessionId).not.toBe('live-snippet');
        expect(['retained-trailer-a', 'retained-trailer-b']).toContain(victim.playSessionId);
    });

    it('throws rather than silently misbehaving on an empty session list', () => {
        // Both call sites guard on `length >= cap` before calling this, so
        // an empty array should be unreachable in production -- but
        // `Array#reduce` with no seed throws an opaque TypeError on an
        // empty array, so make the precondition explicit instead.
        expect(() => pickEvictionVictim([])).toThrow();
    });
});
