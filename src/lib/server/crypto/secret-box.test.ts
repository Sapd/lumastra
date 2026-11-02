// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the shared AES-256-GCM secret-box primitives used by both the
 * plugin secret store and the config service at-rest encryption (F66 / Sec MED-8).
 *
 * Run with: npx vitest run src/lib/server/crypto/secret-box.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
    deriveMasterKey,
    encrypt,
    decrypt,
    sealSecret,
    openSecret,
    isSealed,
    isAadBound,
    isAadBoundBlob,
} from './secret-box.js';

// 64-char hex → 32 raw bytes (0xAA × 32).
const KEY_HEX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('secret-box buffer crypto', () => {
    it('round-trips encrypt → decrypt', () => {
        const key = deriveMasterKey(KEY_HEX);
        const blob = encrypt('super-secret-api-key', key);
        expect(decrypt(blob, key)).toBe('super-secret-api-key');
    });

    it('rejects a tampered ciphertext (GCM auth)', () => {
        const key = deriveMasterKey(KEY_HEX);
        const blob = encrypt('hello', key);
        blob[blob.length - 1] ^= 0xff;
        expect(() => decrypt(blob, key)).toThrow();
    });
});

describe('secret-box string envelope', () => {
    it('seals into a tagged enc:v1: envelope and opens back to plaintext', () => {
        const key = deriveMasterKey(KEY_HEX);
        const envelope = sealSecret('jellyfin-api-key', key);
        expect(envelope.startsWith('enc:v1:')).toBe(true);
        expect(isSealed(envelope)).toBe(true);
        expect(envelope).not.toContain('jellyfin-api-key');
        expect(openSecret(envelope, key)).toBe('jellyfin-api-key');
    });

    it('isSealed returns false for plaintext', () => {
        expect(isSealed('plain-value')).toBe(false);
        expect(isSealed('')).toBe(false);
    });

    it('openSecret throws on non-envelope input', () => {
        const key = deriveMasterKey(KEY_HEX);
        expect(() => openSecret('not-an-envelope', key)).toThrow();
    });
});

describe('deriveMasterKey strength enforcement', () => {
    it('accepts a 64-char hex key', () => {
        expect(deriveMasterKey(KEY_HEX)).toHaveLength(32);
    });

    it('rejects an empty key', () => {
        expect(() => deriveMasterKey('')).toThrow(/not set/);
    });

    it('rejects a short passphrase', () => {
        expect(() => deriveMasterKey('short1')).toThrow(/24 characters/);
    });

    it('rejects a single-class passphrase', () => {
        expect(() => deriveMasterKey('aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow(/character classes/);
    });

    it('derives from a valid passphrase', () => {
        expect(deriveMasterKey('a-strong-passphrase-with-digits-123')).toHaveLength(32);
    });
});

// ── AAD binding (security review 2026-09-13, C19) ─────────────────────────────
//
// A sealed blob carries no statement about WHICH row it belongs to, so anyone
// who can write to the database can copy one row's ciphertext into another
// row and have a reveal endpoint decrypt it in the wrong context. Binding the
// row's identity in as AES-GCM additional authenticated data makes that copy
// fail the auth tag instead of opening.

describe('secret-box AAD binding', () => {
    it('encrypt/decrypt round-trips under the same context and fails under another', () => {
        const key = deriveMasterKey(KEY_HEX);
        const blob = encrypt('row-a-secret', key, 'row:A');
        expect(decrypt(blob, key, 'row:A')).toBe('row-a-secret');
        expect(() => decrypt(blob, key, 'row:B')).toThrow();
    });

    it('an AAD-bound blob refuses to open with no context at all', () => {
        const key = deriveMasterKey(KEY_HEX);
        const blob = encrypt('row-a-secret', key, 'row:A');
        expect(() => decrypt(blob, key)).toThrow(/context/i);
    });

    it('a legacy blob (no AAD) still opens, with or without a context', () => {
        const key = deriveMasterKey(KEY_HEX);
        const legacy = encrypt('legacy-secret', key);
        expect(decrypt(legacy, key)).toBe('legacy-secret');
        // Readers thread their context unconditionally; a v1 blob ignores it.
        expect(decrypt(legacy, key, 'row:A')).toBe('legacy-secret');
    });

    it('seals into a tagged enc:v2: envelope and opens back under the same context', () => {
        const key = deriveMasterKey(KEY_HEX);
        const envelope = sealSecret('tmdb-key', key, 'settings.json:TMDB_API_KEY');
        expect(envelope.startsWith('enc:v2:')).toBe(true);
        expect(isSealed(envelope)).toBe(true);
        expect(isAadBound(envelope)).toBe(true);
        expect(openSecret(envelope, key, 'settings.json:TMDB_API_KEY')).toBe('tmdb-key');
    });

    it('an enc:v2: envelope opened under the wrong context throws', () => {
        const key = deriveMasterKey(KEY_HEX);
        const envelope = sealSecret('admin-token', key, 'subsonic_client_passwords:user-a');
        expect(() => openSecret(envelope, key, 'subsonic_client_passwords:user-b')).toThrow();
        expect(() => openSecret(envelope, key)).toThrow(/context/i);
    });

    it('an enc:v1: envelope opens without AAD even when a context is supplied', () => {
        const key = deriveMasterKey(KEY_HEX);
        const legacy = sealSecret('legacy-token', key);
        expect(legacy.startsWith('enc:v1:')).toBe(true);
        expect(isAadBound(legacy)).toBe(false);
        expect(openSecret(legacy, key)).toBe('legacy-token');
        expect(openSecret(legacy, key, 'subsonic_client_passwords:user-a')).toBe('legacy-token');
    });

    it('isAadBound distinguishes blobs as well as envelopes', () => {
        const key = deriveMasterKey(KEY_HEX);
        expect(isAadBoundBlob(encrypt('x', key, 'row:A'))).toBe(true);
        expect(isAadBoundBlob(encrypt('x', key))).toBe(false);
        expect(isAadBound('plain-value')).toBe(false);
    });

    it('the context is authenticated, not encrypted — tampering with it is detected', () => {
        const key = deriveMasterKey(KEY_HEX);
        const envelope = sealSecret('secret', key, 'row:A');
        expect(envelope).not.toContain('row:A');
        expect(() => openSecret(envelope, key, 'row:A ')).toThrow();
    });
});
