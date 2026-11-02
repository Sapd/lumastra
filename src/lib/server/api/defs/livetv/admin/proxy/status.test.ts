// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { ProxyStatusResponseSchema } from '$lib/schemas/livetv';

const { getProxyStatus } = vi.hoisted(() => ({ getProxyStatus: vi.fn() }));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({ getProxyStatus }),
}));

// Both real mounts must apply the same canonical output contract, including the
// deprecated admin alias that production's Sessions page still polls.
import { GET as internalGet } from '../../../../../../../routes/api/admin/livetv/proxy/status/+server';
import { GET as v1Get } from '../../../../../../../routes/api/v1/livetv/admin/proxy/status/+server';

afterEach(() => vi.restoreAllMocks());

describe('proxy status output through both mounted aliases', () => {
    it.each([
        ['/api/admin/livetv/proxy/status', internalGet],
        ['/api/v1/livetv/admin/proxy/status', v1Get],
    ] as const)(
        '%s preserves full runtime decisions and progress without contract drift',
        async (path, get) => {
            vi.spyOn(config, 'LIVETV_SOURCE', 'get').mockReturnValue('standalone');
            // Recorded wire shapes: a complete Rust decision and a failed probe.
            const decisions = [
                {
                    videoAction: 'transcode',
                    audioAction: 'transcode',
                    videoEncoder: 'libx264',
                    deinterlace: true,
                    deinterlaceFilterName: 'bwdif',
                    sourceCodec: 'hevc',
                    sourceHdr: true,
                    sourceInterlaced: true,
                    reason: 'Interlaced HDR source',
                },
                {
                    videoAction: 'transcode',
                    audioAction: 'transcode',
                    videoEncoder: 'libx264',
                    deinterlace: true,
                    deinterlaceFilterName: 'yadif',
                    sourceCodec: null,
                    sourceHdr: false,
                    sourceInterlaced: false,
                    reason: 'Probe failed',
                },
            ];
            expect(decisions[0]).toMatchObject({
                deinterlaceFilterName: 'bwdif',
                sourceCodec: 'hevc',
                sourceHdr: true,
                sourceInterlaced: true,
            });
            expect(decisions[1].sourceCodec).toBeNull();
            const payload = {
                healthy: true,
                uptime: 60,
                activeChannels: 2,
                totalViewers: 2,
                ffmpegAvailable: true,
                perSourceLimits: [],
                channels: decisions.map((decision, index) => ({
                    channelId: `feed-${index}`,
                    channelName: 'Example channel',
                    sourceId: 'source',
                    viewers: 1,
                    ffmpegHealthy: true,
                    startedAt: '2026-10-26T10:00:00.000Z',
                    lastSegmentAt: '2026-10-26T10:00:08.000Z',
                    transcodeDecision: decision,
                    lastFailureReason: 'upstream_stalled',
                    terminal: false,
                })),
            };
            getProxyStatus.mockResolvedValue(payload);
            const event = {
                request: new Request(`http://localhost${path}`),
                url: new URL(`http://localhost${path}`),
                route: { id: path },
                params: {},
                locals: { principal: { scopes: ['livetv:admin'] } },
                cookies: { get: vi.fn(), set: vi.fn() },
                getClientAddress: () => '127.0.0.1',
                setHeaders: vi.fn(),
                fetch: vi.fn(),
            } as unknown as RequestEvent;
            // In test mode mount() throws ResponseContractViolation if any nested
            // runtime field is stripped. Parsing again also covers the browser schema.
            const response = await get!(event);
            expect(response.status).toBe(200);
            const body: unknown = await response.json();
            expect(body).toEqual(payload);
            expect(ProxyStatusResponseSchema.parse(body)).toEqual(payload);
        },
    );
});
