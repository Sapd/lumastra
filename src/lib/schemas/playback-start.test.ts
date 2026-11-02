// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { PlaybackStartRequestSchema, PlaybackStartResponseSchema } from './playback-start.js';
import { reportingBlockSchema } from './play-reporting.js';
import { LiveHlsDeliverySchema } from './livetv-delivery.js';
import { playbackStartFixture } from './playback-start.test-fixture.js';

const request = {
    mediaId: '22222222-2222-4222-8222-222222222222',
    deviceId: 'living-room',
    capabilities: {
        containers: ['mp4'],
        videoCodecs: ['h264'],
        audioCodecs: ['aac'],
        subtitleFormats: ['vtt'],
        hdr: [],
    },
};
describe('playback start schema', () => {
    it('preserves app version plus build and permits omitted diagnostic fields', () => {
        const clientInfo = {
            client: 'Apple',
            version: '1.0.1 (2610140823)',
            userAgent: 'Apple agent',
        };
        expect(PlaybackStartRequestSchema.parse({ ...request, clientInfo }).clientInfo).toEqual(
            clientInfo,
        );
        expect(PlaybackStartRequestSchema.parse({ ...request, clientInfo: {} }).clientInfo).toEqual(
            {},
        );
        expect(PlaybackStartRequestSchema.parse(request).clientInfo).toBeUndefined();
    });

    it('defaults purpose to play, accepts prefetch, and keeps the enum and object strict', () => {
        expect(PlaybackStartRequestSchema.parse(request).purpose).toBe('play');
        expect(PlaybackStartRequestSchema.parse({ ...request, purpose: 'prefetch' }).purpose).toBe(
            'prefetch',
        );
        expect(
            PlaybackStartRequestSchema.safeParse({ ...request, purpose: 'download' }).success,
        ).toBe(false);
        expect(PlaybackStartRequestSchema.safeParse({ ...request, prefetch: true }).success).toBe(
            false,
        );
    });

    it('defaults castTarget to false and accepts only booleans', () => {
        expect(PlaybackStartRequestSchema.parse(request).castTarget).toBe(false);
        expect(PlaybackStartRequestSchema.parse({ ...request, castTarget: true }).castTarget).toBe(
            true,
        );
        expect(
            PlaybackStartRequestSchema.safeParse({ ...request, castTarget: 'true' }).success,
        ).toBe(false);
    });

    it('preserves typed capabilities and rejects invalid quality limits', () => {
        const capabilities = { ...request.capabilities, maxHeight: 720, maxAudioChannels: 2 };
        expect(PlaybackStartRequestSchema.parse({ ...request, capabilities }).capabilities).toEqual(
            capabilities,
        );
        expect(
            PlaybackStartRequestSchema.safeParse({
                ...request,
                capabilities: { ...capabilities, maxHeight: -1 },
            }).success,
        ).toBe(false);
    });

    it('accepts typed capabilities and explicit positions in milliseconds', () => {
        expect(
            PlaybackStartRequestSchema.parse({
                ...request,
                startPositionMs: 12345,
                subtitleId: 'none',
            }).startPositionMs,
        ).toBe(12345);
    });

    it('rejects the retired snake-case start request', () => {
        expect(
            PlaybackStartRequestSchema.safeParse({
                media_id: request.mediaId,
                device_id: request.deviceId,
                requested: { play_method: 'direct' },
            }).success,
        ).toBe(false);
    });

    it.each([-1, 1.5])('rejects invalid millisecond start positions (%s)', (startPositionMs) => {
        expect(PlaybackStartRequestSchema.safeParse({ ...request, startPositionMs }).success).toBe(
            false,
        );
    });

    it('imports the reporting block owned by package 5', () => {
        expect(PlaybackStartResponseSchema.shape.reporting).toBe(reportingBlockSchema);
        expect(PlaybackStartResponseSchema.safeParse(playbackStartFixture()).success).toBe(true);
    });

    it('reuses the shared live-hls delivery for a live start', () => {
        expect(PlaybackStartResponseSchema.shape.delivery.options[3]).toBe(LiveHlsDeliverySchema);
        expect(
            PlaybackStartResponseSchema.safeParse({
                ...playbackStartFixture(),
                kind: 'live',
                reporting: {
                    kind: 'keepalive',
                    method: 'POST',
                    playbackSessionId: 'test-session',
                    intervalMs: 10000,
                    href: '/api/v1/livetv/playback-sessions/x/keepalive',
                },
                delivery: {
                    kind: 'live-hls',
                    url: '/api/v1/livetv/stream?grant=secret',
                    feedId: '00000000-0000-4000-8000-000000000001',
                    requestedQuality: 'server',
                    appliedQuality: 'original',
                    requiresProxy: true,
                    rungId: null,
                    requestedMaxBitrateBps: null,
                    appliedMaxBitrateBps: null,
                    appliedMaxHeight: null,
                    reason: null,
                },
            }).success,
        ).toBe(true);
    });

    it('rejects a delivery with an unknown discriminator', () => {
        expect(
            PlaybackStartResponseSchema.safeParse({
                ...playbackStartFixture(),
                delivery: { kind: 'stream', url: '/stream' },
            }).success,
        ).toBe(false);
    });
});

it.each([
    { forceTranscode: true },
    { device: {} },
    { subtitleStreamIndex: -1 },
    { audio: { bitrate: 128 } },
    { capabilities: { maxVideoBitrate: 1000 } },
])('rejects retired start fields %j', (retired) => {
    expect(PlaybackStartRequestSchema.safeParse({ ...request, ...retired }).success).toBe(false);
});

it('rejects ordinary starts with a preview purpose', () => {
    expect(PlaybackStartRequestSchema.safeParse({ ...request, purpose: 'preview' }).success).toBe(
        false,
    );
});

it('distinguishes progress PUT from lease keepalive POST', () => {
    const base = { playbackSessionId: request.mediaId, href: '/issued', intervalMs: 10000 };
    expect(
        reportingBlockSchema.safeParse({ ...base, kind: 'progress', method: 'PUT', unit: 'ms' })
            .success,
    ).toBe(true);
    expect(
        reportingBlockSchema.safeParse({ ...base, kind: 'keepalive', method: 'POST' }).success,
    ).toBe(true);
    expect(
        reportingBlockSchema.safeParse({ ...base, kind: 'keepalive', method: 'PUT' }).success,
    ).toBe(false);
    expect(reportingBlockSchema.safeParse(base).success).toBe(false);
});

it('publishes scrubbing metadata as trickplay', () => {
    const fixture = playbackStartFixture();
    const parsed = PlaybackStartResponseSchema.parse({
        ...fixture,
        delivery: {
            ...fixture.delivery,
            trickplay: { href: '/issued/trickplay', intervalMs: 10000 },
        },
    });
    expect(parsed.delivery).toHaveProperty('trickplay');
});

it.each(['continue', 'next_up', 'autoplay', 'resume', 'explicit'])(
    'accepts entry %s in the strict start contract',
    (entry) => {
        expect(PlaybackStartRequestSchema.parse({ ...request, entry }).entry).toBe(entry);
        expect(
            PlaybackStartRequestSchema.safeParse({ ...request, entry, purpose: 'preview' }).success,
        ).toBe(false);
    },
);
it('rejects unknown entry modes', () => {
    expect(PlaybackStartRequestSchema.safeParse({ ...request, entry: 'unknown' }).success).toBe(
        false,
    );
});
