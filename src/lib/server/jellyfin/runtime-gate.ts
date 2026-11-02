// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One gate for every Jellyfin network call made OUTSIDE the axios client.
 *
 * The axios client (base-client.ts) already fast-fails through the circuit
 * breaker, but the image proxy and the avatar path call Jellyfin with plain
 * `fetchWithTimeout`, which knew nothing about the breaker: a stopped Jellyfin
 * that was still configured cost a full fetch timeout per uncached image. And
 * URL + key being set is not consent — an admin who turned Jellyfin sync off
 * (typically on the way to removing the server) must see no traffic at all.
 */

import { features } from '../config.js';
import { connectionStatus } from '../services/connection-status.service.js';
import { circuitBreaker } from './base-client.js';
import { FetchRedirectError } from '../utils/fetch-utils.js';

/** Timeout for direct (non-axios) Jellyfin fetches; a healthy Jellyfin answers in well under a second. */
export const JELLYFIN_DIRECT_FETCH_TIMEOUT_MS = 2_500;

/** Static half of the gate: sync on and credentials present. Safe for cache keys. */
export function isJellyfinSyncEnabled(): boolean {
    return features.jellyfinSync;
}

/**
 * True only when a runtime Jellyfin call may go out right now: sync on,
 * connection status `connected`, and the circuit breaker not fast-failing.
 */
export function canCallJellyfin(): boolean {
    return (
        features.jellyfinSync &&
        connectionStatus.isJellyfinAvailable() &&
        circuitBreaker.shouldAllowRequest()
    );
}

/**
 * Feed a transport failure (timeout, refused connection) of a direct fetch into
 * the shared breaker, mirroring the axios interceptor, so image traffic alone
 * can open it and flip the connection status (which starts the reconnect loop).
 */
export function recordJellyfinTransportFailure(error: unknown): void {
    // A refused off-origin redirect is a config/security fact, not "server down".
    if (error instanceof FetchRedirectError) return;
    circuitBreaker.recordFailure();
    if (circuitBreaker.isOpen && connectionStatus.isJellyfinAvailable()) {
        connectionStatus.setDisconnected(
            'jellyfin',
            `Circuit breaker opened after ${circuitBreaker.failureCount} failures`,
        );
    }
}

/** Any HTTP answer proves the server is up. */
export function recordJellyfinTransportSuccess(): void {
    circuitBreaker.recordSuccess();
}
