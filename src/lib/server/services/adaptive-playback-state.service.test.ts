// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    SERVER_FRESH_MS,
    adaptiveTier,
    buildSessionAdaptive,
    matchServerRecords,
    nextViewerRecord,
    redactSessionAdaptive,
    type ChannelLadderRecord,
    type ServerViewerRecord,
} from './adaptive-playback-state.service.js';

const NOW = 1_800_000_000_000;

const LADDER: ChannelLadderRecord = {
    rungs: [
        { id: '1080p8m', height: 1080, maxBitrate: 8_000_000 },
        { id: '720p4m', height: 720, maxBitrate: 4_000_000 },
        { id: '540p2m', height: 540, maxBitrate: 2_000_000 },
        { id: '360p1m', height: 360, maxBitrate: 1_000_000 },
    ],
    includesOriginal: false,
};

function record(overrides: Partial<ServerViewerRecord> = {}): ServerViewerRecord {
    return {
        u: 'mira',
        rung: '720p4m',
        since: NOW - 60_000,
        last: NOW - 2_000,
        sw: 0,
        recent: [],
        ...overrides,
    };
}

describe('adaptiveTier', () => {
    it('colours like the player badge: top, high, low, bottom', () => {
        expect([0, 1, 2, 3].map((i) => adaptiveTier(i, 4))).toEqual([
            'top',
            'high',
            'low',
            'bottom',
        ]);
        expect(adaptiveTier(-1, 4)).toBeUndefined();
        expect(adaptiveTier(0, 1)).toBe('top');
    });
});

describe('nextViewerRecord', () => {
    it('starts a fresh record on the first segment', () => {
        expect(nextViewerRecord(null, 'mira', '720p4m', NOW)).toEqual({
            u: 'mira',
            rung: '720p4m',
            since: NOW,
            last: NOW,
            sw: 0,
            recent: [],
        });
    });

    it('only moves `last` while the rung stays the same', () => {
        const previous = record();
        const next = nextViewerRecord(previous, 'mira', '720p4m', NOW);
        expect(next).toEqual({ ...previous, last: NOW });
    });

    it('counts a switch and keeps the five newest, newest first', () => {
        let state = record({ rung: '1080p8m' });
        const rungs = ['720p4m', '540p2m', '360p1m', '540p2m', '720p4m', '1080p8m'];
        rungs.forEach((rung, i) => {
            state = nextViewerRecord(state, 'mira', rung, NOW + i * 1000);
        });
        expect(state.sw).toBe(6);
        expect(state.rung).toBe('1080p8m');
        expect(state.since).toBe(NOW + 5000);
        expect(state.recent).toHaveLength(5);
        expect(state.recent[0]).toEqual({ f: '720p4m', t: '1080p8m', at: NOW + 5000 });
    });

    it('does not count a long gap (pause, re-join) as a switch', () => {
        const previous = record({ rung: '1080p8m', last: NOW - SERVER_FRESH_MS * 3, sw: 4 });
        const next = nextViewerRecord(previous, 'mira', '360p1m', NOW);
        expect(next.sw).toBe(0);
        expect(next.recent).toEqual([]);
    });
});

describe('buildSessionAdaptive', () => {
    it('server inference: current rung, ladder, tier and switch history', () => {
        const adaptive = buildSessionAdaptive({
            server: record({
                rung: '540p2m',
                sw: 2,
                recent: [{ f: '720p4m', t: '540p2m', at: NOW - 60_000 }],
            }),
            ladder: LADDER,
            client: null,
            now: NOW,
        });
        expect(adaptive).toMatchObject({
            source: 'server',
            current: { id: '540p2m', height: 540, bitrate: 2_000_000 },
            tier: 'low',
            switches: 2,
            recentSwitches: [
                { from: '720p4m', to: '540p2m', at: new Date(NOW - 60_000).toISOString() },
            ],
            lastSegmentAt: new Date(NOW - 2_000).toISOString(),
        });
        expect(adaptive?.ladder.map((v) => v.id)).toEqual([
            '1080p8m',
            '720p4m',
            '540p2m',
            '360p1m',
        ]);
    });

    it('puts Original on top of the ladder when the group copies it', () => {
        const adaptive = buildSessionAdaptive({
            server: record({ rung: 'original' }),
            ladder: { ...LADDER, includesOriginal: true },
            client: null,
            now: NOW,
        });
        expect(adaptive?.ladder[0]).toEqual({ id: 'original', original: true });
        expect(adaptive?.tier).toBe('top');
    });

    it('falls back to the fixed ladder when none was recorded', () => {
        const adaptive = buildSessionAdaptive({
            server: record(),
            ladder: null,
            client: null,
            now: NOW,
        });
        expect(adaptive?.ladder).toHaveLength(4);
        expect(adaptive?.tier).toBe('high');
    });

    it('adds the client measurements to a server record', () => {
        const adaptive = buildSessionAdaptive({
            server: record(),
            ladder: LADDER,
            client: { at: NOW - 5_000, measured_bandwidth: 24_000_000, rebuffers: 1, switches: 9 },
            now: NOW,
        });
        expect(adaptive).toMatchObject({
            source: 'server',
            switches: 0, // the server's own count wins
            measuredBandwidth: 24_000_000,
            rebuffers: 1,
            clientReportedAt: new Date(NOW - 5_000).toISOString(),
        });
    });

    it('ignores a stale server record and uses the client report', () => {
        const adaptive = buildSessionAdaptive({
            server: record({ last: NOW - SERVER_FRESH_MS - 1 }),
            ladder: LADDER,
            client: {
                at: NOW,
                height: 720,
                indicated_bitrate: 3_200_000,
                ladder: [
                    { height: 480, bitrate: 1_500_000 },
                    { height: 1080, bitrate: 6_000_000 },
                    { height: 720, bitrate: 3_200_000 },
                ],
                switches: 3,
            },
            now: NOW,
        });
        expect(adaptive).toMatchObject({
            source: 'client',
            current: { id: '720p', height: 720, bitrate: 3_200_000 },
            tier: 'high',
            switches: 3,
        });
        expect(adaptive?.ladder.map((v) => v.id)).toEqual(['1080p', '720p', '480p']);
        expect(adaptive?.currentSince).toBeUndefined();
    });

    it('is undefined for a client with a single level (not adaptive)', () => {
        expect(
            buildSessionAdaptive({
                server: null,
                ladder: null,
                client: { at: NOW, height: 1080, ladder: [{ height: 1080, bitrate: 8_000_000 }] },
                now: NOW,
            }),
        ).toBeUndefined();
        expect(
            buildSessionAdaptive({ server: null, ladder: null, client: null, now: NOW }),
        ).toBeUndefined();
    });

    it('uses the channel ladder for a Live TV client report before its first segment', () => {
        const adaptive = buildSessionAdaptive({
            server: null,
            ladder: LADDER,
            client: { at: NOW, variant_id: '360p1m' },
            now: NOW,
        });
        expect(adaptive).toMatchObject({
            source: 'client',
            current: { id: '360p1m' },
            tier: 'bottom',
        });
    });
});

describe('matchServerRecords', () => {
    const channel = 'c0ffee00-0000-4000-8000-000000000001';

    it('matches two browsers on the same station by their exact internal viewer keys', () => {
        const records = new Map([
            [
                channel,
                new Map([
                    ['mira:browser:one', record({ rung: '720p4m' })],
                    ['mira:browser:two', record({ rung: '360p1m' })],
                ]),
            ],
        ]);
        const sessions = ['one', 'two'].map((id) => ({
            sessionId: id,
            username: 'mira',
            mediaId: channel,
            viewerKey: `mira:browser:${id}`,
        }));
        const result = matchServerRecords(sessions, records, NOW);
        expect(result.get('one')?.rung).toBe('720p4m');
        expect(result.get('two')?.rung).toBe('360p1m');
    });

    it("joins a user's only session on a channel to their fresh record", () => {
        const records = new Map([[channel, new Map([['mira:browser:aaa', record()]])]]);
        const out = matchServerRecords(
            [{ sessionId: 's1', username: 'Mira', mediaType: 'tvchannel', mediaId: channel }],
            records,
            NOW,
        );
        expect(out.get('s1')?.rung).toBe('720p4m');
    });

    it('picks the newest record when a reload left an old one behind', () => {
        const records = new Map([
            [
                channel,
                new Map([
                    ['mira:browser:old', record({ rung: '360p1m', last: NOW - 30_000 })],
                    ['mira:browser:new', record({ rung: '1080p8m', last: NOW - 1_000 })],
                ]),
            ],
        ]);
        const out = matchServerRecords(
            [{ sessionId: 's1', username: 'mira', mediaId: channel }],
            records,
            NOW,
        );
        expect(out.get('s1')?.rung).toBe('1080p8m');
    });

    it('matches by device when one user watches the channel on two devices', () => {
        const records = new Map([
            [
                channel,
                new Map([
                    ['mira:device:tv-1', record({ rung: '1080p8m' })],
                    ['mira:device:phone-2', record({ rung: '360p1m' })],
                ]),
            ],
        ]);
        const out = matchServerRecords(
            [
                { sessionId: 'tv', username: 'mira', mediaId: channel, deviceId: 'tv-1' },
                { sessionId: 'phone', username: 'mira', mediaId: channel, deviceId: 'phone-2' },
            ],
            records,
            NOW,
        );
        expect(out.get('tv')?.rung).toBe('1080p8m');
        expect(out.get('phone')?.rung).toBe('360p1m');
    });

    it('leaves ambiguous pairs unmatched rather than guessing', () => {
        const records = new Map([
            [
                channel,
                new Map([
                    ['mira:browser:a', record({ rung: '1080p8m' })],
                    ['mira:browser:b', record({ rung: '360p1m' })],
                ]),
            ],
        ]);
        const out = matchServerRecords(
            [
                { sessionId: 'one', username: 'mira', mediaId: channel, deviceId: 'web-x' },
                { sessionId: 'two', username: 'mira', mediaId: channel, deviceId: 'web-y' },
            ],
            records,
            NOW,
        );
        expect(out.size).toBe(0);
    });

    it("never gives one user another user's record", () => {
        const records = new Map([
            [channel, new Map([['jonas:browser:a', record({ u: 'jonas' })]])],
        ]);
        const out = matchServerRecords(
            [{ sessionId: 's1', username: 'mira', mediaId: channel }],
            records,
            NOW,
        );
        expect(out.size).toBe(0);
    });
});

describe('redactSessionAdaptive', () => {
    it("keeps the variant and ladder, drops another user's connection telemetry", () => {
        const full = buildSessionAdaptive({
            server: record({ sw: 3, recent: [{ f: '1080p8m', t: '720p4m', at: NOW - 1000 }] }),
            ladder: LADDER,
            client: { at: NOW, measured_bandwidth: 30_000_000, rebuffers: 2 },
            now: NOW,
        });
        expect(full).toBeDefined();
        const redacted = redactSessionAdaptive(full!);
        expect(redacted).toEqual({
            source: 'server',
            current: full!.current,
            ladder: full!.ladder,
            tier: 'high',
        });
    });
});
