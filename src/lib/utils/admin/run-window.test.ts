// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isLiveOnlyFilter, sinceParamFor, sinceParamForView } from './run-window.js';

describe('sinceParamFor', () => {
    it('returns undefined for "all" (preserves the unfiltered default)', () => {
        expect(sinceParamFor('all', Date.now())).toBeUndefined();
    });

    it('returns an ISO timestamp 24 hours before now for "24h"', () => {
        const now = Date.parse('2026-07-15T12:00:00.000Z');
        expect(sinceParamFor('24h', now)).toBe('2026-07-14T12:00:00.000Z');
    });

    it('returns an ISO timestamp 7 days before now for "7d"', () => {
        const now = Date.parse('2026-07-15T12:00:00.000Z');
        expect(sinceParamFor('7d', now)).toBe('2026-07-08T12:00:00.000Z');
    });
});

describe('live-only views ignore the window', () => {
    it('the Running tab sends no since, whatever the window', () => {
        expect(sinceParamForView('24h', ['pending', 'active', 'cancelling'])).toBeUndefined();
        expect(isLiveOnlyFilter(['active'])).toBe(true);
    });

    it('Failed / All / mixed filters keep the window', () => {
        const now = Date.parse('2026-10-07T12:00:00Z');
        expect(sinceParamForView('24h', ['failed'], now)).toBe('2026-10-06T12:00:00.000Z');
        expect(sinceParamForView('24h', undefined, now)).toBe('2026-10-06T12:00:00.000Z');
        expect(isLiveOnlyFilter(['active', 'failed'])).toBe(false);
        expect(isLiveOnlyFilter([])).toBe(false);
    });
});
