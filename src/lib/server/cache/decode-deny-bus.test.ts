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
    startDecodeDenySubscriber,
    publishDecodeDenySync,
    onRemoteDecodeDenyLearn,
    onRemoteDecodeDenyReset,
    _resetDecodeDenyBusForTests,
    _handleSyncMessageForTests,
    DECODE_DENY_SYNC_CHANNEL,
} from './decode-deny-bus.js';

const ENTRY = { codec: 'av1', bitDepth: 10, learnedAt: '2026-08-07T00:00:00.000Z' };

beforeEach(() => {
    _resetDecodeDenyBusForTests();
    publishMessage.mockClear();
    subscribeToChannel.mockReset().mockResolvedValue(null);
});

describe('decode-deny-bus', () => {
    it('delivers a learn event to the registered applier', () => {
        const learns: unknown[] = [];
        onRemoteDecodeDenyLearn((backend, key, entry) => learns.push({ backend, key, entry }));

        _handleSyncMessageForTests(
            JSON.stringify({ kind: 'learn', backend: 'qsv', key: 'av1@10bit', entry: ENTRY }),
        );

        expect(learns).toEqual([
            { backend: 'qsv', key: 'av1@10bit', entry: expect.objectContaining({ codec: 'av1' }) },
        ]);
    });

    it('delivers a reset event, including its backend scope', () => {
        const resets: (string | undefined)[] = [];
        onRemoteDecodeDenyReset((backend) => resets.push(backend));

        _handleSyncMessageForTests(JSON.stringify({ kind: 'reset', backend: 'qsv' }));
        _handleSyncMessageForTests(JSON.stringify({ kind: 'reset' }));

        expect(resets).toEqual(['qsv', undefined]);
    });

    // A replica applies its own change BEFORE publishing, so re-applying its own
    // echo is at best wasted work and at worst resurrects an entry it just reset.
    it('ignores the messages this process published itself', () => {
        const seen: unknown[] = [];
        onRemoteDecodeDenyReset(() => seen.push('reset'));

        publishDecodeDenySync({ kind: 'reset' });
        const [, published] = publishMessage.mock.calls[0];
        _handleSyncMessageForTests(published);

        expect(seen).toEqual([]);
    });

    it('publishes on the shared channel', () => {
        publishDecodeDenySync({ kind: 'reset', backend: 'qsv' });

        expect(publishMessage.mock.calls[0][0]).toBe(DECODE_DENY_SYNC_CHANNEL);
    });

    // A malformed payload must never corrupt the local map — the same
    // codec+bitDepth rule the write and hydrate paths enforce applies here.
    it.each([
        ['malformed JSON', 'not json at all'],
        ['unknown kind', JSON.stringify({ kind: 'explode' })],
        [
            'learn with no codec',
            JSON.stringify({ kind: 'learn', backend: 'qsv', key: 'k', entry: { bitDepth: 10 } }),
        ],
        [
            'learn with no bit depth',
            JSON.stringify({ kind: 'learn', backend: 'qsv', key: 'k', entry: { codec: 'av1' } }),
        ],
        ['learn with no backend', JSON.stringify({ kind: 'learn', key: 'k', entry: ENTRY })],
    ])('ignores %s without throwing', (_label, raw) => {
        const applied: unknown[] = [];
        onRemoteDecodeDenyLearn((...a) => applied.push(a));

        expect(() => _handleSyncMessageForTests(raw)).not.toThrow();
        expect(applied).toEqual([]);
    });

    // Validity is keyed on the ORIGIN's build. Restamping a peer's lesson with the
    // receiver's build would disguise it as locally learned and let it outlive the
    // build that recorded it — the staleness the build stamp exists to prevent.
    it('carries learnedBy through untouched', () => {
        const seen: { learnedBy?: string }[] = [];
        onRemoteDecodeDenyLearn((_b, _k, entry) => seen.push(entry));

        _handleSyncMessageForTests(
            JSON.stringify({
                kind: 'learn',
                backend: 'qsv',
                key: 'av1@10bit',
                entry: { ...ENTRY, learnedBy: 'build-from-another-replica' },
            }),
        );

        expect(seen[0].learnedBy).toBe('build-from-another-replica');
    });

    // Publishing runs on the transcode failure path; a Valkey outage there must
    // degrade to today's behaviour, not reject into the caller.
    it('never rejects when the publish fails', () => {
        publishMessage.mockRejectedValueOnce(new Error('valkey down') as never);

        expect(() => publishDecodeDenySync({ kind: 'reset' })).not.toThrow();
    });
});

describe('subscriber startup recovery', () => {
    it('retries an unavailable subscription and checkpoints only success', async () => {
        subscribeToChannel.mockResolvedValueOnce(null).mockResolvedValueOnce(() => undefined);
        expect(await startDecodeDenySubscriber()).toBe(false);
        expect(await startDecodeDenySubscriber()).toBe(true);
        expect(await startDecodeDenySubscriber()).toBe(true);
        expect(subscribeToChannel).toHaveBeenCalledTimes(2);
    });
    it('retries a rejected subscription', async () => {
        subscribeToChannel
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(() => undefined);
        await expect(startDecodeDenySubscriber()).rejects.toThrow('offline');
        expect(await startDecodeDenySubscriber()).toBe(true);
        expect(subscribeToChannel).toHaveBeenCalledTimes(2);
    });
    it('shares pending startup without reporting success early', async () => {
        const pending = Promise.withResolvers<(() => void) | null>();
        subscribeToChannel.mockReturnValueOnce(pending.promise);
        const first = startDecodeDenySubscriber();
        let settled = false;
        const second = startDecodeDenySubscriber().then((ready) => {
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
