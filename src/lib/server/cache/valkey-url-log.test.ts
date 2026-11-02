// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    createClient: vi.fn(),
}));

vi.mock('../utils/logger', () => ({ Logger: { for: () => mocks } }));
vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient: mocks.createClient },
    Logger: { setLoggerConfig: vi.fn() },
    TimeUnit: {},
}));

describe('malformed Valkey connection URL logging', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ ping: vi.fn().mockResolvedValue('PONG') });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it.each(['CACHE_URL', 'TASK_CACHE_URL'] as const)(
        'does not log credentials or the URL parse error for %s',
        async (variable) => {
            const invalidUrl = 'redis://default:secret-canary@[invalid-host';
            vi.stubEnv('CACHE_URL', variable === 'CACHE_URL' ? invalidUrl : 'redis://cache:6379');
            vi.stubEnv(
                'TASK_CACHE_URL',
                variable === 'TASK_CACHE_URL' ? invalidUrl : 'redis://tasks:6379',
            );

            const { connectValkey } = await import('./valkey');
            await expect(connectValkey()).rejects.toThrow(`${variable} must be a valid`);
            expect(mocks.createClient).not.toHaveBeenCalled();

            const logs = inspect([
                ...mocks.warn.mock.calls,
                ...mocks.error.mock.calls,
                ...mocks.info.mock.calls,
                ...mocks.debug.mock.calls,
            ]);
            expect(logs).not.toContain('secret-canary');
            expect(logs).not.toContain(invalidUrl);
        },
    );
});
