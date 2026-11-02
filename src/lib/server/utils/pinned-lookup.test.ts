// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the pinned undici connect.lookup.
 *
 * Regression: a SYNCHRONOUS lookup answer plus a synchronous connect failure
 * (ENETUNREACH / EHOSTUNREACH on a broken IPv6 route) inside tls.connect made
 * Node throw before undici attached its 'error' listener, so the socket's queued
 * error surfaced as an uncaughtException in the worker on every IPv6 attempt.
 *
 * Run with: npx vitest run src/lib/server/utils/pinned-lookup.test.ts
 */

import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import { createPinnedLookup, type PinnedAddress } from './pinned-lookup.js';

describe('createPinnedLookup', () => {
    it('answers an `all` lookup with an array of the pinned address', async () => {
        const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
        const answer = await new Promise<unknown>((resolve) =>
            lookup('example.com', { all: true }, (err, addrs) => resolve({ err, addrs })),
        );
        expect(answer).toEqual({ err: null, addrs: [{ address: '93.184.216.34', family: 4 }] });
    });

    it('answers a scalar lookup with (address, family)', async () => {
        const lookup = createPinnedLookup({ address: '2001:db8::1', family: 6 });
        const answer = await new Promise<unknown>((resolve) =>
            lookup('example.com', {}, (err, address, family) => resolve({ err, address, family })),
        );
        expect(answer).toEqual({ err: null, address: '2001:db8::1', family: 6 });
    });

    it('never answers synchronously', () => {
        const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
        const cb = vi.fn();
        lookup('example.com', { all: true }, cb);
        lookup('example.com', {}, cb);
        expect(cb).not.toHaveBeenCalled();
    });
});

describe('pinned Agent over https against unreachable addresses', () => {
    const uncaught = vi.fn();
    const unhandled = vi.fn();

    beforeEach(() => {
        uncaught.mockClear();
        unhandled.mockClear();
        // vitest installs its own listeners; ours is added on top and removed after.
        process.on('uncaughtException', uncaught);
        process.on('unhandledRejection', unhandled);
    });

    afterEach(() => {
        process.off('uncaughtException', uncaught);
        process.off('unhandledRejection', unhandled);
    });

    async function fetchPinned(target: PinnedAddress, port: number): Promise<unknown> {
        const agent = new Agent({
            connect: { timeout: 1_500, lookup: createPinnedLookup(target) },
        });
        try {
            await undiciFetch(`https://pinned.example.test:${port}/x`, { dispatcher: agent });
            return undefined;
        } catch (err) {
            return err;
        } finally {
            void agent.destroy().catch(() => {});
        }
    }

    it('rejects for an unreachable IPv6 address without an uncaught exception', async () => {
        // 100::/64 is the discard prefix: ENETUNREACH (Linux, no route),
        // EHOSTUNREACH (macOS) or a connect timeout, depending on the host.
        const err = await fetchPinned({ address: '100::1', family: 6 }, 443);
        expect(err).toBeInstanceOf(Error);
        // Give a queued socket 'error' emit the chance to fire.
        await new Promise((r) => setTimeout(r, 400));
        expect(uncaught).not.toHaveBeenCalled();
        expect(unhandled).not.toHaveBeenCalled();
    }, 10_000);

    it('rejects for a refused IPv4 address without an uncaught exception', async () => {
        const server = net.createServer();
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const { port } = server.address() as net.AddressInfo;
        await new Promise<void>((r) => server.close(() => r()));

        const err = await fetchPinned({ address: '127.0.0.1', family: 4 }, port);
        expect(err).toBeInstanceOf(Error);
        await new Promise((r) => setTimeout(r, 400));
        expect(uncaught).not.toHaveBeenCalled();
        expect(unhandled).not.toHaveBeenCalled();
    }, 10_000);
});
