// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { deviceKind, clientLabel, olderSessionIds } from './device-presentation';

describe('deviceKind', () => {
    it('trusts the reported device type', () => {
        expect(deviceKind({ deviceType: 'tv', clientId: 'lumastra-ios' })).toBe('tv');
    });

    it('falls back to the client id when the device never reported a type', () => {
        expect(deviceKind({ clientId: 'stellar-tvos' })).toBe('tv');
        expect(deviceKind({ clientId: 'lumastra-ios' })).toBe('mobile');
        expect(deviceKind({ clientId: 'lumastra-discord-rpc' })).toBe('integration');
        expect(deviceKind({ deviceType: 'unknown', clientId: 'something' })).toBe('unknown');
    });
});

describe('clientLabel', () => {
    it('names first-party clients and passes unknown ids through', () => {
        expect(clientLabel('stellar-tvos')).not.toBe('stellar-tvos');
        expect(clientLabel('third-party-app')).toBe('third-party-app');
        expect(clientLabel(undefined)).toBe('');
    });
});

describe('olderSessionIds', () => {
    const base = { clientId: 'stellar-tvos', createdAt: '2026-01-01T00:00:00Z' };

    it('flags every sign-in of a device except the most recent one', () => {
        const older = olderSessionIds([
            {
                ...base,
                deviceSessionId: 'a',
                deviceId: 'tv1',
                deviceName: 'Apple TV',
                lastUsedAt: '2026-09-01T00:00:00Z',
            },
            {
                ...base,
                deviceSessionId: 'b',
                deviceId: 'tv1',
                deviceName: 'Apple TV',
                lastUsedAt: '2026-09-20T00:00:00Z',
            },
            {
                ...base,
                deviceSessionId: 'c',
                deviceId: 'tv2',
                deviceName: 'Apple TV',
                lastUsedAt: '2026-08-01T00:00:00Z',
            },
        ]);
        expect([...older]).toEqual(['a']);
    });

    it('groups clients without a device id by client and name', () => {
        const rpc = { clientId: 'lumastra-discord-rpc', deviceId: null, deviceName: 'Discord RPC' };
        const older = olderSessionIds([
            { ...rpc, deviceSessionId: 'x', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null },
            { ...rpc, deviceSessionId: 'y', createdAt: '2026-02-01T00:00:00Z', lastUsedAt: null },
        ]);
        expect([...older]).toEqual(['x']);
    });
});

describe('olderSessionIds tie-break', () => {
    it('keeps the later-issued session when both share a last-seen time', () => {
        const at = '2026-09-20T00:00:00Z';
        const older = olderSessionIds([
            {
                deviceSessionId: 'new',
                deviceId: 'tv',
                clientId: 'x',
                deviceName: 'TV',
                lastUsedAt: at,
                createdAt: '2026-09-19T00:00:00Z',
            },
            {
                deviceSessionId: 'old',
                deviceId: 'tv',
                clientId: 'x',
                deviceName: 'TV',
                lastUsedAt: at,
                createdAt: '2026-08-01T00:00:00Z',
            },
        ]);
        expect([...older]).toEqual(['old']);
    });
});
