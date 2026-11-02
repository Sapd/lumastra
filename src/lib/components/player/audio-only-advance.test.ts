// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { shouldAdvanceInPlace } from './audio-only-advance';

describe('shouldAdvanceInPlace', () => {
    it('advances in place for audio-only episodes', () => {
        expect(shouldAdvanceInPlace('audio-only', 'episode', false)).toBe(true);
    });
    it('navigates normally for video', () => {
        expect(shouldAdvanceInPlace('original', 'episode', false)).toBe(false);
    });
    it('navigates normally for playlist items even in audio-only', () => {
        expect(shouldAdvanceInPlace('audio-only', 'playlist', false)).toBe(false);
    });
    it('navigates normally in a watch party even in audio-only', () => {
        expect(shouldAdvanceInPlace('audio-only', 'episode', true)).toBe(false);
    });
});
