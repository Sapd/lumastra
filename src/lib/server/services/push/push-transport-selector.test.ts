// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which transport an install gets, for every combination of configuration.
 *
 * The bug this file exists to prevent is the one that shipped: the delivery
 * pass constructed `RelayTransport` unconditionally, so `DirectApnsTransport`
 * was unreachable no matter what the operator configured. An inverted or
 * short-circuited rule looks fine from every other test in the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const state = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, prop: string | symbol) {
                if (typeof prop === 'string' && prop in state.overrides) {
                    return state.overrides[prop];
                }
                return Reflect.get(target, prop) as unknown;
            },
        }),
    };
});

const {
    createPushTransport,
    createLivePushTransport,
    currentPushTransportSelection,
    hasUsablePushCredential,
    selectPushTransportKind,
} = await import('./push-transport-selector.js');
const { _resetApnsCredentialCache } = await import('./apns-credential.js');
const { DirectApnsTransport } = await import('./direct-apns-transport.js');
const { RelayTransport } = await import('./relay-transport.js');
const { setRelayToken } = await import('./relay-token.store.js');
const { PushTransportError } = await import('./push-transport.js');

const KEY_ID = 'ABCDE12345';
const TEAM_ID = 'TEAM123456';

function p256(): string {
    return generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
}

function configure(overrides: Record<string, unknown>): void {
    state.overrides = {
        PUSH_TRANSPORT: 'auto',
        APNS_KEY_P8: '',
        APNS_KEY_P8_PATH: '',
        APNS_KEY_ID: '',
        APNS_TEAM_ID: '',
        PUSH_RELAY_TOKEN: '',
        ...overrides,
    };
    _resetApnsCredentialCache();
}

/** A complete, valid direct configuration. */
function withSigningKey(extra: Record<string, unknown> = {}): void {
    configure({ APNS_KEY_P8: p256(), APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, ...extra });
}

beforeEach(() => {
    configure({});
    setRelayToken(null);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    state.overrides = {};
    setRelayToken(null);
    _resetApnsCredentialCache();
    vi.restoreAllMocks();
});

describe('selectPushTransportKind', () => {
    it('picks direct when a signing key is configured and nothing overrides it', () => {
        expect(selectPushTransportKind({ override: 'auto', apnsKeyConfigured: true })).toEqual({
            kind: 'direct',
            reason: 'signing-key-configured',
        });
    });

    it('picks the relay when no signing key is configured', () => {
        expect(selectPushTransportKind({ override: 'auto', apnsKeyConfigured: false })).toEqual({
            kind: 'relay',
            reason: 'no-signing-key',
        });
    });

    it('honours an explicit relay override even with a signing key present', () => {
        // The reason the override exists: an operator who configured both.
        expect(selectPushTransportKind({ override: 'relay', apnsKeyConfigured: true })).toEqual({
            kind: 'relay',
            reason: 'explicit-override',
        });
    });

    it('honours an explicit direct override even with no signing key present', () => {
        // Deliberately NOT a silent fallback to the relay: the operator asked
        // for direct, so the failure they get must be about the missing key.
        expect(selectPushTransportKind({ override: 'direct', apnsKeyConfigured: false })).toEqual({
            kind: 'direct',
            reason: 'explicit-override',
        });
    });

    it('honours both overrides when both credentials exist', () => {
        expect(selectPushTransportKind({ override: 'direct', apnsKeyConfigured: true }).kind).toBe(
            'direct',
        );
        expect(selectPushTransportKind({ override: 'relay', apnsKeyConfigured: false }).kind).toBe(
            'relay',
        );
    });
});

describe('currentPushTransportSelection', () => {
    it('treats an unrecognised or missing override as auto', () => {
        // An override nobody recognises must not mean "no transport". The
        // getter validates in production, but this module is reached from the
        // orchestrator's construction path, where partial config objects and
        // hand-edited settings.json both exist.
        withSigningKey({ PUSH_TRANSPORT: 'sideways' });
        expect(currentPushTransportSelection().kind).toBe('direct');

        configure({ PUSH_TRANSPORT: undefined });
        expect(currentPushTransportSelection().kind).toBe('relay');
    });
});

describe('createPushTransport', () => {
    it('builds a RelayTransport on a stock install', () => {
        expect(createPushTransport()).toBeInstanceOf(RelayTransport);
        expect(currentPushTransportSelection().kind).toBe('relay');
    });

    it('builds a DirectApnsTransport once an operator supplies a valid key', () => {
        withSigningKey();
        expect(createPushTransport()).toBeInstanceOf(DirectApnsTransport);
    });

    it('still builds a DirectApnsTransport when the relay is also configured', () => {
        withSigningKey();
        state.overrides.PUSH_RELAY_TOKEN = 'relay-token';
        expect(createPushTransport()).toBeInstanceOf(DirectApnsTransport);
    });

    it('builds a RelayTransport when the operator overrides back to the relay', () => {
        withSigningKey({ PUSH_TRANSPORT: 'relay' });
        expect(createPushTransport()).toBeInstanceOf(RelayTransport);
    });

    it('refuses to sign — loudly, and without throwing — when the key is unusable', async () => {
        // Throwing here would take the whole task orchestrator down over a typo
        // in an optional notification setting. Instead the fault is logged at
        // error level and every send fails as `no_credential`, which
        // push-outbox.ts dies immediately rather than riding the full ladder
        // and then reporting `max_attempts` (which reads as an Apple outage).
        configure({ APNS_KEY_P8: 'hunter2', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });

        const transport = createPushTransport();
        expect(transport).not.toBeInstanceOf(DirectApnsTransport);
        expect(transport).not.toBeInstanceOf(RelayTransport);
        expect(console.error).toHaveBeenCalled();

        const error = await transport
            .send({
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                collapseId: '11111111-1111-4111-8111-111111111111',
                expirationEpochSeconds: 1_786_554_000,
                tokens: ['a'.repeat(64)],
                payload: {
                    aps: {
                        alert: { title: 'x', body: 'y' },
                        badge: 1,
                        'mutable-content': 1,
                        sound: 'default',
                    },
                    data: { id: 'x', kind: 'library.new_episode', v: 1 },
                },
            })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PushTransportError);
        expect((error as InstanceType<typeof PushTransportError>).kind).toBe('no_credential');
        expect((error as Error).message).toMatch(/BEGIN PRIVATE KEY/);
    });

    it('reports the missing key when direct was forced without one', async () => {
        configure({ PUSH_TRANSPORT: 'direct' });

        const transport = createPushTransport();
        expect(transport).not.toBeInstanceOf(RelayTransport);
        expect(console.error).toHaveBeenCalled();
    });
});

describe('hasUsablePushCredential', () => {
    it('is false on a stock install with neither credential', () => {
        expect(hasUsablePushCredential()).toBe(false);
    });

    it('is true with only a relay credential', () => {
        setRelayToken('relay-token');
        expect(hasUsablePushCredential()).toBe(true);
    });

    it('is true with only an operator signing key', () => {
        // The whole point of the direct transport: push works with no relay
        // credential of any kind, so the capability must say so.
        withSigningKey();
        expect(hasUsablePushCredential()).toBe(true);
    });

    it('is false when a broken signing key shadows a working relay credential', () => {
        // The selector routes this install to the direct transport, so it can
        // deliver nothing — advertising push here burns the single
        // notification-permission prompt iOS grants.
        configure({ APNS_KEY_P8: 'hunter2', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
        setRelayToken('relay-token');

        expect(hasUsablePushCredential()).toBe(false);
    });

    it('is true when a broken signing key is overridden back to the relay', () => {
        configure({
            PUSH_TRANSPORT: 'relay',
            APNS_KEY_P8: 'hunter2',
            APNS_KEY_ID: KEY_ID,
            APNS_TEAM_ID: TEAM_ID,
        });
        setRelayToken('relay-token');

        expect(hasUsablePushCredential()).toBe(true);
    });
});

describe('createLivePushTransport', () => {
    it('follows a saved switch from the relay to a direct signing key without a restart', async () => {
        const relaySend = vi.spyOn(RelayTransport.prototype, 'send').mockResolvedValue([]);
        const directSend = vi.spyOn(DirectApnsTransport.prototype, 'send').mockResolvedValue([]);
        const closeSpy = vi.spyOn(DirectApnsTransport.prototype, 'close').mockResolvedValue();
        try {
            const live = createLivePushTransport();
            const req = { tokens: [], payload: {} } as never;

            await live.send(req);
            expect(relaySend).toHaveBeenCalledTimes(1);

            withSigningKey();
            await live.send(req);
            expect(directSend).toHaveBeenCalledTimes(1);

            // Back to the relay: the replaced direct transport's pool is closed.
            state.overrides.PUSH_TRANSPORT = 'relay';
            await live.send(req);
            expect(relaySend).toHaveBeenCalledTimes(2);
            expect(closeSpy).toHaveBeenCalledTimes(1);
        } finally {
            relaySend.mockRestore();
            directSend.mockRestore();
            closeSpy.mockRestore();
        }
    });
});
