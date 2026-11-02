// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the sandbox-entry RPC client (`createRpcClient`).
 *
 * `sandbox-entry.ts`'s bootstrap only runs off the main thread (see its
 * module header's "Import-safe" note), so importing it here from vitest's
 * main thread is a no-op for the worker bootstrap — but `createRpcClient` is
 * a plain, dependency-free factory that can be exercised directly without a
 * real `node:worker_threads` Worker, `parentPort`, or a DB.
 *
 * Covers the abort-wiring fix: a plugin `await`ing a pending RPC (secrets/
 * settings/cache/reportFailure/userCredentials) when `abort` arrives must
 * observe the cancellation instead of hanging forever on a reply that may
 * never come — every such stall used to escalate all the way to a hard
 * `terminate()`.
 *
 * Run: npx vitest run src/lib/server/tasks/isolation/sandbox-entry.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { createRpcClient } from './sandbox-entry.js';
import type { WorkerToMain } from './protocol.js';

describe('createRpcClient', () => {
    it('posts an rpc message and resolves when the matching rpcResult arrives', async () => {
        const posted: WorkerToMain[] = [];
        const client = createRpcClient(
            (msg) => posted.push(msg),
            () => false,
        );

        const promise = client.call('secrets.get', 'API_KEY');
        expect(posted).toEqual([{ t: 'rpc', cid: 1, method: 'secrets.get', args: ['API_KEY'] }]);

        client.handleReply({ t: 'rpcResult', cid: 1, ok: true, value: 'shh' });
        await expect(promise).resolves.toBe('shh');
    });

    it('rejects with the serialized error message when rpcResult is ok:false', async () => {
        const client = createRpcClient(
            () => {},
            () => false,
        );
        const promise = client.call('settings');
        client.handleReply({
            t: 'rpcResult',
            cid: 1,
            ok: false,
            error: { isTaskError: false, message: 'no settings' },
        });
        await expect(promise).rejects.toThrow('no settings');
    });

    it('ignores an rpcResult for an unknown/already-settled cid', () => {
        const client = createRpcClient(
            () => {},
            () => false,
        );
        // No matching pending call — must not throw.
        expect(() =>
            client.handleReply({ t: 'rpcResult', cid: 999, ok: true, value: 1 }),
        ).not.toThrow();
    });

    it('ignores non-rpcResult messages passed to handleReply', () => {
        const client = createRpcClient(
            () => {},
            () => false,
        );
        expect(() => client.handleReply({ t: 'abort' })).not.toThrow();
    });

    it('rejectAll rejects every pending call and clears them (a late reply is a no-op)', async () => {
        const client = createRpcClient(
            () => {},
            () => false,
        );
        const p1 = client.call('secrets.get', 'a');
        const p2 = client.call('secrets.getOptional', 'b');

        client.rejectAll(new Error('isolation RPC aborted: run cancelled'));

        await expect(p1).rejects.toThrow('isolation RPC aborted: run cancelled');
        await expect(p2).rejects.toThrow('isolation RPC aborted: run cancelled');

        // A reply arriving after rejectAll must not resolve/throw — the entry
        // was already cleared.
        const resolveSpy = vi.fn();
        p1.then(resolveSpy, () => {});
        client.handleReply({ t: 'rpcResult', cid: 1, ok: true, value: 'late' });
        await Promise.resolve();
        expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('rejects new calls immediately (without posting) once isAborted() is true', () => {
        let aborted = false;
        const posted: WorkerToMain[] = [];
        const client = createRpcClient(
            (msg) => posted.push(msg),
            () => aborted,
        );

        aborted = true;
        const promise = client.call('cache.get', 'k');
        expect(posted).toEqual([]); // no round-trip opened post-abort

        return expect(promise).rejects.toThrow('isolation RPC aborted: run cancelled');
    });

    it('a call issued before abort still gets rejected once abort fires (simulating the host relay)', async () => {
        let aborted = false;
        const client = createRpcClient(
            () => {},
            () => aborted,
        );

        // Plugin issues the RPC before cancellation...
        const promise = client.call('userCredentials.get', 'user-1', 'key');

        // ...then the host relays 'abort' — sandbox-entry's handleMainMessage
        // flips `aborted` and calls rejectAll(); simulate both here.
        aborted = true;
        client.rejectAll(new Error('isolation RPC aborted: run cancelled'));

        await expect(promise).rejects.toThrow('isolation RPC aborted: run cancelled');
    });
});
