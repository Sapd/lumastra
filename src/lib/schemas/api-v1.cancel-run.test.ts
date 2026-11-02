// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gate contract for POST /api/v1/runs/{id}/cancel body (E1 row #38).
 *
 * `reason` is capped at 255 chars — it is persisted verbatim to the Valkey
 * run-state hash + audit_log JSONB, so an unbounded attacker-controlled blob
 * is a cache/audit bloat surface. Verify the cap fires and the field stays
 * optional.
 */

import { describe, it, expect } from 'vitest';
import { CancelRunRequestSchema } from './api-v1.js';

describe('CancelRunRequestSchema — reason cap', () => {
    it('accepts a reason of exactly 255 chars', () => {
        expect(CancelRunRequestSchema.safeParse({ reason: 'x'.repeat(255) }).success).toBe(true);
    });

    it('rejects a reason longer than 255 chars', () => {
        expect(CancelRunRequestSchema.safeParse({ reason: 'x'.repeat(256) }).success).toBe(false);
    });

    it('keeps reason (and force/hard) optional', () => {
        expect(CancelRunRequestSchema.safeParse({}).success).toBe(true);
        expect(CancelRunRequestSchema.safeParse({ force: true }).success).toBe(true);
        expect(CancelRunRequestSchema.safeParse({ hard: true }).success).toBe(true);
    });
});
