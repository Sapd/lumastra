// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveTvDiagnostics from './LiveTvDiagnostics.svelte';
import type { ProxyChannelInfo } from '$lib/schemas/livetv';
import * as m from '$lib/paraglide/messages';

const channel: ProxyChannelInfo = {
    channelId: 'channel',
    channelName: 'DAZN 2',
    sourceId: 'source',
    viewers: 1,
    ffmpegHealthy: true,
    ffmpegHealth: 'healthy',
    startedAt: '2026-10-26T10:00:00Z',
};
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('live TV diagnostics', () => {
    it('shows progressing output independently of process health and updates its age', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-26T10:00:10Z'));
        const { container, rerender } = render(LiveTvDiagnostics, {
            channel: {
                ...channel,
                lastSegmentAt: '2026-10-26T10:00:08Z',
                segmentCount: 10,
                memoryBytes: 2097152,
                failoverCount: 2,
                probeResult: {
                    videoCodec: 'h264',
                    audioCodec: 'aac',
                    width: 1920,
                    height: 1080,
                    interlaced: false,
                    hdr: false,
                    bitDepth: 8,
                },
                transcodeDecision: {
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    videoEncoder: null,
                    deinterlace: false,
                    reason: 'audio',
                },
                outputDiagnostics: {
                    bufferedSeconds: 59.8,
                    timestampSamples: 100,
                    gapCount: 1,
                    resetCount: 0,
                    largestGapSeconds: 8,
                },
            },
        });
        expect(container.textContent).toContain('h264');
        expect(container.textContent).toContain('1920×1080');
        expect(container.textContent).toContain(m.admin_livetv_seconds({ seconds: '59.8' }));
        expect(container.textContent).toContain('2.0 MiB');
        expect(container.textContent).toContain(m.admin_sessions_seconds_ago({ seconds: 2 }));
        expect(container.querySelector('.text-amber-300')?.textContent).toBe('1');
        await vi.advanceTimersByTimeAsync(5000);
        expect(container.textContent).toContain(m.admin_sessions_seconds_ago({ seconds: 7 }));
        await rerender({ channel });
        expect(screen.getAllByText(m.admin_livetv_unavailable()).length).toBeGreaterThan(0);
    });
    it('does not claim continuity was measured on an older proxy or a stream without timestamps', () => {
        const { container } = render(LiveTvDiagnostics, {
            channel: {
                ...channel,
                outputDiagnostics: {
                    bufferedSeconds: 0,
                    timestampSamples: 0,
                    gapCount: 0,
                    resetCount: 0,
                    largestGapSeconds: 0,
                },
            },
        });
        expect(container.textContent).toContain(m.admin_livetv_unavailable());
        expect(container.textContent).not.toContain(m.admin_livetv_largest_gap());
        expect(container.querySelector('details')).not.toBeNull();
        expect(container.querySelector('summary')).not.toBeNull();
    });
});
