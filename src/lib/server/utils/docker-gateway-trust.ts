// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detect a TRUSTED_PROXY_IPS entry that trusts the container's DEFAULT GATEWAY.
 *
 * With a reverse proxy installed on the HOST (Caddy/nginx proxying to the
 * published port), the TCP peer Lumastra sees is the Docker bridge gateway
 * (e.g. 172.21.0.1): Docker's port publishing and the host's own connections to
 * the bridge both arrive from that address. Operators therefore set
 * TRUSTED_PROXY_IPS to it — and from then on ANY process on the host can send
 * `X-Forwarded-User: <admin>` to 127.0.0.1:<port> and be trusted as the proxy
 * (verified in the Linux e2e 2026-09-29: a forged-header curl got the admin user
 * list). A subnet entry that CONTAINS the gateway (172.21.0.0/16) has the same
 * hole.
 *
 * This is a WARNING, never a startup block: a single-user host where every local
 * process is already trusted may accept it knowingly.
 *
 * The gateway is read from `/proc/net/route` (Linux; absent elsewhere → no
 * check). Everything here is pure except `readProcNetRoute`, so the detection is
 * unit-tested by feeding route-table text.
 */

import { readFileSync } from 'node:fs';

/** IPv4 dotted-quad → unsigned 32-bit int, or null when not an IPv4 literal. */
function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const b = Number(part);
        if (b > 255) return null;
        n = ((n << 8) | b) >>> 0;
    }
    return n >>> 0;
}

/**
 * The default-route gateway from `/proc/net/route` content, or null.
 *
 * Format: a header line, then whitespace-separated columns
 * `Iface Destination Gateway Flags …`, addresses as 8 hex digits in HOST byte
 * order (little-endian on every platform Docker runs on), e.g. gateway
 * `010015AC` = 172.21.0.1. The default route has Destination `00000000` and
 * the RTF_GATEWAY flag (0x2) set.
 */
export function parseDefaultGateway(procNetRoute: string): string | null {
    for (const line of procNetRoute.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const [, destination, gateway, flags] = cols;
        if (destination !== '00000000') continue;
        if (!/^[0-9A-Fa-f]{8}$/.test(gateway) || gateway === '00000000') continue;
        const flagBits = Number.parseInt(flags, 16);
        if (Number.isFinite(flagBits) && (flagBits & 0x2) === 0) continue;
        const bytes = [6, 4, 2, 0].map((i) => Number.parseInt(gateway.slice(i, i + 2), 16));
        return bytes.join('.');
    }
    return null;
}

/**
 * The TRUSTED_PROXY_IPS entries (verbatim) that trust `ip` — an exact match or
 * an IPv4 CIDR containing it. IPv6 / malformed entries never match.
 */
export function trustedEntriesCovering(trustedProxyIps: string, ip: string): string[] {
    const target = ipv4ToInt(ip);
    if (target === null) return [];
    const hits: string[] = [];
    for (const entry of trustedProxyIps
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const plain = entry.replace(/^::ffff:/i, '');
        const slash = plain.indexOf('/');
        if (slash === -1) {
            if (ipv4ToInt(plain) === target) hits.push(entry);
            continue;
        }
        const network = ipv4ToInt(plain.slice(0, slash));
        const bitsRaw = plain.slice(slash + 1);
        const bits = /^\d{1,2}$/.test(bitsRaw) ? Number(bitsRaw) : NaN;
        if (network === null || !(bits >= 0 && bits <= 32)) continue;
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((network & mask) >>> 0 === (target & mask) >>> 0) hits.push(entry);
    }
    return hits;
}

export interface GatewayTrustFinding {
    /** The container's default gateway (the Docker host, seen from inside). */
    gateway: string;
    /** TRUSTED_PROXY_IPS entries that trust it (exact IP or containing CIDR). */
    entries: string[];
}

/** Pure detection: null when nothing in TRUSTED_PROXY_IPS trusts the gateway. */
export function detectGatewayTrust(input: {
    trustedProxyIps: string | undefined;
    procNetRoute: string | null;
}): GatewayTrustFinding | null {
    const list = (input.trustedProxyIps ?? '').trim();
    if (!list || !input.procNetRoute) return null;
    const gateway = parseDefaultGateway(input.procNetRoute);
    if (!gateway) return null;
    const entries = trustedEntriesCovering(list, gateway);
    return entries.length > 0 ? { gateway, entries } : null;
}

/** `/proc/net/route`, or null off Linux / when unreadable. */
export function readProcNetRoute(): string | null {
    try {
        return readFileSync('/proc/net/route', 'utf8');
    } catch {
        return null;
    }
}

/** Operator-facing explanation — shared by the config doctor and the boot WARN. */
export function describeGatewayTrust(finding: GatewayTrustFinding): {
    message: string;
    remediation: string;
} {
    const entries = finding.entries.join(', ');
    const how =
        finding.entries.length === 1 &&
        finding.entries[0].replace(/^::ffff:/i, '') === finding.gateway
            ? `is the container's default gateway (${finding.gateway})`
            : `contains the container's default gateway (${finding.gateway})`;
    return {
        message:
            `TRUSTED_PROXY_IPS entry ${entries} ${how} — the Docker host. Every process on the ` +
            'host reaches the app from that address, so any local program can send forged ' +
            'forward-auth headers (e.g. X-Forwarded-User: <admin>) to the published port and ' +
            'be trusted as your reverse proxy.',
        remediation:
            'Run the reverse proxy as a container on the same Docker network as the app, do not ' +
            'publish the app port, and set TRUSTED_PROXY_IPS to the proxy container’s own address ' +
            '(give it a fixed IP on that network) — not the gateway, and not a subnet that ' +
            'includes it.',
    };
}

let bootWarned = false;

/**
 * One WARN at boot when TRUSTED_PROXY_IPS trusts the default gateway. Never
 * throws and never blocks startup. The config doctor carries the same finding
 * to `npm run doctor` and the admin config banner.
 */
export function warnIfTrustedProxyCoversGateway(
    warn: (message: string, meta?: Record<string, unknown>) => void,
    input: { trustedProxyIps?: string; procNetRoute?: string | null } = {},
): GatewayTrustFinding | null {
    if (bootWarned) return null;
    bootWarned = true;
    const finding = detectGatewayTrust({
        trustedProxyIps: input.trustedProxyIps ?? process.env.TRUSTED_PROXY_IPS,
        procNetRoute: input.procNetRoute !== undefined ? input.procNetRoute : readProcNetRoute(),
    });
    if (!finding) return null;
    const { message, remediation } = describeGatewayTrust(finding);
    warn(`${message} ${remediation}`, { gateway: finding.gateway, entries: finding.entries });
    return finding;
}

/** Test hook: re-arm the once-per-process boot warning. */
export function resetGatewayTrustWarning(): void {
    bootWarned = false;
}
