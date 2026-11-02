// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for the deferred security item that collapsed the two
 * independent `FetchRedirectError` classes (fetch-utils.ts and
 * fetch-timeout.ts) into one shared class.
 *
 * Before the fix, each module defined its OWN `FetchRedirectError` with the
 * same name — so `instanceof` failed across the module boundary: a caller
 * that imported the class from one module could never catch an instance
 * thrown by the other. This test proves the class is now the SAME object
 * identity from both import paths, and that hop exhaustion throws the typed
 * error (not a plain `Error`) in both modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    FetchRedirectError as FetchRedirectErrorFromUtils,
    fetchWithTimeout as fetchWithTimeoutFromUtils,
} from './fetch-utils';
import {
    FetchRedirectError as FetchRedirectErrorFromTimeout,
    fetchWithTimeout as fetchWithTimeoutFromTimeout,
} from './fetch-timeout';

describe('FetchRedirectError — single shared class (item 9)', () => {
    it('is the same class object regardless of which module it is imported from', () => {
        expect(FetchRedirectErrorFromUtils).toBe(FetchRedirectErrorFromTimeout);
    });

    it('an instance thrown by fetch-timeout.ts is instanceof the class imported from fetch-utils.ts', () => {
        const err = new FetchRedirectErrorFromTimeout('evil.example.com');
        expect(err).toBeInstanceOf(FetchRedirectErrorFromUtils);
    });

    it('an instance thrown by fetch-utils.ts is instanceof the class imported from fetch-timeout.ts', () => {
        const err = new FetchRedirectErrorFromUtils('evil.example.com');
        expect(err).toBeInstanceOf(FetchRedirectErrorFromTimeout);
    });

    function redirectResponse(location: string, status = 302): Response {
        return new Response(null, { status, headers: { location } });
    }

    describe('hop exhaustion throws the typed error, not a plain Error', () => {
        let mockFetch: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockFetch = vi.fn();
            global.fetch = mockFetch as unknown as typeof fetch;
            for (let i = 0; i < 10; i++) {
                mockFetch.mockResolvedValueOnce(redirectResponse('https://example.com/loop'));
            }
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('fetch-utils.ts fetchWithTimeout throws FetchRedirectError on hop exhaustion', async () => {
            const error = await fetchWithTimeoutFromUtils('https://example.com/api').catch(
                (e: unknown) => e,
            );
            expect(error).toBeInstanceOf(FetchRedirectErrorFromUtils);
            expect(error).toBeInstanceOf(FetchRedirectErrorFromTimeout);
        });

        it('fetch-timeout.ts fetchWithTimeout throws FetchRedirectError on hop exhaustion', async () => {
            const error = await fetchWithTimeoutFromTimeout('https://example.com/api').catch(
                (e: unknown) => e,
            );
            expect(error).toBeInstanceOf(FetchRedirectErrorFromTimeout);
            expect(error).toBeInstanceOf(FetchRedirectErrorFromUtils);
        });
    });

    // A caller must be able to separate "refused a cross-host redirect" from
    // "gave up after too many hops" (and from "refused because the body
    // could not be resent") WITHOUT parsing the message string — that is
    // exactly the fragile pattern collapsing the two classes was meant to
    // let callers retire. `reason` is a constructor parameter; unless it is
    // also STORED on the instance, it is invisible to a catch block and the
    // message substring is the only thing left to match on.
    describe('reason field — callers distinguish cases by field, not message', () => {
        it('constructing directly: reason is readable on the instance for all three cases', () => {
            expect(new FetchRedirectErrorFromUtils('host', 'cross-origin').reason).toBe(
                'cross-origin',
            );
            expect(new FetchRedirectErrorFromUtils('host', 'unresendable-body').reason).toBe(
                'unresendable-body',
            );
            expect(new FetchRedirectErrorFromUtils('host', 'redirect-limit-exceeded').reason).toBe(
                'redirect-limit-exceeded',
            );
        });

        it('defaults to reason "cross-origin" when omitted', () => {
            expect(new FetchRedirectErrorFromUtils('host').reason).toBe('cross-origin');
        });

        function redirectResponseWithBody(location: string, status = 302): Response {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1]));
                    controller.close();
                },
            });
            return new Response(stream, { status, headers: { location } });
        }

        let mockFetch: ReturnType<typeof vi.fn>;
        beforeEach(() => {
            mockFetch = vi.fn();
            global.fetch = mockFetch as unknown as typeof fetch;
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('a cross-origin redirect sets reason "cross-origin"', async () => {
            mockFetch.mockResolvedValueOnce(redirectResponseWithBody('http://127.0.0.1:9999/'));

            const error = (await fetchWithTimeoutFromUtils('https://example.com/api').catch(
                (e: unknown) => e,
            )) as InstanceType<typeof FetchRedirectErrorFromUtils>;

            expect(error.reason).toBe('cross-origin');
        });

        it('hop exhaustion sets reason "redirect-limit-exceeded"', async () => {
            for (let i = 0; i < 10; i++) {
                mockFetch.mockResolvedValueOnce(redirectResponse('https://example.com/loop'));
            }

            const error = (await fetchWithTimeoutFromUtils('https://example.com/api').catch(
                (e: unknown) => e,
            )) as InstanceType<typeof FetchRedirectErrorFromUtils>;

            expect(error.reason).toBe('redirect-limit-exceeded');
        });

        it('an unresendable streamed body on a 307/308 sets reason "unresendable-body"', async () => {
            mockFetch.mockResolvedValueOnce(redirectResponse('https://example.com/other', 307));
            const stream = new ReadableStream();

            const error = (await fetchWithTimeoutFromUtils('https://example.com/api', {
                method: 'POST',
                body: stream,
                // @ts-expect-error — duplex is required by undici for a stream body but not in the lib.dom RequestInit type
                duplex: 'half',
            }).catch((e: unknown) => e)) as InstanceType<typeof FetchRedirectErrorFromUtils>;

            expect(error.reason).toBe('unresendable-body');
        });

        it('three distinct failures produce three distinct reason values — a caller can switch on the field alone', async () => {
            mockFetch.mockResolvedValueOnce(redirectResponseWithBody('http://127.0.0.1:9999/'));
            const crossOrigin = (await fetchWithTimeoutFromUtils('https://example.com/api').catch(
                (e: unknown) => e,
            )) as InstanceType<typeof FetchRedirectErrorFromUtils>;

            mockFetch.mockReset();
            for (let i = 0; i < 10; i++) {
                mockFetch.mockResolvedValueOnce(redirectResponse('https://example.com/loop'));
            }
            const limitExceeded = (await fetchWithTimeoutFromUtils('https://example.com/api').catch(
                (e: unknown) => e,
            )) as InstanceType<typeof FetchRedirectErrorFromUtils>;

            const reasons = new Set([crossOrigin.reason, limitExceeded.reason]);
            expect(reasons.size).toBe(2);
        });
    });
});
