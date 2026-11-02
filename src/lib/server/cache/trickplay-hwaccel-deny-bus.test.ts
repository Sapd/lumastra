// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const subscribeToChannel = vi.fn<() => Promise<(() => void) | null>>(async () => null);
const publishMessage = vi.fn(async (_channel: string, _message: string) => true);
vi.mock('./valkey.js', () => ({
    publishMessage: (channel: string, message: string) => publishMessage(channel, message),
    subscribeToChannel: () => subscribeToChannel(),
}));

import {
    startTrickplayHwaccelDenySubscriber,
    publishTrickplayHwaccelDenyReset,
    onRemoteTrickplayHwaccelDenyReset,
    _resetTrickplayHwaccelDenyBusForTests,
    _handleTrickplayHwaccelDenyResetForTests,
    TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL,
} from './trickplay-hwaccel-deny-bus.js';

beforeEach(() => {
    _resetTrickplayHwaccelDenyBusForTests();
    publishMessage.mockClear();
    subscribeToChannel.mockReset().mockResolvedValue(null);
});

describe('trickplay-hwaccel-deny-bus', () => {
    it('delivers a reset-all event to the registered applier', () => {
        const seen: unknown[] = [];
        onRemoteTrickplayHwaccelDenyReset((event) => seen.push(event));

        _handleTrickplayHwaccelDenyResetForTests(JSON.stringify({ kind: 'reset-all' }));

        expect(seen).toEqual([{ kind: 'reset-all' }]);
    });

    it('delivers a reset-key event, including its codec key', () => {
        const seen: unknown[] = [];
        onRemoteTrickplayHwaccelDenyReset((event) => seen.push(event));

        _handleTrickplayHwaccelDenyResetForTests(
            JSON.stringify({ kind: 'reset-key', codecKey: 'av1:yuv420p10le' }),
        );

        expect(seen).toEqual([{ kind: 'reset-key', codecKey: 'av1:yuv420p10le' }]);
    });

    // A replica applies its own change BEFORE publishing, so re-applying its own
    // echo is at best wasted work and at worst resurrects a latch it just cleared.
    it('ignores the messages this process published itself', () => {
        const seen: unknown[] = [];
        onRemoteTrickplayHwaccelDenyReset(() => seen.push('reset'));

        publishTrickplayHwaccelDenyReset({ kind: 'reset-all' });
        const [, published] = publishMessage.mock.calls[0];
        _handleTrickplayHwaccelDenyResetForTests(published);

        expect(seen).toEqual([]);
    });

    it('publishes on the shared channel', () => {
        publishTrickplayHwaccelDenyReset({ kind: 'reset-all' });

        expect(publishMessage.mock.calls[0][0]).toBe(TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL);
    });

    // A malformed payload must never corrupt the local latch.
    it.each([
        ['malformed JSON', 'not json at all'],
        ['unknown kind', JSON.stringify({ kind: 'explode' })],
        ['reset-key with no codecKey', JSON.stringify({ kind: 'reset-key' })],
        ['reset-key with empty codecKey', JSON.stringify({ kind: 'reset-key', codecKey: '' })],
    ])('ignores %s without throwing', (_label, raw) => {
        const applied: unknown[] = [];
        onRemoteTrickplayHwaccelDenyReset((event) => applied.push(event));

        expect(() => _handleTrickplayHwaccelDenyResetForTests(raw)).not.toThrow();
        expect(applied).toEqual([]);
    });

    // Publishing runs on the admin reset path; a Valkey outage there must
    // degrade to today's behaviour (single-replica reset), not reject the request.
    it('never rejects when the publish fails', () => {
        publishMessage.mockRejectedValueOnce(new Error('valkey down') as never);

        expect(() => publishTrickplayHwaccelDenyReset({ kind: 'reset-all' })).not.toThrow();
    });
});

describe('subscriber startup recovery', () => {
    it('retries an unavailable subscription and checkpoints only success', async () => {
        subscribeToChannel.mockResolvedValueOnce(null).mockResolvedValueOnce(() => undefined);
        expect(await startTrickplayHwaccelDenySubscriber()).toBe(false);
        expect(await startTrickplayHwaccelDenySubscriber()).toBe(true);
        expect(await startTrickplayHwaccelDenySubscriber()).toBe(true);
        expect(subscribeToChannel).toHaveBeenCalledTimes(2);
    });
    it('retries a rejected subscription', async () => {
        subscribeToChannel
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(() => undefined);
        await expect(startTrickplayHwaccelDenySubscriber()).rejects.toThrow('offline');
        expect(await startTrickplayHwaccelDenySubscriber()).toBe(true);
        expect(subscribeToChannel).toHaveBeenCalledTimes(2);
    });
    it('shares pending startup without reporting success early', async () => {
        const pending = Promise.withResolvers<(() => void) | null>();
        subscribeToChannel.mockReturnValueOnce(pending.promise);
        const first = startTrickplayHwaccelDenySubscriber();
        let settled = false;
        const second = startTrickplayHwaccelDenySubscriber().then((ready) => {
            settled = true;
            return ready;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(subscribeToChannel).toHaveBeenCalledTimes(1);
        pending.resolve(() => undefined);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
    });
});
