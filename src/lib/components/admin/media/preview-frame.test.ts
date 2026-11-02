// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { previewFrame } from './preview-frame.js';
describe('boundary frames', () => {
    it.each([90000, 90100, 89999])('previews strictly before the exclusive end %d', (end) => {
        expect(previewFrame(end, 10000, 20, 'before') * 10000).toBeLessThan(end);
    });
    it('retains nearest-frame seeking for start previews', () => {
        expect(previewFrame(89999, 10000, 20)).toBe(9);
        expect(previewFrame(90000, 10000, 20, 'before')).toBe(8);
    });
});
