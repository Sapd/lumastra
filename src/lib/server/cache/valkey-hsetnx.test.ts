// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
    ping: vi.fn().mockResolvedValue('PONG'),
    customCommand: vi.fn(),
}));
vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient: vi.fn(async () => client) },
    TimeUnit: { Seconds: 'Seconds', Milliseconds: 'Milliseconds' },
    GlideClientConfiguration: {},
}));
afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('hSetNX', () => {
    it('uses atomic HSETNX so later replicas cannot overwrite the first sample', async () => {
        vi.stubEnv('CACHE_URL', 'redis://localhost:6379/0');
        vi.stubEnv('TASK_CACHE_URL', 'redis://localhost:6380/1');
        const { connectValkey, hSetNX } = await import('./valkey.js');
        expect(await connectValkey()).toBe(true);
        client.customCommand.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
        expect(
            await hSetNX('apiconf:s:2026-10-16', 'GET /api/items/[id]|stripped', '["extra"]'),
        ).toBe(true);
        expect(
            await hSetNX('apiconf:s:2026-10-16', 'GET /api/items/[id]|stripped', '["later"]'),
        ).toBe(false);
        expect(client.customCommand).toHaveBeenNthCalledWith(1, [
            'HSETNX',
            'apiconf:s:2026-10-16',
            'GET /api/items/[id]|stripped',
            '["extra"]',
        ]);
        client.customCommand.mockRejectedValueOnce(new Error('offline'));
        await expect(
            hSetNX('apiconf:s:2026-10-16', 'GET /api/items/[id]|stripped', '[]'),
        ).resolves.toBe(false);
    });
});
