// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { toUserId } from '$lib/shared/user-id';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/server/services/image-proxy/work-budget', () => ({
    restrictImageRequest: vi.fn(),
    runImageProviderBudget: vi.fn(),
}));
vi.mock('$lib/server/cache/valkey', async (original) => ({
    ...(await original<typeof import('$lib/server/cache/valkey')>()),
    isCoordinationValkeyReady: () => true,
    getCoordinationClient: () => ({
        incr: async (key: string) => {
            throw new Error(`Valkey unavailable for ${key}`);
        },
    }),
}));
import { checkDeviceApprovalRateLimit } from './device-approval-rate-limit';

it('does not log an offline-enumerable approval hash when Valkey fails', async () => {
    const code = 'ABCD-1234';
    const hash = createHash('sha256').update(code).digest('hex');
    await checkDeviceApprovalRateLimit(
        toUserId('00000000-0000-4000-8000-000000000001'),
        code,
        '192.0.2.1',
    );
    expect(h.warn).toHaveBeenCalledWith(
        'Valkey rate limit check failed, using fallback',
        expect.objectContaining({ key: expect.any(String) }),
        undefined,
    );
    const logged = JSON.stringify(h.warn.mock.calls, (_key, value: unknown) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value,
    );
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(hash);
});

it('limits one IP across users and codes while preserving another IP budget', async () => {
    const ip = '192.0.2.20';
    for (let i = 0; i < 20; i++) {
        expect(
            await checkDeviceApprovalRateLimit(
                toUserId(`00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`),
                `ZZZZ-${String(i).padStart(4, '0')}`,
                ip,
            ),
        ).toBeNull();
    }
    const limited = await checkDeviceApprovalRateLimit(
        toUserId('00000000-0000-4000-8000-000000000121'),
        'ZZZZ-0021',
        ip,
    );
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('content-type')).toContain('application/problem+json');
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited?.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(
        await checkDeviceApprovalRateLimit(
            toUserId('00000000-0000-4000-8000-000000000122'),
            'ZZZZ-0022',
            '192.0.2.21',
        ),
    ).toBeNull();
});

it('rotating IPs and codes cannot bypass the existing per-user limit', async () => {
    const userId = toUserId('00000000-0000-4000-8000-000000000200');
    for (let i = 0; i < 10; i++) {
        expect(
            await checkDeviceApprovalRateLimit(
                userId,
                `YYYY-${String(i).padStart(4, '0')}`,
                `192.0.2.${30 + i}`,
            ),
        ).toBeNull();
    }
    expect((await checkDeviceApprovalRateLimit(userId, 'YYYY-9999', '192.0.2.99'))?.status).toBe(
        429,
    );
});
