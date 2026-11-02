// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { AttentionResponse } from '$lib/schemas/api-attention-responses.js';
import { attentionItem } from '$lib/shared/__fixtures__/attention-section-ids.js';

const state = vi.hoisted(() => ({
    loaded: true,
    readable: true,
    shared: { verdict: 'healthy', items: [], unreadCount: 0 } as AttentionResponse,
}));
vi.mock('$lib/server/services/admin-status-cache.js', () => ({
    getOrComputeAdminStatus: async () =>
        JSON.stringify({ databaseHealthy: true, totalMediaItems: 0, totalUsers: 0 }),
}));
vi.mock('$lib/server/services/attention/attention-cache.js', async (orig) => ({
    ...(await orig<typeof import('./attention/attention-cache.js')>()),
    // Always a HIT: a cache populated by another server must not hide local running code.
    getOrComputeAttention: async () => JSON.stringify(state.shared),
}));
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async () => '0',
}));
vi.mock('$lib/server/database/connection.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/connection.js')>()),
    getAdminDb: () => ({}),
}));
vi.mock('$lib/server/services/session-read-model.service.js', async (orig) => ({
    ...(await orig<typeof import('./session-read-model.service.js')>()),
    getSessionReadModel: () => ({ getAllActive: async () => [] }),
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/play-sessions.queries.js')>()),
    getLastEndedSession: async () => null,
}));
vi.mock('$lib/server/services/admin-cluster-core.service.js', async (orig) => ({
    ...(await orig<typeof import('./admin-cluster-core.service.js')>()),
    getClusterCore: async () => ({ nodes: [] }),
}));
vi.mock('$lib/server/database/queries/attention.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/attention.queries.js')>()),
    loadUncleanExits: async () => [],
}));
vi.mock('$lib/server/database/queries/license-seats.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/license-seats.queries.js')>()),
    countActiveSeats: async () => 0,
}));
vi.mock('$lib/server/database/queries/admin-status-payload.queries.js', async (orig) => ({
    ...(await orig<
        typeof import('$lib/server/database/queries/admin-status-payload.queries.js')
    >()),
    getTaskCounters: async () => ({ running: 0, ranToday: 0, failedRuns24h: 0 }),
}));
vi.mock('$lib/server/database/queries/external-plugins.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/external-plugins.queries.js')>()),
    listExternalPluginsIncludingPendingRemoval: async () => {
        if (!state.readable) throw new Error('plugin registry unavailable');
        return [
            {
                name: 'still-loaded',
                enabled: false,
                status: 'installed',
                updatedAt: '2026-10-29T00:00:00.000Z',
            },
        ];
    },
}));

import { getAdminStatusPayload } from './admin-status-payload.service.js';
import { registry } from '$lib/server/tasks/registry.js';

beforeEach(() => {
    state.loaded = true;
    state.readable = true;
    state.shared = { verdict: 'healthy', items: [], unreadCount: 0 };
    vi.spyOn(registry, 'hasPluginRegistered').mockImplementation(() => state.loaded);
});
afterEach(() => {
    vi.restoreAllMocks();
});

it('shows and clears local pending changes immediately even while the shared attention cache stays warm', async () => {
    const pending = await getAdminStatusPayload();
    expect(pending.attention.items.find((i) => i.id === 'settings:plugin-restart')).toBeDefined();
    expect(pending.attention.unreadCount).toBe(1);
    expect(pending.verdict).toBe('degraded');
    expect(pending.sectionStatus.settings).toBe('degraded');
    state.loaded = false;
    const restarted = await getAdminStatusPayload();
    expect(restarted.attention.items).toEqual([]);
    expect(restarted.attention.unreadCount).toBe(0);
    expect(restarted.verdict).toBe('healthy');
});

it('does not reuse another server’s cached plugin notice or erase an existing critical verdict', async () => {
    state.loaded = false;
    state.shared = {
        verdict: 'critical',
        unreadCount: 2,
        items: [
            attentionItem({ id: 'settings:plugin-restart', severity: 'warning' }),
            attentionItem({ id: 'critical-other', severity: 'critical' }),
        ],
    };
    const payload = await getAdminStatusPayload();
    expect(payload.attention.items.map((i) => i.id)).toEqual(['critical-other']);
    expect(payload.attention.unreadCount).toBe(1);
    expect(payload.verdict).toBe('critical');
});

it('marks attention unavailable if local plugin state cannot be read, even with a healthy cached board', async () => {
    state.readable = false;
    const payload = await getAdminStatusPayload();
    expect(payload.attention.unavailable).toBe(true);
    expect(payload.verdict).toBe('degraded');
});

it('keeps the cached source order within a severity when joining local notices', async () => {
    state.loaded = false;
    state.shared = {
        verdict: 'healthy',
        unreadCount: 2,
        items: [
            attentionItem({ id: 'z-first', severity: 'info' }),
            attentionItem({ id: 'a-second', severity: 'info' }),
        ],
    };
    expect((await getAdminStatusPayload()).attention.items.map((item) => item.id)).toEqual([
        'z-first',
        'a-second',
    ]);
});
