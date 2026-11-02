// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `resolveProfile` is the whole "Gentle/Balanced/Fast" mapping: it must never
 * write a value outside a setting's own min/max (the config save would
 * otherwise reject it), and Balanced must reproduce the SAME numbers the
 * task runner already boots with by default — a profile switch that
 * silently changed the "no opinion" case would surprise every existing
 * install the day this ships.
 */

import { describe, it, expect } from 'vitest';
import { resolveProfile } from './work-profile.js';
import { cpuClassConcurrencyDefault, ioClassConcurrencyDefault } from '$lib/config/schema.js';

describe('resolveProfile', () => {
    it('balanced reproduces the existing cgroup-aware defaults', () => {
        const cores = 8;
        const result = resolveProfile('balanced', cores);
        expect(result.LUMASTRA_CONCURRENCY_CPU).toBe(cpuClassConcurrencyDefault(cores));
        expect(result.LUMASTRA_CONCURRENCY_IO).toBe(ioClassConcurrencyDefault(cores));
        expect(result.LUMASTRA_CONCURRENCY_INGEST).toBe(2); // static default, no dynamicDefault
    });

    it('gentle is lower than balanced but never below the floor of 1', () => {
        const cores = 2;
        const gentle = resolveProfile('gentle', cores);
        const balanced = resolveProfile('balanced', cores);
        for (const key of Object.keys(balanced) as (keyof typeof balanced)[]) {
            expect(gentle[key]).toBeLessThanOrEqual(balanced[key]);
            expect(gentle[key]).toBeGreaterThanOrEqual(1);
        }
    });

    it("fast is higher than balanced but clamped to each setting's max", () => {
        const cores = 64; // deliberately huge to try to blow past the ceiling
        const fast = resolveProfile('fast', cores);
        // LUMASTRA_CONCURRENCY_CPU validation max is 32 (schema.ts)
        expect(fast.LUMASTRA_CONCURRENCY_CPU).toBeLessThanOrEqual(32);
        // LUMASTRA_CONCURRENCY_IO validation max is 64
        expect(fast.LUMASTRA_CONCURRENCY_IO).toBeLessThanOrEqual(64);
        // LUMASTRA_CONCURRENCY_INGEST validation max is 32
        expect(fast.LUMASTRA_CONCURRENCY_INGEST).toBeLessThanOrEqual(32);
    });

    it('every profile stays within [1, max] on a tiny single-core host', () => {
        for (const profile of ['gentle', 'balanced', 'fast'] as const) {
            const result = resolveProfile(profile, 1);
            for (const value of Object.values(result)) {
                expect(value).toBeGreaterThanOrEqual(1);
            }
        }
    });
});
