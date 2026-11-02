// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/paraglide/messages.js', () => ({}));
const hevc = vi.hoisted(() => ({ value: 'fmp4' as string | null }));
vi.mock('$lib/components/player/livetv-hevc-support.js', () => ({
    getLiveTvHevcSupport: () => hevc.value,
}));

import { getStreamInfoWithLimitCheck } from './livetv-playback.js';

describe('Live TV stream join reports the HEVC capability', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 201,
            json: () =>
                Promise.resolve({
                    grant: {
                        id: '00000000-0000-4000-8000-000000000009',
                        ipPinned: true,
                        token: 'tok',
                        param: 'grant',
                        expiresAt: '2099-01-01T00:00:00.000Z',
                        renewAfter: '2098-12-31T23:55:00.000Z',
                        renewHref:
                            '/api/v1/playback/grants/00000000-0000-4000-8000-000000000009/renew',
                        mediaId: '00000000-0000-4000-8000-000000000002',
                        playbackSessionId: '00000000-0000-4000-8000-000000000001',
                        kind: 'live',
                    },
                    playbackSessionId: '00000000-0000-4000-8000-000000000001',
                    kind: 'live',
                    stationId: '00000000-0000-4000-8000-000000000002',
                    reporting: {
                        kind: 'keepalive',
                        method: 'POST',
                        playbackSessionId: '00000000-0000-4000-8000-000000000001',
                        intervalMs: 10_000,
                        href: '/api/livetv/playback-sessions/00000000-0000-4000-8000-000000000001/keepalive',
                    },
                    delivery: {
                        kind: 'live-hls',
                        url: '/api/livetv/channels/ch-1/stream/v/fmp4/master.m3u8',
                        feedId: '00000000-0000-4000-8000-000000000003',
                        requestedQuality: 'server',
                        appliedQuality: 'original',
                        requiresProxy: true,
                        rungId: null,
                        requestedMaxBitrateBps: null,
                        appliedMaxBitrateBps: null,
                        appliedMaxHeight: null,
                        reason: null,
                        variant: 'fmp4',
                    },
                }),
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        hevc.value = 'fmp4';
    });

    it('includes hevc in the quality request and accepts the variant answer', async () => {
        const result = await getStreamInfoWithLimitCheck('ch-1', 'server');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ stationId: 'ch-1', quality: 'server', hevc: 'fmp4' }),
            }),
        );
        expect(result).toMatchObject({ ok: true, streamInfo: { delivery: { variant: 'fmp4' } } });
    });

    it('includes hevc in the maxBitrate request', async () => {
        hevc.value = 'none';
        await getStreamInfoWithLimitCheck('ch-1', 3_000_000);
        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ stationId: 'ch-1', maxBitrateBps: 3000000, hevc: 'none' }),
            }),
        );
    });

    it('sends nothing when the capability is unknown', async () => {
        hevc.value = null;
        await getStreamInfoWithLimitCheck('ch-1', 'server');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ stationId: 'ch-1', quality: 'server' }),
            }),
        );
    });
});
