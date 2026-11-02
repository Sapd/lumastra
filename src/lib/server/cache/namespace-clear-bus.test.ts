// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishMessage = vi.fn(async (_channel: string, _message: string) => true);
vi.mock('./valkey.js', () => ({
    publishMessage: (channel: string, message: string) => publishMessage(channel, message),
    subscribeToChannel: vi.fn(async () => null),
}));

import { CacheManager } from './unified-cache.js';
import {
    NAMESPACE_CLEAR_CHANNEL,
    publishNamespaceClear,
    _handleNamespaceClearForTests,
    _resetNamespaceClearBusForTests,
} from './namespace-clear-bus.js';

const NS = 'namespace-clear-bus-test';

function l1Only() {
    return CacheManager.getInstance().getCache(NS, { enableL2: false });
}

beforeEach(() => {
    _resetNamespaceClearBusForTests();
    publishMessage.mockClear();
});

describe('namespace-clear-bus', () => {
    it('drops the local L1 entries of a namespace another process cleared', async () => {
        const cache = l1Only();
        await cache.set('k', { v: 1 });
        expect(await cache.get('k')).toEqual({ v: 1 });

        _handleNamespaceClearForTests(JSON.stringify({ namespaces: [NS], _from: 'other-process' }));

        expect(await cache.get('k')).toBeNull();
    });

    it('leaves namespaces that were not named alone', async () => {
        const cache = l1Only();
        await cache.set('k', { v: 1 });

        _handleNamespaceClearForTests(
            JSON.stringify({ namespaces: ['some-other-namespace'], _from: 'other-process' }),
        );

        expect(await cache.get('k')).toEqual({ v: 1 });
    });

    it('ignores its own publish and malformed payloads', async () => {
        const cache = l1Only();
        await cache.set('k', { v: 1 });

        publishNamespaceClear([NS]);
        const own = publishMessage.mock.calls[0][1];
        _handleNamespaceClearForTests(own);
        _handleNamespaceClearForTests('not json');
        _handleNamespaceClearForTests(JSON.stringify({ namespaces: 'x', _from: 'other' }));

        expect(await cache.get('k')).toEqual({ v: 1 });
    });

    it('publishes the namespace names on the shared channel, and nothing for an empty list', () => {
        publishNamespaceClear([]);
        expect(publishMessage).not.toHaveBeenCalled();

        publishNamespaceClear(['a', 'b']);
        expect(publishMessage).toHaveBeenCalledTimes(1);
        expect(publishMessage.mock.calls[0][0]).toBe(NAMESPACE_CLEAR_CHANNEL);
        expect(JSON.parse(publishMessage.mock.calls[0][1]).namespaces).toEqual(['a', 'b']);
    });
});
