// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Does the Live TV proxy need an update? Compares a proxy heartbeat with this app.
 *
 * The proxy runs on its own pinned image (a restart drops every live channel), so after
 * an app update it can lag behind. Two signals, both in the proxy heartbeat:
 *
 * - `proxyProtocol`: the app↔proxy contract (src/shared/livetv-proxy-protocol.ts).
 *   Below LIVETV_PROXY_MIN_PROTOCOL the two do not work together: 'incompatible',
 *   raised on the attention board too. Above LIVETV_PROXY_PROTOCOL (app rolled back):
 *   'update'.
 * - `proxyBuild`: hash of the proxy code (scripts/livetv-proxy-inputs.mjs), compared
 *   with the id this app's image was built with. Different ids mean the proxy changed
 *   since the proxy image was pinned: 'update'.
 *
 * Proxies built before these fields existed report neither: protocol 0, build unknown.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    LIVETV_PROXY_BUILD_FILE,
    LIVETV_PROXY_PROTOCOL,
} from '../../../../shared/livetv-proxy-protocol.js';

/**
 * Oldest proxy protocol this app still works with. 0 = proxies that predate the field.
 * Raise it together with LIVETV_PROXY_PROTOCOL when a contract change breaks old proxies.
 */
export const LIVETV_PROXY_MIN_PROTOCOL = 0;

export type ProxyCompatState = 'current' | 'update' | 'incompatible' | 'unchecked';

export type ProxyCompatReason =
    /** The proxy speaks a protocol older than this app accepts. */
    | 'protocol_too_old'
    /** The proxy speaks a newer protocol than this app (the app was rolled back); 'update'. */
    | 'protocol_too_new'
    /** The proxy code differs from the code in this app's image. */
    | 'build_differs'
    /** The proxy predates build ids, so whether it changed is unknown. */
    | 'build_unknown';

export interface ProxyCompat {
    state: ProxyCompatState;
    reason?: ProxyCompatReason;
    /** Protocol the proxy reported (0 when absent). */
    proxyProtocol: number;
}

export interface ProxyHeartbeatFields {
    proxyProtocol?: number;
    proxyBuild?: string;
}

export interface AppProxyExpectation {
    protocol: number;
    minProtocol: number;
    /** Proxy build id of this app's image; undefined outside a built image (dev). */
    build: string | undefined;
}

/** The decision. Pure, so the cluster API and the attention board agree. */
export function decideProxyCompat(
    proxy: ProxyHeartbeatFields,
    app: AppProxyExpectation,
): ProxyCompat {
    const proxyProtocol = proxy.proxyProtocol ?? 0;
    if (proxyProtocol < app.minProtocol) {
        return { state: 'incompatible', reason: 'protocol_too_old', proxyProtocol };
    }
    // Newer than the app (the app was rolled back): a bump may be additive, so this is
    // an update notice, not an alert.
    if (proxyProtocol > app.protocol) {
        return { state: 'update', reason: 'protocol_too_new', proxyProtocol };
    }
    // Running from source (no build id of our own): nothing to compare with.
    if (!app.build) return { state: 'unchecked', proxyProtocol };
    if (!proxy.proxyBuild) return { state: 'update', reason: 'build_unknown', proxyProtocol };
    if (proxy.proxyBuild !== app.build) {
        return { state: 'update', reason: 'build_differs', proxyProtocol };
    }
    return { state: 'current', proxyProtocol };
}

/** Proxy build id from a build-id file; undefined when missing or garbled. */
export function readProxyBuildFile(file: string): string | undefined {
    try {
        const id = fs.readFileSync(file, 'utf8').trim();
        return /^[0-9a-f]{16}$/.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
}

let appBuild: string | undefined;

/**
 * What this app expects of its proxy. The build id is the file `npm run build:proxy`
 * wrote into build/ of this image (the app runs from the image root, /app). A missing
 * file is read again next time rather than cached.
 */
export function appProxyExpectation(): AppProxyExpectation {
    appBuild ??= readProxyBuildFile(path.join(process.cwd(), 'build', LIVETV_PROXY_BUILD_FILE));
    return {
        protocol: LIVETV_PROXY_PROTOCOL,
        minProtocol: LIVETV_PROXY_MIN_PROTOCOL,
        build: appBuild,
    };
}
