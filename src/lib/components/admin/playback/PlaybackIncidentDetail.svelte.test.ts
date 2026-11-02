// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The delivery-windows table carried every metadata field the client reports
 * EXCEPT `minSegBps` — the slowest single segment in the window. That is the one
 * column that distinguishes "one segment arrived late" from "every segment in
 * this window was slow", which is exactly the distinction the window average
 * erases, so the table was missing the number it exists to show.
 *
 * `null` must read as `—`: the metadata bag is written by whichever client
 * version was playing, and a field it never sent is unknown, not 0 Mbit/s.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PlaybackIncidentDetail from './PlaybackIncidentDetail.svelte';
import type {
    PlaybackIncidentDetail as PlaybackIncidentDetailType,
    DeliveryWindow,
} from '$lib/schemas/api-playback-incidents.js';
import type { SpeedTestResultResponse } from '$lib/schemas/api-network-responses.js';

const INCIDENT: PlaybackIncidentDetailType = {
    id: 1,
    attemptId: 'attempt-1',
    playSessionId: '4b7e3d0e-7f4d-4f1a-9f1a-0f2a3b4c5d6e',
    incidentAt: '2026-09-12T10:00:00.000Z',
    serverRecordedAt: '2026-09-12T10:00:01.000Z',
    triggerType: 'error',
    errorType: 'bufferStalledError',
    stage: null,
    httpStatus: null,
    serverDiagnosticCode: null,
    reconnectCause: null,
    message: null,
    userId: null,
    deviceId: null,
    mediaId: null,
    username: null,
    deviceName: null,
    mediaTitle: null,
    resolvedAt: null,
    timeline: [],
    clientInfo: null,
};

function window_(overrides: Partial<DeliveryWindow> = {}): DeliveryWindow {
    return {
        recordedAt: '2026-09-12T09:59:30.000Z',
        throughputBps: 20_000_000,
        bytes: 7_000_000,
        segments: 4,
        mediaSec: 24,
        transferMs: 2800,
        wallMaxMs: 9000,
        ttfbMaxMs: 120,
        minSegBps: 1_500_000,
        overdue: null,
        stalls: null,
        bufferAheadSec: 1.5,
        engine: 'hls_js',
        ...overrides,
    };
}

describe('PlaybackIncidentDetail — delivery windows table', () => {
    afterEach(() => cleanup());

    it('renders the slowest-segment column in Mbit/s', () => {
        render(PlaybackIncidentDetail, {
            incident: INCIDENT,
            correlatedTranscodeFailures: [],
            roots: { libraryRoots: [] },
            deliveryWindows: [window_()],
        });

        expect(screen.getByText('Slowest seg')).toBeTruthy();
        // The window averaged 20.0 Mbit/s while its worst segment managed 1.5 —
        // both must be on the row, or the average speaks for the window alone.
        expect(screen.getByText('20.0')).toBeTruthy();
        expect(screen.getByText('1.5')).toBeTruthy();
    });

    it('reads a client that never sent minSegBps as —, not as 0.0', () => {
        render(PlaybackIncidentDetail, {
            incident: INCIDENT,
            correlatedTranscodeFailures: [],
            roots: { libraryRoots: [] },
            deliveryWindows: [window_({ minSegBps: null })],
        });

        expect(screen.getByText('Slowest seg')).toBeTruthy();
        expect(screen.queryByText('0.0')).toBeNull();
        expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });
});

/**
 * The speed-test strip has to say WHICH profile produced a row, because the three
 * do not answer the same question — and a cadence run records no buckets at all,
 * so its bucket-derived pair would render as "slowest ¼ s 0.0 Mbit/s · stalled
 * 0 ms": a confident claim where there is no measurement. Mirrors the same
 * assertions in SessionDetailDrawer.svelte.test.ts, the other strip.
 */
describe('PlaybackIncidentDetail — speed-test strip', () => {
    afterEach(() => cleanup());

    function speedTest(overrides: Partial<SpeedTestResultResponse> = {}): SpeedTestResultResponse {
        return {
            id: 21,
            mode: 'single',
            throughputBps: 18_400_000,
            ttfbMs: 42,
            minBucketBps: 900_000,
            stallMs: 500,
            requestCount: 1,
            maxTtfbMs: null,
            minRequestBps: null,
            bytesReceived: 16_777_216,
            durationMs: 7300,
            aborted: false,
            createdAt: '2026-09-13T09:58:00.000Z',
            ...overrides,
        };
    }

    function mount(speedTests: SpeedTestResultResponse[]): void {
        render(PlaybackIncidentDetail, {
            incident: INCIDENT,
            correlatedTranscodeFailures: [],
            roots: { libraryRoots: [] },
            speedTests,
        });
    }

    it('labels a quick run and keeps the bucket pair', () => {
        mount([speedTest()]);

        expect(screen.getByText('Recent speed tests')).toBeTruthy();
        expect(screen.getByText('quick')).toBeTruthy();
        expect(screen.getByText(/18\.4 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/first byte 42 ms/)).toBeTruthy();
        expect(screen.getByText(/slowest ¼ s 0\.9 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/stalled 500 ms/)).toBeTruthy();
    });

    it('labels a cadence run and swaps the bucket figures out for the worst segment', () => {
        mount([
            speedTest({
                id: 22,
                mode: 'cadence',
                requestCount: 8,
                maxTtfbMs: 910,
                minRequestBps: 4_200_000,
                throughputBps: 24_800_000,
                ttfbMs: 38,
                // No buckets were recorded, so neither figure below exists.
                minBucketBps: null,
                stallMs: 0,
                bytesReceived: 33_554_432,
                durationMs: 31_000,
            }),
        ]);

        expect(screen.getByText('cadence')).toBeTruthy();
        expect(screen.getByText(/24\.8 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/worst segment 4\.2 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/worst TTFB 910 ms/)).toBeTruthy();
        expect(screen.queryByText(/slowest ¼ s/)).toBeNull();
        expect(screen.queryByText(/stalled/)).toBeNull();
    });

    it('reads a cadence run with no worst-TTFB figure as —, not as 0 ms', () => {
        mount([
            speedTest({
                id: 23,
                mode: 'cadence',
                requestCount: 8,
                maxTtfbMs: null,
                minRequestBps: null,
                minBucketBps: null,
                stallMs: 0,
            }),
        ]);

        expect(screen.getByText('cadence')).toBeTruthy();
        expect(screen.getByText(/worst TTFB — ms/)).toBeTruthy();
        expect(screen.queryByText(/worst TTFB 0 ms/)).toBeNull();
    });
});
