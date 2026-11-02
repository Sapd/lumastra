// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getSeriesOrdering } from '$lib/api/content';

/**
 * Fetch the active episode ordering label for a series.
 * Returns the human-readable name (e.g., "DVD Order") or null for standard ordering.
 */
export async function fetchOrderingLabel(seriesId: string): Promise<string | null> {
    try {
        const { data } = await getSeriesOrdering(seriesId);
        if (!data) return null;
        const { current, available } = data;
        if (current.orderingType === 'standard') return null;
        const match = available.find(
            (a) => a.type === current.orderingType && a.groupId === current.groupId,
        );
        return match?.name ?? current.orderingType;
    } catch {
        /* expected: network or parse failure */
        return null;
    }
}
