// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { parseByteRange } from './byte-range.js';

describe('parseByteRange', () => {
    it('reads an open-ended and a bounded range, clamping the end', () => {
        expect(parseByteRange('bytes=1000-', 5000)).toEqual({
            kind: 'range',
            start: 1000,
            end: 4999,
        });
        expect(parseByteRange('bytes=0-1', 5000)).toEqual({ kind: 'range', start: 0, end: 1 });
        expect(parseByteRange('bytes=10-99999', 5000)).toEqual({
            kind: 'range',
            start: 10,
            end: 4999,
        });
    });

    it('reads a suffix range', () => {
        expect(parseByteRange('bytes=-500', 5000)).toEqual({
            kind: 'range',
            start: 4500,
            end: 4999,
        });
        expect(parseByteRange('bytes=-9999', 5000)).toEqual({ kind: 'range', start: 0, end: 4999 });
    });

    it('takes the first range of a multi-range header', () => {
        expect(parseByteRange('bytes=0-1, 5-6', 5000)).toEqual({ kind: 'range', start: 0, end: 1 });
    });

    it('refuses a range that starts past the end, or an empty suffix', () => {
        expect(parseByteRange('bytes=5000-', 5000)).toEqual({ kind: 'unsatisfiable' });
        expect(parseByteRange('bytes=-0', 5000)).toEqual({ kind: 'unsatisfiable' });
    });

    it('ignores what it cannot read, so the whole file is served (RFC 9110)', () => {
        expect(parseByteRange('bytes=500-100', 5000)).toEqual({ kind: 'ignore' });
        expect(parseByteRange('items=0-1', 5000)).toEqual({ kind: 'ignore' });
        expect(parseByteRange('bytes=abc', 5000)).toEqual({ kind: 'ignore' });
        expect(parseByteRange('', 5000)).toEqual({ kind: 'ignore' });
    });
});
