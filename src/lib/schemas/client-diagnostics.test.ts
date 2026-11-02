// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as schemas from './client-diagnostics.js';
import {
    diagnosticEventSchema,
    diagnosticEventBatchSchema,
    diagnosticBundleSchema,
} from './client-diagnostics.js';

const base = {
    eventId: '6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11',
    platform: 'ios' as const,
    occurredAt: Date.now(),
};

describe('client diagnostics wire schemas', () => {
    it('accepts one event of every automatic kind', () => {
        const events = [
            {
                ...base,
                kind: 'crash',
                payload: { source: 'metrickit', confidence: 'high', callStacks: [] },
            },
            {
                ...base,
                kind: 'hang',
                payload: {
                    source: 'metrickit',
                    confidence: 'high',
                    hangDurationMs: 3000,
                    callStacks: [],
                },
            },
            {
                ...base,
                kind: 'js_error',
                platform: 'web',
                payload: { name: 'TypeError', message: 'x', origin: 'window_error' },
            },
            {
                ...base,
                kind: 'api_failures',
                payload: {
                    windowStart: Date.now() - 1000,
                    windowEnd: Date.now(),
                    method: 'GET',
                    route: 'getMediaIdDetail',
                    outcome: 'status_5xx',
                    status: 502,
                },
                occurrences: 4,
            },
            {
                ...base,
                kind: 'playback_incident',
                attemptId: 'a1',
                payload: { triggerType: 'terminal', timeline: [] },
            },
        ];
        for (const e of events)
            expect(diagnosticEventSchema.safeParse(e).success, e.kind).toBe(true);
    });

    it('rejects log_bundle in the event batch (own endpoint)', () => {
        expect(
            diagnosticEventSchema.safeParse({ ...base, kind: 'log_bundle', payload: {} }).success,
        ).toBe(false);
    });

    it('caps the batch at 50 events', () => {
        const e = {
            ...base,
            kind: 'js_error',
            platform: 'web',
            payload: { name: 'E', message: 'm', origin: 'window_error' },
        };
        expect(diagnosticEventBatchSchema.safeParse({ events: Array(50).fill(e) }).success).toBe(
            true,
        );
        expect(diagnosticEventBatchSchema.safeParse({ events: Array(51).fill(e) }).success).toBe(
            false,
        );
    });

    it('rejects an api_failures route that looks like a raw path or URL', () => {
        for (const route of [
            '/media/6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11',
            '/search?q=secret',
            'https://x/y',
            '/items/123456',
            '/items/1',
            '/items/12',
            '/items/123',
        ]) {
            const r = diagnosticEventSchema.safeParse({
                ...base,
                kind: 'api_failures',
                payload: {
                    windowStart: 1_700_000_000_000,
                    windowEnd: 1_700_000_001_000,
                    method: 'GET',
                    route,
                    outcome: 'network',
                },
            });
            expect(r.success, route).toBe(false);
        }
        for (const route of ['/api/media/:id/detail', 'getV1Items']) {
            const ok = diagnosticEventSchema.safeParse({
                ...base,
                kind: 'api_failures',
                payload: {
                    windowStart: 1_700_000_000_000,
                    windowEnd: 1_700_000_001_000,
                    method: 'GET',
                    route,
                    outcome: 'network',
                },
            });
            expect(ok.success, route).toBe(true);
        }
    });

    it('rejects a log tail over 200 lines', () => {
        const r = diagnosticEventSchema.safeParse({
            ...base,
            kind: 'crash',
            payload: {
                source: 'abnormal_exit',
                confidence: 'low',
                callStacks: [],
                logTail: { lines: Array(201).fill('x'), truncated: false, source: 'previous_run' },
            },
        });
        expect(r.success).toBe(false);
    });

    it('rejects a log tail at or under 200 lines whose serialized size exceeds 32 KiB', () => {
        const r = diagnosticEventSchema.safeParse({
            ...base,
            kind: 'crash',
            payload: {
                source: 'abnormal_exit',
                confidence: 'low',
                callStacks: [],
                // 200 lines * 2000-char max length is far over 32 KiB serialized.
                logTail: {
                    lines: Array(200).fill('x'.repeat(2000)),
                    truncated: false,
                    source: 'previous_run',
                },
            },
        });
        expect(r.success).toBe(false);
    });

    it('rejects a js_error route with a query string, fragment, or scheme', () => {
        for (const route of ['/error?x=1', '/error#section', 'https://x/error']) {
            const r = diagnosticEventSchema.safeParse({
                ...base,
                kind: 'js_error',
                platform: 'web',
                payload: { name: 'TypeError', message: 'x', origin: 'window_error', route },
            });
            expect(r.success, route).toBe(false);
        }
        const ok = diagnosticEventSchema.safeParse({
            ...base,
            kind: 'js_error',
            platform: 'web',
            payload: { name: 'TypeError', message: 'x', origin: 'window_error', route: '/error' },
        });
        expect(ok.success).toBe(true);
    });

    it('rejects a playback_incident with clientInfo over the legacy 32-key/4096-byte cap', () => {
        const tooManyKeys: Record<string, number> = {};
        for (let i = 0; i < 33; i++) tooManyKeys[`k${i}`] = i;
        const r1 = diagnosticEventSchema.safeParse({
            ...base,
            kind: 'playback_incident',
            attemptId: 'a1',
            payload: { triggerType: 'terminal', timeline: [], clientInfo: tooManyKeys },
        });
        expect(r1.success).toBe(false);

        const tooManyBytes = { blob: 'x'.repeat(4096) };
        const r2 = diagnosticEventSchema.safeParse({
            ...base,
            kind: 'playback_incident',
            attemptId: 'a1',
            payload: { triggerType: 'terminal', timeline: [], clientInfo: tooManyBytes },
        });
        expect(r2.success).toBe(false);
    });

    it('rejects a playback_incident timeline with <=200 entries that exceeds the byte cap', () => {
        const bigEntry = { blob: 'x'.repeat(2000) };
        const r = diagnosticEventSchema.safeParse({
            ...base,
            kind: 'playback_incident',
            attemptId: 'a1',
            payload: { triggerType: 'terminal', timeline: Array(200).fill(bigEntry) },
        });
        expect(r.success).toBe(false);
    });

    it('accepts a bundle with base64 content and rejects a non-base64 body', () => {
        const ok = diagnosticBundleSchema.safeParse({
            ...base,
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: 'H4sIAAAAAAAAA8tIzcnJBwCGphA2BQAAAA==',
        });
        expect(ok.success).toBe(true);
        const bad = diagnosticBundleSchema.safeParse({
            ...base,
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: 'not base64!!',
        });
        expect(bad.success).toBe(false);
    });

    it('accountIds must be uuids (either case) and at most 16', () => {
        const bundle = (accountIds: string[]) =>
            diagnosticBundleSchema.safeParse({
                ...base,
                trigger: 'user',
                scope: 'device',
                accountIds,
                contentGzipBase64: 'H4sIAAAAAAAAA8tIzcnJBwCGphA2BQAAAA==',
            });
        const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
        expect(bundle([id, id.toUpperCase()]).success).toBe(true);
        expect(bundle(['alice']).success).toBe(false);
        expect(bundle(Array(17).fill(id)).success).toBe(false);
    });

    it('rejects base64 with the wrong length or misplaced padding', () => {
        for (const contentGzipBase64 of ['AAAA=', 'AAAAA']) {
            const r = diagnosticBundleSchema.safeParse({
                ...base,
                trigger: 'user',
                scope: 'account',
                contentGzipBase64,
            });
            expect(r.success, contentGzipBase64).toBe(false);
        }
    });

    it('accepts base64 decoding to exactly the 2 MiB cap and rejects one byte over', () => {
        const capBytes = 2 * 1024 * 1024; // EVENT_LIMITS.bundleGzipBytes
        // capBytes % 3 === 2, so the base64 encoding of exactly capBytes needs
        // one '=' of padding; capBytes + 1 is a multiple of 3 and needs none —
        // both encode to the same base64 LENGTH, differing only in padding.
        expect(capBytes % 3).toBe(2);
        const encodedLength = Math.ceil(capBytes / 3) * 4;

        const atCap = 'A'.repeat(encodedLength - 1) + '=';
        const okAtCap = diagnosticBundleSchema.safeParse({
            ...base,
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: atCap,
        });
        expect(okAtCap.success).toBe(true);

        const overCap = 'A'.repeat(encodedLength);
        const rejectOverCap = diagnosticBundleSchema.safeParse({
            ...base,
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: overCap,
        });
        expect(rejectOverCap.success).toBe(false);
    });

    it('never marks a field both optional and nullable (Swift codegen)', () => {
        const offenders: string[] = [];
        const visit = (schema: z.ZodTypeAny, path: string): void => {
            let s: z.ZodTypeAny = schema;
            let optional = false;
            let nullable = false;
            for (;;) {
                if (s instanceof z.ZodOptional) {
                    optional = true;
                    s = s.unwrap() as z.ZodTypeAny;
                    continue;
                }
                if (s instanceof z.ZodNullable) {
                    nullable = true;
                    s = s.unwrap() as z.ZodTypeAny;
                    continue;
                }
                if (s instanceof z.ZodDefault) {
                    s = s.unwrap() as z.ZodTypeAny;
                    continue;
                }
                break;
            }
            if (optional && nullable) offenders.push(path);
            if (s instanceof z.ZodObject)
                for (const [k, v] of Object.entries(s.shape))
                    visit(v as z.ZodTypeAny, `${path}.${k}`);
            else if (s instanceof z.ZodArray) visit(s.element as z.ZodTypeAny, `${path}[]`);
            else if (s instanceof z.ZodDiscriminatedUnion)
                for (const o of s.options) visit(o as z.ZodTypeAny, path);
        };
        for (const [name, value] of Object.entries(schemas))
            if (value instanceof z.ZodType) visit(value, name);
        expect(offenders).toEqual([]);
    });
});

it('bounds optional decode diagnostics and rejects UUID key paths but permits array indices', () => {
    const event = {
        ...base,
        kind: 'api_failures',
        payload: {
            windowStart: Date.now(),
            windowEnd: Date.now(),
            method: 'GET',
            route: '/api/items/:id',
            outcome: 'decode',
            keyPath: 'items.3.image.url',
            issueCount: 10_000,
            detail: 'x'.repeat(300),
        },
    };
    expect(diagnosticEventSchema.safeParse(event).success).toBe(true);
    for (const override of [
        { keyPath: base.eventId },
        { keyPath: 'x'.repeat(201) },
        { keyPath: null },
        { issueCount: 0 },
        { issueCount: 10_001 },
        { issueCount: 1.5 },
        { issueCount: null },
        { detail: 'x'.repeat(301) },
        { detail: null },
    ]) {
        expect(
            diagnosticEventSchema.safeParse({
                ...event,
                payload: { ...event.payload, ...override },
            }).success,
        ).toBe(false);
    }
});
