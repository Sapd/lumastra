// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { escapeTablePipes } from './markdown-table-cell.js';
import { cell } from './diagnostics-report.js';

/** What a GFM table parser does to a row: split on unescaped pipes. */
function splitCells(row: string): string[] {
    const out: string[] = [];
    let cur = '';
    for (let i = 0; i < row.length; i++) {
        if (row[i] === '\\' && i + 1 < row.length) {
            cur += row[i] + row[i + 1];
            i++;
        } else if (row[i] === '|') {
            out.push(cur);
            cur = '';
        } else cur += row[i];
    }
    out.push(cur);
    return out;
}

describe('escapeTablePipes', () => {
    it('escapes a plain pipe', () => {
        expect(escapeTablePipes('a|b')).toBe('a\\|b');
    });

    it('leaves backslashes that are not before a pipe alone', () => {
        expect(escapeTablePipes('C:\\media\\x')).toBe('C:\\media\\x');
    });

    it('doubles a backslash before a pipe so the pipe cannot split the row', () => {
        expect(escapeTablePipes('a\\|b')).toBe('a\\\\\\|b');
        expect(splitCells(escapeTablePipes('a\\|b'))).toHaveLength(1);
    });

    it('never lets a pipe/backslash mix produce more than one cell', () => {
        for (const v of ['\\|', '\\\\|', '|\\', '\\\\\\|x|\\\\|']) {
            expect(splitCells(escapeTablePipes(v))).toHaveLength(1);
        }
    });

    it('is applied by the diagnostics report cell()', () => {
        expect(splitCells(cell('x\\|y'))).toHaveLength(1);
    });
});
