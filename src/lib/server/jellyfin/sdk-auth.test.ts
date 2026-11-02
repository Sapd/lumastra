// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosHeaders } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';

vi.mock('../config.js', () => ({
    config: { APP_NAME: 'Lumastra', JELLYFINURL: 'http://jf', JELLYFINAPIKEY: 'admin-key' },
}));
vi.mock('../operation-mode.js', () => ({ operationMode: { isJellyfinEnabled: true } }));
vi.mock('../runtime-optimizations.js', () => ({ configureAxiosWithOptimizedAgents: vi.fn() }));

import { JellyfinBaseClient, resetJellyfinApi } from './base-client.js';

beforeEach(() => {
    resetJellyfinApi();
});

describe('real SDK / axios transport', () => {
    it('authenticates raw SDK-wrapper requests and the connection probe with shared defaults', async () => {
        const client = new JellyfinBaseClient();
        const axios = client.getAxiosInstance()!;
        const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
            data: { ServerName: 'jf', Version: '12.4.0' },
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
        }));
        axios.defaults.adapter = adapter;
        await axios.get('http://jf/Items');
        expect(await client.verifyConnection()).toEqual({ serverName: 'jf', version: '12.4.0' });
        expect(adapter).toHaveBeenCalledTimes(2);
        for (const [cfg] of adapter.mock.calls) {
            const headers = AxiosHeaders.from(cfg.headers);
            expect(headers.get('Authorization')).toMatch(
                /^MediaBrowser Client="Lumastra", .*Token="admin-key"$/,
            );
            expect(headers.has('X-Emby-Token')).toBe(false);
        }
        expect(adapter.mock.calls[1][0]._bypassCircuitBreaker).toBe(true);
    });

    it('does not let SDK defaults override explicit user-token or tokenless authentication', async () => {
        const client = new JellyfinBaseClient();
        const axios = client.getAxiosInstance()!;
        const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
            data: {},
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
        }));
        axios.defaults.adapter = adapter;
        const { JellyfinAuthService } = await import('./auth.service.js');
        const auth = new JellyfinAuthService();
        await auth.validateAccessToken('user-token');
        await auth.connectQuickConnectWithDevice('secret', 'TV', 'tv-42');
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(adapter.mock.calls[0][0].headers.get('Authorization')).toContain(
            'Token="user-token"',
        );
        expect(adapter.mock.calls[1][0].headers.get('Authorization')).not.toContain('Token=');
        expect(adapter.mock.calls[1][0].headers.get('Authorization')).toContain('DeviceId="tv-42"');
    });

    it('rebuilds a separate authenticated axios instance after reset', () => {
        const client = new JellyfinBaseClient();
        const first = client.getAxiosInstance();
        resetJellyfinApi();
        expect(client.getAxiosInstance()).not.toBe(first);
    });

    it('creates and validates a token with the same sanitized Device value capped at 100 characters', async () => {
        const client = new JellyfinBaseClient();
        const axios = client.getAxiosInstance()!;
        const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
            data:
                config.method === 'post'
                    ? { AccessToken: 'device-token' }
                    : { Id: 'jf-user', Name: 'admin' },
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
        }));
        axios.defaults.adapter = adapter;
        const { JellyfinAuthService } = await import('./auth.service.js');
        const auth = new JellyfinAuthService();
        const storedDeviceName = 'Lumastra - "TV"\\\r\n' + 'Living Room '.repeat(15);
        const deviceId = 'tv-session-'.repeat(12);
        const created = await auth.connectQuickConnectWithDevice(
            'secret',
            storedDeviceName,
            deviceId,
        );
        expect(created?.AccessToken).toBe('device-token');
        expect(
            await auth.validateAccessToken(created!.AccessToken, {
                deviceName: storedDeviceName,
                deviceId,
            }),
        ).toEqual({ Id: 'jf-user', Name: 'admin' });

        expect(adapter).toHaveBeenCalledTimes(2);
        const headers = adapter.mock.calls.map(([cfg]) => String(cfg.headers.get('Authorization')));
        const expectedDevice = ('Lumastra - TV' + 'Living Room '.repeat(15)).slice(0, 100);
        for (const header of headers) {
            expect(header).toContain(`Device="${expectedDevice}", DeviceId="${deviceId}"`);
        }
        expect(headers[0]).not.toContain('Token=');
        expect(headers[1]).toContain('Token="device-token"');
    });
});
