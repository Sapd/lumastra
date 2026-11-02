// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveStartFixture } from '$lib/utils/livetv-start.fixture.js';
const renew = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', async (original) => ({
    ...(await original<typeof import('$lib/api/client.js')>()),
    apiPost: renew,
}));
import { LiveTvHeartbeat } from './livetv-heartbeat.js';
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    renew.mockReset();
    fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe('Live grant ownership', () => {
    it.each(['internal', 'v1'] as const)(
        'follows the %s issued heartbeat href and renews the owned delivery',
        async (surface) => {
            const start = liveStartFixture('live', surface);
            start.reporting.href += '?issued=opaque';
            start.grant.renewAfter = new Date(Date.now() + 2000).toISOString();
            const next = {
                ...start.grant,
                token: 'renewed',
                renewAfter: new Date(Date.now() + 60000).toISOString(),
            };
            renew.mockResolvedValue({ status: 200, data: next });
            const onRenew = vi.fn();
            const heartbeat = new LiveTvHeartbeat(
                start,
                10000,
                undefined,
                undefined,
                undefined,
                undefined,
                onRenew,
            );
            expect(fetcher).toHaveBeenCalledWith(
                start.reporting.href,
                expect.objectContaining({ method: 'POST' }),
            );
            await vi.advanceTimersByTimeAsync(2000);
            expect(renew).toHaveBeenCalledWith(start.grant.renewHref, expect.anything(), {
                token: 'original',
            });
            expect(start.delivery.url).toContain('grant=renewed');
            expect(onRenew).toHaveBeenCalledOnce();
            await heartbeat.destroy();
            await vi.advanceTimersByTimeAsync(120000);
            expect(renew).toHaveBeenCalledOnce();
        },
    );
    it('ignores an in-flight renewal after disposal and sends one DELETE', async () => {
        const start = liveStartFixture();
        start.grant.renewAfter = new Date(Date.now() + 1000).toISOString();
        let resolve!: (value: unknown) => void;
        renew.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const onRenew = vi.fn();
        const heartbeat = new LiveTvHeartbeat(
            start,
            10000,
            undefined,
            undefined,
            undefined,
            undefined,
            onRenew,
        );
        await vi.advanceTimersByTimeAsync(1000);
        await heartbeat.destroy();
        await heartbeat.destroy();
        resolve({ status: 200, data: { ...start.grant, token: 'stale' } });
        await vi.advanceTimersByTimeAsync(60000);
        expect(start.grant.token).toBe('original');
        expect(onRenew).not.toHaveBeenCalled();
        expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(1);
        expect(renew).toHaveBeenCalledOnce();
    });
    it('stops renewal after terminal keepalive and never renews that session again', async () => {
        const start = liveStartFixture();
        start.grant.renewAfter = new Date(Date.now() + 1000).toISOString();
        fetcher.mockResolvedValue(
            new Response(JSON.stringify({ reason: 'expired' }), { status: 410 }),
        );
        const heartbeat = new LiveTvHeartbeat(start);
        await vi.advanceTimersByTimeAsync(60000);
        expect(renew).not.toHaveBeenCalled();
        await heartbeat.destroy();
    });
});
