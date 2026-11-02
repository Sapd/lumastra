// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seam between "decide what to push" and "hand it to Apple".
 *
 * Two implementations exist: `RelayTransport` (posts to the
 * Lumastra-operated relay, which holds Apple's signing key) and
 * `DirectApnsTransport` (operator BYO `.p8`, selectable today). The delivery
 * pass knows only this interface.
 *
 * @module services/push/push-transport
 */

import type { ApnsPayload } from './push-payload.js';

/** Per-token outcome. `gone`/`unregistered` mean stop using this token. */
export type PushTokenStatus = 'ok' | 'gone' | 'unregistered' | 'invalid' | 'failed';

export interface PushResult {
    token: string;
    status: PushTokenStatus;
}

export interface PushRequest {
    bundleId: string;
    environment: 'sandbox' | 'production';
    /** APNs collapse id — the notification uuid, so retries coalesce on-device. */
    collapseId: string;
    /** Absolute UNIX epoch SECONDS, UTC. Not a duration. */
    expirationEpochSeconds: number;
    tokens: string[];
    payload: ApnsPayload;
}

/**
 * Whole-call failure, as distinct from a per-token result.
 *
 * `kind` is what the delivery pass switches on to decide the row's fate:
 * `unauthenticated` is refresh-and-retry-once, `no_credential`, `not_entitled`
 * and `invalid` are dead-immediately, `throttled` honours `retryAfterSeconds`,
 * `transient` takes the ladder.
 *
 * `no_credential` is separate from `unauthenticated` on purpose. The latter is
 * "the relay rejected what we sent" — plausibly transient (a token that expired
 * a minute before a refresh was due). The former is "this install has no
 * credential to send", a permanent fact about its configuration that no number
 * of retries changes. Collapsing the two makes a misconfigured install spend
 * the whole ladder and then report `max_attempts`, which reads as a relay
 * outage and sends the operator looking in the wrong place.
 */
export class PushTransportError extends Error {
    constructor(
        message: string,
        public readonly kind:
            | 'unauthenticated'
            | 'no_credential'
            | 'not_entitled'
            | 'throttled'
            | 'transient'
            | 'invalid',
        public readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'PushTransportError';
    }
}

export interface PushTransport {
    send(req: PushRequest): Promise<PushResult[]>;
}
