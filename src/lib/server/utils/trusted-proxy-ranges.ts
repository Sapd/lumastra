// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detect TRUSTED_PROXY_IPS entries that trust more than a proxy.
 *
 * Every address in TRUSTED_PROXY_IPS may choose the client IP Lumastra sees
 * (X-Forwarded-For), and with FORWARD_AUTH_ENABLED=true it may also send the
 * identity headers and sign in as anyone. A LAN range such as 192.168.0.0/16
 * hands that to every device on the network. The list should name proxies.
 *
 * Threshold: an IPv4 prefix shorter than /24 (more than 256 addresses). A /24 is
 * the largest network the docs ever create for a compose proxy (the reverse-proxy
 * guide's `172.28.0.0/24` with the proxy pinned at `172.28.0.10`), and the docs
 * list the proxy's own address, never that subnet. Anything wider is a LAN, a
 * Docker default /16 or a whole private block, which is never one proxy. This
 * does not catch a /24 home LAN; the docs cover that case in prose.
 *
 * IPv6: client-ip.ts matches IPv6 entries only as exact addresses, so an IPv6
 * range (`fd00::/8`) trusts nothing at all. It is reported separately: harmless
 * for security, but forward auth through that proxy cannot work.
 *
 * Kubernetes: the Helm chart's documented value is the router's pod CIDR
 * (`10.42.0.0/16`), and the chart requires a NetworkPolicy with forward auth, so
 * only the router pods reach the app. There the finding is informational, but
 * only while every wide range is private (RFC 1918 or 100.64.0.0/10, the ranges
 * pod networks use): `0.0.0.0/0` or a public range stays a warning.
 *
 * Pure: the parsing mirrors `buildTrustedProxyMatcher` in client-ip.ts, so an
 * entry is flagged exactly when that matcher would treat it as a range.
 */

/** IPv4 prefixes shorter than this are reported as too wide. */
export const MIN_TRUSTED_PROXY_PREFIX_V4 = 24;

export interface WideTrustedProxyRanges {
    /** IPv4 CIDR entries (verbatim) with a prefix shorter than /24. */
    wide: string[];
    /** Entries with a `/` that are not IPv4 CIDRs: IPv6 ranges, which match nothing. */
    unsupported: string[];
}

/** Same rules as client-ip.ts `ipv4ToInt`: dotted quad, each part 0..255; null otherwise. */
function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
        const b = Number(part);
        if (!Number.isInteger(b) || b < 0 || b > 255) return null;
        n = ((n << 8) | b) >>> 0;
    }
    return n;
}

/** Private ranges a pod network is allocated from: 10/8, 172.16/12, 192.168/16, 100.64/10. */
const PRIVATE_V4: ReadonlyArray<readonly [number, number]> = [
    [0x0a000000, 8],
    [0xac100000, 12],
    [0xc0a80000, 16],
    [0x64400000, 10],
];

/** Whether an IPv4 CIDR entry lies wholly inside one private range. */
function isPrivateRange(entry: string): boolean {
    const slash = entry.indexOf('/');
    const network = ipv4ToInt(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    if (network === null) return false;
    return PRIVATE_V4.some(([base, prefix]) => {
        if (bits < prefix) return false;
        const mask = (~0 << (32 - prefix)) >>> 0;
        return (network & mask) >>> 0 === base;
    });
}

/** Classify the range entries of a TRUSTED_PROXY_IPS value; null when nothing is flagged. */
export function findWideTrustedProxyRanges(
    trustedProxyIps: string | undefined,
): WideTrustedProxyRanges | null {
    const wide: string[] = [];
    const unsupported: string[] = [];
    for (const entry of (trustedProxyIps ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const slash = entry.indexOf('/');
        if (slash === -1) continue;
        const network = entry.slice(0, slash);
        const bits = Number(entry.slice(slash + 1));
        if (ipv4ToInt(network) !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
            if (bits < MIN_TRUSTED_PROXY_PREFIX_V4) wide.push(entry);
            continue;
        }
        if (network.includes(':')) unsupported.push(entry);
    }
    return wide.length > 0 || unsupported.length > 0 ? { wide, unsupported } : null;
}

export interface WideTrustedProxyRangeReport {
    /** `warn`; `info` on Kubernetes when every flagged entry is a private IPv4 range. */
    severity: 'warn' | 'info';
    message: string;
    remediation: string;
}

/**
 * Operator-facing text, shared by the security self-check, `npm run doctor`
 * and the boot log. Null when TRUSTED_PROXY_IPS has no flagged entry.
 */
export function describeWideTrustedProxyRanges(input: {
    trustedProxyIps: string | undefined;
    forwardAuthEnabled: boolean;
    kubernetes: boolean;
}): WideTrustedProxyRangeReport | null {
    const found = findWideTrustedProxyRanges(input.trustedProxyIps);
    if (!found) return null;
    const messages: string[] = [];
    const remediations: string[] = [];
    const kubernetesPodRange = input.kubernetes && found.wide.every(isPrivateRange);
    if (found.wide.length > 0) {
        messages.push(
            `TRUSTED_PROXY_IPS contains ${found.wide.join(', ')}, wider than /${MIN_TRUSTED_PROXY_PREFIX_V4}. ` +
                'Every device in that range can choose the client IP Lumastra sees, so per-IP rate limits and IP-bound tokens no longer tell clients apart.',
        );
        messages.push(
            input.forwardAuthEnabled
                ? 'FORWARD_AUTH_ENABLED is on, so any of those devices can also send the identity headers itself and sign in as any user, including an admin.'
                : 'If FORWARD_AUTH_ENABLED is turned on, any of those devices can also send the identity headers itself and sign in as any user.',
        );
        remediations.push(
            'List only the address of each reverse proxy. For a proxy in the same compose file, give it a fixed IP on the compose network and list that IP instead of the subnet.',
        );
        if (kubernetesPodRange) {
            remediations.push(
                "On Kubernetes, the router's pod CIDR is acceptable when a NetworkPolicy admits only the router pods to the app.",
            );
        }
    }
    if (found.unsupported.length > 0) {
        messages.push(
            `TRUSTED_PROXY_IPS contains ${found.unsupported.join(', ')}. IPv6 ranges are not supported, so ${found.unsupported.length === 1 ? 'this entry matches' : 'these entries match'} no address.`,
        );
        remediations.push('List each IPv6 proxy as an exact address.');
    }
    const severity = kubernetesPodRange && found.unsupported.length === 0 ? 'info' : 'warn';
    return { severity, message: messages.join(' '), remediation: remediations.join(' ') };
}

/** Whether this process runs in a Kubernetes pod (the kubelet sets this for every container). */
export function runsOnKubernetes(env: Record<string, string | undefined> = process.env): boolean {
    return (env.KUBERNETES_SERVICE_HOST ?? '').trim().length > 0;
}
