// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signed URL Utility
 *
 * Stateless, reusable primitive for generating tamper-proof, expiring URLs.
 * Uses HMAC-SHA256 with JWT_SECRET.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '$lib/server/config';

export interface SignUrlOptions {
    expiresIn: number; // seconds from now
    purpose: string; // scope — prevents cross-feature reuse
}

export type SignedUrlResult =
    | { valid: true }
    | {
          valid: false;
          reason: 'expired' | 'invalid_signature' | 'purpose_mismatch' | 'missing_params';
      };

function getSecret(): string {
    const secret = config.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET must be configured to use signed URLs');
    }
    return secret;
}

function hmac(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Generate a signed URL by appending ?expires=UNIX&purpose=X&sig=HMAC to the path.
 * The path must NOT contain query params (throws if it does).
 */
export function signUrl(path: string, options: SignUrlOptions): string {
    if (path.includes('?')) {
        throw new Error('signUrl: path must not contain query params');
    }

    const secret = getSecret();
    const expires = Math.floor(Date.now() / 1000) + options.expiresIn;
    const canonical = `${path}:${expires}:${options.purpose}`;
    const sig = hmac(canonical, secret);

    return `${path}?expires=${expires}&purpose=${encodeURIComponent(options.purpose)}&sig=${sig}`;
}

/**
 * Verify a signed URL's signature, expiry, and purpose.
 */
export function verifySignedUrl(url: URL, expectedPurpose: string): SignedUrlResult {
    const expires = url.searchParams.get('expires');
    const purpose = url.searchParams.get('purpose');
    const sig = url.searchParams.get('sig');

    if (!expires || !purpose || !sig) {
        return { valid: false, reason: 'missing_params' };
    }

    const expiresNum = parseInt(expires, 10);
    if (isNaN(expiresNum) || expiresNum < Math.floor(Date.now() / 1000)) {
        return { valid: false, reason: 'expired' };
    }

    if (purpose !== expectedPurpose) {
        return { valid: false, reason: 'purpose_mismatch' };
    }

    const secret = getSecret();
    const canonical = `${url.pathname}:${expires}:${purpose}`;
    const expectedSig = hmac(canonical, secret);

    // Use timing-safe comparison to prevent timing attacks
    const sigBuffer = Buffer.from(sig, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');

    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
        return { valid: false, reason: 'invalid_signature' };
    }

    return { valid: true };
}
