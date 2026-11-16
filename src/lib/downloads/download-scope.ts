// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * download-scope.ts - what a series download sheet can offer, derived client-side from ONE
 * download-list of the whole series (season 0 included). Pure: no fetch, no state. The queue
 * keeps the `SeriesScope` and re-derives the chosen items whenever the scope, the checklist or
 * the specials checkbox changes.
 */

import type { DownloadList, DownloadListItem } from './download-queue.svelte';

/** `episode` = one episode, `fromHere` = it and the rest of its season, `custom` = the checklist. */
export type DownloadScope = 'episode' | 'fromHere' | 'custom' | 'season' | 'series';

export interface SeriesScope {
    /** Every item of the series, season 0 included. */
    all: DownloadList;
    scope: DownloadScope;
    /** The season the sheet was opened in (picker season, or the episode's), when known. */
    season: number | undefined;
    /** The episode the sheet was opened from. */
    episodeId: string | undefined;
    /** Checked episode ids of the custom checklist. */
    custom: string[];
    /** Series scope only: include season 0. */
    specials: boolean;
}

export interface ScopeOption {
    scope: DownloadScope;
    count: number;
    bytes: number;
}

const usable = (items: DownloadListItem[]) => items.filter((i) => i.available);
const sum = (items: DownloadListItem[]) => items.reduce((s, i) => s + i.sizeBytes, 0);

/** Available items of one season, in list order. */
export function seasonEpisodes(s: SeriesScope): DownloadListItem[] {
    return s.season === undefined ? [] : usable(s.all.items.filter((i) => i.season === s.season));
}

/** Available items from the opening episode to the end of its season (itself included). */
export function fromHereEpisodes(s: SeriesScope): DownloadListItem[] {
    const season = seasonEpisodes(s);
    const at = season.findIndex((i) => i.mediaItemId === s.episodeId);
    return at < 0 ? [] : season.slice(at);
}

/** Real seasons that have a downloadable file (season 0 does not count). */
export function realSeasonCount(all: DownloadList): number {
    return new Set(
        usable(all.items)
            .filter((i) => i.season !== 0)
            .map((i) => i.season),
    ).size;
}

/** The items a scope stands for (available ones only). */
export function scopeItems(s: SeriesScope, scope: DownloadScope = s.scope): DownloadListItem[] {
    switch (scope) {
        case 'episode':
            return usable(s.all.items.filter((i) => i.mediaItemId === s.episodeId));
        case 'fromHere':
            return fromHereEpisodes(s);
        case 'custom': {
            const picked = new Set(s.custom);
            return seasonEpisodes(s).filter((i) => picked.has(i.mediaItemId));
        }
        case 'season':
            return seasonEpisodes(s);
        case 'series':
            return usable(s.all.items).filter((i) => s.specials || i.season !== 0);
    }
}

/** The radio options that make sense for this context, in display order. */
export function scopeOptions(s: SeriesScope): ScopeOption[] {
    const season = seasonEpisodes(s);
    const out: DownloadScope[] = [];
    if (s.episodeId && scopeItems(s, 'episode').length === 1) out.push('episode');
    if (s.episodeId && fromHereEpisodes(s).length >= 2) out.push('fromHere');
    if (season.length >= 2) out.push('custom');
    if (s.season !== undefined && season.length > 0) out.push('season');
    // "Whole series" is left out only when it would repeat the season row: everything
    // downloadable (specials included, they can be added) is that one season.
    const everything = usable(s.all.items).length;
    if (everything > 0 && (season.length === 0 || everything > season.length)) {
        out.push('series');
    }
    return out.map((scope) => {
        const items = scopeItems(s, scope === 'custom' ? 'season' : scope);
        return { scope, count: items.length, bytes: sum(items) };
    });
}

/** `S01E02`, or the file name when the item has no numbers. */
export function episodeCode(i: DownloadListItem): string {
    if (i.season === null || i.episode === null) return i.fileName;
    return `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}`;
}

/**
 * Starting state for a sheet. `scope` is the entry point's wish; it falls back to the first
 * option that exists (e.g. "season" of a series that has no such season). null = nothing to
 * download at all.
 */
export function initialSeriesScope(
    all: DownloadList,
    want: { scope: DownloadScope; season?: number; episodeId?: string },
): SeriesScope | null {
    let season = want.season;
    const episodeId = want.episodeId;
    if (episodeId) {
        const from = all.items.find((i) => i.mediaItemId === episodeId);
        if (!from?.available) return null;
        if (from.season !== null) season = from.season;
    }
    const base: SeriesScope = {
        all,
        scope: want.scope,
        season,
        episodeId,
        custom: [],
        specials: false,
    };
    base.custom = episodeId ? [episodeId] : seasonEpisodes(base).map((i) => i.mediaItemId);
    const options = scopeOptions(base);
    if (options.length === 0) return null;
    if (!options.some((o) => o.scope === base.scope)) {
        const fallback = options.find((o) => o.scope === 'season') ?? options[options.length - 1]!;
        base.scope = fallback.scope;
    }
    return base;
}

/** Zip/queue options matching a scope: what the list endpoint and the archive endpoint take. */
export function scopeQuery(s: SeriesScope): {
    season?: number;
    specials?: boolean;
    episodeIds?: string[];
} {
    switch (s.scope) {
        case 'season':
            return s.season === 0 ? { season: 0, specials: true } : { season: s.season };
        case 'series':
            return s.specials ? { specials: true } : {};
        default: {
            const chosen = scopeItems(s);
            // The server narrows the subset by specials: a chosen special needs it spelled out.
            return {
                episodeIds: chosen.map((i) => i.mediaItemId),
                ...(chosen.some((i) => i.season === 0) ? { specials: true } : {}),
            };
        }
    }
}
