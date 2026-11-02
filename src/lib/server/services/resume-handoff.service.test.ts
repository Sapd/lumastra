// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { HandoffSessionRow } from '$lib/server/database/queries/resume-handoff.queries.js';
import {
    CAUGHT_UP_SLACK_MS,
    HANDOFF_SAME_ITEM_DEAD_BAND_MS,
    LINK_MAX_GAP_MS,
    LINK_POSITION_SLACK_MS,
    decideHandoffMove,
    walkHandoffChain,
    type HandoffAnchor,
} from './resume-handoff.service.js';

const MIN = 60_000;
const RUNTIME = 40 * MIN;
const E1 = 'e1';
const E2 = 'e2';
const E3 = 'e3';
const E4 = 'e4';
const T0 = Date.parse('2026-10-01T20:00:00Z');
const at = (min: number) => new Date(T0 + min * MIN);
const NEXT = new Map<string, string | null>([
    [E1, E2],
    [E2, E3],
    [E3, E4],
    [E4, null],
]);

/** Tab paused on E1 at 10:00; its last action was at T0. */
const anchor: HandoffAnchor = {
    mediaId: E1,
    mediaType: 'episode',
    positionMs: 10 * MIN,
    runtimeMs: RUNTIME,
    deviceId: 'tab',
    since: at(0),
};

let n = 0;
function session(over: Partial<HandoffSessionRow>): HandoffSessionRow {
    n += 1;
    return {
        session_id: `s${n}`,
        media_id: E1,
        media_type: 'episode',
        device_id: 'tv',
        device_name: 'Living room',
        entry_mode: 'continue',
        started_at: at(5),
        start_position_ms: 10 * MIN,
        high_water_ms: 25 * MIN,
        last_position_ms: 25 * MIN,
        completed: false,
        moved_at: at(20),
        runtime_ms: RUNTIME,
        ...over,
    };
}

/** TV: resumes E1 at the tab's spot, finishes it, autoplays E2 and E3, stops in E3. */
function binge(): HandoffSessionRow[] {
    return [
        session({
            session_id: 'tv-e1',
            last_position_ms: RUNTIME,
            high_water_ms: RUNTIME,
            completed: true,
            moved_at: at(35),
        }),
        session({
            session_id: 'tv-e2',
            media_id: E2,
            started_at: at(36),
            start_position_ms: 0,
            last_position_ms: RUNTIME,
            high_water_ms: RUNTIME,
            completed: true,
            moved_at: at(76),
        }),
        session({
            session_id: 'tv-e3',
            media_id: E3,
            started_at: at(77),
            start_position_ms: 0,
            last_position_ms: 12 * MIN,
            high_water_ms: 12 * MIN,
            moved_at: at(89),
        }),
    ];
}

describe('walkHandoffChain', () => {
    it('follows a TV that resumed where the tab stood (same episode)', () => {
        const chain = walkHandoffChain(anchor, [session({ session_id: 'tv' })], NEXT);
        expect(chain?.leader.session_id).toBe('tv');
        expect(chain?.rootSessionId).toBe('tv');
    });

    it('follows the chain across autoplayed episodes; the root names the chain', () => {
        const chain = walkHandoffChain(anchor, binge(), NEXT);
        expect(chain?.leader.session_id).toBe('tv-e3');
        expect(chain?.rootSessionId).toBe('tv-e1');
    });

    it('still follows two weeks later: the anchor has no age limit', () => {
        const old = { ...anchor, since: at(-14 * 24 * 60) };
        expect(walkHandoffChain(old, binge(), NEXT)?.leader.session_id).toBe('tv-e3');
    });

    it('a resume far from where the tab stood is not a continuation (an explicit spot, another viewer)', () => {
        const s = session({ start_position_ms: 10 * MIN + LINK_POSITION_SLACK_MS + 1 });
        expect(walkHandoffChain(anchor, [s], NEXT)).toBeNull();
    });

    it('another episode picked while the anchor was unfinished is no continuation', () => {
        const s = session({ media_id: E3, start_position_ms: 0 });
        expect(walkHandoffChain(anchor, [s], NEXT)).toBeNull();
    });

    it('the next episode after an unfinished one is no continuation (Next Up on a shared account)', () => {
        const s = session({ media_id: E2, start_position_ms: 0 });
        expect(walkHandoffChain(anchor, [s], NEXT)).toBeNull();
    });

    it('a finished anchor links to the next episode at 0', () => {
        const done = { ...anchor, positionMs: RUNTIME - 10_000 };
        const s = session({ media_id: E2, start_position_ms: 0 });
        expect(walkHandoffChain(done, [s], NEXT)?.leader.media_id).toBe(E2);
    });

    it('a session without an entry (an old client) never joins a chain', () => {
        expect(walkHandoffChain(anchor, [session({ entry_mode: null })], NEXT)).toBeNull();
    });

    it('a predecessor event landing just after the successor started still links', () => {
        const sessions = binge();
        sessions[1] = {
            ...sessions[1],
            started_at: new Date(sessions[0].moved_at!.getTime() - 3000),
        };
        expect(walkHandoffChain(anchor, sessions, NEXT)?.leader.session_id).toBe('tv-e3');
    });

    it('an explicit session breaks the chain', () => {
        const sessions = binge();
        sessions[1] = { ...sessions[1], entry_mode: 'explicit' };
        expect(walkHandoffChain(anchor, sessions, NEXT)?.leader.session_id).toBe('tv-e1');
    });

    it('a session that started before the tab acted is older news', () => {
        expect(walkHandoffChain({ ...anchor, since: at(10) }, [session({})], NEXT)).toBeNull();
    });

    it('a link gap over the maximum breaks the chain (not the anchor)', () => {
        const sessions = binge();
        const late = new Date(sessions[0].moved_at!.getTime() + LINK_MAX_GAP_MS + MIN);
        sessions[1] = { ...sessions[1], started_at: late, moved_at: late };
        sessions[2] = {
            ...sessions[2],
            started_at: new Date(late.getTime() + MIN),
            moved_at: new Date(late.getTime() + 2 * MIN),
        };
        expect(walkHandoffChain(anchor, sessions, NEXT)?.leader.session_id).toBe('tv-e1');
    });

    it('never follows its own device, and a session that wrote no progress cannot lead', () => {
        expect(walkHandoffChain(anchor, [session({ device_id: 'tab' })], NEXT)).toBeNull();
        expect(walkHandoffChain(anchor, [session({ moved_at: null })], NEXT)).toBeNull();
    });

    it('the chain may pass through the tab device (a quality restart, another tab)', () => {
        const viaTab = session({
            session_id: 'tab-restart',
            device_id: 'tab',
            started_at: at(2),
            last_position_ms: 12 * MIN,
            moved_at: at(4),
        });
        const tv = session({ session_id: 'tv', start_position_ms: 12 * MIN, started_at: at(6) });
        const chain = walkHandoffChain(anchor, [viaTab, tv], NEXT);
        expect(chain?.leader.session_id).toBe('tv');
        expect(chain?.rootSessionId).toBe('tab-restart');
    });

    it('a leader rewound below its furthest point is not followed, until it passes it again', () => {
        const rewound = session({
            high_water_ms: 25 * MIN,
            last_position_ms: 25 * MIN - CAUGHT_UP_SLACK_MS - 1,
        });
        expect(walkHandoffChain(anchor, [rewound], NEXT)).toBeNull();
        const caughtUp = session({
            high_water_ms: 25 * MIN,
            last_position_ms: 25 * MIN - CAUGHT_UP_SLACK_MS,
        });
        expect(walkHandoffChain(anchor, [caughtUp], NEXT)).not.toBeNull();
    });

    it('a rewatch of a watched episode is linear too (no watched rule)', () => {
        // Nothing in the rows says "watched": the chain alone decides.
        expect(walkHandoffChain(anchor, [session({ entry_mode: 'resume' })], NEXT)).not.toBeNull();
    });
});

describe('decideHandoffMove', () => {
    const tabAnchor = { mediaId: E1, positionMs: 10 * MIN, orderKey: 10_001 };
    const leader = (over: Partial<HandoffSessionRow> & { orderKey?: number | null }) => ({
        ...session({}),
        orderKey: 10_001,
        ...over,
    });

    it('same episode: move to the leader position', () => {
        expect(decideHandoffMove(tabAnchor, leader({}))).toEqual({
            kind: 'move',
            mediaId: E1,
            positionMs: 25 * MIN,
        });
    });

    it('same episode inside the dead band: stay', () => {
        const near = leader({ last_position_ms: 10 * MIN + HANDOFF_SAME_ITEM_DEAD_BAND_MS - 1 });
        expect(decideHandoffMove(tabAnchor, near)).toEqual({ kind: 'stay' });
    });

    it('a later episode: move there', () => {
        expect(
            decideHandoffMove(
                tabAnchor,
                leader({ media_id: E3, orderKey: 10_003, last_position_ms: 12 * MIN }),
            ),
        ).toEqual({ kind: 'move', mediaId: E3, positionMs: 12 * MIN });
    });

    it('an earlier episode or one without an order key: stay', () => {
        expect(
            decideHandoffMove({ mediaId: E2, positionMs: 0, orderKey: 10_002 }, leader({})),
        ).toEqual({ kind: 'stay' });
        expect(decideHandoffMove(tabAnchor, leader({ media_id: E2, orderKey: null }))).toEqual({
            kind: 'stay',
        });
    });

    it('a finished episode: the one after it, at 0', () => {
        expect(decideHandoffMove(tabAnchor, leader({ completed: true }))).toEqual({
            kind: 'next_after',
            episodeId: E1,
        });
    });

    it('a finished movie has nothing after it', () => {
        expect(
            decideHandoffMove(
                { mediaId: 'm', positionMs: 0, orderKey: null },
                leader({ media_id: 'm', media_type: 'movie', orderKey: null, completed: true }),
            ),
        ).toEqual({ kind: 'stay' });
    });
});
