// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operator's `.p8`, validated before anything tries to sign with it.
 *
 * Every case here is a real paste-a-key-into-a-box mistake: the wrong file, a
 * `\n`-flattened secret, both sources set at once, the key without its ids.
 * Each has to be distinguishable in the log, because the operator's only other
 * signal is "notifications stopped working".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    apnsSigningKeyConfigured,
    getApnsCredential,
    apnsAdminStatus,
    hasUsableApnsCredential,
    _resetApnsCredentialCache,
} = await import('./apns-credential.js');

const KEY_ID = 'ABCDE12345';
const TEAM_ID = 'TEAM123456';

function p256(): string {
    return generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
}

function p384(): string {
    return generateKeyPairSync('ec', {
        namedCurve: 'secp384r1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
}

function rsa(): string {
    return generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
}

function configure(overrides: {
    APNS_KEY_P8?: string;
    APNS_KEY_P8_PATH?: string;
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
}): void {
    state.overrides = {
        APNS_KEY_P8: '',
        APNS_KEY_P8_PATH: '',
        APNS_KEY_ID: '',
        APNS_TEAM_ID: '',
        ...overrides,
    };
    _resetApnsCredentialCache();
}

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'apns-credential-test-'));
    configure({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    state.overrides = {};
    _resetApnsCredentialCache();
    vi.restoreAllMocks();
});

describe('apnsSigningKeyConfigured', () => {
    it('is false when nothing at all is set', () => {
        expect(apnsSigningKeyConfigured()).toBe(false);
        expect(getApnsCredential()).toEqual({ kind: 'absent' });
    });

    it('is true for a key that does not parse, so the operator hears about it', () => {
        // Intent, not validity. An install that pasted a broken key and got
        // silently routed to a relay would believe the key was in service.
        configure({ APNS_KEY_P8: 'not a key', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
        expect(apnsSigningKeyConfigured()).toBe(true);
        expect(getApnsCredential().kind).toBe('invalid');
    });

    it('is true when only the ids were filled in', () => {
        configure({ APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
        expect(apnsSigningKeyConfigured()).toBe(true);
    });
});

describe('getApnsCredential — accepted configurations', () => {
    it('accepts an inline P-256 PKCS#8 key', () => {
        const key = p256();
        configure({ APNS_KEY_P8: key, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });

        expect(getApnsCredential()).toEqual({
            kind: 'ready',
            // Trimmed: a trailing newline on a pasted key is not a difference.
            credential: { keyP8: key.trim(), keyId: KEY_ID, teamId: TEAM_ID },
        });
        expect(hasUsableApnsCredential()).toBe(true);
    });

    it('normalises a key whose newlines were flattened to the two characters \\n', () => {
        // Secret managers and compose files do this routinely. PEM without real
        // newlines does not parse, and OpenSSL's complaint names neither the
        // variable nor the cause.
        const key = p256();
        configure({
            APNS_KEY_P8: key.replace(/\n/g, '\\n'),
            APNS_KEY_ID: KEY_ID,
            APNS_TEAM_ID: TEAM_ID,
        });

        const state_ = getApnsCredential();
        expect(state_.kind).toBe('ready');
        if (state_.kind === 'ready') expect(state_.credential.keyP8).toContain('\n');
    });

    it('reads the key from a file when given a path', () => {
        const key = p256();
        const path = join(scratch, 'AuthKey.p8');
        writeFileSync(path, key, 'utf8');
        configure({ APNS_KEY_P8_PATH: path, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });

        expect(getApnsCredential().kind).toBe('ready');
    });
});

describe('getApnsCredential — rejected configurations', () => {
    function reasonFor(overrides: Parameters<typeof configure>[0]): string {
        configure(overrides);
        const result = getApnsCredential();
        expect(result.kind).toBe('invalid');
        return result.kind === 'invalid' ? result.reason : '';
    }

    it('refuses both an inline key and a path', () => {
        const path = join(scratch, 'AuthKey.p8');
        writeFileSync(path, p256(), 'utf8');
        expect(
            reasonFor({
                APNS_KEY_P8: p256(),
                APNS_KEY_P8_PATH: path,
                APNS_KEY_ID: KEY_ID,
                APNS_TEAM_ID: TEAM_ID,
            }),
        ).toMatch(/not both/);
    });

    it('refuses ids without a key', () => {
        expect(reasonFor({ APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID })).toMatch(
            /no signing key is/,
        );
    });

    it('refuses a key without its key id', () => {
        expect(reasonFor({ APNS_KEY_P8: p256(), APNS_TEAM_ID: TEAM_ID })).toMatch(
            /APNS_KEY_ID is required/,
        );
    });

    it('refuses a key without its team id', () => {
        expect(reasonFor({ APNS_KEY_P8: p256(), APNS_KEY_ID: KEY_ID })).toMatch(
            /APNS_TEAM_ID is required/,
        );
    });

    it('refuses a key id that is not alphanumeric', () => {
        expect(
            reasonFor({ APNS_KEY_P8: p256(), APNS_KEY_ID: 'ABC-12345', APNS_TEAM_ID: TEAM_ID }),
        ).toMatch(/alphanumeric/);
    });

    it('refuses something that is not a PKCS#8 PEM at all', () => {
        expect(
            reasonFor({ APNS_KEY_P8: 'hunter2', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID }),
        ).toMatch(/BEGIN PRIVATE KEY/);
    });

    it('refuses a truncated PEM', () => {
        const truncated = `${p256().split('\n').slice(0, 2).join('\n')}\n`;
        expect(
            reasonFor({ APNS_KEY_P8: truncated, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID }),
        ).toMatch(/could not be parsed/);
    });

    it('refuses an RSA key — ES256 needs EC', () => {
        expect(
            reasonFor({ APNS_KEY_P8: rsa(), APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID }),
        ).toMatch(/must be an EC key/);
    });

    it('refuses an EC key on the wrong curve', () => {
        // P-384 parses, is EC, and produces a signature Apple rejects. The
        // curve check is the only place this is catchable without a real push.
        expect(
            reasonFor({ APNS_KEY_P8: p384(), APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID }),
        ).toMatch(/prime256v1/);
    });

    it('refuses a path it cannot read without echoing its value', () => {
        const missing = join(scratch, 'absent.p8');
        const reason = reasonFor({
            APNS_KEY_P8_PATH: missing,
            APNS_KEY_ID: KEY_ID,
            APNS_TEAM_ID: TEAM_ID,
        });
        expect(reason).toMatch(/APNS_KEY_P8_PATH could not be read/);
        expect(reason).not.toContain(missing);
    });

    it('never puts key material in the reason, which is logged', () => {
        const key = p256();
        const body = key.split('\n')[1] ?? '';
        const reason = reasonFor({
            APNS_KEY_P8: key,
            APNS_KEY_ID: 'nope!',
            APNS_TEAM_ID: TEAM_ID,
        });

        expect(reason).not.toContain(body);
        expect(reason).not.toContain('BEGIN PRIVATE KEY');
    });

    it('reports the fault at error level rather than degrading quietly', () => {
        configure({ APNS_KEY_P8: 'hunter2', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
        getApnsCredential();

        expect(console.error).toHaveBeenCalled();
        expect(hasUsableApnsCredential()).toBe(false);
    });
});

describe('getApnsCredential caching', () => {
    it('does not re-read a key file once resolved', () => {
        const path = join(scratch, 'AuthKey.p8');
        writeFileSync(path, p256(), 'utf8');
        configure({ APNS_KEY_P8_PATH: path, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });

        const first = getApnsCredential();
        writeFileSync(path, 'clobbered', 'utf8');

        // Same object identity: nothing touched the disk the second time.
        expect(getApnsCredential()).toBe(first);
    });

    it('picks up a configuration change without a restart', () => {
        configure({ APNS_KEY_P8: 'hunter2', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID });
        expect(getApnsCredential().kind).toBe('invalid');

        // An admin fixing the key in the UI: ConfigService getters are live, so
        // the memo has to be keyed on the inputs and not on process lifetime.
        state.overrides = {
            ...state.overrides,
            APNS_KEY_P8: p256(),
        };

        expect(getApnsCredential().kind).toBe('ready');
    });
});

it('exposes no signing material in admin status for any credential state', () => {
    const key = p256();
    expect(apnsAdminStatus({})).toEqual({ kind: 'absent' });
    expect(
        apnsAdminStatus({ APNS_KEY_P8: key, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID }),
    ).toEqual({ kind: 'ready' });
    const invalid = apnsAdminStatus({
        APNS_KEY_P8: 'secret',
        APNS_KEY_ID: KEY_ID,
        APNS_TEAM_ID: TEAM_ID,
    });
    expect(invalid).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/PKCS#8/) });
    expect(JSON.stringify(invalid)).not.toContain('secret');
});

it('normalises lowercase Apple IDs before parsing and signing', () => {
    configure({ APNS_KEY_P8: p256(), APNS_KEY_ID: 'abcde12345', APNS_TEAM_ID: 'team123456' });
    expect(getApnsCredential()).toMatchObject({
        kind: 'ready',
        credential: { keyId: KEY_ID, teamId: TEAM_ID },
    });
});
