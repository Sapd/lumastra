/*
 * SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { decideHoverLoopCap, readHoverMaxSeconds } from './media-preview-hover-cap';

describe('decideHoverLoopCap', () => {
    it('continues looping while under the cap, regardless of hover state', () => {
        expect(decideHoverLoopCap(0, 60, true)).toBe('continue');
        expect(decideHoverLoopCap(10, 60, false)).toBe('continue');
        expect(decideHoverLoopCap(59.9, 60, false)).toBe('continue');
    });

    it('re-arms when the cap is reached but the pointer is still on the preview', () => {
        expect(decideHoverLoopCap(60, 60, true)).toBe('rearm');
        expect(decideHoverLoopCap(120, 60, true)).toBe('rearm');
    });

    it('expires when the cap is reached and the pointer has left the preview', () => {
        expect(decideHoverLoopCap(60, 60, false)).toBe('expire');
        expect(decideHoverLoopCap(200, 60, false)).toBe('expire');
    });

    it('treats a non-positive cap as disabled (always continue)', () => {
        expect(decideHoverLoopCap(1000, 0, false)).toBe('continue');
        expect(decideHoverLoopCap(1000, -5, true)).toBe('continue');
    });
});

describe('readHoverMaxSeconds', () => {
    it('passes through a real 0 (explicit "disable the cap") instead of substituting the fallback', () => {
        expect(readHoverMaxSeconds({ maxSeconds: 0 }, 60)).toBe(0);
    });

    it('passes through any other hydrated finite number, including negative', () => {
        expect(readHoverMaxSeconds({ maxSeconds: 30 }, 60)).toBe(30);
        expect(readHoverMaxSeconds({ maxSeconds: -5 }, 60)).toBe(-5);
    });

    it('falls back when not yet hydrated (undefined/null/non-record/non-finite)', () => {
        expect(readHoverMaxSeconds(undefined, 60)).toBe(60);
        expect(readHoverMaxSeconds(null, 60)).toBe(60);
        expect(readHoverMaxSeconds({}, 60)).toBe(60);
        expect(readHoverMaxSeconds({ maxSeconds: 'nope' }, 60)).toBe(60);
        expect(readHoverMaxSeconds({ maxSeconds: NaN }, 60)).toBe(60);
    });
});
