// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the canonical duration parser — the single source of truth that
 * replaced three divergent copies (scheduler / orchestrator / runner).
 *
 * Run: npx vitest run src/lib/server/tasks/duration.test.ts
 */
import { describe, expect, it } from 'vitest';
import { parseDurationMs } from './duration.js';

const S = 1_000;
const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const W = 7 * D;

describe('parseDurationMs — single units', () => {
    it('ms', () => expect(parseDurationMs('500ms')).toBe(500));
    it('s', () => expect(parseDurationMs('30s')).toBe(30 * S));
    it('m', () => expect(parseDurationMs('15m')).toBe(15 * M));
    it('h', () => expect(parseDurationMs('1h')).toBe(H));
    it('d', () => expect(parseDurationMs('7d')).toBe(7 * D));
    it('w', () => expect(parseDurationMs('1w')).toBe(W));
});

describe('parseDurationMs — ms vs m disambiguation (longest-match)', () => {
    it("'500ms' is 500ms, not 500m", () => expect(parseDurationMs('500ms')).toBe(500));
    it("'1m' is one minute", () => expect(parseDurationMs('1m')).toBe(M));
    it("compound '1m500ms'", () => expect(parseDurationMs('1m500ms')).toBe(M + 500));
});

describe('parseDurationMs — compound + whitespace', () => {
    it("'3h45m'", () => expect(parseDurationMs('3h45m')).toBe(3 * H + 45 * M));
    it("'1h30m' (the runner's old gap → was rejected, fell back to default)", () =>
        expect(parseDurationMs('1h30m')).toBe(H + 30 * M));
    it("'1d12h'", () => expect(parseDurationMs('1d12h')).toBe(D + 12 * H));
    it("'1w2d3h'", () => expect(parseDurationMs('1w2d3h')).toBe(W + 2 * D + 3 * H));
    it("whitespace ' 2h '", () => expect(parseDurationMs(' 2h ')).toBe(2 * H));
    it("inner whitespace '3h 45m'", () => expect(parseDurationMs('3h 45m')).toBe(3 * H + 45 * M));
});

describe('parseDurationMs — cross-parser divergence now unified', () => {
    it("'2w' (orchestrator lacked w → was rejected)", () =>
        expect(parseDurationMs('2w')).toBe(2 * W));
    it("'500ms' (scheduler lacked ms → was rejected)", () =>
        expect(parseDurationMs('500ms')).toBe(500));
});

describe('parseDurationMs — rejections (→ null, caller falls back to default)', () => {
    it.each([
        ['empty', ''],
        ['whitespace only', '   '],
        ['unknown unit', '5x'],
        ['bare number', '100'],
        ['zero', '0m'],
        ['all-zero compound', '0h0m'],
        ['duplicate unit', '1h1h'],
        ['fractional', '3.5h'],
        ['word unit', '3hour'],
        ['trailing garbage', '3h abc'],
        ['stuck letters', '1mh'],
        ['negative-like', '-1h'],
    ])('%s → null', (_label, input) => {
        expect(parseDurationMs(input)).toBeNull();
    });

    it('undefined → null', () => expect(parseDurationMs(undefined)).toBeNull());
    it('null → null', () => expect(parseDurationMs(null)).toBeNull());
    it('non-string → null', () => expect(parseDurationMs(123 as unknown as string)).toBeNull());
});
