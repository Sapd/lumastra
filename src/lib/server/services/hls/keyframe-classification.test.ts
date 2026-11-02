// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { classifyKeyframeRow } from './keyframe-classification.js';

describe('classifyKeyframeRow', () => {
    it('NULL keyframes → probe (file was never keyframe-probed)', () => {
        expect(classifyKeyframeRow({ keyframes: null })).toEqual({ kind: 'probe' });
    });

    it('no row at all → probe', () => {
        expect(classifyKeyframeRow(null)).toEqual({ kind: 'probe' });
        expect(classifyKeyframeRow(undefined)).toEqual({ kind: 'probe' });
    });

    it('empty array → negative-cache (probed, no usable keyframes — do NOT re-probe)', () => {
        // This is THE regression guard: an empty (non-NULL) array must NOT be
        // treated the same as NULL, or a zero-keyframe copy file re-probes and
        // stalls on every single play.
        expect(classifyKeyframeRow({ keyframes: [] })).toEqual({ kind: 'negative-cache' });
    });

    it('non-empty array → use the cached keyframes', () => {
        const keyframes = [0, 2.5, 5.0, 7.5];
        expect(classifyKeyframeRow({ keyframes })).toEqual({ kind: 'use', keyframes });
    });
});
