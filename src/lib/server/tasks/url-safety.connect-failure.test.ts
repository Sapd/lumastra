// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * safeFetch against REAL undici when every pinned connect fails.
 *
 * Regression: each failed IPv6 attempt also raised an uncaughtException
 * (ENETUNREACH) on top of the rejected fetch; see utils/pinned-lookup.ts.
 *
 * url-safety.test.ts mocks undici entirely, so this lives in its own file.
 * safeFetch refuses loopback, so DNS answers a public stand-in IPv4 and the
 * undici Agent below rewrites that ONE address to 127.0.0.1 after the real
 * pinned lookup ran. Production code is untouched.
 *
 * Run with: npx vitest run src/lib/server/tasks/url-safety.connect-failure.test.ts
 */

import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeFetch, UrlSafetyError } from './url-safety.js';

const STAND_IN_IPV4 = '93.184.216.34';

const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
    promises: { lookup: (...args: unknown[]) => dnsLookupMock(...args) },
}));

vi.mock('undici', async (importOriginal) => {
    const actual = await importOriginal<typeof import('undici')>();
    type Lookup = (
        host: string,
        options: unknown,
        cb: (err: Error | null, addrs: Array<{ address: string; family: number }>) => void,
    ) => void;
    class TestAgent extends actual.Agent {
        constructor(opts: { connect?: { lookup?: Lookup; timeout?: number } }) {
            const inner = opts.connect?.lookup as Lookup;
            const remapped: Lookup = (host, options, cb) =>
                inner(host, options, (err, addrs) =>
                    cb(
                        err,
                        addrs.map((a) =>
                            a.address === STAND_IN_IPV4 ? { address: '127.0.0.1', family: 4 } : a,
                        ),
                    ),
                );
            super({ connect: { timeout: 1_500, lookup: remapped as never } });
        }
    }
    return { ...actual, Agent: TestAgent };
});

describe('safeFetch — every pinned connect fails', () => {
    const uncaught = vi.fn();
    const unhandled = vi.fn();

    beforeEach(() => {
        uncaught.mockClear();
        unhandled.mockClear();
        process.on('uncaughtException', uncaught);
        process.on('unhandledRejection', unhandled);
    });

    afterEach(() => {
        process.off('uncaughtException', uncaught);
        process.off('unhandledRejection', unhandled);
    });

    it('rejects with UrlSafetyError after trying both addresses, nothing uncaught', async () => {
        const server = net.createServer();
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const { port } = server.address() as net.AddressInfo;
        await new Promise<void>((r) => server.close(() => r()));

        dnsLookupMock.mockResolvedValue([
            { address: '100::1', family: 6 },
            { address: STAND_IN_IPV4, family: 4 },
        ]);

        const err = await safeFetch(`https://unreachable.example.com:${port}/x`).catch(
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(UrlSafetyError);
        expect((err as Error).message).toContain('tried 2 address(es)');

        await new Promise((r) => setTimeout(r, 400));
        expect(uncaught).not.toHaveBeenCalled();
        expect(unhandled).not.toHaveBeenCalled();
    }, 15_000);
});
