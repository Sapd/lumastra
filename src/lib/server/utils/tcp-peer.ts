// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';

interface NodeRequestPlatform {
    req?: { socket?: { remoteAddress?: string } };
}

/**
 * adapter-node exposes the original IncomingMessage as platform.req. Unlike
 * getClientAddress(), its socket peer is unaffected by ADDRESS_HEADER/XFF_DEPTH.
 * Other adapters may use getClientAddress only when no address header is set.
 * An unavailable peer is empty, never an address that an allowlist could trust.
 */
export function getTcpPeer(event: RequestEvent): string {
    const platform = event.platform as NodeRequestPlatform | undefined;
    if (platform?.req) return platform.req.socket?.remoteAddress ?? '';
    if (process.env.ADDRESS_HEADER) return '';
    try {
        return event.getClientAddress() || '';
    } catch {
        return '';
    }
}
