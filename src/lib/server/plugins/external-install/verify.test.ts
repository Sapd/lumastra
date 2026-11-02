// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { verifyManifestSignature } from './verify.js';
import type { TrustedKey } from '$lib/server/config.js';

function keypair(
    keyId: string,
    source: 'official' | 'operator' = 'operator',
): { trusted: TrustedKey; priv: crypto.KeyObject } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { trusted: { keyId, publicKey, source }, priv: privateKey };
}

describe('verifyManifestSignature', () => {
    const bytes = Buffer.from('{"name":"sample-plugin","version":"1.0.0"}', 'utf8');

    it('returns keyId for a signature by a trusted key', () => {
        const { trusted, priv } = keypair('ops');
        const sig = crypto.sign(null, bytes, priv).toString('base64');
        expect(verifyManifestSignature(bytes, sig, [trusted])).toEqual({
            keyId: 'ops',
            source: 'operator',
        });
    });
    it('returns null for an untrusted signer', () => {
        const a = keypair('a');
        const b = keypair('b');
        const sig = crypto.sign(null, bytes, a.priv).toString('base64');
        expect(verifyManifestSignature(bytes, sig, [b.trusted])).toBeNull();
    });
    it('returns null when a single byte is tampered [Fable-4]', () => {
        const { trusted, priv } = keypair('ops');
        const sig = crypto.sign(null, bytes, priv).toString('base64');
        const tampered = Buffer.from(bytes);
        tampered[0] = tampered[0] ^ 0xff;
        expect(verifyManifestSignature(tampered, sig, [trusted])).toBeNull();
    });
    it('returns null for a re-serialized manifest (same fields, different bytes) — sig is over RAW bytes, not canonical JSON', () => {
        const { trusted, priv } = keypair('ops');
        const obj = { name: 'sample-plugin', version: '1.0.0' };
        const signedBytes = Buffer.from(JSON.stringify(obj), 'utf8');
        const sig = crypto.sign(null, signedBytes, priv).toString('base64');
        // Same object, whitespace-reformatted (what a proxy/CDN re-minify would produce)
        const reSerialized = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
        expect(verifyManifestSignature(reSerialized, sig, [trusted])).toBeNull();
        expect(verifyManifestSignature(signedBytes, sig, [trusted])).toEqual({
            keyId: 'ops',
            source: 'operator',
        });
    });
    it('does not throw when the list contains an RSA key; still returns null [review C11]', () => {
        const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const rsaTrusted = { keyId: 'rsa', publicKey } as unknown as TrustedKey;
        const { trusted, priv } = keypair('ed');
        const sig = crypto.sign(null, bytes, priv).toString('base64');
        // rsa first so the try/catch path is exercised, then a valid ed key
        expect(verifyManifestSignature(bytes, sig, [rsaTrusted, trusted])).toEqual({
            keyId: 'ed',
            source: 'operator',
        });
    });
    it('reports the OFFICIAL source when an official and a same-keyId operator key both verify', () => {
        // Same keyId, DIFFERENT material — official listed first must win the report.
        const off = keypair('shared', 'official');
        const opBogus = {
            keyId: 'shared',
            publicKey: keypair('x').trusted.publicKey,
            source: 'operator' as const,
        };
        const sig = crypto.sign(null, bytes, off.priv).toString('base64');
        expect(verifyManifestSignature(bytes, sig, [off.trusted, opBogus])).toEqual({
            keyId: 'shared',
            source: 'official',
        });
    });
});
