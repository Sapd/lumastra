// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { LeaderLock } from './leader-lock.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('LeaderLock real coordination cleanup', () => {
    const keys = new Set<string>();
    const locks = new Set<LeaderLock>();
    const key = (): string => {
        const value = `lock:test:shutdown:${randomUUID()}`;
        keys.add(value);
        return value;
    };
    const lock = (client: ValkeyLike, name: string): LeaderLock => {
        const value = new LeaderLock(client, name, 'original-holder', 30_000, 10_000);
        locks.add(value);
        return value;
    };
    beforeAll(async () => {
        await connectValkey();
    });
    afterEach(async () => {
        for (const value of locks) value.stop();
        if (keys.size) await requireClient().customCommand(['DEL', ...keys]);
        locks.clear();
        keys.clear();
    });
    afterAll(async () => {
        await disconnectValkey();
    });

    it.each([false, true])(
        'releases an applied SET after stop, lost acknowledgement: %s',
        async (loseAck) => {
            const name = key();
            const applied = deferred();
            const finish = deferred();
            const client: ValkeyLike = {
                async customCommand(command): Promise<unknown> {
                    const result = await requireClient().customCommand(command);
                    if (command.includes(name) && result === 'OK') {
                        applied.resolve();
                        await finish.promise;
                        if (loseAck) throw new Error('SET applied but acknowledgement lost');
                    }
                    return result;
                },
            };
            const owner = lock(client, name);
            const acquisition = owner.acquire().catch((error: unknown) => error);
            await applied.promise;
            expect(await requireClient().customCommand(['GET', name])).toBe('original-holder');
            const stopping = owner.release({ strict: true });
            let stopped = false;
            void stopping.then(() => {
                stopped = true;
            });
            try {
                await Promise.resolve();
                expect(stopped).toBe(false);
                finish.resolve();
                const result = await acquisition;
                if (loseAck) expect(result).toBeInstanceOf(Error);
                else expect(result).toBe(false);
                await stopping;
                expect(owner.isHeld()).toBe(false);
                expect(await requireClient().customCommand(['GET', name])).toBeNull();
            } finally {
                finish.resolve();
                await acquisition;
                await stopping.catch(() => {});
            }
        },
    );

    it.each(['before-delete', 'after-delete'])(
        'retains release uncertainty until compare-delete retry: %s',
        async (failure) => {
            const name = key();
            let releasing = false;
            let fail = true;
            const client: ValkeyLike = {
                async customCommand(command): Promise<unknown> {
                    if (releasing && fail && failure === 'before-delete')
                        throw new Error('release request unavailable');
                    const result = await requireClient().customCommand(command);
                    if (releasing && fail) throw new Error('DEL acknowledgement lost');
                    return result;
                },
            };
            const owner = lock(client, name);
            expect(await owner.acquire()).toBe(true);
            releasing = true;
            await expect(owner.release({ strict: true })).rejects.toThrow('UNKNOWN');
            expect(await requireClient().customCommand(['GET', name])).toBe(
                failure === 'before-delete' ? 'original-holder' : null,
            );
            fail = false;
            await owner.release({ strict: true });
            expect(await requireClient().customCommand(['GET', name])).toBeNull();
        },
    );

    it('confirms the original token absent without deleting a successor lock', async () => {
        const name = key();
        const owner = lock(requireClient(), name);
        expect(await owner.acquire()).toBe(true);
        owner.stop();
        await requireClient().customCommand(['SET', name, 'successor-holder', 'PX', '30000']);
        await owner.release({ strict: true });
        expect(await requireClient().customCommand(['GET', name])).toBe('successor-holder');
    });

    it('declares loss before a peer can acquire while a renewal hangs', async () => {
        const name = key();
        // After the acquisition, the owner's connection is paused: its renewals
        // never get a reply. The acquisition itself uses the real Valkey.
        let paused = false;
        const hung: ValkeyLike = {
            async customCommand(command): Promise<unknown> {
                if (paused) return new Promise<never>(() => {});
                return requireClient().customCommand(command);
            },
        };
        // ttl 3s, renew every 500ms: loss threshold = 3s - max(1s, 0.6s) = 2s.
        const owner = new LeaderLock(hung, name, 'original-holder', 3_000, 500);
        const peer = new LeaderLock(requireClient(), name, 'peer-holder', 3_000, 500);
        locks.add(owner);
        locks.add(peer);
        let lostAt: number | null = null;
        owner.onLost(() => {
            lostAt = performance.now();
        });
        const acquiredAt = performance.now();
        expect(await owner.acquire()).toBe(true);
        paused = true;
        let peerAt: number | null = null;
        while (performance.now() - acquiredAt < 6_000) {
            if (await peer.acquire()) {
                peerAt = performance.now();
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(peerAt).not.toBeNull();
        expect(lostAt).not.toBeNull();
        expect(owner.isHeld()).toBe(false);
        // Loss was declared while the key was still ours, before the takeover.
        expect(lostAt!).toBeLessThan(peerAt!);
        expect(lostAt! - acquiredAt).toBeLessThan(3_000);
        peer.stop();
    }, 15_000);
});
