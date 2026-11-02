// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { parseTrustedKeys } from './config.js';

function spkiBase64(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

describe('parseTrustedKeys', () => {
    it('parses a keyId:base64Spki ed25519 entry', () => {
        const keys = parseTrustedKeys(`ops-2026:${spkiBase64()}`);
        expect(keys).toHaveLength(1);
        expect(keys[0].keyId).toBe('ops-2026');
        expect(keys[0].publicKey.asymmetricKeyType).toBe('ed25519');
    });

    it('splits on commas and newlines', () => {
        const raw = `a:${spkiBase64()}\nb:${spkiBase64()},c:${spkiBase64()}`;
        expect(parseTrustedKeys(raw).map((k) => k.keyId)).toEqual(['a', 'b', 'c']);
    });

    it('WARN-drops a non-ed25519 (RSA) key instead of throwing [review C11]', () => {
        const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const rsa = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        expect(parseTrustedKeys(`rsa-key:${rsa}`)).toEqual([]);
    });

    it('WARN-drops malformed base64 and empty input', () => {
        expect(parseTrustedKeys('bad:@@@not-base64@@@')).toEqual([]);
        expect(parseTrustedKeys(undefined)).toEqual([]);
        expect(parseTrustedKeys('')).toEqual([]);
    });

    it('tags parsed keys operator by default and honours an explicit source', () => {
        const spki = spkiBase64();
        expect(parseTrustedKeys(`k:${spki}`)[0].source).toBe('operator');
        expect(parseTrustedKeys(`k:${spki}`, 'official')[0].source).toBe('official');
    });
});
