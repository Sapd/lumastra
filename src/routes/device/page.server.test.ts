// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ get: vi.fn(), limit: vi.fn(async () => null as Response | null) }));
vi.mock('$lib/server/oauth', () => ({
    isDeviceAuthEnabled: () => true,
    getDeviceCodeService: () => ({ getByUserCode: h.get }),
    getDeviceGrantCapabilities: () => ({}),
}));
vi.mock('$lib/server/oauth/device-approval-rate-limit', () => ({
    checkDeviceApprovalRateLimit: h.limit,
}));
import { load } from './+page.server';
function event(code: string) {
    return {
        url: new URL(`http://localhost/device?code=${code}`),
        locals: { user: { username: 'alice', userId: 'u1' } },
        request: new Request('http://localhost/device'),
        getClientAddress: () => '192.0.2.10',
    } as never;
}
beforeEach(() => {
    vi.clearAllMocks();
    h.get.mockResolvedValue(null);
});
it('limits normalized ?code= lookups before querying', async () => {
    h.limit.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(load(event('abcd1234'))).rejects.toMatchObject({ status: 429 });
    expect(h.limit).toHaveBeenCalledWith('u1', 'ABCD-1234', '192.0.2.10');
    expect(h.get).not.toHaveBeenCalled();
});
it.each([null, { status: 'authorized' }, { status: 'expired' }, { status: 'denied' }])(
    'hides unavailable code state (%j)',
    async (record) => {
        h.get.mockResolvedValue(record);
        expect(await load(event('ABCD-1234'))).toMatchObject({
            enabled: true,
            username: 'alice',
            error: 'Invalid or expired device code',
            deviceCode: null,
        });
    },
);
it('rejects an oversized code before database access', async () => {
    expect(await load(event('a'.repeat(1000)))).toMatchObject({
        error: 'Invalid or expired device code',
        deviceCode: null,
    });
    expect(h.get).not.toHaveBeenCalled();
});
it('keeps the valid ?code= deep link', async () => {
    h.get.mockResolvedValue({
        status: 'pending',
        user_code: 'ABCD-1234',
        expires_at: new Date(Date.now() + 60000),
    });
    expect(await load(event('abcd1234'))).toMatchObject({ deviceCode: { userCode: 'ABCD-1234' } });
});

it('renders BAD as the same inline error without losing the input page', async () => {
    expect(await load(event('BAD'))).toMatchObject({
        enabled: true,
        username: 'alice',
        error: 'Invalid or expired device code',
        deviceCode: null,
        providedCode: 'BAD',
    });
    expect(h.get).not.toHaveBeenCalled();
});
