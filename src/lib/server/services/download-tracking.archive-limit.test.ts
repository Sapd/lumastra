// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Every archive request is its own slot: with the REAL lease manager and a limit of 1, a second
// ZIP of the same title from the same device is refused (429), and a freed slot is reusable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const cfg = vi.hoisted(() => ({
    DOWNLOAD_THROTTLE_KBPS: 0,
    DOWNLOAD_USER_BANDWIDTH_KBPS: 0,
    DOWNLOAD_TOTAL_BANDWIDTH_KBPS: 0,
    DOWNLOAD_MAX_PARALLEL_PER_USER: 1,
    DOWNLOAD_MIN_SPEED_KBPS: 0,
}));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient: () => null }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));
vi.mock('$lib/paraglide/messages', () => ({ downloads_limit_reached: () => 'limit' }));

import { trackDownload } from './download-tracking';
import { resetDownloadLeasesForTests } from './download-leases';

const USER = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

const event = (): RequestEvent =>
    ({
        locals: { user: { userId: USER } },
        request: new Request('http://localhost/x', { headers: { 'user-agent': 'UA' } }),
    }) as unknown as RequestEvent;

const zip = () => trackDownload(event(), { mediaItemId: ITEM, archive: true, surface: 'web' });

beforeEach(() => {
    vi.useFakeTimers();
    resetDownloadLeasesForTests();
});
afterEach(() => vi.useRealTimers());

describe('archive downloads and the parallel limit', () => {
    it('limit 1: the second ZIP of the same title and device gets 429, after a release it works', async () => {
        const first = await zip();
        expect(first.ok).toBe(true);
        const second = await zip();
        expect(second.ok).toBe(false);
        if (!second.ok) {
            expect(second.response.status).toBe(429);
            expect(Number(second.response.headers.get('Retry-After'))).toBeGreaterThan(0);
        }
        if (first.ok) first.tracker.discard();
        await vi.advanceTimersByTimeAsync(0);
        const third = await zip();
        expect(third.ok).toBe(true);
        if (third.ok) third.tracker.discard();
    });

    it('limit 2 admits two ZIPs of the same title, not three', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 2;
        try {
            const a = await zip();
            const b = await zip();
            const c = await zip();
            expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
            for (const t of [a, b]) if (t.ok) t.tracker.discard();
        } finally {
            cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        }
    });
});
