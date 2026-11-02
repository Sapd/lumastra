// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adaptive playback state against a REAL Valkey: the segment route's writes, the
 * master route's ladder and a heartbeat's client report come back joined to the
 * right play session. Skips when no Valkey is reachable via CACHE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectValkey, del } from '$lib/server/cache/valkey';
import {
    _resetAdaptiveWriteThrottleForTests,
    recordAdaptiveLadder,
    recordAdaptiveSegment,
    recordClientAdaptiveReport,
    clearClientAdaptiveReport,
    resolveSessionAdaptive,
} from './adaptive-playback-state.service.js';

let available = false;
const channelId = randomUUID();
const otherChannelId = randomUUID();
const liveSessionId = randomUUID();
const vodSessionId = randomUUID();

beforeAll(async () => {
    if (!process.env.CACHE_URL) return;
    available = await connectValkey().catch(() => false);
});

afterAll(async () => {
    if (!available) return;
    await del([
        `v1:abr:livetv:${channelId}`,
        `v1:abr:livetv:${otherChannelId}`,
        `v1:abr:session:${liveSessionId}`,
        `v1:abr:session:${vodSessionId}`,
    ]);
});

describe('adaptive playback state (Valkey)', () => {
    it('joins segment fetches, the ladder and client reports to sessions', async (ctx) => {
        if (!available) ctx.skip();
        _resetAdaptiveWriteThrottleForTests();
        const t0 = Date.now();

        await recordAdaptiveLadder(channelId, {
            rungs: [
                { id: '1080p8m', height: 1080, maxBitrate: 8_000_000 },
                { id: '720p4m', height: 720, maxBitrate: 4_000_000 },
                { id: '360p1m', height: 360, maxBitrate: 1_000_000 },
            ],
            includesOriginal: false,
        });
        await recordAdaptiveSegment(channelId, 'linnea:browser:tab-1', 'linnea', '1080p8m', t0);
        // Same rung inside the throttle window: no write, no switch.
        await recordAdaptiveSegment(
            channelId,
            'linnea:browser:tab-1',
            'linnea',
            '1080p8m',
            t0 + 2_000,
        );
        await recordAdaptiveSegment(
            channelId,
            'linnea:browser:tab-1',
            'linnea',
            '720p4m',
            t0 + 4_000,
        );
        // Someone else on another channel must not leak into Linnea's row.
        await recordAdaptiveSegment(otherChannelId, 'oskar:browser:x', 'oskar', '360p1m', t0);

        await recordClientAdaptiveReport(liveSessionId, {
            measured_bandwidth: 9_500_000,
            rebuffers: 0,
        });
        await recordClientAdaptiveReport(vodSessionId, {
            height: 720,
            indicated_bitrate: 3_000_000,
            ladder: [
                { height: 1080, bitrate: 6_000_000 },
                { height: 720, bitrate: 3_000_000 },
            ],
            switches: 1,
        });

        const result = await resolveSessionAdaptive(
            [
                {
                    sessionId: liveSessionId,
                    username: 'Linnea',
                    mediaType: 'tvchannel',
                    mediaId: channelId,
                },
                {
                    sessionId: vodSessionId,
                    username: 'oskar',
                    mediaType: 'movie',
                    mediaId: randomUUID(),
                },
                {
                    sessionId: randomUUID(),
                    username: 'linnea',
                    mediaType: 'episode',
                    mediaId: randomUUID(),
                },
            ],
            t0 + 5_000,
        );

        expect(result.size).toBe(2);
        const live = result.get(liveSessionId);
        expect(live).toMatchObject({
            source: 'server',
            current: { id: '720p4m' },
            tier: 'high',
            switches: 1,
            measuredBandwidth: 9_500_000,
        });
        expect(live?.ladder.map((v) => v.id)).toEqual(['1080p8m', '720p4m', '360p1m']);
        expect(live?.recentSwitches?.[0]).toMatchObject({ from: '1080p8m', to: '720p4m' });

        expect(result.get(vodSessionId)).toMatchObject({
            source: 'client',
            current: { height: 720 },
            switches: 1,
        });

        await clearClientAdaptiveReport(vodSessionId);
        const afterStop = await resolveSessionAdaptive(
            [
                {
                    sessionId: vodSessionId,
                    username: 'oskar',
                    mediaType: 'movie',
                    mediaId: randomUUID(),
                },
            ],
            t0 + 6_000,
        );
        expect(afterStop.size).toBe(0);
    });
});
