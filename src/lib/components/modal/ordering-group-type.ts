// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';

/**
 * A provider episode group's type in plain words.
 *
 * Prefers the provider's own type code (TMDB group types 1–7) because the
 * mapped ordering type folds several of them together. Falls back to the
 * mapped type when the code is missing (older cached responses).
 */
export function orderingGroupTypeLabel(
    providerType: number | undefined,
    orderingType: string,
): string {
    switch (providerType) {
        case 1:
            return m.ordering_group_type_original_air_date();
        case 2:
            return m.ordering_group_type_absolute();
        case 3:
            return m.ordering_group_type_dvd();
        case 4:
            return m.ordering_group_type_digital();
        case 5:
            return m.ordering_group_type_story_arc();
        case 6:
            return m.ordering_group_type_production();
        case 7:
            return m.ordering_group_type_tv();
    }
    switch (orderingType) {
        case 'absolute':
            return m.ordering_group_type_absolute();
        case 'dvd':
            return m.ordering_group_type_dvd();
        case 'standard':
            return m.ordering_group_type_original_air_date();
        default:
            return m.ordering_group_type_other();
    }
}

export interface OrderingTypeSection<T> {
    /** Stable key for keyed each blocks. */
    key: string;
    label: string;
    items: T[];
}

/** Display order of the type sections: TMDB's own type order, unknown types last. */
const TYPE_RANK: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };

/**
 * Provider groups split into one section per type, so a long list (SpongeBob
 * has 21 groups, two of them named "Production Order") reads by kind: DVD,
 * Digital, TV and so on. The provider's order is kept inside a section.
 */
export function groupOrderingsByType<T extends { providerType?: number; type: string }>(
    orderings: readonly T[],
): OrderingTypeSection<T>[] {
    const sections = new Map<string, OrderingTypeSection<T> & { rank: number }>();
    for (const o of orderings) {
        const label = orderingGroupTypeLabel(o.providerType, o.type);
        const key = o.providerType !== undefined ? `p${o.providerType}` : `t:${label}`;
        let section = sections.get(key);
        if (!section) {
            const rank = o.providerType !== undefined ? (TYPE_RANK[o.providerType] ?? 99) : 99;
            section = { key, label, items: [], rank };
            sections.set(key, section);
        }
        section.items.push(o);
    }
    return [...sections.values()]
        .sort((a, b) => a.rank - b.rank)
        .map(({ key, label, items }) => ({ key, label, items }));
}
