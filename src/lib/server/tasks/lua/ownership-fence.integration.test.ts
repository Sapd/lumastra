// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectValkey, disconnectValkey, subscribeToChannel } from '$lib/server/cache/valkey.js';
import type { AuthorityToken } from '../../../../task-runtime/authority/store.js';
import { StateMachine } from '../state-machine.js';
import { invokeOwnedCommand } from '../owned-write.js';
import { ProgressTracker } from '../progress.js';
import { requireClient, type ValkeyLike } from '../valkey-types.js';
import { luaLoader } from './loader.js';
import {
    invokeFencedValkey,
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
} from './fenced.js';
import { installValkeyTaskAuthority, quarantineValkeyTaskAuthority } from './fenced-control.js';

const token: AuthorityToken = {
    partition: 'tasks',
    generation: '9007199254740993',
    ownerId: randomUUID(),
};
let client: ValkeyLike;
// Progress publication rides the coordination (task) Valkey, like every other pub/sub and the
// SSE relay's subscription (subscribeToChannel). Same instance as `client`; kept as its own
// name so the tests read as "the publisher" and can wrap it.
let publishClient: ValkeyLike;
/** Authority mirrors to install: one per distinct instance. */
const mirrors = (): ValkeyLike[] => [...new Set([client, publishClient])];
let runId: string;
let tracker: ProgressTracker | undefined;
let unsubscribeProgress: (() => Promise<void>) | undefined;
const activeKey = (): string => `task:run:active:${runId}`;
const terminalKey = (): string => `task:run:terminal:${runId}`;

/** subscribeToChannel resolves only after the actual SUBSCRIBE acknowledgment. */
async function observeProgress(): Promise<unknown[]> {
    const events: unknown[] = [];
    const unsubscribe = await subscribeToChannel('task:events:progress', (message) => {
        const payload: unknown = JSON.parse(message);
        if (
            payload &&
            typeof payload === 'object' &&
            'runId' in payload &&
            payload.runId === runId
        ) {
            events.push(payload);
        }
    });
    if (!unsubscribe) throw new Error('Real progress subscription unavailable');
    unsubscribeProgress = unsubscribe;
    return events;
}

async function install(authority = token, phase: 'active' | 'draining' = 'active'): Promise<void> {
    for (const mirror of mirrors()) {
        await quarantineValkeyTaskAuthority(mirror);
        await installValkeyTaskAuthority(mirror, undefined, {
            authority,
            phase,
            leaseUntilMs: Date.now() + 30_000,
        });
    }
}
async function stageProcessed(): Promise<unknown> {
    return client.customCommand(['HGET', activeKey(), 'stage:main:processed']);
}
async function waitForWrites(milliseconds = 80): Promise<void> {
    // Wait beyond the explicitly short test throttle, allowing real network I/O.
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
    const cacheUrl = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL;
    if (!cacheUrl || Number(new URL(cacheUrl).pathname.slice(1)) < 1) {
        throw new Error('Isolated Valkey required');
    }
    if (!(await connectValkey())) throw new Error('Valkey unavailable');
    client = requireClient();
    publishClient = client;
    await luaLoader.load();
});
beforeEach(async () => {
    runId = `fenced-writer-${randomUUID()}`;
    for (const mirror of mirrors())
        await mirror.customCommand(['DEL', VALKEY_TASK_AUTHORITY_KEY, VALKEY_TASK_MANAGED_KEY]);
    await client.customCommand([
        'HSET',
        activeKey(),
        'state',
        'pending',
        'stage:main:state',
        'waiting',
    ]);
});
afterEach(async () => {
    await unsubscribeProgress?.();
    unsubscribeProgress = undefined;
    tracker?.finalize(runId, token);
    tracker = undefined;
    await waitForWrites();
    await publishClient.customCommand(['DEL', VALKEY_TASK_AUTHORITY_KEY, VALKEY_TASK_MANAGED_KEY]);
    await client.customCommand([
        'DEL',
        activeKey(),
        terminalKey(),
        VALKEY_TASK_AUTHORITY_KEY,
        VALKEY_TASK_MANAGED_KEY,
    ]);
});
afterAll(async () => {
    await disconnectValkey();
});

describe('existing Valkey writers at the atomic ownership boundary', () => {
    it('preserves unmanaged TypeScript behavior and original script arguments', async () => {
        const machine = new StateMachine(() => client);
        expect(
            await machine.transitionRun({
                runId,
                from: 'pending',
                to: 'active',
                extra: { original: 'value' },
            }),
        ).toMatchObject({ ok: true });
        expect(await client.customCommand(['HGET', activeKey(), 'original'])).toBe('value');
        expect(await client.customCommand(['HGET', activeKey(), 'ownerId'])).toBeNull();
    });

    it('rejects missing/no-token/stale writes without touching current state', async () => {
        const bound = new StateMachine(() => client, token);
        await expect(bound.transitionRun({ runId, from: 'pending', to: 'active' })).rejects.toThrow(
            /TASK_AUTHORITY_MISSING/,
        );
        await install();
        const unbound = new StateMachine(() => client);
        await expect(
            unbound.transitionRun({ runId, from: 'pending', to: 'active' }),
        ).rejects.toThrow(/TASK_AUTHORITY_REQUIRED/);
        const wrongOwner = new StateMachine(() => client, { ...token, ownerId: randomUUID() });
        await expect(wrongOwner.incrementStage({ runId, stageId: 'main' })).rejects.toThrow(
            /TASK_AUTHORITY_STALE/,
        );
        expect(await client.customCommand(['HGET', activeKey(), 'state'])).toBe('pending');
        expect(await stageProcessed()).toBeNull();
    });

    it('allows current claim, stage updates, increments and terminal transition', async () => {
        await install();
        const machine = new StateMachine(() => client, token);
        expect(
            await machine.claimRun({
                runId,
                expectedState: 'pending',
                instanceId: 'fixture',
                bootId: randomUUID(),
            }),
        ).toMatchObject({ ok: true });
        expect(await machine.transitionRun({ runId, from: 'pending', to: 'active' })).toMatchObject(
            { ok: true },
        );
        expect(
            await machine.transitionStage({
                runId,
                stageId: 'main',
                from: 'waiting',
                to: 'active',
            }),
        ).toMatchObject({ ok: true });
        expect(
            await machine.incrementStage({ runId, stageId: 'main', increment: 3, total: 4 }),
        ).toMatchObject({ ok: true, processed: 3 });
        expect(
            await machine.transitionRun({ runId, from: 'active', to: 'completed' }),
        ).toMatchObject({ ok: true });
        expect(await client.customCommand(['HGET', terminalKey(), 'state'])).toBe('completed');
    });

    it('rejects an expired lease and a lost fence even with legacy scripts cached', async () => {
        await install();
        const machine = new StateMachine(() => client, token);
        await machine.transitionRun({ runId, from: 'pending', to: 'active' });
        await client.customCommand(['HSET', VALKEY_TASK_AUTHORITY_KEY, 'leaseUntilMs', '1']);
        await expect(machine.incrementStage({ runId, stageId: 'main' })).rejects.toThrow(
            /TASK_AUTHORITY_EXPIRED/,
        );
        await client.customCommand(['DEL', VALKEY_TASK_AUTHORITY_KEY]);
        await expect(
            machine.transitionRun({ runId, from: 'active', to: 'failed' }),
        ).rejects.toThrow(/TASK_AUTHORITY_MISSING/);
        await expect(
            new StateMachine(() => client).incrementStage({ runId, stageId: 'main' }),
        ).rejects.toThrow(/TASK_AUTHORITY_REQUIRED/);
        expect(await stageProcessed()).toBeNull();
    });

    it('permits graceful draining writes, rejects admissions, and quarantines all writes', async () => {
        await install(token, 'draining');
        const machine = new StateMachine(() => client, token);
        expect(await machine.transitionRun({ runId, from: 'pending', to: 'active' })).toMatchObject(
            { ok: true },
        );
        await expect(
            machine.claimRun({
                runId,
                expectedState: 'active',
                instanceId: 'fixture',
                bootId: randomUUID(),
            }),
        ).rejects.toThrow(/TASK_AUTHORITY_DRAINING/);
        await expect(
            luaLoader.invoke(
                'enqueue-with-identity',
                [`test:identity:${runId}`],
                [runId, 1000],
                client,
                token,
            ),
        ).rejects.toThrow(/TASK_AUTHORITY_DRAINING/);
        await quarantineValkeyTaskAuthority(client, token);
        await expect(
            machine.transitionRun({ runId, from: 'active', to: 'completed' }),
        ).rejects.toThrow(/TASK_AUTHORITY_QUARANTINED/);
        expect(await client.customCommand(['HGET', activeKey(), 'state'])).toBe('active');
        expect(await client.customCommand(['PTTL', VALKEY_TASK_MANAGED_KEY])).toBe(-1);
        expect(await client.customCommand(['PTTL', VALKEY_TASK_AUTHORITY_KEY])).toBe(-1);
    });

    it('rejects delayed original progress and terminal callbacks after a newer generation', async () => {
        await install();
        const mutable = { ...token };
        const machine = new StateMachine(() => client, mutable);
        tracker = new ProgressTracker(() => client, 1000, 30_000);
        const report = tracker.create(runId, 'main', mutable);
        report(1, 10);
        await expect.poll(stageProcessed).toBe('1');
        report(9, 10); // held in the throttle buffer when ownership moves.
        await quarantineValkeyTaskAuthority(client, token);
        const next = { ...token, generation: '9007199254740994', ownerId: randomUUID() };
        await installValkeyTaskAuthority(client, token, {
            authority: next,
            phase: 'active',
            leaseUntilMs: Date.now() + 30_000,
        });
        Object.assign(mutable, next); // mutation must not upgrade captured callbacks.
        await waitForWrites(1100);
        tracker.finalize(runId, token);
        tracker = undefined;
        await waitForWrites();
        await expect(
            machine.transitionRun({ runId, from: 'pending', to: 'completed' }),
        ).rejects.toThrow(/TASK_AUTHORITY_STALE/);
        expect(await stageProcessed()).toBe('1');
        expect(
            await new StateMachine(() => client, next).transitionRun({
                runId,
                from: 'pending',
                to: 'active',
            }),
        ).toMatchObject({ ok: true });
    });

    it('keeps direct heartbeat/HSET payload positions private and fenced', async () => {
        await install();
        const write = (authority?: AuthorityToken): Promise<unknown> =>
            invokeFencedValkey(
                "return redis.call('HSET', KEYS[1], unpack(ARGV))",
                [activeKey()],
                ['heartbeatAt', 'original'],
                client,
                authority,
            );
        await write(token);
        await quarantineValkeyTaskAuthority(client, token);
        await expect(write(token)).rejects.toThrow(/TASK_AUTHORITY_QUARANTINED/);
        await expect(write()).rejects.toThrow(/TASK_AUTHORITY_REQUIRED/);
        expect(await client.customCommand(['HGET', activeKey(), 'heartbeatAt'])).toBe('original');
        expect(await client.customCommand(['HEXISTS', activeKey(), 'tasks'])).toBe(false);
    });

    it('fences the real direct HSET, SET, PEXPIRE and DEL writer helper', async () => {
        await install();
        const heartbeatKey = `task:test:owned:${runId}`;
        try {
            await invokeOwnedCommand(
                ['HSET', activeKey(), 'heartbeatAt', 'current'],
                client,
                token,
            );
            await invokeOwnedCommand(['SET', heartbeatKey, 'current'], client, token);
            expect(
                await invokeOwnedCommand(['PEXPIRE', heartbeatKey, '30000'], client, token),
            ).toBe(1);
            await quarantineValkeyTaskAuthority(client, token);
            const next = { ...token, generation: '9007199254740994', ownerId: randomUUID() };
            await installValkeyTaskAuthority(client, token, {
                authority: next,
                phase: 'active',
                leaseUntilMs: Date.now() + 30_000,
            });
            for (const command of [
                ['HSET', activeKey(), 'heartbeatAt', 'stale'],
                ['SET', heartbeatKey, 'stale'],
                ['PEXPIRE', heartbeatKey, '1'],
                ['DEL', heartbeatKey],
            ]) {
                await expect(invokeOwnedCommand(command, client, token)).rejects.toThrow(
                    /TASK_AUTHORITY_STALE/,
                );
                await expect(invokeOwnedCommand(command, client)).rejects.toThrow(
                    /TASK_AUTHORITY_REQUIRED/,
                );
            }
            expect(await client.customCommand(['GET', heartbeatKey])).toBe('current');
            expect(await client.customCommand(['HGET', activeKey(), 'heartbeatAt'])).toBe(
                'current',
            );
            expect(await invokeOwnedCommand(['DEL', heartbeatKey], client, next)).toBe(1);
        } finally {
            await client.customCommand(['DEL', heartbeatKey]);
        }
    });

    it('rejects stale publication when a committed HSET acknowledgment arrives after handoff', async () => {
        await install();
        const observed = await observeProgress();
        let markCommitted!: () => void;
        let releaseAck!: () => void;
        const committed = new Promise<void>((resolve) => {
            markCommitted = resolve;
        });
        const acknowledgment = new Promise<void>((resolve) => {
            releaseAck = resolve;
        });
        let pause = true;
        const delayedCoordination: ValkeyLike = {
            customCommand: async (command) => {
                const result = await client.customCommand(command);
                if (pause) {
                    pause = false;
                    markCommitted();
                    await acknowledgment;
                }
                return result;
            },
        };
        const published: string[][] = [];
        const rejected: string[] = [];
        const publisher: ValkeyLike = {
            customCommand: async (command) => {
                try {
                    const result = await publishClient.customCommand(command);
                    published.push(command);
                    return result;
                } catch (error) {
                    rejected.push(String(error));
                    throw error;
                }
            },
        };
        tracker = new ProgressTracker(
            () => delayedCoordination,
            1000,
            30_000,
            () => publisher,
        );
        tracker.create(runId, 'main', token)(1, 10);
        await committed;
        expect(await stageProcessed()).toBe('1');
        const next = { ...token, generation: '9007199254740994', ownerId: randomUUID() };
        try {
            for (const mirror of mirrors()) {
                await quarantineValkeyTaskAuthority(mirror, token);
                await installValkeyTaskAuthority(mirror, token, {
                    authority: next,
                    phase: 'active',
                    leaseUntilMs: Date.now() + 30_000,
                });
            }
        } finally {
            releaseAck();
        }
        await expect
            .poll(() => rejected.some((error) => error.includes('TASK_AUTHORITY_STALE')))
            .toBe(true);
        expect(published).toHaveLength(0);
        tracker.finalize(runId, token);
        tracker = new ProgressTracker(
            () => client,
            1000,
            30_000,
            () => publisher,
        );
        tracker.create(runId, 'main', next)(2, 10);
        await expect.poll(() => published.length).toBe(1);
        const command = published[0];
        const argvStart = 3 + Number(command[2]);
        expect(command[argvStart]).toBe('task:events:progress');
        expect(JSON.parse(command[argvStart + 1])).toMatchObject({ authority: next, processed: 2 });
        // A real later event is the barrier for absence of an earlier stale one.
        await expect.poll(() => observed.length).toBe(1);
        expect(observed).toMatchObject([{ runId, authority: next, processed: 2, total: 10 }]);
        tracker.finalize(runId, next);
        tracker = undefined;
        await waitForWrites();
    });

    it('rejects unmanaged publication when first management occurs before the HSET acknowledgment', async () => {
        const observed = await observeProgress();
        let markCommitted!: () => void;
        let releaseAck!: () => void;
        const committed = new Promise<void>((resolve) => {
            markCommitted = resolve;
        });
        const acknowledgment = new Promise<void>((resolve) => {
            releaseAck = resolve;
        });
        let pause = true;
        const delayedCoordination: ValkeyLike = {
            customCommand: async (command) => {
                const result = await client.customCommand(command);
                if (pause) {
                    pause = false;
                    markCommitted();
                    await acknowledgment;
                }
                return result;
            },
        };
        const published: string[][] = [];
        const rejected: string[] = [];
        const publisher: ValkeyLike = {
            customCommand: async (command) => {
                try {
                    const result = await publishClient.customCommand(command);
                    published.push(command);
                    return result;
                } catch (error) {
                    rejected.push(String(error));
                    throw error;
                }
            },
        };
        tracker = new ProgressTracker(
            () => delayedCoordination,
            1000,
            30_000,
            () => publisher,
        );
        tracker.create(runId)(1, 10);
        await committed;
        expect(await stageProcessed()).toBe('1');
        try {
            await install();
        } finally {
            releaseAck();
        }
        await expect
            .poll(() => rejected.some((error) => error.includes('TASK_AUTHORITY_REQUIRED')))
            .toBe(true);
        expect(published).toHaveLength(0);
        tracker.finalize(runId);
        tracker = new ProgressTracker(
            () => client,
            1000,
            30_000,
            () => publisher,
        );
        tracker.create(runId, 'main', token)(2, 10);
        // Confirm actual delivery after the rejected unmanaged publication.
        await expect.poll(() => observed.length).toBe(1);
        expect(observed).toMatchObject([{ runId, authority: token, processed: 2, total: 10 }]);
        tracker.finalize(runId, token);
        tracker = undefined;
        await waitForWrites();
    });

    it('requires quarantine and exact CAS before changing mirrored generations', async () => {
        await install();
        const next = { ...token, generation: '9007199254740994', ownerId: randomUUID() };
        await expect(
            installValkeyTaskAuthority(client, token, {
                authority: next,
                phase: 'active',
                leaseUntilMs: Date.now() + 30_000,
            }),
        ).rejects.toThrow(/TASK_AUTHORITY_NOT_QUARANTINED/);
        await expect(quarantineValkeyTaskAuthority(client, next)).rejects.toThrow(
            /TASK_AUTHORITY_STALE/,
        );
        expect(await client.customCommand(['HGET', VALKEY_TASK_AUTHORITY_KEY, 'generation'])).toBe(
            token.generation,
        );
    });
});
