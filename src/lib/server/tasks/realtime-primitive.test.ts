// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishMock = vi.fn(async (_channel: string, _message: string): Promise<void> => undefined);
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        publishMessage: (channel: string, message: string) => publishMock(channel, message),
    };
});

import { buildRealtime, PluginRealtimeError } from './context-primitives.js';

beforeEach(() => publishMock.mockClear());

describe('buildRealtime', () => {
    it('publishes to a per-plugin namespaced channel with topic in the payload', async () => {
        const rt = buildRealtime('shoutbox');
        await rt.publish('message', { id: '1', body: 'hi' });
        expect(publishMock).toHaveBeenCalledTimes(1);
        const [channel, message] = publishMock.mock.calls[0];
        expect(channel).toBe('plugin:rt:shoutbox');
        const parsed = JSON.parse(message as string);
        expect(parsed.pluginId).toBe('shoutbox');
        expect(parsed.topic).toBe('message');
        expect(parsed.payload).toEqual({ id: '1', body: 'hi' });
        expect(typeof parsed.ts).toBe('number');
    });

    it('throws a typed PluginRealtimeError for a non-serializable (BigInt) payload', async () => {
        const rt = buildRealtime('shoutbox');
        await expect(rt.publish('message', { n: 1n })).rejects.toBeInstanceOf(PluginRealtimeError);
        expect(publishMock).not.toHaveBeenCalled();
    });

    it('throws a typed PluginRealtimeError for a circular-reference payload', async () => {
        const rt = buildRealtime('shoutbox');
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(rt.publish('message', circular)).rejects.toBeInstanceOf(PluginRealtimeError);
        expect(publishMock).not.toHaveBeenCalled();
    });
});
