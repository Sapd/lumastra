// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical form of an IP literal, used for the allowlist on write and in the
 * matcher: IPv6 is lower-cased and compressed (`2001:DB8:0:0::1` ->
 * `2001:db8::1`), and an IPv4-mapped IPv6 address (`::ffff:10.0.0.5`, in
 * either notation) becomes its IPv4 address, so an allowlist entry of
 * `10.0.0.5` matches a request that arrives from a dual-stack socket. A value
 * that does not parse (e.g. a zone id) is only trimmed and lower-cased.
 */
export function normalizeIp(ip: string): string {
    const trimmed = ip.trim();
    if (!trimmed.includes(':')) return trimmed;
    let host: string;
    try {
        host = new URL(`http://[${trimmed}]/`).hostname.slice(1, -1);
    } catch {
        // expected: not an IPv6 literal the URL parser accepts
        return trimmed.toLowerCase();
    }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
        const hi = parseInt(mapped[1], 16);
        const lo = parseInt(mapped[2], 16);
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return host;
}
