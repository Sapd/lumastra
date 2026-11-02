// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readProviderCalls = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/provider-calls.js', () => ({ readProviderCalls }));

const saveConfig = vi.hoisted(() => vi.fn());
const computeTaskRunRates = vi.hoisted(() => vi.fn());
const listCostAggregations = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
const readRequestPathCalls = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/external-request-stats.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/external-request-stats.js')>()),
    readRequestPathCalls,
}));
vi.mock('$lib/server/database/queries/cost-ledger.queries.js', () => ({
    listCostAggregations,
    listRecentCostlyRuns: async () => [],
    getAssistantUsage: async () => ({ totalTokens: 0, totalCostUsd: 0, messageCount: 0 }),
}));
vi.mock('$lib/server/config/domains/ai.js', () => ({
    getAiConfig: () => ({ embeddingModel: 'text-embedding-3-small' }),
}));
vi.mock('$lib/server/config.js', () => ({ config: { AI_COST_PRICE_OVERRIDES: [] } }));
vi.mock('$lib/server/config/index.js', () => ({ saveConfig }));
vi.mock('$lib/server/tasks/registry.js', () => ({
    getRegistry: () => ({ getTask: () => undefined }),
}));
vi.mock('$lib/server/tasks/observability/run-rate.js', () => ({ computeTaskRunRates }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActorFromLocals: () => ({ username: 'admin' }),
}));

import { actions, load } from './+page.server.js';

const locals = { user: { username: 'admin', isAdmin: true }, principal: { isAdmin: true } };

function priceEvent(price: string) {
    const body = new FormData();
    body.set('model', 'text-embedding-3-small');
    body.set('pricePerMillion', price);
    return {
        request: new Request('http://localhost/admin/system/cost?/assignPrice', {
            method: 'POST',
            body,
        }),
        locals,
    } as never;
}

beforeEach(() => {
    readProviderCalls.mockReset().mockRejectedValue(new Error('unavailable'));
    saveConfig.mockReset().mockResolvedValue(undefined);
    computeTaskRunRates.mockReset().mockResolvedValue([]);
    listCostAggregations.mockReset().mockResolvedValue([]);
    readRequestPathCalls.mockReset().mockResolvedValue({ windowDays: 7, byHost: new Map() });
});

describe('/admin/system/cost assignPrice', () => {
    it('rejects a blank price instead of saving a $0 override', async () => {
        const result = (await actions.assignPrice(priceEvent('  '))) as { status?: number };
        expect(result.status).toBe(400);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('accepts an explicit 0', async () => {
        await actions.assignPrice(priceEvent('0'));
        expect(saveConfig).toHaveBeenCalledWith({
            AI_COST_PRICE_OVERRIDES: ['text-embedding-3-small=0'],
        });
    });
});

describe('/admin/system/cost load — run rates', () => {
    const url = new URL('http://localhost/admin/system/cost');

    it('flags a failed run-rate computation instead of reporting no data', async () => {
        computeTaskRunRates.mockRejectedValue(new Error('boom'));
        const data = await load({ url });
        expect(data.dbError).toBeNull();
        expect(data.runRates).toEqual([]);
        expect(data.runRatesError).toBe(true);
    });

    it('no flag when the computation succeeds with nothing to show', async () => {
        const data = await load({ url });
        expect(data.runRatesError).toBe(false);
    });
});

describe('/admin/system/cost load — provider calls', () => {
    it('merges task and request-path calls, errors and 429s per provider host', async () => {
        listCostAggregations.mockResolvedValue([
            { taskId: 'album-enrichment', costUnit: 'api_calls:musicbrainz.org', totalUnits: 40 },
            { taskId: 'album-enrichment', costUnit: 'api_errors:musicbrainz.org', totalUnits: 3 },
            { taskId: 'album-enrichment', costUnit: 'api_429:musicbrainz.org', totalUnits: 2 },
            { taskId: 'tmdb-sync', costUnit: 'api_calls:api.themoviedb.org', totalUnits: 10 },
            { taskId: 'tmdb-sync', costUnit: 'api_calls', totalUnits: 50 },
        ]);
        readRequestPathCalls.mockResolvedValue({
            windowDays: 7,
            byHost: new Map([
                [
                    'api.themoviedb.org',
                    {
                        ok: 8,
                        not_found: 0,
                        client_error: 0,
                        rate_limited: 1,
                        server_error: 0,
                        network_error: 0,
                    },
                ],
            ]),
        });

        const data = await load({ url: new URL('http://localhost/admin/system/cost') } as never);

        expect(data.providers.sinceDays).toBe(7);
        expect(data.providers.liveWindowDays).toBe(7);
        expect(data.providers.rows).toEqual([
            {
                host: 'musicbrainz.org',
                taskCalls: 40,
                liveCalls: 0,
                errors: 3,
                rateLimited: 2,
            },
            {
                host: 'api.themoviedb.org',
                taskCalls: 10,
                liveCalls: 9,
                errors: 1,
                rateLimited: 1,
            },
        ]);
        expect(data.providers.taskCalls).toBe(50);
        expect(data.providers.liveCalls).toBe(9);
        expect(data.providers.errors).toBe(4);
        expect(data.providers.rateLimited).toBe(3);
        // Error and 429 units are shown in the provider table, not as "other usage".
        expect(data.otherUnits).toEqual([]);
    });

    it('clamps the request-path window to the 8-day retention', async () => {
        // The real readRequestPathCalls clamps to 8 days; mirror that here.
        readRequestPathCalls.mockResolvedValue({ windowDays: 8, byHost: new Map() });
        const data = await load({
            url: new URL('http://localhost/admin/system/cost?days=30'),
        } as never);
        expect(data.providers.sinceDays).toBe(30);
        expect(data.providers.liveWindowDays).toBe(8);
        expect(readRequestPathCalls).toHaveBeenCalledWith(30);
    });
});

describe('/admin/system/cost hourly provider calls', () => {
    it('loads the fixed 24-hour window independently of the cost-history selector', async () => {
        const metrics = { hours: 24, providers: [] };
        readProviderCalls.mockResolvedValue(metrics);
        const data = await load({ url: new URL('http://localhost/admin/system/cost?days=90') });
        expect(readProviderCalls).toHaveBeenCalledWith(24);
        expect(data.providerCalls).toEqual(metrics);
    });
    it('keeps unavailable counters distinct from an empty result', async () => {
        const data = await load({ url: new URL('http://localhost/admin/system/cost') });
        expect(data.providerCalls).toBeNull();
        expect(data.dbError).toBeNull();
    });
});
