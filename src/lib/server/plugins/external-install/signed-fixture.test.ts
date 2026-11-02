// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A REAL signature, produced by the real signer, verified by the real verifier.
 *
 * Every other test in this area constructs a keypair in-process and signs
 * inline, which proves the crypto round-trips but not that
 * `scripts/plugin-sign.mjs` and the host agree on WHAT gets signed. That
 * agreement is the fragile part: the signature covers the exact manifest bytes,
 * so a re-serialisation anywhere between signing and verifying — a different
 * key order, a re-minify, a trailing newline — breaks it silently.
 *
 * These fixtures were generated out-of-band by:
 *   node scripts/plugin-keygen.mjs --key-id lumastra-test-2026 --out <outside repo>
 *   node scripts/plugin-sign.mjs   --dir examples/plugins/sample-task ...
 *
 * The PRIVATE key is not in this repository and never will be. Only the public
 * half is needed to verify, and it is inlined below — that is what a trusted
 * key IS.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifestSignature } from './verify.js';
import { getOfficialTrustedKeys } from './trust-anchors.js';
import { parseTrustedKeys } from '$lib/server/config.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/signed');
const manifestBytes = fs.readFileSync(path.join(DIR, 'manifest.json'));
const signature = fs.readFileSync(path.join(DIR, 'manifest.json.sig'), 'utf-8').trim();

/** Public half only. The private key lives outside the repo. */
const TEST_ENTRY =
    'lumastra-test-2026:MCowBQYDK2VwAyEAWG0PnWWnVHrXnwFVLwUmVr1esEsiWcVROA7m+b8s1xs=';

describe('a manifest signed by the real signer', () => {
    it('verifies against an OPERATOR key', () => {
        const result = verifyManifestSignature(
            manifestBytes,
            signature,
            parseTrustedKeys(TEST_ENTRY, 'operator'),
        );
        expect(result).toMatchObject({ keyId: 'lumastra-test-2026', source: 'operator' });
    });

    it('verifies through the OFFICIAL anchor path, tagged official', () => {
        // Exercises `getOfficialTrustedKeys` with entries passed in, rather
        // than baking a throwaway key into OFFICIAL_TRUSTED_KEY_ENTRIES — that
        // constant is compiled into every install, so a test key in it would
        // ship a trust anchor whose private half is a scratch file.
        const result = verifyManifestSignature(
            manifestBytes,
            signature,
            getOfficialTrustedKeys([TEST_ENTRY]),
        );
        expect(result).toMatchObject({ keyId: 'lumastra-test-2026', source: 'official' });
    });

    it('is REFUSED by an unrelated trusted key', () => {
        const other = 'someone-else:MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=';
        expect(
            verifyManifestSignature(manifestBytes, signature, parseTrustedKeys(other, 'operator')),
        ).toBeNull();
    });

    it('is REFUSED when the manifest bytes change by ONE byte', () => {
        // The whole point of signing exact bytes. A re-serialisation that only
        // reorders keys produces identical JSON semantically and a dead
        // signature — which is why the signer prints "serve byte-for-byte".
        const tampered = Buffer.from(
            manifestBytes.toString('utf-8').replace('"1.0.0"', '"1.0.1"'),
            'utf-8',
        );
        expect(
            verifyManifestSignature(tampered, signature, parseTrustedKeys(TEST_ENTRY, 'operator')),
        ).toBeNull();
    });

    it('is REFUSED with an empty trusted set — no keys means no trust', () => {
        expect(verifyManifestSignature(manifestBytes, signature, [])).toBeNull();
    });
});

describe('the shipped anchor', () => {
    it('never contains THIS fixture key — no test key ships as a compile-time trust anchor', async () => {
        // The anchor is no longer empty (an official key ships), so emptiness is
        // the wrong assertion. The invariant that actually matters is unchanged
        // and is now checked where it bites: the key this file signs with, whose
        // private half is a repo fixture, must never be a trust anchor.
        const { OFFICIAL_TRUSTED_KEY_ENTRIES } = await import('./trust-anchors.js');
        expect(OFFICIAL_TRUSTED_KEY_ENTRIES).not.toContain(TEST_ENTRY);
        expect(OFFICIAL_TRUSTED_KEY_ENTRIES.some((e) => e.includes(TEST_ENTRY.split(':')[1]))).toBe(
            false,
        );
    });

    it('does not verify this fixture signature through the shipped anchor', () => {
        // The end-to-end statement of the same thing, at the seam that matters:
        // a manifest signed by the test key must be REFUSED by what actually
        // ships, regardless of how the anchor is spelled.
        expect(
            verifyManifestSignature(manifestBytes, signature, getOfficialTrustedKeys()),
        ).toBeNull();
    });
});
