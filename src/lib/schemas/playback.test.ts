// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { playbackIncidentReportSchema, playbackIncidentResolveSchema } from './playback.js';
import { publicTelemetryReportSchema, clientMetricTypeSchema } from './playback.js';
import {
    speedTestModeSchema,
    speedTestRequestSchema,
    speedTestResultSchema,
    SPEED_TEST_CADENCE_CHUNK_BYTES,
    SPEED_TEST_CADENCE_GAP_MS,
    SPEED_TEST_CADENCE_REQUESTS,
    SPEED_TEST_LONG_BYTES,
    SPEED_TEST_LONG_CAP_MS,
    SPEED_TEST_MAX_BYTES,
} from './playback.js';

describe('playbackIncidentReportSchema', () => {
    it('accepts a minimal valid report', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'terminal',
            timeline: [],
        });
        expect(result.success).toBe(true);
    });

    it('accepts an empty playSessionId, as the unload beacon sends', () => {
        // IncidentReporter.onPageHide() has no session id to send (and none
        // exists at all when the very first playback request failed). Rejecting
        // it 422'd every terminal beacon.
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: '',
            incidentAt: Date.now(),
            triggerType: 'terminal',
            timeline: [],
        });
        expect(result.success).toBe(true);
    });

    it('still rejects a playSessionId over the length cap', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 'x'.repeat(65),
            incidentAt: Date.now(),
            triggerType: 'terminal',
            timeline: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects an unknown triggerType', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'bogus',
            timeline: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects a timeline array over the sanity cap', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline: Array.from({ length: 201 }, () => ({ t: 0, kind: 'seek' })),
        });
        expect(result.success).toBe(false);
    });

    it('strips unknown fields rather than rejecting', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'terminal',
            timeline: [],
            somethingUnexpected: 'x',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect('somethingUnexpected' in result.data).toBe(false);
        }
    });

    it('rejects a non-finite incidentAt', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Number.POSITIVE_INFINITY,
            triggerType: 'terminal',
            timeline: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects an implausibly out-of-range incidentAt', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Number.MAX_SAFE_INTEGER,
            triggerType: 'terminal',
            timeline: [],
        });
        expect(result.success).toBe(false);
    });

    it('accepts explicit null for optional fields (not just absence)', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'terminal',
            errorType: null,
            stage: null,
            serverDiagnosticCode: null,
            reconnectCause: null,
            message: null,
            clientInfo: null,
            deviceId: null,
            timeline: [],
        });
        expect(result.success).toBe(true);
    });

    it('rejects triggerType "error" without errorType', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline: [],
        });
        expect(result.success).toBe(false);
    });

    it('accepts triggerType "error" with errorType', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            errorType: 'network',
            timeline: [],
        });
        expect(result.success).toBe(true);
    });

    it('rejects triggerType "reconnect" without reconnectCause', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'reconnect',
            timeline: [],
        });
        expect(result.success).toBe(false);
    });

    it('accepts triggerType "reconnect" with reconnectCause', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'reconnect',
            reconnectCause: 'network',
            timeline: [],
        });
        expect(result.success).toBe(true);
    });

    it('rejects a timeline under the entry cap but over the byte-size cap', () => {
        const result = playbackIncidentReportSchema.safeParse({
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'terminal',
            timeline: Array.from({ length: 150 }, () => ({
                t: 0,
                kind: 'seek',
                blob: 'x'.repeat(5_000),
            })),
        });
        expect(result.success).toBe(false);
    });
});

describe('playbackIncidentResolveSchema', () => {
    it('requires attemptId only', () => {
        const result = playbackIncidentResolveSchema.safeParse({ attemptId: 'a1' });
        expect(result.success).toBe(true);
    });
});

describe('delivery_window telemetry type', () => {
    it('is an accepted client metric type', () => {
        expect(clientMetricTypeSchema.safeParse('delivery_window').success).toBe(true);
    });
    it('round-trips through the public report schema with numeric metadata', () => {
        const parsed = publicTelemetryReportSchema.safeParse({
            playbackSessionId: '4b7e3d0e-7f4d-4f1a-9f1a-0f2a3b4c5d6e',
            clientType: 'avplayer',
            events: [
                {
                    type: 'delivery_window',
                    value: 12_000_000,
                    metadata: { bytes: 45_000_000, overdue: 1 },
                    timestamp: Date.now(),
                },
            ],
        });
        expect(parsed.success).toBe(true);
    });
});

describe('speedTestResultSchema clientInfo', () => {
    const base = {
        bytesRequested: 16 * 1024 * 1024,
        bytesReceived: 1_000_000,
        durationMs: 1500,
        ttfbMs: 500,
        buckets: [],
    };

    function clientInfoOf(keys: number): Record<string, string> {
        return Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, 'v']));
    }

    it('accepts exactly 16 keys', () => {
        const parsed = speedTestResultSchema.safeParse({ ...base, clientInfo: clientInfoOf(16) });
        expect(parsed.success).toBe(true);
    });

    it('rejects the 17th key — the cap is the spec bound, not the 32-key metadata one', () => {
        const parsed = speedTestResultSchema.safeParse({ ...base, clientInfo: clientInfoOf(17) });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((i) => i.message.includes('16 keys'))).toBe(true);
    });

    it('an absent clientInfo is still valid', () => {
        expect(speedTestResultSchema.safeParse(base).success).toBe(true);
    });
});

describe('speedTestResultSchema modes', () => {
    const base = {
        bytesRequested: 16 * 1024 * 1024,
        bytesReceived: 1_000_000,
        durationMs: 1500,
        ttfbMs: 500,
        buckets: [],
    };

    const request = { bytes: SPEED_TEST_CADENCE_CHUNK_BYTES, ttfbMs: 40, durationMs: 900 };

    it('knows exactly three modes', () => {
        expect(speedTestModeSchema.options).toEqual(['single', 'long', 'cadence']);
    });

    it('defaults mode to single so a pre-modes client keeps working', () => {
        const parsed = speedTestResultSchema.parse(base);
        expect(parsed.mode).toBe('single');
        expect(parsed.requests).toBeUndefined();
    });

    it('accepts long with the 60 s cap worth of 250 ms buckets (240)', () => {
        const buckets = Array.from({ length: 240 }, () => ({ ms: 250, bytes: 1000 }));
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'long',
            bytesRequested: SPEED_TEST_LONG_BYTES,
            durationMs: SPEED_TEST_LONG_CAP_MS,
            buckets,
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects a 241st bucket', () => {
        const buckets = Array.from({ length: 241 }, () => ({ ms: 250, bytes: 1000 }));
        expect(speedTestResultSchema.safeParse({ ...base, mode: 'long', buckets }).success).toBe(
            false,
        );
    });

    it('accepts a cadence run of 8 requests with no buckets', () => {
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'cadence',
            bytesRequested: SPEED_TEST_CADENCE_CHUNK_BYTES * SPEED_TEST_CADENCE_REQUESTS,
            bytesReceived: SPEED_TEST_CADENCE_CHUNK_BYTES * SPEED_TEST_CADENCE_REQUESTS,
            durationMs: 30_000,
            requests: Array.from({ length: SPEED_TEST_CADENCE_REQUESTS }, () => request),
        });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.requests?.length).toBe(8);
    });

    it('the full cadence request total fits under the bytesRequested ceiling', () => {
        expect(SPEED_TEST_CADENCE_CHUNK_BYTES * SPEED_TEST_CADENCE_REQUESTS).toBe(33_554_432);
        expect(SPEED_TEST_CADENCE_CHUNK_BYTES * SPEED_TEST_CADENCE_REQUESTS).toBeLessThanOrEqual(
            SPEED_TEST_MAX_BYTES,
        );
    });

    it('rejects cadence without requests', () => {
        const parsed = speedTestResultSchema.safeParse({ ...base, mode: 'cadence' });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((i) => i.path.includes('requests'))).toBe(true);
    });

    it('rejects cadence with an empty requests array', () => {
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'cadence',
            requests: [],
        });
        expect(parsed.success).toBe(false);
    });

    it('rejects requests on a single run', () => {
        const parsed = speedTestResultSchema.safeParse({ ...base, requests: [request] });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((i) => i.path.includes('requests'))).toBe(true);
    });

    it('rejects requests on a long run', () => {
        expect(
            speedTestResultSchema.safeParse({ ...base, mode: 'long', requests: [request] }).success,
        ).toBe(false);
    });

    it('accepts an explicitly empty requests array on a single run', () => {
        expect(speedTestResultSchema.safeParse({ ...base, requests: [] }).success).toBe(true);
    });

    it('rejects a 65th cadence request', () => {
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'cadence',
            requests: Array.from({ length: 65 }, () => request),
        });
        expect(parsed.success).toBe(false);
    });

    it('rejects an unknown mode', () => {
        expect(speedTestResultSchema.safeParse({ ...base, mode: 'turbo' }).success).toBe(false);
    });

    it('accepts a zero-byte request — a dead fetch is the evidence, not an error', () => {
        expect(
            speedTestRequestSchema.safeParse({ bytes: 0, ttfbMs: 20_000, durationMs: 20_000 })
                .success,
        ).toBe(true);
    });

    it('rejects a request whose timings exceed the 120 s bound', () => {
        expect(
            speedTestRequestSchema.safeParse({ bytes: 10, ttfbMs: 0, durationMs: 120_001 }).success,
        ).toBe(false);
    });

    it('accepts a request whose ttfbMs equals durationMs', () => {
        expect(
            speedTestRequestSchema.safeParse({ bytes: 10, ttfbMs: 900, durationMs: 900 }).success,
        ).toBe(true);
    });

    it('rejects a request whose first byte arrives after its own end', () => {
        const parsed = speedTestRequestSchema.safeParse({
            bytes: 10,
            ttfbMs: 901,
            durationMs: 900,
        });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((i) => i.path.includes('ttfbMs'))).toBe(true);
    });

    it('pins the cadence gap at 2 s', () => {
        expect(SPEED_TEST_CADENCE_GAP_MS).toBe(2000);
    });

    it('the long profile IS the endpoint ceiling, not a second 64 MiB literal', () => {
        expect(SPEED_TEST_LONG_BYTES).toBe(SPEED_TEST_MAX_BYTES);
    });

    /**
     * The per-request series is the cadence numerator, so a run whose requests do
     * not account for `bytesReceived` would let a client claim 32 MiB moved in
     * 1 ms — an arbitrarily large "speed" off a payload that never arrived.
     */
    it('rejects a cadence run whose requests do not sum to bytesReceived', () => {
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'cadence',
            bytesRequested: SPEED_TEST_CADENCE_CHUNK_BYTES,
            bytesReceived: SPEED_TEST_CADENCE_CHUNK_BYTES,
            requests: [{ bytes: 1_000, ttfbMs: 1, durationMs: 2 }],
        });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((i) => i.path.includes('bytesReceived'))).toBe(true);
    });

    it('accepts a cadence run whose requests sum exactly to bytesReceived', () => {
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'cadence',
            bytesRequested: SPEED_TEST_CADENCE_CHUNK_BYTES * 2,
            bytesReceived: 1_500_000,
            requests: [
                { bytes: 1_000_000, ttfbMs: 100, durationMs: 1_100 },
                { bytes: 500_000, ttfbMs: 500, durationMs: 1_500 },
            ],
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects a cadence run that also carries buckets', () => {
        const parsed = speedTestResultSchema.safeParse({
            ...base,
            mode: 'cadence',
            bytesReceived: 1_000_000,
            buckets: [{ ms: 250, bytes: 1_000_000 }],
            requests: [{ bytes: 1_000_000, ttfbMs: 100, durationMs: 1_100 }],
        });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((i) => i.path.includes('buckets'))).toBe(true);
    });
});

describe('telemetry playback session vocabulary', () => {
    it('requires playbackSessionId and refuses the removed spelling', () => {
        const id = '00000000-0000-4000-8000-000000000001';
        expect(
            publicTelemetryReportSchema.safeParse({ playbackSessionId: id, events: [] }).success,
        ).toBe(true);
        expect(
            publicTelemetryReportSchema.safeParse({ playSessionId: id, events: [] }).success,
        ).toBe(false);
    });
});
