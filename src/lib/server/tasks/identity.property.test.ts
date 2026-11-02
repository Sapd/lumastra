// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Property-based tests for identity formula computation.
 * Plan §16.2: Identity formula properties using fast-check.
 *
 * Properties verified:
 *   (a) computeIdentity output is deterministic for stable identityFor
 *   (b) different identityFor outputs produce different identities
 *   (c) identityFor results with control chars throw (sanitizeIdentity invariant)
 *   (d) identityFor results exceeding 256 chars throw
 *   (e) valid identity is URL-safe (no RESP-breaking chars beyond standard key chars)
 *
 * Run with: npx vitest run src/lib/server/tasks/identity.property.test.ts
 * No live infrastructure required.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeIdentity, sanitizeIdentity } from './identity.js';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';

// ── Arbitraries ───────────────────────────────────────────────────────────────

// Regex that matches any control character (C0 range 0x00-0x1f or DEL 0x7f).
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Strings that are valid identityFor outputs (no control chars, no `#`
 * reserved-delimiter, ≤256 chars).
 */
const validIdentityArb = fc
    .string({ minLength: 1, maxLength: 256 })
    .filter(
        (s) =>
            !CONTROL_CHAR_RE.test(s) && !s.includes('#') && !s.includes(':') && !s.includes('~~'),
    );

/**
 * Strings that contain at least one control character.
 */
const controlCharArb = fc
    .tuple(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.integer({ min: 0x00, max: 0x1f }),
        fc.string({ minLength: 0, maxLength: 50 }),
    )
    .map(([prefix, code, suffix]) => `${prefix}${String.fromCharCode(code)}${suffix}`);

/**
 * Strings exceeding 256 chars (no control chars — isolates length violation).
 */
const tooLongArb = fc
    .string({ minLength: 257, maxLength: 400 })
    .filter((s) => !CONTROL_CHAR_RE.test(s));

/**
 * Valid task IDs (alphanumeric + hyphens).
 */
const taskIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,50}$/).filter((s) => s.length > 0);

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTask(id: string, formula: string): TaskDefinition<unknown, unknown> {
    return {
        id,
        name: 'Test',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        identityFor: () => formula,
        inputSchema: null as unknown as TaskDefinition['inputSchema'],
        execute: async () => ({ success: true }),
    } as TaskDefinition<unknown, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('identity.property — computeIdentity + sanitizeIdentity (plan §16.2)', () => {
    it('(a) computeIdentity is deterministic: same inputs always produce same output', () => {
        fc.assert(
            fc.property(taskIdArb, validIdentityArb, (taskId, formula) => {
                const task = makeTask(taskId, formula);
                const r1 = computeIdentity(task, {});
                const r2 = computeIdentity(task, {});
                return r1 === r2;
            }),
            { numRuns: 500, seed: 20240513 },
        );
    });

    it('(b) different identityFor outputs produce different computed identities for the same taskId', () => {
        fc.assert(
            fc.property(
                taskIdArb,
                validIdentityArb,
                validIdentityArb,
                (taskId, formulaA, formulaB) => {
                    // Only check when formulas differ.
                    fc.pre(formulaA !== formulaB);
                    const taskA = makeTask(taskId, formulaA);
                    const taskB = makeTask(taskId, formulaB);
                    return computeIdentity(taskA, {}) !== computeIdentity(taskB, {});
                },
            ),
            { numRuns: 500, seed: 20240513 },
        );
    });

    it('(c) identityFor results with control chars always throw', () => {
        fc.assert(
            fc.property(controlCharArb, (s) => {
                // Must throw regardless of the control-char position.
                expect(() => sanitizeIdentity(s)).toThrow();
                return true;
            }),
            { numRuns: 500, seed: 20240513 },
        );
    });

    it('(d) identityFor results exceeding 256 chars always throw', () => {
        fc.assert(
            fc.property(tooLongArb, (s) => {
                expect(() => sanitizeIdentity(s)).toThrow(/exceeds 256/);
                return true;
            }),
            { numRuns: 200, seed: 20240513 },
        );
    });

    it('(e) valid identity output format: <taskId>~~<formula> — contains "~~" separator', () => {
        fc.assert(
            fc.property(taskIdArb, validIdentityArb, (taskId, formula) => {
                const task = makeTask(taskId, formula);
                const result = computeIdentity(task, {});
                // Must contain the separator.
                if (!result.includes('~~')) return false;
                // Must start with the taskId.
                if (!result.startsWith(`${taskId}~~`)) return false;
                // Tail must be the formula.
                const tail = result.slice(taskId.length + 2);
                return tail === formula;
            }),
            { numRuns: 500, seed: 20240513 },
        );
    });

    it('(f) sanitizeIdentity is idempotent on valid strings', () => {
        fc.assert(
            fc.property(validIdentityArb, (s) => {
                const result = sanitizeIdentity(s);
                return result === s;
            }),
            { numRuns: 500, seed: 20240513 },
        );
    });

    it('(g) DEL character (0x7f) is rejected by sanitizeIdentity', () => {
        fc.assert(
            fc.property(
                fc.tuple(
                    fc.string({ minLength: 0, maxLength: 20 }),
                    fc.string({ minLength: 0, maxLength: 20 }),
                ),
                ([prefix, suffix]) => {
                    const s = `${prefix}\x7f${suffix}`;
                    expect(() => sanitizeIdentity(s)).toThrow();
                    return true;
                },
            ),
            { numRuns: 200, seed: 20240513 },
        );
    });

    it('(h) empty string is rejected by sanitizeIdentity', () => {
        expect(() => sanitizeIdentity('')).toThrow(/empty/);
    });
});
