// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * APNs status + `reason` → `PushTokenStatus`.
 *
 * Apple returns `200` with an empty body on success and a JSON body
 * `{"reason": "..."}` on failure. The mapping's job is to tell the delivery
 * pass three different things:
 *
 * - **stop using this token** (`gone` / `unregistered`) — the device is
 *   unreachable forever
 * - **this will never work as sent** (`invalid`) — permanent, do not retry
 * - **try again later** (`failed`) — the retry ladder takes it
 *
 * Getting the second and third confused is the expensive mistake in both
 * directions: a permanent failure classed `failed` burns the whole ladder and
 * reports `max_attempts`, which reads as an Apple outage; a transient failure
 * classed `invalid` throws the notification away on the first blip.
 *
 * @module services/push/apns-reason-map
 */

import type { PushTokenStatus } from './push-transport.js';

export type ApnsOutcome =
    | { kind: 'result'; status: PushTokenStatus }
    /** `403 ExpiredProviderToken` — re-mint the JWT and retry this token once. */
    | { kind: 'remint-and-retry' };

/**
 * Permanently unusable *as addressed*. The token is well-formed but not
 * deliverable for this topic/environment, or the request itself is malformed.
 *
 * `BadDeviceToken` is the one worth calling out: it is also what Apple returns
 * when a perfectly live production token is sent to the sandbox host (and vice
 * versa), so it is indistinguishable from a genuinely dead device. That is why
 * environment routing is a property of the request we build rather than
 * something diagnosed from the response.
 */
const INVALID_REASONS: ReadonlySet<string> = new Set([
    'BadDeviceToken',
    'DeviceTokenNotForTopic',
    'BadTopic',
    'TopicDisallowed',
    'BadCollapseId',
    'BadExpirationDate',
    'BadMessageId',
    'BadPriority',
    'BadPushType',
    'MissingDeviceToken',
    'MissingTopic',
    'PayloadEmpty',
    'PayloadTooLarge',
    'InvalidPushType',
    'DuplicateHeaders',
]);

/** Retryable: the ladder should have another go. */
const FAILED_REASONS: ReadonlySet<string> = new Set([
    'TooManyRequests',
    'TooManyProviderTokenUpdates',
    'ServiceUnavailable',
    'Shutdown',
    'InternalServerError',
    'IdleTimeout',
]);

export function mapApnsResponse(statusCode: number, reason: string | undefined): ApnsOutcome {
    if (statusCode === 200) return { kind: 'result', status: 'ok' };

    // 410 is Apple saying the device is gone for good.
    //
    // `PushTokenStatus` carries both `gone` and `unregistered` and the delivery
    // pass acts on them identically — deactivate the token, record the status
    // as the reason. They are kept apart here anyway because that recorded
    // reason is what an operator reads out of `deactivation_reason` months
    // later, and "Apple said Unregistered" is a different story from "Apple
    // returned 410 without telling us why". The relay collapses both to `gone`
    // because its wire contract is an API boundary; here the producer and the
    // consumer are the same process, so the fidelity is free.
    if (statusCode === 410) {
        return { kind: 'result', status: reason === 'Unregistered' ? 'unregistered' : 'gone' };
    }

    if (statusCode === 403 && reason === 'ExpiredProviderToken') {
        return { kind: 'remint-and-retry' };
    }

    // Any other 403 (`InvalidProviderToken`, `MissingProviderToken`) is a
    // signing-key fault, not a token fault. It is not going to fix itself, but
    // classing it `invalid` would discard the notification on the spot; the
    // ladder gives the operator ~21 minutes to correct the key, and the log
    // line says which one it was.
    if (statusCode === 403) return { kind: 'result', status: 'failed' };

    if (statusCode === 429 || statusCode >= 500) {
        return { kind: 'result', status: 'failed' };
    }

    if (reason !== undefined) {
        if (INVALID_REASONS.has(reason)) return { kind: 'result', status: 'invalid' };
        if (FAILED_REASONS.has(reason)) return { kind: 'result', status: 'failed' };
    }

    // A 400 with a reason we do not recognise is still a 400: Apple is telling
    // us the request is wrong, and sending the identical request again cannot
    // make it right.
    if (statusCode === 400) return { kind: 'result', status: 'invalid' };

    // Anything else unrecognised takes the ladder rather than being discarded.
    return { kind: 'result', status: 'failed' };
}

/** Pull `reason` out of an APNs error body, tolerating an empty or odd one. */
export function parseApnsReason(body: string): string | undefined {
    if (!body) return undefined;
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const reason = (parsed as Record<string, unknown>).reason;
            if (typeof reason === 'string' && reason.length > 0 && reason.length <= 100) {
                return reason;
            }
        }
    } catch {
        // Not JSON. Apple always sends JSON on failure, so this means a proxy
        // or a captive portal answered instead — nothing to extract.
    }
    return undefined;
}
