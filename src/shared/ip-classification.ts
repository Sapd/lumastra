// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure IP-address classification helpers for the app's SSRF guard.
 * Keep this arithmetic dependency-free; Rust has its own transport guard.
 */

function ipv4ToBigInt(ip: string): bigint {
    return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(parseInt(octet, 10)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
    // DNS can return dotted IPv4 tails even though URL literals normalize them.
    if (ip.includes('.')) {
        const colon = ip.lastIndexOf(':');
        const v4 = ipv4ToBigInt(ip.slice(colon + 1));
        ip = `${ip.slice(0, colon)}:${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
    }
    const halves = ip.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
    return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

function isPrivateIPv4(ip: string): boolean {
    const val = ipv4ToBigInt(ip);
    const ranges: Array<[string, number]> = [
        ['10.0.0.0', 8],
        ['172.16.0.0', 12],
        ['192.168.0.0', 16],
        ['127.0.0.0', 8],
        ['169.254.0.0', 16],
        ['100.64.0.0', 10],
        ['0.0.0.0', 8],
        ['192.0.0.0', 24], // IETF protocol assignments
        ['198.18.0.0', 15], // benchmarking
        ['224.0.0.0', 4], // multicast
        ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
    ];
    for (const [cidr, bits] of ranges) {
        const prefix = ipv4ToBigInt(cidr);
        const mask = ~((1n << BigInt(32 - bits)) - 1n) & 0xffffffffn;
        if ((val & mask) === (prefix & mask)) return true;
    }
    return false;
}

function isPrivateIPv6(ip: string): boolean {
    const val = ipv6ToBigInt(ip);
    // IPv4-compatible and mapped addresses are private only when their target is.
    // This also covers unspecified/loopback (:: and ::1 -> 0.0.0.0/8).
    if (val >> 32n === 0n || val >> 32n === 0xffffn) {
        const v4 = val & 0xffffffffn;
        return isPrivateIPv4(
            [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join('.'),
        );
    }
    // NAT64 (64:ff9b::/96) carries an IPv4 address in its low 32 bits; a DNS64
    // resolver hands it out for public sites too, so classify the embedded one.
    const nat64 = ipv6ToBigInt('64:ff9b:0:0:0:0:0:0');
    if (val >> 32n === nat64 >> 32n) {
        const v4 = val & 0xffffffffn;
        return isPrivateIPv4(
            [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join('.'),
        );
    }
    // 6to4 carries its IPv4 relay in bits 16..48 (2002:V4HI:V4LO::/48).
    if (val >> 112n === 0x2002n) {
        const v4 = (val >> 80n) & 0xffffffffn;
        return isPrivateIPv4(
            [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join('.'),
        );
    }
    const ranges: Array<[string, number]> = [
        ['fc00:0:0:0:0:0:0:0', 7],
        ['fe80:0:0:0:0:0:0:0', 10],
        ['fec0:0:0:0:0:0:0:0', 10], // site-local (deprecated)
        ['ff00:0:0:0:0:0:0:0', 8], // multicast
        ['64:ff9b:1:0:0:0:0:0', 48], // local-use NAT64 (RFC 8215)
    ];
    for (const [cidr, bits] of ranges) {
        const prefix = ipv6ToBigInt(cidr);
        const mask = bits === 128 ? ~0n : ~((1n << BigInt(128 - bits)) - 1n);
        if ((val & mask) === (prefix & mask)) return true;
    }
    return false;
}

/**
 * Classify an IP address (literal, with optional `[...]` IPv6 brackets) as
 * private/internal. Returns false for hostnames or unparseable input — callers
 * must resolve hostnames to addresses via DNS before calling this.
 */
export function isPrivateIP(address: string): boolean {
    const normalized =
        address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
        return isPrivateIPv4(normalized);
    }
    if (normalized.includes(':')) {
        return isPrivateIPv6(normalized);
    }
    return false;
}
