// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Preview admission-control tests.
 *
 * Verifies the two backstops that guarantee previews can never overwhelm the
 * server: the global concurrency budget and the system-load circuit breaker,
 * plus the operator manual override. Valkey, os, and config are mocked so the
 * decision logic is exercised in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above module-top-level declarations, so all
// mutable mock state must live inside vi.hoisted() to be reachable from them.
const h = vi.hoisted(() => {
    const valkeyStore = new Map<string, string>();
    const state = { previewKeys: [] as string[], loadAvg1: 1.0, cpuCount: 8 };
    const cfg = {
        PREVIEW_MAX_GLOBAL: 8,
        PREVIEW_LOAD_SHED_RATIO: 3.0,
        PREVIEW_AUTODISABLE_SECONDS: 45,
    };
    const cacheStats = {
        entries: 3,
        ready: 2,
        warming: 1,
        totalBytes: 1024,
        maxBytes: 4096,
        hits: 5,
        misses: 1,
        evictions: 0,
    };
    return { valkeyStore, state, cfg, cacheStats };
});

const cacheSet = vi.fn(async (key: string, value: string, _ttl?: number) => {
    h.valkeyStore.set(key, value);
    return true;
});
const cacheGet = vi.fn(async (key: string) => h.valkeyStore.get(key) ?? null);
const cacheDel = vi.fn(async (key: string) => (h.valkeyStore.delete(key) ? 1 : 0));
const getKeysByPattern = vi.fn(async (_pattern: string, limit = 1000) =>
    h.state.previewKeys.slice(0, limit),
);

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheSet: (k: string, v: string, ttl?: number) => cacheSet(k, v, ttl),
    cacheGet: (k: string) => cacheGet(k),
    cacheDel: (k: string) => cacheDel(k),
    getKeysByPattern: (p: string, limit?: number) => getKeysByPattern(p, limit),
}));

vi.mock('node:os', () => ({
    loadavg: () => [h.state.loadAvg1, h.state.loadAvg1, h.state.loadAvg1],
    cpus: () => Array.from({ length: h.state.cpuCount }, () => ({})),
}));

vi.mock('$lib/server/config.js', () => ({ config: h.cfg }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

vi.mock('$lib/server/services/preview-cache.store.js', () => ({
    getPreviewCacheStore: () => ({ stats: () => h.cacheStats }),
}));

// Convenience aliases so the test bodies read naturally.
const valkeyStore = h.valkeyStore;
const cfg = h.cfg;

import {
    checkPreviewAdmission,
    getSystemLoadRatio,
    getPreviewAdmissionStatus,
    setPreviewsAdminDisabled,
    _resetPreviewReservationsForTest,
} from './preview-admission.service';

const AUTO_DISABLE_KEY = 'preview:autodisabled';
const ADMIN_DISABLE_KEY = 'preview:admin-disabled';

beforeEach(() => {
    valkeyStore.clear();
    h.state.previewKeys = [];
    h.state.loadAvg1 = 1.0;
    h.state.cpuCount = 8;
    cfg.PREVIEW_MAX_GLOBAL = 8;
    cfg.PREVIEW_LOAD_SHED_RATIO = 3.0;
    cfg.PREVIEW_AUTODISABLE_SECONDS = 45;
    _resetPreviewReservationsForTest(); // the in-flight counter is module state
    vi.clearAllMocks();
});

describe('getSystemLoadRatio', () => {
    it('divides 1-minute load average by core count', () => {
        h.state.loadAvg1 = 4;
        h.state.cpuCount = 4;
        expect(getSystemLoadRatio()).toBe(1);
    });

    it('returns 0 when the platform reports no load', () => {
        h.state.loadAvg1 = 0;
        expect(getSystemLoadRatio()).toBe(0);
    });
});

describe('checkPreviewAdmission', () => {
    it('admits when load is low, budget has room, and nothing is disabled', async () => {
        h.state.loadAvg1 = 1; // ratio 0.125 on 8 cores
        h.state.previewKeys = ['a', 'b']; // 2 < 8
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(true);
    });

    it('refuses when an operator has manually disabled previews', async () => {
        valkeyStore.set(ADMIN_DISABLE_KEY, String(Date.now()));
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(false);
        expect(d.reason).toBe('admin_disabled');
        expect(d.status).toBe(503);
    });

    it('trips the load breaker and refuses when load exceeds the threshold', async () => {
        h.state.loadAvg1 = 80; // ratio 10 > 3
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(false);
        expect(d.reason).toBe('load_shed');
        // Auto-disable cool-off flag was set for other replicas to observe.
        expect(cacheSet).toHaveBeenCalledWith(AUTO_DISABLE_KEY, expect.any(String), 45);
    });

    it('keeps refusing during the cool-off window even after load recovers', async () => {
        h.state.loadAvg1 = 1; // below threshold now
        valkeyStore.set(AUTO_DISABLE_KEY, String(Date.now())); // but breaker recently tripped
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(false);
        expect(d.reason).toBe('load_shed');
    });

    it('refuses with 429 when the global preview budget is exhausted', async () => {
        h.state.loadAvg1 = 1;
        h.state.previewKeys = Array.from({ length: 8 }, (_, i) => `preview:session:v1:${i}`);
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(false);
        expect(d.reason).toBe('global_budget');
        expect(d.status).toBe(429);
    });

    it('fails open (admits) when Valkey is unavailable for the budget count', async () => {
        h.state.loadAvg1 = 1;
        getKeysByPattern.mockRejectedValueOnce(new Error('valkey down'));
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(true);
    });

    it('skips the load breaker entirely when the ratio is configured to 0', async () => {
        cfg.PREVIEW_LOAD_SHED_RATIO = 0;
        h.state.loadAvg1 = 999;
        h.state.previewKeys = [];
        const d = await checkPreviewAdmission();
        expect(d.admit).toBe(true);
    });

    // C1 regression: the session-key scan only counts ESTABLISHED sessions (the
    // key is written at the very end of createPreview). A concurrent burst must
    // NOT all pass on the same stale count — the in-flight reservation caps it.
    it('serializes a concurrent burst to the budget even when the scan is stale', async () => {
        cfg.PREVIEW_MAX_GLOBAL = 8;
        h.state.previewKeys = []; // scan reports 0 — sessions not yet established
        h.state.loadAvg1 = 1;
        const decisions = await Promise.all(
            Array.from({ length: 12 }, () => checkPreviewAdmission()),
        );
        const admitted = decisions.filter((d) => d.admit);
        expect(admitted.length).toBe(8); // exactly the budget, not all 12
        expect(decisions.filter((d) => !d.admit).every((d) => d.reason === 'global_budget')).toBe(
            true,
        );
        admitted.forEach((d) => d.release?.()); // clean up module state
    });

    it('releasing a reservation frees the slot for a later request', async () => {
        cfg.PREVIEW_MAX_GLOBAL = 1;
        h.state.previewKeys = [];
        const first = await checkPreviewAdmission();
        expect(first.admit).toBe(true);
        const second = await checkPreviewAdmission();
        expect(second.admit).toBe(false);
        expect(second.reason).toBe('global_budget');
        first.release?.();
        const third = await checkPreviewAdmission();
        expect(third.admit).toBe(true);
        third.release?.();
    });

    it('release is idempotent (double-call does not free two slots)', async () => {
        cfg.PREVIEW_MAX_GLOBAL = 1;
        h.state.previewKeys = [];
        const first = await checkPreviewAdmission();
        expect(first.admit).toBe(true);
        first.release?.();
        first.release?.(); // second call must be a no-op
        // Only one slot should have been freed: two fresh requests, one fits.
        const a = await checkPreviewAdmission();
        const b = await checkPreviewAdmission();
        expect(a.admit).toBe(true);
        expect(b.admit).toBe(false);
        a.release?.();
    });
});

describe('operator override + status snapshot', () => {
    it('setPreviewsAdminDisabled(true/false) toggles the durable flag', async () => {
        await setPreviewsAdminDisabled(true);
        expect(valkeyStore.has(ADMIN_DISABLE_KEY)).toBe(true);
        await setPreviewsAdminDisabled(false);
        expect(valkeyStore.has(ADMIN_DISABLE_KEY)).toBe(false);
    });

    it('reports a disabled status with the active reason', async () => {
        valkeyStore.set(ADMIN_DISABLE_KEY, String(Date.now()));
        const status = await getPreviewAdmissionStatus();
        expect(status.disabled).toBe(true);
        expect(status.reason).toBe('admin_disabled');
        expect(status.maxGlobal).toBe(8);
    });

    it('includes the preview cache store snapshot', async () => {
        const status = await getPreviewAdmissionStatus();
        expect(status.cache).toEqual(h.cacheStats);
    });
});
