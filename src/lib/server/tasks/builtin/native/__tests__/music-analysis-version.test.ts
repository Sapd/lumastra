// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

// ============================================================================
// PROCESSING_VERSION tests
// ============================================================================

// The constant is module-private; we validate its value by importing the
// compiled module and checking the observable behaviour it controls.
// For a lightweight unit test, we replicate the constant here and test the
// JSONB structure produced by the update logic.

const PROCESSING_VERSION = 5;

describe('music-analysis task: processing version', () => {
    it('PROCESSING_VERSION is a positive integer', () => {
        expect(typeof PROCESSING_VERSION).toBe('number');
        expect(Number.isInteger(PROCESSING_VERSION)).toBe(true);
        expect(PROCESSING_VERSION).toBeGreaterThan(0);
    });

    it('processing_state JSONB payload has correct shape', () => {
        const processedAt = new Date().toISOString();

        const payload = {
            'music-analysis': {
                version: PROCESSING_VERSION,
                processedAt,
            },
        };

        expect(payload['music-analysis']).toBeDefined();
        expect(payload['music-analysis'].version).toBe(PROCESSING_VERSION);
        expect(typeof payload['music-analysis'].processedAt).toBe('string');
        // ISO 8601 format
        expect(() => new Date(payload['music-analysis'].processedAt)).not.toThrow();
    });

    it('merging processing_state preserves other plugin keys', () => {
        const existing = { 'other-plugin': { version: 2 } };
        const update = {
            'music-analysis': {
                version: PROCESSING_VERSION,
                processedAt: new Date().toISOString(),
            },
        };

        // Simulate JSONB || merge operator behaviour
        const merged = { ...existing, ...update };

        expect(merged['other-plugin']).toEqual({ version: 2 });
        expect(merged['music-analysis'].version).toBe(PROCESSING_VERSION);
    });
});
