// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import * as crypto from 'node:crypto';
import type { TrustedKey } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PluginVerify');

/** Verify a detached Ed25519 signature over the RAW manifest bytes against any
 *  trusted key. Returns the matching keyId + its source, or null if none verify.
 *  The reported keyId/source is always the trusted key that actually verified —
 *  never `manifest.keyId` (advisory metadata that selects nothing). [Fable-4] */
export function verifyManifestSignature(
    rawManifestBytes: Buffer,
    signatureBase64: string,
    trustedKeys: TrustedKey[],
): { keyId: string; source: 'official' | 'operator' } | null {
    const sig = Buffer.from(signatureBase64, 'base64');
    for (const { keyId, publicKey, source } of trustedKeys) {
        try {
            if (crypto.verify(null, rawManifestBytes, publicKey, sig)) return { keyId, source };
        } catch (err) {
            logger.warn('Trusted key failed to verify (skipping)', { keyId, err: String(err) });
        }
    }
    return null;
}
