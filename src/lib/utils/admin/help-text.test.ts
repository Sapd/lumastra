// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { helpTextSegments } from './help-text';

describe('helpTextSegments', () => {
    it('splits **bold** runs out of plain prose', () => {
        expect(helpTextSegments('Use **Internal URLs** for the server.')).toEqual([
            { text: 'Use ', bold: false },
            { text: 'Internal URLs', bold: true },
            { text: ' for the server.', bold: false },
        ]);
    });

    it('returns the whole text as one plain run when nothing is bold', () => {
        expect(helpTextSegments('plain')).toEqual([{ text: 'plain', bold: false }]);
    });

    it('leaves an unpaired ** alone', () => {
        expect(helpTextSegments('a ** b')).toEqual([{ text: 'a ** b', bold: false }]);
    });
});
