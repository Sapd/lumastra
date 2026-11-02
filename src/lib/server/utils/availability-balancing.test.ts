// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { capByAvailabilityClass } from './availability-balancing.js';

interface Item {
    id: number;
    isAvailable: boolean;
}

function item(id: number, isAvailable: boolean): Item {
    return { id, isAvailable };
}

describe('capByAvailabilityClass', () => {
    it('caps each class independently instead of a blind slice', () => {
        // 8 unavailable items followed by 2 available items — a blind
        // slice(0, 3) would return 3 unavailable items and evict the
        // available class entirely (the crowd-out bug this helper fixes).
        const items = [
            ...Array.from({ length: 8 }, (_, i) => item(i, false)),
            item(100, true),
            item(101, true),
        ];

        const result = capByAvailabilityClass(items, 3, (i) => i.isAvailable);

        const available = result.filter((r) => r.isAvailable);
        const unavailable = result.filter((r) => !r.isAvailable);
        expect(available).toHaveLength(2); // only 2 exist — all survive
        expect(unavailable).toHaveLength(3); // capped at limitPerClass
    });

    it('preserves the original relative order within and across classes', () => {
        const items = [item(1, true), item(2, false), item(3, true), item(4, false)];

        const result = capByAvailabilityClass(items, 10, (i) => i.isAvailable);

        expect(result.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    });

    it('returns fewer than 2×limitPerClass when one class is short', () => {
        const items = [item(1, true), item(2, false), item(3, false), item(4, false)];

        const result = capByAvailabilityClass(items, 2, (i) => i.isAvailable);

        expect(result.map((i) => i.id)).toEqual([1, 2, 3]);
    });

    it('returns an empty array for empty input', () => {
        expect(capByAvailabilityClass([], 5, () => true)).toEqual([]);
    });

    it('is a no-op when both classes are already within the cap', () => {
        const items = [item(1, true), item(2, false)];

        expect(capByAvailabilityClass(items, 5, (i) => i.isAvailable)).toEqual(items);
    });
});
