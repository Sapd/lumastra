// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
import { getServerId, _resetServerIdCache } from './server-id.js';

const winner = '11111111-1111-4111-8111-111111111111';
beforeEach(_resetServerIdCache);

function database(...results: unknown[]) {
    const query = vi.fn();
    for (const result of results) query.mockResolvedValueOnce(result);
    return { query, sql: query as unknown as postgres.Sql };
}

describe('persistent installation id', () => {
    it('selects first and caches a valid value without writing', async () => {
        const { query, sql } = database([{ value: winner }]);
        expect(await getServerId(sql)).toBe(winner);
        expect(await getServerId(sql)).toBe(winner);
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0].join('')).toContain('SELECT value');
    });
    it('inserts only when absent and reads the winning concurrent value', async () => {
        const { query, sql } = database([], [], [{ value: winner }]);
        expect(await getServerId(sql)).toBe(winner);
        expect(query.mock.calls[1][0].join('')).toContain('ON CONFLICT (plugin_id, key) DO NOTHING');
        expect(query).toHaveBeenCalledTimes(3);
    });
    it('repairs a corrupt stored value once using compare-and-swap then reselects', async () => {
        const { query, sql } = database([{ value: 'corrupt' }], [], [{ value: winner }]);
        expect(await getServerId(sql)).toBe(winner);
        expect(query.mock.calls[1][0].join('')).toContain('UPDATE plugin_settings');
        expect(query.mock.calls[1]).toContain(JSON.stringify('corrupt'));
        expect(query).toHaveBeenCalledTimes(3);
    });
    it('does not loop or return an invented id when repair fails', async () => {
        const { query, sql } = database([{ value: 'corrupt' }], [], [{ value: 'corrupt' }]);
        expect(await getServerId(sql)).toBeNull();
        expect(query).toHaveBeenCalledTimes(3);
    });
    it('returns null for an unavailable database', async () => {
        expect(await getServerId()).toBeNull();
    });
    it('clears failures so the next request can retry', async () => {
        const query = vi.fn().mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce([{ value: winner }]);
        expect(await getServerId(query as unknown as postgres.Sql)).toBeNull();
        expect(await getServerId(query as unknown as postgres.Sql)).toBe(winner);
    });
    it('does not invent an id when insert is not visible', async () => {
        const { query, sql } = database([], [], []);
        expect(await getServerId(sql)).toBeNull();
        expect(query).toHaveBeenCalledTimes(3);
    });
});
