// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operator's own Apple signing key: read, normalised, and proved usable
 * before anything tries to push with it.
 *
 * Everything here is checkable without contacting Apple — that the bytes are a
 * PKCS#8 PEM, that they parse, that the curve is the P-256 ES256 requires.
 * Whether Apple *recognises* the key id and team id is only ever observable
 * from a real APNs response, so those are shape-checked and no more.
 *
 * Inline keys are validated before saving. File paths are syntax-checked on save;
 * the push sender validates the mounted file for delivery or capabilities. A key that only fails at delivery time produces an outbox row
 * riding the whole retry ladder and dying `max_attempts`, which reads to an
 * operator as an Apple outage rather than as their own truncated paste.
 *
 * @module services/push/apns-credential
 */

import * as m from '$lib/paraglide/messages';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('ApnsCredential');

export interface ApnsCredential {
    /** PKCS#8 PEM contents of the `.p8`. Never logged, never returned to a client. */
    keyP8: string;
    keyId: string;
    teamId: string;
}

/**
 * Three states, deliberately distinct.
 *
 * `absent` means "this install did not configure a signing key" — a normal
 * configuration, and the reason the selector falls back to the relay.
 * `invalid` means "it configured one and it cannot be used", which is an
 * operator error that must be shouted about rather than quietly downgraded:
 * silently using the relay instead would leave the operator believing their
 * `.p8` is in service.
 */
export type ApnsCredentialState =
    | { kind: 'absent' }
    | { kind: 'invalid'; reason: string }
    | { kind: 'ready'; credential: ApnsCredential };

/** Apple key and team identifiers are exactly ten uppercase ASCII characters. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;

interface RawInputs {
    inline: string;
    path: string;
    keyId: string;
    teamId: string;
}

/**
 * Read one setting as a trimmed string, tolerating a key that is not there.
 *
 * `config` is a getter object in production and always answers with a string,
 * but plenty of suites replace it with a hand-written partial object listing
 * only the keys that suite cares about. This module is reached from the task
 * orchestrator's construction path, so a bare `.trim()` on a key such a mock
 * omits turns "this install configured no Apple key" — which is the truth, and
 * the common case — into a load-time TypeError for the whole suite.
 */
function setting(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readInputs(values: Record<string, unknown> = config): RawInputs {
    return {
        inline: setting(values.APNS_KEY_P8),
        path: setting(values.APNS_KEY_P8_PATH),
        keyId: setting(values.APNS_KEY_ID).toUpperCase(),
        teamId: setting(values.APNS_TEAM_ID).toUpperCase(),
    };
}

/**
 * Whether the operator has *attempted* to configure a direct signing key.
 *
 * Deliberately cheap and deliberately not a validity check: this is what the
 * selector uses to decide the operator's intent. An install that pasted a
 * broken `.p8` wanted the direct transport, and must be told its key is broken
 * rather than silently routed to a relay it never configured.
 */
export function apnsSigningKeyConfigured(): boolean {
    const { inline, path, keyId, teamId } = readInputs();
    return inline !== '' || path !== '' || keyId !== '' || teamId !== '';
}

let cache: { inputs: RawInputs; state: ApnsCredentialState } | null = null;
let loggedInvalidReason: string | null = null;

/**
 * The resolved credential, memoised against the exact configuration that
 * produced it.
 *
 * Memoised because the capabilities endpoint calls this on every request and
 * the alternative is a `readFileSync` plus an EC key parse per call. Keyed on
 * the raw inputs rather than time, so an admin editing the key in the UI takes
 * effect immediately (ConfigService getters are live). A key *file* whose
 * contents change without the path changing is NOT picked up — rotating a
 * mounted key needs a restart, which is also when `requiresRestart` on those
 * settings tells the operator to do it.
 */
export function getApnsCredential(): ApnsCredentialState {
    const inputs = readInputs();
    if (cache && sameInputs(cache.inputs, inputs)) return cache.state;

    const state = resolve(inputs);
    cache = { inputs, state };

    if (state.kind === 'invalid' && loggedInvalidReason !== state.reason) {
        loggedInvalidReason = state.reason;
        // error, not warn: an install in this state cannot deliver a single
        // notification, and nothing else in the system will say so louder.
        log.error('APNs signing key is configured but unusable', { reason: state.reason });
    }
    if (state.kind === 'ready') loggedInvalidReason = null;

    return state;
}

/** Whether a direct push could actually be signed right now. */
export function hasUsableApnsCredential(): boolean {
    return getApnsCredential().kind === 'ready';
}

/** Drops the memo. Tests only — production config changes are picked up by key. */
export function _resetApnsCredentialCache(): void {
    cache = null;
    loggedInvalidReason = null;
}

function sameInputs(a: RawInputs, b: RawInputs): boolean {
    return (
        a.inline === b.inline && a.path === b.path && a.keyId === b.keyId && a.teamId === b.teamId
    );
}

/** Validate the effective candidate configuration without saving or logging secrets. */
export function validateApnsCredential(values: Record<string, unknown>): ApnsCredentialState {
    return resolve(readInputs(values));
}

/** Only this credential-free projection may enter settings-page data. */
export type ApnsAdminStatus =
    { kind: 'absent' | 'ready' } | { kind: 'invalid' | 'warning'; reason: string };

/** A file may only be mounted in the push worker. Saving never opens that file. */
export function validateApnsSettings(values: Record<string, unknown>): ApnsAdminStatus {
    const inputs = readInputs(values);
    const reason = inputError(inputs);
    if (reason) return { kind: 'invalid', reason };
    if (inputs.path) return { kind: 'warning', reason: m.apns_path_sender_validation() };
    const state = resolve(inputs);
    return state.kind === 'invalid' ? state : { kind: state.kind };
}

export function apnsAdminStatus(values: Record<string, unknown>): ApnsAdminStatus {
    const candidate = validateApnsSettings(values);
    if (candidate.kind !== 'warning') return candidate;
    // Local readability is useful diagnostic information, never a save gate or
    // proof of the worker's state. The sender resolves and validates its own mount.
    const local = validateApnsCredential(values);
    return local.kind === 'invalid'
        ? { kind: 'warning', reason: `${local.reason} ${candidate.reason}` }
        : candidate;
}

function inputError({ inline, path, keyId, teamId }: RawInputs): string | null {
    if (!inline && !path && !keyId && !teamId) return null;
    if (inline && path) return m.apns_sources_conflict();
    if (!inline && !path) return m.apns_key_missing();
    const idError = appleIdError('APNS_KEY_ID', keyId) || appleIdError('APNS_TEAM_ID', teamId);
    if (idError) return idError;
    if (
        path &&
        (!isAbsolute(path) ||
            Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    ) {
        return m.apns_path_invalid();
    }
    return null;
}

function resolve(inputs: RawInputs): ApnsCredentialState {
    const { inline, path, keyId, teamId } = inputs;
    if (!inline && !path && !keyId && !teamId) return { kind: 'absent' };
    const reason = inputError(inputs);
    if (reason) return { kind: 'invalid', reason };

    let pem: string;
    if (inline !== '') {
        // Secret managers and compose files routinely flatten newlines to the
        // two-character sequence `\n`. PEM without real newlines does not
        // parse, and OpenSSL's complaint names neither the variable nor the
        // cause, so normalise before validating.
        pem = inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
    } else {
        try {
            pem = readFileSync(path, 'utf8');
        } catch {
            return {
                kind: 'invalid',
                reason: m.apns_path_unreadable(),
            };
        }
    }

    if (!pem.includes('-----BEGIN PRIVATE KEY-----')) {
        return {
            kind: 'invalid',
            reason: m.apns_pem_invalid(),
        };
    }

    let parsed: ReturnType<typeof createPrivateKey>;
    try {
        parsed = createPrivateKey(pem);
    } catch {
        return {
            kind: 'invalid',
            reason: m.apns_parse_invalid(),
        };
    }
    if (parsed.asymmetricKeyType !== 'ec') {
        return {
            kind: 'invalid',
            reason: m.apns_type_invalid(),
        };
    }
    const curve = parsed.asymmetricKeyDetails?.namedCurve;
    if (curve !== undefined && curve !== 'prime256v1') {
        return {
            kind: 'invalid',
            reason: m.apns_curve_invalid(),
        };
    }

    return { kind: 'ready', credential: { keyP8: pem, keyId, teamId } };
}

function appleIdError(name: string, value: string): string | null {
    if (value === '') return m.apns_id_required({ name });
    if (!APPLE_ID_RE.test(value)) return m.apns_id_invalid({ name });
    return null;
}
