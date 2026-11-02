// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ProxyChannelInfoSchema } from './livetv';

describe('live TV output status on the dashboard wire', () => {
    const base = {
        channelId: 'feed',
        channelName: 'DAZN 2',
        sourceId: 'source',
        viewers: 1,
        ffmpegHealthy: true,
        startedAt: '2026-10-26T10:00:00Z',
    };
    it('preserves freshness and passive timestamp observations instead of stripping them', () => {
        const value = {
            ...base,
            lastSegmentAt: '2026-10-26T10:00:08Z',
            outputDiagnostics: {
                bufferedSeconds: 59.8,
                timestampSamples: 1000,
                gapCount: 1,
                resetCount: 0,
                largestGapSeconds: 8,
                lastGapAt: '2026-10-26T10:00:07Z',
            },
        };
        expect(ProxyChannelInfoSchema.parse(value)).toEqual(value);
    });
    it('accepts older proxies without claiming zero timestamp gaps', () => {
        expect(ProxyChannelInfoSchema.parse(base).outputDiagnostics).toBeUndefined();
        expect(ProxyChannelInfoSchema.parse(base).lastSegmentAt).toBeUndefined();
    });
});
