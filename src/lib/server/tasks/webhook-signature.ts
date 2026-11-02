// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// webhook-signature.ts — shared HMAC signing helpers for webhook delivery.
//
// Single source of truth for the Stripe-style `X-Lumastra-Signature` header.
// Both the outbox worker and the admin "test" endpoint MUST import from here
// so the wire format never drifts.
//
// ── Receiver contract ────────────────────────────────────────────────────────
//
// Header format: `t=<unix-seconds>,v1=<hex-hmac-sha256>`
//
// Verification on the receiver side MUST:
//   1. Parse `t=` (timestamp in unix seconds) and `v1=` (hex signature).
//   2. Reject the request if the timestamp is more than ±5 minutes from
//      "now" (replay-attack window).
//   3. Compute `expected = HMAC_SHA256(secret, `${t}.${rawBody}`).hex`
//      using the SAME secret previously shared with the sender.
//   4. Compare `v1` against `expected` using a constant-time compare
//      (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python,
//      `subtle.timingSafeEqual` in Web Crypto). Plain `===` leaks timing.
//   5. Reject on any mismatch.
//
// Important: receivers MUST use the raw request body bytes — re-serializing
// JSON breaks the signature because key ordering and whitespace differ.

import crypto from 'node:crypto';

/**
 * Compute the HMAC-SHA256 hex digest of `${timestamp}.${body}` using
 * `secret`. Used by both the outbox worker and the webhook test endpoint
 * so they cannot drift.
 *
 * Throws if `secret` is empty — HMAC with an empty key produces a
 * deterministic digest, which would let any caller that observed one
 * signed payload forge all future ones. Hook creation validates at
 * 16+ bytes, but a corrupted/migrated row could still slip through.
 */
export function computeSignature(timestamp: number, body: string, secret: string): string {
    if (!secret || secret.length === 0) {
        throw new Error('webhook secret must not be empty');
    }
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Build the full `X-Lumastra-Signature` header value (`t=...,v1=...`).
 */
export function signatureHeader(timestamp: number, body: string, secret: string): string {
    const sig = computeSignature(timestamp, body, secret);
    return `t=${timestamp},v1=${sig}`;
}

/**
 * Defense-in-depth: strip all ASCII control characters from custom webhook headers.
 *
 * Zod schema rejects CRLF at input validation time; this catches any legacy
 * rows or bypass attempts at delivery time. Removes all control characters
 * (0x00-0x1f, 0x7f) from both header names and values, silently dropping any
 * headers that become empty after sanitization.
 */
export function sanitizeWebhookHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        // eslint-disable-next-line no-control-regex
        const cleanK = k.replace(/[\x00-\x1f\x7f]/g, '');
        // eslint-disable-next-line no-control-regex
        const cleanV = v.replace(/[\x00-\x1f\x7f]/g, '');
        // Only include if key survives sanitization (value can be empty)
        if (cleanK) out[cleanK] = cleanV;
    }
    return out;
}
