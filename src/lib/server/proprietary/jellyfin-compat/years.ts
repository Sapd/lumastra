// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin "Year" items for /Years and /Years/{year}.
 *
 * A year is an item-by-name in Jellyfin: its dto carries the year as `Name`
 * and a stable id, and clients open it by listing `/Items?Years=<Name>`, so
 * the id only has to be stable and distinct (same scheme as the Genre ids).
 */

import { createHash } from 'node:crypto';
import type { JellyfinBaseItemDto } from './types';
import { JELLYFIN_SERVER_ID } from './constants';
import { getParam } from './utils';
import { mapJellyfinTypes } from '$lib/server/database/queries/jellyfin-browse.queries';

/** Year item dto. `Type: 'Year'` is a BaseItemKind the Jellyfin SDK knows. */
export type JellyfinYearDto = Omit<JellyfinBaseItemDto, 'Type'> & {
    Type: 'Year';
    MediaType: 'Unknown';
    ChildCount: number;
    ProductionYear: number;
};

export function yearItemId(year: number): string {
    const hash = createHash('md5').update(`year:${year}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function serializeYear(year: number, itemCount: number): JellyfinYearDto {
    return {
        Name: String(year),
        Id: yearItemId(year),
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'Year',
        MediaType: 'Unknown',
        IsFolder: true,
        ProductionYear: year,
        ChildCount: itemCount,
        ImageTags: {},
        BackdropImageTags: [],
    };
}

/** Jellyfin item types from a comma list (`IncludeItemTypes=Movie,Series`). */
export function typesParam(url: URL, name: string): string[] {
    const raw = getParam(url, name);
    return raw ? mapJellyfinTypes(raw) : [];
}

/** A whole year in a sane range, else null. */
export function parseYear(raw: string | undefined): number | null {
    if (!raw || !/^\d{1,4}$/.test(raw)) return null;
    const year = Number(raw);
    return year > 0 ? year : null;
}
