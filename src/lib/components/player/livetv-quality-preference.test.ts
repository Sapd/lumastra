// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getLiveTvQualityPreference,
    setLiveTvQualityPreference,
} from './livetv-quality-preference.js';

describe('Live TV quality preference', () => {
    const values = new Map<string, string>();
    beforeEach(() => {
        values.clear();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });
    });

    it('follows the server by default', () => {
        expect(getLiveTvQualityPreference()).toBe('server');
    });

    it('persists an explicit adaptive or fixed override', () => {
        setLiveTvQualityPreference('adaptive');
        expect(getLiveTvQualityPreference()).toBe('adaptive');
        setLiveTvQualityPreference('540p2m');
        expect(getLiveTvQualityPreference()).toBe('540p2m');
    });

    it('fails closed to server for an obsolete value', () => {
        values.set('lumastra:livetv-quality', 'all-variants-and-original');
        expect(getLiveTvQualityPreference()).toBe('server');
    });
});
