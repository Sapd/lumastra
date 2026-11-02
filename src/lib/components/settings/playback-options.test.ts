// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
    QUALITY_MODE_OPTIONS,
    RESOLUTION_OPTIONS,
    bitrateLabel,
    isFixedMode,
} from './playback-options';

describe('playback-options', () => {
    test('exposes the three quality modes in stable order', () => {
        expect(QUALITY_MODE_OPTIONS.map((o) => o.value)).toEqual(['original', 'auto', 'fixed']);
    });

    test('resolution options include an "auto" sentinel plus common heights', () => {
        expect(RESOLUTION_OPTIONS[0].value).toBeNull();
        expect(RESOLUTION_OPTIONS.some((o) => o.value === '1080p')).toBe(true);
    });

    test('bitrateLabel renders Mbps', () => {
        expect(bitrateLabel(8_000_000)).toBe('8 Mbps');
    });

    test('isFixedMode is true only for fixed', () => {
        expect(isFixedMode('fixed')).toBe(true);
        expect(isFixedMode('auto')).toBe(false);
    });
});
