// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const getServerInfo = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/server.js', () => ({ getServerInfo }));

beforeEach(() => {
    vi.resetModules();
    getServerInfo.mockReset();
});

describe('server capabilities bootstrap reader', () => {
    it('extracts signed-in capabilities and reuses the session request', async () => {
        const capabilities = { liveTv: { available: true, adaptiveLadder: { enabled: true } } };
        getServerInfo.mockResolvedValue({ data: { capabilities, caller: { id: 'user' } } });
        const { serverCapabilities } = await import('./server-capabilities.store');
        await Promise.all([serverCapabilities.fetch(), serverCapabilities.fetch()]);
        expect(getServerInfo).toHaveBeenCalledTimes(1);
        expect(get(serverCapabilities).data).toEqual(capabilities);
    });

    it('caches anonymous discovery with a distinct unauthenticated state', async () => {
        getServerInfo.mockResolvedValue({ data: { caller: null } });
        const { serverCapabilities } = await import('./server-capabilities.store');
        await serverCapabilities.fetch();
        await serverCapabilities.fetch();
        expect(getServerInfo).toHaveBeenCalledTimes(1);
        expect(get(serverCapabilities)).toMatchObject({
            data: null, loading: false, error: null, unauthenticated: true,
        });
    });
    it('backs off errors before retrying', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            getServerInfo.mockResolvedValue({ error: 'offline' });
            const { serverCapabilities } = await import('./server-capabilities.store');
            await serverCapabilities.fetch();
            await serverCapabilities.fetch();
            expect(getServerInfo).toHaveBeenCalledTimes(1);
            now.mockReturnValue(6001);
            await serverCapabilities.fetch();
            expect(getServerInfo).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });
});
