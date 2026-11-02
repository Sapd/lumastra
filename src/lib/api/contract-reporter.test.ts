// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { diagnosticEventBatchSchema } from '$lib/schemas/client-diagnostics.js';

const env = vi.hoisted(() => ({ browser: true }));
vi.mock('$app/environment', () => ({
    get browser() {
        return env.browser;
    },
    version: 'v'.repeat(50),
}));
vi.mock('$app/paths', () => ({ base: '/lumastra' }));

const error = z
    .object({ items: z.array(z.object({ url: z.string() })) })
    .safeParse({ items: [{}] }).error!;
const uuid = '6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11';

describe('contract reporter', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        env.browser = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
        // The shared queue holds reports until the root layout passes the admin switch.
        (await import('$lib/client-diagnostics/web-reporter.js')).setClientDiagnosticsEnabled(true);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('batches, templates server paths, deduplicates and emits valid wire events without bodies', async () => {
        const { reportApiContractMismatch: report } = await import('./contract-reporter.js');
        report(`/api/items/${uuid}/123?token=secret`, 'GET', 200, error);
        report(`/api/items/${uuid}/456`, 'GET', 200, error);
        report(`/api/items/${uuid}/456`, 'POST', 204, error);
        expect(fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('/lumastra/api/diagnostics/events');
        expect(init).toMatchObject({ keepalive: true, credentials: 'same-origin' });
        const batch = JSON.parse(init!.body as string);
        expect(diagnosticEventBatchSchema.safeParse(batch).success).toBe(true);
        expect(batch.events).toHaveLength(2);
        expect(batch.events[0]).toMatchObject({
            platform: 'web',
            appVersion: 'v'.repeat(32),
            payload: {
                route: '/lumastra/api/items/:id/:id',
                keyPath: 'items.0.url',
                issueCount: 1,
                outcome: 'decode',
            },
        });
        expect(init!.body).not.toContain('secret');
        report(`/api/items/${uuid}/789`, 'GET', 200, error);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('caps at 20 reports for the page even across batches', async () => {
        const { reportApiContractMismatch: report } = await import('./contract-reporter.js');
        // Paths outside the route tree all template to /api/:id; the key path keeps them apart.
        for (let i = 0; i < 25; i++) {
            const issue = z.object({ [`f${i}`]: z.string() }).safeParse({}).error!;
            report(`/api/route${i}`, 'GET', 200, issue);
        }
        await vi.advanceTimersByTimeAsync(2000);
        expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).events).toHaveLength(
            20,
        );
        report('/api/another', 'GET', 200, error);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not report on the server or report its own sink; swallows transport errors', async () => {
        const { reportApiContractMismatch: report } = await import('./contract-reporter.js');
        env.browser = false;
        report('/api/things', 'GET', 200, error);
        env.browser = true;
        report('/api/diagnostics/events', 'POST', 200, error);
        report('/api/v1/diagnostics/events', 'POST', 200, error);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).not.toHaveBeenCalled();
        vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
        report('/api/things', 'GET', 200, error);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

it('keeps escaped diagnostic text within 2 KiB and provides a UUID fallback', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    env.browser = true;
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
    try {
        (await import('$lib/client-diagnostics/web-reporter.js')).setClientDiagnosticsEnabled(true);
        const { reportApiContractMismatch: report } = await import('./contract-reporter.js');
        const longError = new z.ZodError([
            {
                code: 'custom',
                path: ['\u0001'.repeat(200)],
                message: '\u0001'.repeat(300),
            },
        ]);
        report('/api/items', 'GET', 200, longError);
        await vi.advanceTimersByTimeAsync(2000);
        const batch = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(diagnosticEventBatchSchema.safeParse(batch).success).toBe(true);
        expect(
            new TextEncoder().encode(JSON.stringify(batch.events[0].payload)).byteLength,
        ).toBeLessThanOrEqual(2048);
        expect(batch.events[0].eventId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
    } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});
