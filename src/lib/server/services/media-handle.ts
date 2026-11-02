// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { UUID_RE } from '$lib/utils/id-patterns.js';

const ORDERINGS = ['standard', 'dvd', 'absolute', 'regional', 'other'] as const;
export type SeasonOrdering = (typeof ORDERINGS)[number];

export interface VirtualSeasonHandle {
    seriesUuid: string;
    ordering: SeasonOrdering;
    seasonNumber: number;
}

export function isCatalogUuid(raw: string | null | undefined): raw is string {
    return typeof raw === 'string' && UUID_RE.test(raw);
}

export function buildVirtualSeasonHandle(
    seriesUuid: string, ordering: SeasonOrdering, n: number,
): string {
    if (!isCatalogUuid(seriesUuid) || !ORDERINGS.includes(ordering)
        || !Number.isSafeInteger(n) || n < 0) {
        throw new RangeError('Invalid virtual season identity');
    }
    return `vseason:${seriesUuid}:${ordering}:${n}`;
}

export function parseVirtualSeasonHandle(raw: string): VirtualSeasonHandle | null {
    const match = /^vseason:([^:]+):(standard|dvd|absolute|regional|other):(\d+)$/.exec(raw);
    if (!match || !isCatalogUuid(match[1])) return null;
    const seasonNumber = Number(match[3]);
    if (!Number.isSafeInteger(seasonNumber)) return null;
    return { seriesUuid: match[1], ordering: match[2] as SeasonOrdering, seasonNumber };
}

export interface PreviewIdentityInput {
    uuid?: string | null;
    provider?: string | null;
    providerId?: string | number | null;
    type: string;
}

export interface PreviewIdentity {
    id: string;
    catalogId: string | null;
}

/** Only TMDB can resolve a discovery item without an existing local provider mapping. */
export function buildPreviewIdentity(input: PreviewIdentityInput): PreviewIdentity | null {
    if (isCatalogUuid(input.uuid)) return { id: input.uuid, catalogId: input.uuid };
    if (input.provider !== 'tmdb' || !['movie', 'series'].includes(input.type)) return null;
    const providerId = String(input.providerId ?? '');
    if (!/^[1-9]\d*$/.test(providerId) || !Number.isSafeInteger(Number(providerId))) return null;
    return { id: `${input.provider}:${providerId}:${input.type}`, catalogId: null };
}
