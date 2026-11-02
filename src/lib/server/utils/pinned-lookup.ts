// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `connect.lookup` for an undici Agent that pins every connection to one
 * pre-validated address (the DNS-rebinding defence of `pinnedFetch` and
 * `safeFetch`).
 *
 * undici@7+ calls lookup with `all` semantics: the callback takes an ARRAY of
 * {address, family}; the scalar `(null, address, family)` form throws
 * ERR_INVALID_IP_ADDRESS at connect time and fails every pinned fetch. The
 * scalar form is still answered when a caller does not ask for `all`, like
 * undici's own connect.js.
 *
 * The answer MUST be asynchronous, like the real dns.lookup. A synchronous
 * answer plus a synchronous connect failure (ENETUNREACH/EHOSTUNREACH on a
 * broken IPv6 route) inside tls.connect makes Node throw a TypeError before
 * undici attaches its 'error' listener, so the socket's queued error is
 * emitted with no listener and becomes an uncaughtException.
 */

export interface PinnedAddress {
    address: string;
    family: number;
}

type LookupCallback = (
    err: Error | null,
    addressOrList: string | PinnedAddress[],
    family?: number,
) => void;

export type PinnedLookup = (hostname: string, options: unknown, callback: LookupCallback) => void;

export function createPinnedLookup({ address, family }: PinnedAddress): PinnedLookup {
    return (_hostname, options, callback) => {
        const wantsAll =
            typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
        if (wantsAll) {
            process.nextTick(callback, null, [{ address, family }]);
        } else {
            process.nextTick(callback, null, address, family);
        }
    };
}
