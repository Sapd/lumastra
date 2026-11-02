// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ base: '' }));
vi.mock('$app/paths', () => paths);
const pollSql = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    Database: class {
        getSql() {
            return pollSql;
        }
    },
}));
vi.mock('$lib/server/database/queries/oauth-device-codes.queries.js', () => ({
    createDeviceCode: vi.fn(),
    getDeviceCodeByDeviceCode: vi.fn(),
    updateDeviceCodeStatus: vi.fn(),
    deleteDeviceCode: vi.fn(),
}));
vi.mock('$lib/server/config', () => ({
    config: { DEVICE_CODE_TTL_SECONDS: 600, DEVICE_CODE_POLL_INTERVAL_SECONDS: 5 },
}));
const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn() }));
vi.mock('$lib/server/utils/logger', () => ({ Logger: { for: () => logs } }));
import { getDeviceCodeByDeviceCode } from '$lib/server/database/queries/oauth-device-codes.queries.js';
import { createHash } from 'node:crypto';
import { DeviceCodeService, redactUserCode } from './device-code.service.js';
beforeEach(() => {
    paths.base = '';
});
describe('verification URLs', () => {
    it.each([
        ['', 'https://example.com', 'https://example.com/device'],
        ['/lumastra', 'https://example.com', 'https://example.com/lumastra/device'],
        ['/lumastra', 'https://example.com/lumastra/', 'https://example.com/lumastra/device'],
        ['/lumastra', 'https://example.com/public/', 'https://example.com/public/device'],
    ])('base %s and public URL %s => %s', async (base, origin, expected) => {
        paths.base = base;
        const body = await new DeviceCodeService().createDeviceCode(
            { clientId: 'lumastra-ios' },
            origin,
        );
        expect(body.verification_uri).toBe(expected);
        expect(body.verification_uri_complete).toBe(`${expected}?code=${body.user_code}`);
    });
});

it('expires authorized codes after a two-minute collection grace, but permits slow TVs inside it', async () => {
    const service = new DeviceCodeService();
    for (const [age, expected] of [
        [60, 'authorized'],
        [121, 'expired'],
    ] as const) {
        vi.mocked(getDeviceCodeByDeviceCode).mockResolvedValue({
            status: 'authorized',
            expires_at: new Date(Date.now() - age * 1000),
        } as never);
        expect((await service.getByDeviceCode('opaque-device-code'))?.status).toBe(expected);
    }
});
it('does not log the plaintext approval code on creation', async () => {
    logs.info.mockClear();
    const result = await new DeviceCodeService().createDeviceCode(
        { clientId: 'tv' },
        'https://example.com',
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain(result.user_code);
});

it('logs no device_code prefix on polling or consumption', async () => {
    logs.info.mockClear();
    logs.debug.mockClear();
    pollSql.mockResolvedValue([{ is_too_fast: false, time_since_ms: 6000 }]);
    const code = 'private-device-code-value';
    const service = new DeviceCodeService();
    await service.isPollTooFast(code);
    await service.markAsUsed(code);
    const logged = JSON.stringify([logs.info.mock.calls, logs.debug.mock.calls]);
    expect(logged).not.toContain(code.slice(0, 8));
    expect(logged).not.toContain('deviceCodePrefix');
});

it('approval log identifiers disclose neither the code nor its offline-enumerable hash', async () => {
    logs.info.mockClear();
    const result = await new DeviceCodeService().createDeviceCode(
        { clientId: 'tv' },
        'https://example.com',
    );
    const reversible = createHash('sha256').update(result.user_code).digest('hex').slice(0, 8);
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain(reversible);
    expect(redactUserCode(result.user_code)).toBe('[REDACTED]');
});
