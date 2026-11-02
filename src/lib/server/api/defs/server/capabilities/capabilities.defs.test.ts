// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Exercises the shared push advertisement with real credential validation. */

vi.mock('$lib/server/server-branding.js', () => ({ getServerFeatures: async () => ({}) }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const flags = {
    push: true,
    deviceAuth: true,
    relayToken: 'relay-token-abc',
    /** PKCS#8 PEM of an operator's own Apple key, or '' for the relay-only case. */
    apnsKeyP8: '',
};
const entitlements = { modules: new Set<string>(['push']) };

/** A throwaway P-256 key in the shape Apple ships a `.p8`. Never a real key. */
function testSigningKey(): string {
    return generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
}

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get FEATURE_PUSH_NOTIFICATIONS() {
                return flags.push;
            },
            get FEATURE_DEVICE_AUTH() {
                return flags.deviceAuth;
            },
            // The real store reads this getter, so driving it here exercises
            // `hasRelayCredential()` for real rather than mocking it away.
            get PUSH_RELAY_TOKEN() {
                return flags.relayToken;
            },
            // Same idea for the direct route: driving the real getters runs the
            // real credential validator and the real transport selector.
            get PUSH_TRANSPORT() {
                return 'auto' as const;
            },
            get APNS_KEY_P8() {
                return flags.apnsKeyP8;
            },
            get APNS_KEY_P8_PATH() {
                return '';
            },
            get APNS_KEY_ID() {
                return flags.apnsKeyP8 ? 'ABCDE12345' : '';
            },
            get APNS_TEAM_ID() {
                return flags.apnsKeyP8 ? 'TEAM123456' : '';
            },
        },
    };
});

vi.mock('$lib/server/licensing/entitlements.js', () => ({
    getEffectiveEntitlements: async () => entitlements,
}));

// Avoids a real DB round-trip from `hasMusicLibrary()` — irrelevant to the
// push capability under test, and the working tree's DATABASE_URL points at
// a local dev Postgres that may not be running.
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue(null),
}));

import { computePushCapability } from '../capabilities.js';
import { _resetApnsCredentialCache } from '$lib/server/services/push/apns-credential.js';
async function callCapabilities(): Promise<{
    push: Awaited<ReturnType<typeof computePushCapability>>;
}> {
    return { push: await computePushCapability() };
}

describe('capabilities.push', () => {
    beforeEach(() => {
        flags.push = true;
        flags.deviceAuth = true;
        flags.relayToken = 'relay-token-abc';
        flags.apnsKeyP8 = '';
        entitlements.modules = new Set(['push']);
        // The credential resolver memoises against its inputs; these tests swap
        // those inputs behind a getter, so the memo has to go with them.
        _resetApnsCredentialCache();
    });

    it('is available when flag, entitlement and device auth are all on', async () => {
        const body = await callCapabilities();
        expect(body.push).toEqual({ available: true });
    });

    it('is unavailable with a reason when the feature flag is off', async () => {
        flags.push = false;
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('feature_disabled');
    });

    it('is unavailable when DEVICE_AUTH is off, because registration rides device routes', async () => {
        flags.deviceAuth = false;
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('device_auth_disabled');
    });

    it('is unavailable when the push entitlement is absent', async () => {
        entitlements.modules = new Set([]);
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('not_entitled');
    });

    // The four cases above each toggle exactly one condition, so they cannot
    // distinguish "checked in order" from "ANDed in any order" — the reason
    // is unambiguous only because a single condition fails per test. These
    // two combine multiple failing conditions to pin the actual check order
    // (feature flag -> device auth -> entitlement): if the checks were ever
    // reordered, one of these would report the wrong reason while the four
    // single-condition cases above kept passing.
    it('reports feature_disabled when both the flag and the entitlement are off', async () => {
        flags.push = false;
        entitlements.modules = new Set([]);
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('feature_disabled');
    });

    it('reports device_auth_disabled when both device auth and the entitlement are off', async () => {
        flags.deviceAuth = false;
        entitlements.modules = new Set([]);
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('device_auth_disabled');
    });

    // The regression this endpoint exists to prevent. With licence enforcement
    // off — the default in every build shipped so far — the entitlement
    // resolver hands back UNLIMITED_ENTITLEMENTS, which CONTAINS 'push', while
    // the licence refresh that mints the relay token never runs. So an install
    // in exactly the default state passed all three earlier checks, answered
    // `available: true`, and could not deliver a single push: the client would
    // burn the one notification-permission prompt iOS grants and every row
    // would die reading `max_attempts`.
    it('is unavailable when the install holds no relay credential', async () => {
        flags.relayToken = '';
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('no_relay_credential');
    });

    it('treats a whitespace-only relay token as no credential', async () => {
        flags.relayToken = '   ';
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('no_relay_credential');
    });

    // The operator bring-your-own-certificate path. `no_relay_credential` now
    // means "no usable push credential of any kind", so an install with its own
    // Apple key and NO relay credential must advertise push as available — that
    // is the whole point of the direct transport, and the AGPL core's unpaid
    // route to push.
    it('is available with an operator signing key and no relay credential at all', async () => {
        flags.relayToken = '';
        flags.apnsKeyP8 = testSigningKey();
        const body = await callCapabilities();
        expect(body.push).toEqual({ available: true });
    });

    // The enum stays at its frozen four values: the iOS client decodes it
    // strictly, and a fifth breaks the decode of the entire capabilities
    // response — playback, transcoder and events included.
    it('reuses no_relay_credential when the operator signing key is unusable', async () => {
        flags.relayToken = '';
        flags.apnsKeyP8 = '-----BEGIN PRIVATE KEY-----\ntruncated\n';
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('no_relay_credential');
    });

    // A broken key does not fall back: the selector routes this install to the
    // direct transport, so the relay token it happens to hold delivers nothing.
    it('is unavailable when a broken signing key shadows a working relay credential', async () => {
        flags.relayToken = 'relay-token-abc';
        flags.apnsKeyP8 = '-----BEGIN PRIVATE KEY-----\ntruncated\n';
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('no_relay_credential');
    });

    // Pins the credential check LAST. Entitlement is the more actionable
    // answer for an operator ("buy the module"), and reporting
    // no_relay_credential to an unentitled install would send them looking for
    // a token they are not going to be issued.
    it('reports not_entitled when both the entitlement and the credential are missing', async () => {
        flags.relayToken = '';
        entitlements.modules = new Set([]);
        const body = await callCapabilities();
        expect(body.push.available).toBe(false);
        expect(body.push.unavailableReason).toBe('not_entitled');
    });
});
