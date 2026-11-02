// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    PlaybackIncidentListResponseSchema,
    PlaybackIncidentDetailResponseSchema,
    DeliveryWindowSchema,
} from './api-playback-incidents.js';

describe('PlaybackIncidentListResponseSchema', () => {
    it('parses a list response', () => {
        const result = PlaybackIncidentListResponseSchema.safeParse({
            items: [
                {
                    id: 1,
                    attemptId: 'a1',
                    playSessionId: 's1',
                    incidentAt: '2026-08-13T12:00:00.000Z',
                    serverRecordedAt: '2026-08-13T12:00:01.000Z',
                    triggerType: 'terminal',
                    errorType: null,
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
                },
            ],
            page: { limit: 50, offset: 0, hasMore: false, total: 1 },
        });
        expect(result.success).toBe(true);
    });
});

describe('PlaybackIncidentDetailResponseSchema', () => {
    it('parses a detail response including timeline and correlated failures', () => {
        const result = PlaybackIncidentDetailResponseSchema.safeParse({
            incident: {
                id: 1,
                attemptId: 'a1',
                playSessionId: 's1',
                incidentAt: '2026-08-13T12:00:00.000Z',
                serverRecordedAt: '2026-08-13T12:00:01.000Z',
                triggerType: 'error',
                errorType: 'network',
                stage: 'manifest',
                httpStatus: 502,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: 'boom',
                userId: null,
                deviceId: null,
                mediaId: null,
                username: null,
                deviceName: null,
                mediaTitle: null,
                resolvedAt: null,
                timeline: [{ t: 0, kind: 'seek' }],
                clientInfo: { userAgent: 'test' },
            },
            correlatedTranscodeFailures: [
                { occurredAt: '2026-08-13T11:59:00.000Z', category: 'gpu-failure', summary: 'x' },
            ],
            deliveryWindows: [
                {
                    recordedAt: '2026-08-13T11:59:30.000Z',
                    throughputBps: 1_200_000,
                    bytes: 4_500_000,
                    segments: 3,
                    mediaSec: 30,
                    transferMs: 29_000,
                    wallMaxMs: 12_000,
                    ttfbMaxMs: 800,
                    minSegBps: 400_000,
                    overdue: 2,
                    stalls: 1,
                    bufferAheadSec: 1.5,
                    engine: 'native_hls',
                },
            ],
            speedTests: [],
        });
        expect(result.success).toBe(true);
    });

    /**
     * Both delivery blocks are REQUIRED on the wire: the handler always sends
     * them (empty arrays when there is nothing), so an absent key means a
     * producer regressed rather than "this incident had no evidence".
     */
    it('rejects a detail response that omits the delivery evidence', () => {
        const result = PlaybackIncidentDetailResponseSchema.safeParse({
            incident: {
                id: 1,
                attemptId: 'a1',
                playSessionId: 's1',
                incidentAt: '2026-08-13T12:00:00.000Z',
                serverRecordedAt: '2026-08-13T12:00:01.000Z',
                triggerType: 'error',
                errorType: null,
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
            },
            correlatedTranscodeFailures: [],
        });
        expect(result.success).toBe(false);
    });
});

describe('DeliveryWindowSchema', () => {
    /**
     * `metadata` is a free-form jsonb bag written by whichever client version
     * was playing, so every derived number must be allowed to be null —
     * "unknown", never 0.
     */
    it('accepts a window whose metadata carried nothing but the throughput', () => {
        const result = DeliveryWindowSchema.safeParse({
            recordedAt: '2026-08-13T11:59:30.000Z',
            throughputBps: 900_000,
            bytes: null,
            segments: null,
            mediaSec: null,
            transferMs: null,
            wallMaxMs: null,
            ttfbMaxMs: null,
            minSegBps: null,
            overdue: null,
            stalls: null,
            bufferAheadSec: null,
            engine: null,
        });
        expect(result.success).toBe(true);
    });

    it('still requires the measured throughput', () => {
        const result = DeliveryWindowSchema.safeParse({
            recordedAt: '2026-08-13T11:59:30.000Z',
            bytes: null,
            segments: null,
            mediaSec: null,
            transferMs: null,
            wallMaxMs: null,
            ttfbMaxMs: null,
            minSegBps: null,
            overdue: null,
            stalls: null,
            bufferAheadSec: null,
            engine: null,
        });
        expect(result.success).toBe(false);
    });
});
