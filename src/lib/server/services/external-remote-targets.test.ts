// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    __resetExternalRemoteTargetProviderForTests,
    externalProviderFor,
    getExternalRemoteTargetProvider,
    listExternalRemoteDevices,
    registerExternalRemoteTargetProvider,
    type ExternalRemoteTargetProvider,
} from './external-remote-targets.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const user = { userId: 'u', username: 'alice' };
const provider = (
    over: Partial<ExternalRemoteTargetProvider> = {},
): ExternalRemoteTargetProvider => ({
    owns: (id) => id.startsWith('x:'),
    list: vi.fn(async () => [{ deviceSessionId: 'x:1' } as never]),
    state: vi.fn(async () => null),
    send: vi.fn(),
    ...over,
});

afterEach(() => __resetExternalRemoteTargetProviderForTests());

describe('external remote target registry', () => {
    it('without a provider (AGPL-only build) nothing is external', async () => {
        expect(getExternalRemoteTargetProvider()).toBeNull();
        expect(externalProviderFor('x:1')).toBeNull();
        expect(await listExternalRemoteDevices(user)).toEqual([]);
    });

    it('routes only the ids the provider owns, and lists its devices', async () => {
        const p = provider();
        registerExternalRemoteTargetProvider(p);
        expect(externalProviderFor('x:1')).toBe(p);
        expect(externalProviderFor('11111111-1111-4111-8111-111111111111')).toBeNull();
        expect(await listExternalRemoteDevices(user)).toHaveLength(1);
    });

    it('a failing provider never breaks the device list', async () => {
        registerExternalRemoteTargetProvider(
            provider({ list: vi.fn(async () => Promise.reject(new Error('boom'))) }),
        );
        expect(await listExternalRemoteDevices(user)).toEqual([]);
    });
});
