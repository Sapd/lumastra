// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFriendlyResolution } from './media-display';

describe('getFriendlyResolution', () => {
    it.each([
        // 16:9 frames at the conventional heights
        [640, 360, '360p'],
        [854, 480, '480p'],
        [1280, 720, '720p'],
        [1920, 1080, '1080p'],
        [2560, 1440, '1440p'],
        [3840, 2160, '4K'],
    ])('labels %ix%i as %s', (width, height, label) => {
        expect(getFriendlyResolution(width, height)).toBe(label);
    });

    it('does not label a 640x360 stream as 480p', () => {
        expect(getFriendlyResolution(640, 360)).toBe('360p');
    });

    it('keeps cropped and cinemascope frames at the height the width implies', () => {
        // 1920x800 (2.40:1) is 1080p: 1920 * 9 / 16 = 1080 lines of picture
        expect(getFriendlyResolution(1920, 800)).toBe('1080p');
        // 1280x534 (2.40:1) is 720p
        expect(getFriendlyResolution(1280, 534)).toBe('720p');
        // 3840x1608 (2.40:1) is 4K
        expect(getFriendlyResolution(3840, 1608)).toBe('4K');
    });

    it('uses the coded height for anamorphic frames', () => {
        // 720x480 anamorphic DVD (16:9 by flag): 480 coded lines, 405 from the width
        expect(getFriendlyResolution(720, 480)).toBe('480p');
        // 1440x1080 HDV anamorphic: 1080 coded lines
        expect(getFriendlyResolution(1440, 1080)).toBe('1080p');
    });

    it('uses the bucket edges from the convention', () => {
        expect(getFriendlyResolution(711, 400)).toBe('360p');
        expect(getFriendlyResolution(960, 541)).toBe('720p');
        expect(getFriendlyResolution(1422, 800)).toBe('720p');
        expect(getFriendlyResolution(1600, 901)).toBe('1080p');
        expect(getFriendlyResolution(2000, 1201)).toBe('1440p');
        expect(getFriendlyResolution(2000, 1601)).toBe('4K');
    });

    it('returns an empty label when the size is unknown', () => {
        expect(getFriendlyResolution(undefined, 1080)).toBe('');
        expect(getFriendlyResolution(1920, 0)).toBe('');
        expect(getFriendlyResolution()).toBe('');
    });
});
