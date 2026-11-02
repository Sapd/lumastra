// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeHandoffTarget } from '$lib/schemas/resume-handoff';
import {
    HANDOFF_AGE_PARAM,
    HANDOFF_CHAIN_PARAM,
    HANDOFF_MIN_AWAY_MS,
    HANDOFF_MIN_INTERVAL_MS,
    HANDOFF_REMOUNT_PARAM,
    HANDOFF_SHOW_AGE_AFTER_MS,
    HandoffThrottle,
    declineHandoffChain,
    installHandoffTriggers,
    isHandoffChainDeclined,
    resolveHandoff,
    shouldCheckHandoff,
    type HandoffContext,
} from './resume-handoff';

const EP_A = 'a0000000-0000-4000-a000-000000000001';
const EP_B = 'a0000000-0000-4000-a000-000000000002';
const T0 = Date.parse('2026-10-22T20:00:00Z');

interface State {
    mediaId: string | null;
    positionMs: number;
    playing: boolean;
    party: boolean;
    linear: boolean;
    lastActionAt: number;
    declined: string[];
}

function context(over: Partial<State> = {}): { ctx: HandoffContext; state: State } {
    const state: State = {
        mediaId: EP_A,
        positionMs: 10 * 60_000,
        playing: false,
        party: false,
        linear: true,
        // The tab paused 30 minutes before T0.
        lastActionAt: T0 - 30 * 60_000,
        declined: [],
        ...over,
    };
    const ctx: HandoffContext = {
        mediaId: () => state.mediaId,
        deviceId: () => 'dashboard-tab',
        positionMs: () => state.positionMs,
        isPlaying: () => state.playing,
        watchPartyActive: () => state.party,
        isLinear: () => state.linear,
        lastActionAt: () => state.lastActionAt,
        isDeclined: (id) => state.declined.includes(id),
        entry: () => 'next_up',
        seriesTitle: () => 'Harbour Lights',
        episodeCode: () => 'S01E01',
    };
    return { ctx, state };
}

/** The TV moved `agoMs` before the server answered (server clock = T0). */
function target(over: Partial<ResumeHandoffTarget> = {}, agoMs = 5 * 60_000): ResumeHandoffTarget {
    return {
        mediaId: EP_A,
        positionMs: 25 * 60_000,
        relation: 'same_media',
        sameFileAsFrom: false,
        deviceName: 'Living room',
        chainId: 'chain-1',
        updatedAt: new Date(T0 - agoMs).toISOString(),
        serverNow: new Date(T0).toISOString(),
        ...over,
    };
}

const clock = (start = T0) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('shouldCheckHandoff', () => {
    it('a paused tab on an episode or movie asks on return', () => {
        expect(shouldCheckHandoff(context().ctx, 'return')).toBe(true);
    });

    it('never in a watch party, for an explicit pick, or without an item to follow', () => {
        expect(shouldCheckHandoff(context({ party: true }).ctx, 'return')).toBe(false);
        expect(shouldCheckHandoff(context({ linear: false }).ctx, 'return')).toBe(false);
        expect(shouldCheckHandoff(context({ mediaId: null }).ctx, 'return')).toBe(false);
    });

    it('a playing tab asks only on the play press itself', () => {
        const { ctx } = context({ playing: true });
        expect(shouldCheckHandoff(ctx, 'return')).toBe(false);
        expect(shouldCheckHandoff(ctx, 'resume')).toBe(true);
    });
});

describe('resolveHandoff', () => {
    it('asks with the position, device and the time since the last action', async () => {
        const { ctx } = context();
        let asked = '';
        await resolveHandoff(
            ctx,
            async (path) => {
                asked = path;
                return undefined;
            },
            'return',
            clock().now,
        );
        const url = new URL(asked, 'http://x');
        expect(url.pathname).toBe('/me/resume-handoff');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            mediaId: EP_A,
            positionMs: String(10 * 60_000),
            deviceId: 'dashboard-tab',
            idleMs: String(30 * 60_000),
        });
    });

    it('same episode: remounts at the other device position (fresh session), paused, with undo', async () => {
        const { ctx } = context();
        const d = await resolveHandoff(ctx, async () => target(), 'return', clock().now);
        expect(d.kind).toBe('jump');
        const url = new URL(d.kind === 'jump' ? d.url : '', 'http://x');
        expect(url.pathname).toBe(`/watch/${EP_A}`);
        expect(url.searchParams.get('resolved')).toBe('seek');
        expect(url.searchParams.get('seekMs')).toBe(String(25 * 60_000));
        expect(url.searchParams.get('from')).toBe(EP_A);
        expect(url.searchParams.get('fromPos')).toBe(String(10 * 60_000));
        expect(url.searchParams.get('dev')).toBe('Living room');
        expect(url.searchParams.get(HANDOFF_CHAIN_PARAM)).toBe('chain-1');
        expect(url.searchParams.get(HANDOFF_REMOUNT_PARAM)).toBeTruthy();
        expect(url.searchParams.has('mk')).toBe(false);
    });

    it('later episode: jumps with the marker landing, the entry, the chain and (when old) the age', async () => {
        const { ctx } = context();
        const twoDays = 2 * 24 * 60 * 60_000;
        const d = await resolveHandoff(
            ctx,
            async () =>
                target(
                    {
                        mediaId: EP_B,
                        positionMs: 7 * 60_000,
                        relation: 'later_episode',
                        seasonNumber: 1,
                        episodeNumber: 2,
                    },
                    twoDays,
                ),
            'return',
            clock().now,
        );
        expect(d.kind).toBe('jump');
        const url = new URL(d.kind === 'jump' ? d.url : '', 'http://x');
        expect(url.pathname).toBe(`/watch/${EP_B}`);
        expect(url.searchParams.get('resolved')).toBe('series');
        expect(url.searchParams.get('from')).toBe(EP_A);
        expect(url.searchParams.get('fromPos')).toBe(String(10 * 60_000));
        expect(url.searchParams.get('fmk')).toBe('S01E01');
        expect(url.searchParams.get('mk')).toBe('S01E02');
        expect(url.searchParams.get('dev')).toBe('Living room');
        expect(url.searchParams.get('entry')).toBe('next_up');
        expect(url.searchParams.get(HANDOFF_CHAIN_PARAM)).toBe('chain-1');
        expect(url.searchParams.get(HANDOFF_AGE_PARAM)).toBe(String(twoDays));
        expect(url.searchParams.get('seekMs')).toBe(String(7 * 60_000));
        expect(url.searchParams.has(HANDOFF_REMOUNT_PARAM)).toBe(false);
    });

    it('a recent jump carries no age', async () => {
        const { ctx } = context();
        const d = await resolveHandoff(
            ctx,
            async () => target({ mediaId: EP_B, relation: 'later_episode' }),
            'return',
            clock().now,
        );
        const url = new URL(d.kind === 'jump' ? d.url : '', 'http://x');
        expect(url.searchParams.has(HANDOFF_AGE_PARAM)).toBe(false);
        expect(HANDOFF_SHOW_AGE_AFTER_MS).toBe(12 * 60 * 60_000);
    });

    it('a later episode in the same combined file is a seek', async () => {
        const { ctx } = context();
        const d = await resolveHandoff(
            ctx,
            async () => target({ mediaId: EP_B, relation: 'later_episode', sameFileAsFrom: true }),
            'return',
            clock().now,
        );
        expect(d.kind).toBe('seek');
    });

    it('a chain this tab undid is never followed again', async () => {
        const { ctx } = context({ declined: ['chain-1'] });
        expect(await resolveHandoff(ctx, async () => target(), 'return', clock().now)).toEqual({
            kind: 'stay',
        });
        expect(
            (
                await resolveHandoff(
                    ctx,
                    async () => target({ chainId: 'chain-2' }),
                    'return',
                    clock().now,
                )
            ).kind,
        ).toBe('jump');
    });

    it('stays without an answer, and when the request fails', async () => {
        const { ctx } = context();
        expect(await resolveHandoff(ctx, async () => undefined, 'return', clock().now)).toEqual({
            kind: 'stay',
        });
        expect(
            await resolveHandoff(
                ctx,
                async () => {
                    throw new Error('offline');
                },
                'return',
                clock().now,
            ),
        ).toEqual({ kind: 'stay' });
    });

    it('stays when the viewer moved, switched item, acted or started playing meanwhile', async () => {
        for (const change of [
            (s: State) => (s.positionMs += 5000),
            (s: State) => (s.mediaId = EP_B),
            (s: State) => (s.playing = true),
            (s: State) => (s.party = true),
            (s: State) => (s.lastActionAt = T0),
        ]) {
            const { ctx, state } = context();
            const d = await resolveHandoff(
                ctx,
                async () => {
                    change(state);
                    return target();
                },
                'return',
                clock().now,
            );
            expect(d).toEqual({ kind: 'stay' });
        }
    });

    it('a play press applies while playing, but only within 1.5 s of the press', async () => {
        const fast = context({ playing: true });
        expect(
            (await resolveHandoff(fast.ctx, async () => target(), 'resume', clock().now)).kind,
        ).toBe('jump');

        const slow = context({ playing: true });
        const c2 = clock();
        const d = await resolveHandoff(
            slow.ctx,
            async () => {
                c2.advance(2000);
                return target();
            },
            'resume',
            c2.now,
        );
        expect(d).toEqual({ kind: 'stay' });
    });

    it('the play press itself is not "the tab acted meanwhile"', async () => {
        const { ctx, state } = context({ playing: true });
        const d = await resolveHandoff(
            ctx,
            async () => {
                state.lastActionAt = T0; // the page records the press after the request started
                return target();
            },
            'resume',
            clock().now,
        );
        expect(d.kind).toBe('jump');
    });
});

describe('declined chains', () => {
    beforeEach(() => {
        const map = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => void map.set(k, v),
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('round-trips per tab', () => {
        expect(isHandoffChainDeclined('c1')).toBe(false);
        declineHandoffChain('c1');
        declineHandoffChain('c1');
        expect(isHandoffChainDeclined('c1')).toBe(true);
        expect(isHandoffChainDeclined('c2')).toBe(false);
    });
});

describe('HandoffThrottle', () => {
    it('one return request per interval; a play press always passes', () => {
        const t = new HandoffThrottle();
        expect(t.allow('return', T0)).toBe(true);
        expect(t.allow('return', T0 + 1000)).toBe(false);
        expect(t.allow('resume', T0 + 2000)).toBe(true);
        expect(t.allow('return', T0 + 2000 + HANDOFF_MIN_INTERVAL_MS)).toBe(true);
    });
});

describe('installHandoffTriggers', () => {
    function env() {
        const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
        const win = new EventTarget();
        const c = clock();
        return { doc, win, c };
    }

    it('fires after a hide or a blur of at least the minimum, not for a short one', () => {
        const { doc, win, c } = env();
        const onReturn = vi.fn();
        const uninstall = installHandoffTriggers(onReturn, { doc, win, now: c.now });

        doc.visibilityState = 'hidden';
        doc.dispatchEvent(new Event('visibilitychange'));
        c.advance(HANDOFF_MIN_AWAY_MS - 1);
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(onReturn).not.toHaveBeenCalled();

        win.dispatchEvent(new Event('blur'));
        c.advance(HANDOFF_MIN_AWAY_MS);
        win.dispatchEvent(new Event('focus'));
        expect(onReturn).toHaveBeenCalledTimes(1);

        // Hidden, then visible and focused: one return, not two.
        doc.visibilityState = 'hidden';
        doc.dispatchEvent(new Event('visibilitychange'));
        win.dispatchEvent(new Event('blur'));
        c.advance(60_000);
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        win.dispatchEvent(new Event('focus'));
        expect(onReturn).toHaveBeenCalledTimes(2);

        uninstall();
        win.dispatchEvent(new Event('blur'));
        c.advance(60_000);
        win.dispatchEvent(new Event('focus'));
        expect(onReturn).toHaveBeenCalledTimes(2);
    });

    it('a bfcache restore counts as a return', () => {
        const { doc, win, c } = env();
        const onReturn = vi.fn();
        installHandoffTriggers(onReturn, { doc, win, now: c.now });
        win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        expect(onReturn).toHaveBeenCalledTimes(1);
    });
});
