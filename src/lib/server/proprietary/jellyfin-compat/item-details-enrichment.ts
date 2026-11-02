// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * BaseItemDto fields Jellyfin's DtoService fills for a normal library that no
 * browse query selects (cloud-parity brief 09):
 *
 *  - from one batch query (`getJellyfinItemExtras`): `CriticRating`, series
 *    `Status` / `EndDate` / `DisplayOrder`, track `HasLyrics` /
 *    `NormalizationGain`, episode `IndexNumberEnd`;
 *  - from the MediaSources already on the item (no query): `Width`, `Height`,
 *    `IsHD`, `MediaSourceCount` and, when asked for, top-level `MediaStreams`;
 *  - `Chapters` / `Trickplay` on list routes when `Fields` asks for them (two
 *    batch queries; the detail route loads them itself).
 *
 * Failures leave the fields off rather than failing the response.
 */

import type postgres from 'postgres';
import type { JellyfinBaseItemDto } from './types';
import type { DtoOptions } from './dto-options';
import { getJellyfinItemExtras } from '$lib/server/database/queries/jellyfin-item-extras.queries.js';
import {
    getChaptersForItems,
    getTrickplayForItems,
} from '$lib/server/database/queries/jellyfin-item-detail.queries.js';
import { buildChapters, buildTrickplay } from './serializers/base-item';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { isEpisode, isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:ItemDetails');

/** TMDB series status → Jellyfin SeriesStatus. */
export function seriesStatus(tmdbStatus: string | null): string | undefined {
    switch (tmdbStatus?.trim().toLowerCase()) {
        case 'returning series':
            return 'Continuing';
        case 'ended':
        case 'canceled':
        case 'cancelled':
            return 'Ended';
        case 'in production':
        case 'planned':
        case 'pilot':
            return 'Unreleased';
        default:
            return undefined;
    }
}

/** Lumastra episode ordering → Jellyfin series DisplayOrder. */
const DISPLAY_ORDER: Readonly<Record<string, string>> = {
    dvd: 'dvd',
    absolute: 'absolute',
    regional: 'regional',
    other: 'alternate',
};

function finiteNumber(value: string | null): number | undefined {
    if (value === null) return undefined;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : undefined;
}

function isoDate(value: string | null): string | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
    return value.includes('T') ? value : `${value}T00:00:00.0000000Z`;
}

const canonical = (id: string): string => id.replace(/-/g, '').toLowerCase();

export async function enrichItemsWithItemDetails(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
): Promise<void> {
    const ids = items.map((i) => i.Id).filter((id) => isUuid(id));
    if (ids.length === 0) return;
    let rows;
    try {
        rows = await getJellyfinItemExtras(sql, ids);
    } catch (error) {
        logger.warn('Item details enrichment failed; fields left off', { error: String(error) });
        return;
    }
    const byId = new Map(rows.map((r) => [canonical(r.id), r]));
    for (const item of items) {
        const row = byId.get(canonical(item.Id));
        if (!row) continue;
        const critic = finiteNumber(row.rt_rating);
        if (critic !== undefined && critic >= 0 && critic <= 100) item.CriticRating = critic;
        if (isSeries(item.Type)) {
            const status = seriesStatus(row.series_status);
            if (status) item.Status = status;
            const end = status === 'Ended' ? isoDate(row.last_air_date) : undefined;
            if (end) item.EndDate = end;
            const order = row.display_order ? DISPLAY_ORDER[row.display_order] : undefined;
            if (order) item.DisplayOrder = order;
        }
        if (item.Type === 'Audio') {
            item.HasLyrics = row.has_lyrics;
            const lufs = finiteNumber(row.loudness_lufs);
            // Jellyfin: -18 LUFS reference (ReplayGain 2.0), NormalizationGain = -18 - LUFS.
            if (lufs !== undefined) item.NormalizationGain = Math.round((-18 - lufs) * 100) / 100;
        }
        // A multi-episode file: Jellyfin has one item E1–E2; Lumastra has one
        // item per episode sharing the file. The first carries the span (only
        // while its displayed number is the stored one, i.e. no reordering).
        if (
            isEpisode(item.Type) &&
            row.span_max !== null &&
            row.episode_number !== null &&
            row.span_min === row.episode_number &&
            row.span_max > row.episode_number &&
            item.IndexNumber === row.episode_number
        ) {
            item.IndexNumberEnd = row.span_max;
        }
    }
}

/**
 * Width / Height / IsHD / MediaSourceCount from the item's MediaSources, and
 * top-level `MediaStreams` (the default source's) when `mediaStreams` is set.
 * Pure: reads only what media-source enrichment already put on the item.
 */
export function addSourceDerivedFields(
    items: readonly JellyfinBaseItemDto[],
    { mediaStreams }: { mediaStreams: boolean },
): void {
    for (const item of items) {
        const sources = item.MediaSources;
        if (!sources || sources.length === 0) continue;
        if (sources.length !== 1) item.MediaSourceCount = sources.length;
        const primary = sources[0];
        const video = primary.MediaStreams?.find((s) => s.Type === 'Video');
        if (video?.Width && video.Width > 0) item.Width = video.Width;
        if (video?.Height && video.Height > 0) {
            item.Height = video.Height;
            // Jellyfin BaseItem.IsHD: Height >= 720; only ever sent as true.
            if (video.Height >= 720) item.IsHD = true;
        }
        if (mediaStreams && primary.MediaStreams) item.MediaStreams = primary.MediaStreams;
    }
}

/** `Chapters` / `Trickplay` for list items whose request asked for them. */
export async function enrichItemsWithChaptersAndTrickplay(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
    want: { chapters: boolean; trickplay: boolean },
): Promise<void> {
    if (!want.chapters && !want.trickplay) return;
    const videos = items.filter(
        (i) => (isMovie(i.Type) || isEpisode(i.Type) || i.Type === 'Video') && isUuid(i.Id),
    );
    if (videos.length === 0) return;
    const ids = videos.map((i) => i.Id);
    try {
        // Chapter image tags exist only when trickplay does, so chapters need it too.
        const [chapterRows, trickplayRows] = await Promise.all([
            want.chapters ? getChaptersForItems(sql, ids) : Promise.resolve([]),
            getTrickplayForItems(sql, ids),
        ]);
        const chaptersBy = new Map<string, typeof chapterRows>();
        for (const c of chapterRows) {
            const key = canonical(c.media_item_id);
            const list = chaptersBy.get(key);
            if (list) list.push(c);
            else chaptersBy.set(key, [c]);
        }
        const trickplayBy = new Map<string, typeof trickplayRows>();
        for (const t of trickplayRows) {
            const key = canonical(t.media_item_id);
            const list = trickplayBy.get(key);
            if (list) list.push(t);
            else trickplayBy.set(key, [t]);
        }
        for (const item of videos) {
            const key = canonical(item.Id);
            const shape = {
                id: item.Id,
                title: item.Name,
                media_type: item.Type,
                chapters: (chaptersBy.get(key) ?? []).map((c) => ({
                    chapter_index: c.chapter_index,
                    chapter_name: c.chapter_name,
                    start_ticks: Number(c.start_ticks),
                })),
                trickplay_params: (trickplayBy.get(key) ?? []).map((t) => ({ ...t })),
            };
            if (want.chapters) item.Chapters = buildChapters(shape) ?? [];
            if (want.trickplay) {
                const trickplay = buildTrickplay(shape);
                if (trickplay) item.Trickplay = trickplay;
            }
        }
    } catch (error) {
        logger.warn('Chapters/Trickplay enrichment failed; fields left off', {
            error: String(error),
        });
    }
}

/**
 * Everything above a list route adds before shaping: the batch-query fields
 * always (Jellyfin sends them unconditionally), Chapters / Trickplay only when
 * `Fields` names them.
 */
export async function enrichItemsForList(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
    dto: DtoOptions,
): Promise<void> {
    // Independent queries over the same ids: run them side by side.
    await Promise.all([
        enrichItemsWithItemDetails(sql, items),
        enrichItemsWithChaptersAndTrickplay(sql, items, {
            chapters: dto.fields?.has('chapters') ?? false,
            trickplay: dto.fields?.has('trickplay') ?? false,
        }),
    ]);
}
