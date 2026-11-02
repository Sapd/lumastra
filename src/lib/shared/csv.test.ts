// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { serializeToCSV } from './csv.js';

describe('serializeToCSV', () => {
    it('produces a header row + data row with CRLF endings', () => {
        const result = serializeToCSV(['Name', 'Status'], [{ Name: 'Alice', Status: 'Completed' }]);
        expect(result).toBe('Name,Status\r\nAlice,Completed\r\n');
    });

    it('handles empty rows (header only)', () => {
        const result = serializeToCSV(['A', 'B'], []);
        expect(result).toBe('A,B\r\n');
    });

    it('quotes fields containing commas', () => {
        const result = serializeToCSV(
            ['Title', 'Status'],
            [{ Title: 'Safety, Health & Wellness', Status: 'Completed' }],
        );
        expect(result).toBe('Title,Status\r\n"Safety, Health & Wellness",Completed\r\n');
    });

    it('doubles embedded double-quotes (RFC-4180)', () => {
        const result = serializeToCSV(['Note'], [{ Note: 'He said "hello"' }]);
        expect(result).toBe('Note\r\n"He said ""hello"""\r\n');
    });

    it('quotes fields containing newlines', () => {
        const result = serializeToCSV(['Comment'], [{ Comment: 'line1\nline2' }]);
        expect(result).toBe('Comment\r\n"line1\nline2"\r\n');
    });

    it('quotes fields containing carriage-return', () => {
        const result = serializeToCSV(['Comment'], [{ Comment: 'a\rb' }]);
        expect(result).toBe('Comment\r\n"a\rb"\r\n');
    });

    it('serializes null/undefined values as empty string', () => {
        const result = serializeToCSV(['A', 'B', 'C'], [{ A: 'x', B: null, C: undefined }]);
        expect(result).toBe('A,B,C\r\nx,,\r\n');
    });

    it('handles multiple rows correctly', () => {
        const result = serializeToCSV(
            ['User', 'Course', 'Status'],
            [
                { User: 'Alice', Course: 'Safety 101', Status: 'Completed' },
                { User: 'Bob', Course: 'HR Basics', Status: 'Not started' },
                { User: 'Carol', Course: 'Safety 101', Status: 'In progress' },
            ],
        );
        const lines = result.split('\r\n');
        expect(lines[0]).toBe('User,Course,Status');
        expect(lines[1]).toBe('Alice,Safety 101,Completed');
        expect(lines[2]).toBe('Bob,HR Basics,Not started');
        expect(lines[3]).toBe('Carol,Safety 101,In progress');
        // Trailing CRLF means last element is empty string
        expect(lines[4]).toBe('');
    });

    it('columns not present in row become empty string', () => {
        const result = serializeToCSV(['A', 'B'], [{ A: 'hello' }]);
        expect(result).toBe('A,B\r\nhello,\r\n');
    });

    it('quotes columns that contain commas in the header', () => {
        const result = serializeToCSV(['Name, Surname'], [{ 'Name, Surname': 'Alice Smith' }]);
        expect(result).toBe('"Name, Surname"\r\nAlice Smith\r\n');
    });

    it('round-trips a field with both comma and quote', () => {
        const tricky = 'a,"b"';
        const result = serializeToCSV(['X'], [{ X: tricky }]);
        // Header + data: X\r\n"a,""b"""\r\n
        expect(result).toBe('X\r\n"a,""b"""\r\n');
    });

    // ── Formula injection guard ────────────────────────────────────────────────

    it('prefixes = with single-quote to block formula injection', () => {
        const result = serializeToCSV(['Name'], [{ Name: "=DDE(cmd|/C calc'!A0)" }]);
        expect(result).toBe("Name\r\n'=DDE(cmd|/C calc'!A0)\r\n");
    });

    it('prefixes + with single-quote', () => {
        const result = serializeToCSV(['Val'], [{ Val: '+1234567890' }]);
        expect(result).toBe("Val\r\n'+1234567890\r\n");
    });

    it('prefixes - with single-quote', () => {
        const result = serializeToCSV(['Val'], [{ Val: '-1234567890' }]);
        expect(result).toBe("Val\r\n'-1234567890\r\n");
    });

    it('prefixes @ with single-quote', () => {
        const result = serializeToCSV(['Val'], [{ Val: '@SUM(A1:A10)' }]);
        expect(result).toBe("Val\r\n'@SUM(A1:A10)\r\n");
    });

    it('prefixes tab-leading field with single-quote', () => {
        const result = serializeToCSV(['Val'], [{ Val: '\t=1+1' }]);
        expect(result).toBe("Val\r\n'\t=1+1\r\n");
    });

    it('prefixes a carriage-return-leading field (and still quotes it)', () => {
        // Some spreadsheet importers strip a leading CR and then evaluate "=…".
        const result = serializeToCSV(['Val'], [{ Val: '\r=1+1' }]);
        expect(result).toBe('Val\r\n"\'\r=1+1"\r\n');
    });

    it('does not prefix safe fields', () => {
        const result = serializeToCSV(['Val'], [{ Val: 'Hello World' }]);
        expect(result).toBe('Val\r\nHello World\r\n');
    });

    // ── UTF-8 BOM ─────────────────────────────────────────────────────────────

    it('prepends UTF-8 BOM when bom=true', () => {
        const result = serializeToCSV(
            ['Name', 'Status'],
            [{ Name: 'Alice', Status: 'Completed' }],
            { bom: true },
        );
        // BOM = U+FEFF (0xEF 0xBB 0xBF in UTF-8)
        expect(result.codePointAt(0)).toBe(0xfeff);
        expect(result.slice(1)).toBe('Name,Status\r\nAlice,Completed\r\n');
    });

    it('does not include BOM when bom=false (default)', () => {
        const result = serializeToCSV(['Name'], [{ Name: 'Alice' }]);
        expect(result.codePointAt(0)).not.toBe(0xfeff);
        expect(result).toBe('Name\r\nAlice\r\n');
    });
});
