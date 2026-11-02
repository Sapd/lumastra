// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which `PushTransport` this install delivers through.
 *
 * The delivery pass used to construct `RelayTransport` unconditionally, which
 * made `DirectApnsTransport` unreachable no matter what an operator configured.
 * The choice lives here rather than inline in `orchestrator.ts` because it is a
 * rule with cases worth testing on their own, and the orchestrator is already
 * one of the largest files in the tree.
 *
 * The rule:
 *
 * | `PUSH_TRANSPORT` | signing key configured | transport |
 * | --- | --- | --- |
 * | `auto` (default) | yes | direct |
 * | `auto` | no | relay |
 * | `direct` | — | direct |
 * | `relay` | — | relay |
 *
 * "Signing key configured" means the operator *attempted* one, not that it
 * parses. A broken `.p8` still selects direct and reports its own breakage: an
 * install that pasted a key and got relay delivery instead would believe its
 * key was in service, and the relay credential it never set would be the thing
 * that failed.
 *
 * @module services/push/push-transport-selector
 */

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { apnsSigningKeyConfigured, getApnsCredential } from './apns-credential.js';
import { DirectApnsTransport } from './direct-apns-transport.js';
import { RelayTransport } from './relay-transport.js';
import { hasRelayCredential, relayTokenNeedsRenewal } from './relay-token.store.js';
import {
    PushTransportError,
    type PushRequest,
    type PushResult,
    type PushTransport,
} from './push-transport.js';

const log = Logger.for('PushTransportSelector');

export type PushTransportKind = 'direct' | 'relay';

export interface PushTransportSelection {
    kind: PushTransportKind;
    /** Why, for the startup log line. Not operator copy. */
    reason: 'explicit-override' | 'signing-key-configured' | 'no-signing-key';
}

/**
 * The rule as a pure function, so every combination is testable without
 * touching config, undici, or the relay token store.
 */
export function selectPushTransportKind(input: {
    override: 'auto' | 'direct' | 'relay';
    apnsKeyConfigured: boolean;
}): PushTransportSelection {
    if (input.override !== 'auto') {
        return { kind: input.override, reason: 'explicit-override' };
    }
    return input.apnsKeyConfigured
        ? { kind: 'direct', reason: 'signing-key-configured' }
        : { kind: 'relay', reason: 'no-signing-key' };
}

/** The selection this install's configuration produces. */
export function currentPushTransportSelection(): PushTransportSelection {
    return selectPushTransportKind({
        // Normalised rather than read straight through: an unrecognised value
        // must mean `auto`, not "no transport". `config.PUSH_TRANSPORT` is a
        // validated enum getter in production, but this module is reached from
        // the orchestrator's construction path and several suites replace
        // `config` with a partial object that omits the key entirely.
        override: normaliseOverride(config.PUSH_TRANSPORT),
        apnsKeyConfigured: apnsSigningKeyConfigured(),
    });
}

function normaliseOverride(value: unknown): 'auto' | 'direct' | 'relay' {
    return value === 'direct' || value === 'relay' ? value : 'auto';
}

/**
 * Whether push can actually be delivered — the credential belonging to the
 * transport that will be used, not "some credential exists somewhere".
 *
 * An install with a broken `.p8` and a working relay token has a usable
 * credential in the loosest sense and still cannot deliver one notification,
 * because the selector routes it to the direct transport. Advertising push as
 * available there is exactly the failure the capabilities check exists to
 * prevent (it burns the single notification-permission prompt iOS grants).
 */
export function hasUsablePushCredential(): boolean {
    return currentPushTransportSelection().kind === 'direct'
        ? getApnsCredential().kind === 'ready'
        : hasRelayCredential();
}

/**
 * Whether the licence refresh should fetch a licence-minted relay token now:
 * push is on, delivery goes through the relay, no operator `PUSH_RELAY_TOKEN`
 * is configured, and the held token is missing or due for renewal.
 *
 * Push off, or the operator's own Apple key in use, means no relay token is
 * ever requested — the install then makes no relay-driven call to the
 * licensing server at all.
 */
export function wantsLicenceMintedRelayToken(now: number = Date.now()): boolean {
    if (!config.FEATURE_PUSH_NOTIFICATIONS) return false;
    if (currentPushTransportSelection().kind !== 'relay') return false;
    return relayTokenNeedsRenewal(now);
}

/**
 * A transport for an install that selected direct with an unusable key.
 *
 * `no_credential` rather than `transient` on purpose: `push-outbox.ts` dies the
 * row immediately on that kind instead of spending the whole ladder and then
 * reporting `max_attempts`, which would read as an Apple outage and send the
 * operator looking in the wrong place. The reason string is the validator's,
 * so the admin view names the actual fault.
 */
class MisconfiguredApnsTransport implements PushTransport {
    constructor(private readonly reason: string) {}

    send(_req: PushRequest): Promise<PushResult[]> {
        return Promise.reject(
            new PushTransportError(`APNs signing key is unusable: ${this.reason}`, 'no_credential'),
        );
    }
}

/**
 * Build the transport for this install.
 *
 * Called once, at worker startup. A misconfigured signing key is reported here
 * — loudly, at error level, with the specific fault — rather than deferred to
 * the first push; it does NOT throw, because the alternative is a typo in an
 * optional notification setting taking the whole task orchestrator down with
 * it.
 */
export function createPushTransport(): PushTransport {
    const selection = currentPushTransportSelection();

    if (selection.kind === 'relay') {
        log.info('push delivery uses the relay', { reason: selection.reason });
        return new RelayTransport();
    }

    const credential = getApnsCredential();
    if (credential.kind !== 'ready') {
        const reason =
            credential.kind === 'invalid'
                ? credential.reason
                : 'no signing key is configured (PUSH_TRANSPORT=direct was set without one)';
        log.error('push delivery selected the direct APNs transport but cannot sign', { reason });
        return new MisconfiguredApnsTransport(reason);
    }

    log.info('push delivery goes directly to Apple with the operator signing key', {
        reason: selection.reason,
        keyId: credential.credential.keyId,
        teamId: credential.credential.teamId,
    });
    return new DirectApnsTransport({ credential: credential.credential });
}

/**
 * The transport the push outbox holds for its whole life. It resolves the real
 * transport per send and rebuilds it when PUSH_TRANSPORT or the APNs signing
 * key settings change (the credential memo hands back a new state object
 * then), closing a replaced direct transport's connection pool. A single
 * {@link createPushTransport} call at worker start used to freeze the choice
 * and the key until a restart — while the outbox re-read the transport KIND
 * per tick, so the two could disagree after a save.
 *
 * Resolved once immediately, so a misconfigured key is still reported at
 * startup.
 */
export function createLivePushTransport(): PushTransport {
    let current: { kind: string; credential: unknown; transport: PushTransport } | null = null;

    const resolveTransport = (): PushTransport => {
        const selection = currentPushTransportSelection();
        const credential = selection.kind === 'relay' ? null : getApnsCredential();
        if (current && current.kind === selection.kind && current.credential === credential) {
            return current.transport;
        }
        const previous = current?.transport;
        current = { kind: selection.kind, credential, transport: createPushTransport() };
        if (previous instanceof DirectApnsTransport) {
            void previous.close().catch((err: unknown) => {
                log.warn('closing the replaced APNs transport failed', { err: String(err) });
            });
        }
        return current.transport;
    };

    resolveTransport();
    return { send: (req) => resolveTransport().send(req) };
}
