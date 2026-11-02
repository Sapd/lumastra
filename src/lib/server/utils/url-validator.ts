// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SSRF-safe URL validator.
 *
 * Validates externally-supplied URLs by checking scheme, resolving DNS,
 * and blocking private IP ranges. General-purpose utility — not LiveTV-specific.
 *
 * TOCTOU WARNING: DNS can change between validation and the actual request.
 * To prevent DNS rebinding, callers MUST connect to `resolvedIp` rather than
 * re-resolving the hostname: pass `{ url, resolvedIp }` to `pinnedFetch`
 * (utils/ssrf-guard.ts), which pins in the transport. Do NOT swap the hostname
 * for the IP and send a `Host` header — fetch() drops a caller-set Host, so a
 * name-based virtual host sees `Host: <ip>`.
 */

import * as m from '$lib/paraglide/messages.js';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { isPrivateIP } from '../../../shared/ip-classification.js';

export interface UrlValidationOptions {
    allowPrivateIps?: boolean;
}

export type UrlValidationResult =
    { valid: true; resolvedUrl: string; resolvedIp: string } | { valid: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Shared with the pinned transport and webhook guards. */
export const isPrivateIp = isPrivateIP;

export async function validateUrl(
    url: string,
    options?: UrlValidationOptions,
): Promise<UrlValidationResult> {
    if (!url) {
        return { valid: false, reason: 'URL is empty' };
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // best-effort: malformed URL is a validation failure, returned as a result.
        return { valid: false, reason: 'Invalid URL format' };
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return {
            valid: false,
            reason: `Invalid scheme: ${parsed.protocol} — only http: and https: are allowed`,
        };
    }

    // Strip IPv6 brackets — new URL('http://[::1]/').hostname returns '[::1]'
    const rawHostname = parsed.hostname;
    const hostname =
        rawHostname.startsWith('[') && rawHostname.endsWith(']')
            ? rawHostname.slice(1, -1)
            : rawHostname;
    const allowPrivate = options?.allowPrivateIps ?? false;

    // IP-literal hostname — no DNS needed
    if (isIP(hostname)) {
        if (!allowPrivate && isPrivateIp(hostname)) {
            return {
                valid: false,
                reason: m.livetv_admin_private_url_blocked(),
            };
        }
        return {
            valid: true,
            resolvedUrl: url,
            resolvedIp: hostname,
        };
    }

    // Hostname — resolve DNS
    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await dns.lookup(hostname, { all: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            valid: false,
            reason: `DNS resolution failed for ${hostname}: ${message}`,
        };
    }

    if (addresses.length === 0) {
        return {
            valid: false,
            reason: `DNS resolution returned no addresses for ${hostname}`,
        };
    }

    if (!allowPrivate) {
        for (const { address } of addresses) {
            if (isPrivateIp(address)) {
                return {
                    valid: false,
                    reason: m.livetv_admin_private_url_blocked(),
                };
            }
        }
    }

    // Prefer IPv4, like resolveSafePublicUrl: callers pin the connection to this
    // one address, and a dead AAAA record (common on hosts with no IPv6 route)
    // would otherwise fail every fetch.
    const preferred = addresses.find((a) => a.family === 4) ?? addresses[0];
    return {
        valid: true,
        resolvedUrl: url,
        resolvedIp: preferred.address,
    };
}
