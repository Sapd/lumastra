// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { StuckItemRow } from '$lib/server/database/queries/ingest-map.queries.js';

export type SerializedStuckItem = Omit<StuckItemRow, 'stuck_since'> & {
    stuck_since: string;
};

/** Preserve every selected diagnostic field in the page/cache snapshot. */
export function serializeStuckItem(row: StuckItemRow): SerializedStuckItem {
    return {
        ...row,
        stuck_since: row.stuck_since.toISOString(),
    };
}
