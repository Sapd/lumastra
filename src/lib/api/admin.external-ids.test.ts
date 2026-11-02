// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const monitoredFetch = vi.hoisted(() => vi.fn());
vi.mock('$app/environment', () => ({ browser: false, dev: false }));
vi.mock('$lib/auth-monitor.js', () => ({ monitoredFetch, handleAuthExpiration: vi.fn() }));
vi.mock('./contract-reporter.js', () => ({ reportApiContractMismatch: vi.fn() }));
vi.mock('$lib/client-diagnostics/web-reporter.js', () => ({ reportApiFailure: vi.fn() }));
import { setApiContractStrictForTests } from './client.js';
import { upsertMediaExternalId, deleteMediaExternalId, getMediaExternalIds } from './admin.js';
beforeEach(() => {
    monitoredFetch.mockReset();
    setApiContractStrictForTests(true);
});
afterEach(() => {
    setApiContractStrictForTests(undefined);
});
function reply(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
it.each([true, false])(
    'parses the canonical PUT updated=%s response through the real client',
    async (updated) => {
        monitoredFetch.mockResolvedValue(reply({ updated }));
        const result = await upsertMediaExternalId('movie-1', {
            provider: 'tmdb',
            externalId: '551',
        });
        expect(result.data).toEqual({ updated });
        expect(result.error).toBeFalsy();
        expect(result.validationError).toBeFalsy();
        expect(result.status).toBe(200);
        expect(monitoredFetch.mock.calls[0][0]).toBe('/api/admin/media/movie-1/external-ids');
        expect(monitoredFetch.mock.calls[0][1]).toMatchObject({
            method: 'PUT',
            body: JSON.stringify({ provider: 'tmdb', externalId: '551' }),
        });
    },
);
it('parses the canonical DELETE response without expecting an unrelated success flag', async () => {
    monitoredFetch.mockResolvedValue(reply({ deleted: true }));
    const result = await deleteMediaExternalId('movie-1', 'tmdb');
    expect(result.data).toEqual({ deleted: true });
    expect(result.error).toBeFalsy();
    expect(result.validationError).toBeFalsy();
    expect(result.status).toBe(200);
    expect(monitoredFetch.mock.calls[0][1].method).toBe('DELETE');
});

it('parses canonical GET nullable primary state through the real strict client', async () => {
    const body = {
        externalIds: [{ id: '42', provider: 'tmdb', external_id: '550', is_primary: null }],
    };
    monitoredFetch.mockResolvedValue(reply(body));
    const result = await getMediaExternalIds('movie-1');
    expect(result.data).toEqual(body);
    expect(result.error).toBeFalsy();
    expect(result.validationError).toBeFalsy();
    expect(result.status).toBe(200);
});
