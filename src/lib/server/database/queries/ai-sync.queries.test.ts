// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ai-sync.queries — C2 triggeredBy allowlist fix.
 *
 * These tests verify that the getTaskHistory filter logic no longer accepts
 * arbitrary LIKE wildcards. The actual DB call is not executed (no DB
 * connection in unit tests); instead we test the schema validation layer
 * that guards the filter at the HTTP boundary.
 */

import { describe, it, expect } from 'vitest';
import { triggeredByFilterSchema } from '$lib/schemas/admin';

describe('triggeredByFilterSchema — C2 LIKE injection guard', () => {
    it('accepts "manual"', () => {
        const result = triggeredByFilterSchema.safeParse('manual');
        expect(result.success).toBe(true);
        expect(result.data).toBe('manual');
    });

    it('accepts "scheduler"', () => {
        const result = triggeredByFilterSchema.safeParse('scheduler');
        expect(result.success).toBe(true);
        expect(result.data).toBe('scheduler');
    });

    it('accepts "downstream"', () => {
        const result = triggeredByFilterSchema.safeParse('downstream');
        expect(result.success).toBe(true);
        expect(result.data).toBe('downstream');
    });

    it('rejects a bare wildcard string', () => {
        const result = triggeredByFilterSchema.safeParse('%%%%%%');
        expect(result.success).toBe(false);
    });

    it('rejects an empty string', () => {
        const result = triggeredByFilterSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('rejects arbitrary user input', () => {
        const result = triggeredByFilterSchema.safeParse('manual; DROP TABLE task_history;--');
        expect(result.success).toBe(false);
    });

    it('rejects undefined (undefined is not in the enum)', () => {
        const result = triggeredByFilterSchema.safeParse(undefined);
        expect(result.success).toBe(false);
    });

    it('rejects unknown categories', () => {
        expect(triggeredByFilterSchema.safeParse('system').success).toBe(false);
        expect(triggeredByFilterSchema.safeParse('cron').success).toBe(false);
        expect(triggeredByFilterSchema.safeParse('MANUAL').success).toBe(false);
    });
});
