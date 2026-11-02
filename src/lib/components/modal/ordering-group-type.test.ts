// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { groupOrderingsByType, orderingGroupTypeLabel } from './ordering-group-type';

describe('orderingGroupTypeLabel', () => {
    it('prefers the provider type code over the mapped ordering type', () => {
        // TMDB type 1 is mapped to 'other' for storage, but it is an air-date group.
        expect(orderingGroupTypeLabel(1, 'other')).toBe('Original air date');
        expect(orderingGroupTypeLabel(4, 'dvd')).toBe('Digital');
    });

    it('falls back to the mapped type without a code', () => {
        expect(orderingGroupTypeLabel(undefined, 'absolute')).toBe('Absolute');
        expect(orderingGroupTypeLabel(undefined, 'regional')).toBe('Other');
    });
});

describe('groupOrderingsByType', () => {
    it('sections by type in TMDB type order and keeps the provider order inside', () => {
        const sections = groupOrderingsByType([
            { name: 'Nickelodeon (AU)', providerType: 7, type: 'other' },
            { name: 'DVD (Germany)', providerType: 3, type: 'dvd' },
            { name: 'Production Order', providerType: 6, type: 'other' },
            { name: 'DVD (US)', providerType: 3, type: 'dvd' },
            { name: 'Production Order', providerType: 1, type: 'other' },
        ]);
        expect(sections.map((s) => s.label)).toEqual([
            'Original air date',
            'DVD',
            'Production',
            'TV',
        ]);
        expect(sections[1].items.map((o) => o.name)).toEqual(['DVD (Germany)', 'DVD (US)']);
    });

    it('puts groups without a provider type code last', () => {
        const sections = groupOrderingsByType([
            { name: 'Old cache', type: 'absolute' },
            { name: 'Story', providerType: 5, type: 'other' },
        ]);
        expect(sections.map((s) => s.label)).toEqual(['Story arc', 'Absolute']);
    });
});
