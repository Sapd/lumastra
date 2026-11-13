// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-part ("stacked") movies on /j, the way real Jellyfin exposes them.
 *
 * Lumastra keeps a stacked movie as ONE media_item whose files carry
 * media_files.part_number 1, 2, …. Real Jellyfin instead gives the main item
 * only part 1 as its MediaSource, sets `PartCount` (parts incl. part 1, only
 * when > 1), and serves parts 2..N as items of their own from
 * `/Videos/{id}/AdditionalParts`. jellyfin-androidtv (SdkPlaybackHelper.getParts)
 * and jellyfin-web (playbackmanager getAdditionalParts) then queue
 * `[item, ...AdditionalParts]`. Listing every part as a MediaSource instead made
 * those clients offer the parts as alternative versions.
 *
 * A part's item id is its media_files id — the same file-UUID-as-item-id every
 * /j route already resolves through getOwnerItemForFile (the version picker).
 *
 * What a part is mirrors the web player's selectFileForPlayback: within one
 * edition, at least two DISTINCT part numbers, one file per number (the first in
 * the item's file order). Un-numbered files, a lone part, or several files that
 * share one number are versions — two copies of "Deathly Hallows Part 1" both
 * carry part 1.
 */
import type postgres from 'postgres';
import type { JellyfinBaseItemDto } from './types';

export interface PartFile {
    id: string;
    edition: string | null;
    part_number: number | null;
    duration_seconds?: number | string | null;
}

export interface PartLayout<T extends PartFile> {
    /**
     * The item's playable sources, in file order: every file except parts
     * 2..N of a stack (part 1 stands for its stack).
     */
    sources: T[];
    /** All parts (in part order) of the stack this file belongs to. */
    stackOf(fileId: string): T[] | undefined;
    /** 0-based position of the file in its stack; -1 when it is no part. */
    partIndex(fileId: string): number;
}

export function partLayout<T extends PartFile>(files: readonly T[]): PartLayout<T> {
    const byEdition = new Map<string | null, Map<number, T>>();
    for (const f of files) {
        if (f.part_number === null || f.part_number === undefined) continue;
        const key = f.edition ?? null;
        let parts = byEdition.get(key);
        if (!parts) byEdition.set(key, (parts = new Map()));
        if (!parts.has(f.part_number)) parts.set(f.part_number, f);
    }
    const stacks = new Map<string, T[]>();
    for (const parts of byEdition.values()) {
        if (parts.size < 2) continue;
        const stack = [...parts.entries()].sort(([a], [b]) => a - b).map(([, f]) => f);
        for (const f of stack) stacks.set(f.id, stack);
    }
    const partIndex = (fileId: string): number =>
        stacks.get(fileId)?.findIndex((f) => f.id === fileId) ?? -1;
    return {
        sources: files.filter((f) => partIndex(f.id) <= 0),
        stackOf: (fileId) => stacks.get(fileId),
        partIndex,
    };
}

/** `PartCount` for an item whose first source is `fileId`; undefined unless > 1. */
export function partCountFor<T extends PartFile>(
    layout: PartLayout<T>,
    fileId: string | undefined,
): number | undefined {
    const n = fileId ? (layout.stackOf(fileId)?.length ?? 0) : 0;
    return n > 1 ? n : undefined;
}

function seconds(raw: number | string | null | undefined): number | null {
    const n = Number(raw);
    return raw != null && Number.isFinite(n) && n > 0 ? n : null;
}

/** A file's probed length in ticks, or undefined while it is unprobed. */
export function fileRunTimeTicks(file: PartFile): number | undefined {
    const s = seconds(file.duration_seconds);
    return s === null ? undefined : Math.round(s * 10_000_000);
}

/**
 * Seconds of the movie before part `index` of `stack` (0 for part 1); null when
 * an earlier part is unprobed, so the offset is unknown.
 */
export function partOffsetSeconds(stack: readonly PartFile[], index: number): number | null {
    let total = 0;
    for (const f of stack.slice(0, Math.max(index, 0))) {
        const s = seconds(f.duration_seconds);
        if (s === null) return null;
        total += s;
    }
    return total;
}

/**
 * The item's files with just what the part layout needs. Light on purpose:
 * getFilesForMediaItem drags `keyframes` jsonb along, and the progress reports
 * that call this arrive every few seconds. Same order as getFilesForMediaItem.
 */
export async function getPartFiles(sql: postgres.Sql, mediaItemId: string): Promise<PartFile[]> {
    return sql<PartFile[]>`
        SELECT mf.id, mf.edition, mf.part_number, mf.duration_seconds
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
        ORDER BY mfi.sort_order, mf.part_number NULLS FIRST, mf.id
    `;
}

/**
 * A playback report's position on the whole movie. Clients that play the parts
 * one after another report each part under its own item id (the file id) with a
 * position inside that part; the movie's watch progress — shared with the web
 * player, which plays the parts as one stream — needs the offset of the parts
 * before it. Anything that is not part 2..N of a stack passes through.
 */
export async function moviePositionMs(
    sql: postgres.Sql,
    reportedItemId: string,
    ownerItemId: string | null,
    positionMs: number,
): Promise<number> {
    if (!ownerItemId) return positionMs;
    try {
        const layout = partLayout(await getPartFiles(sql, ownerItemId));
        const index = layout.partIndex(reportedItemId);
        if (index <= 0) return positionMs;
        const stack = layout.stackOf(reportedItemId)!;
        // Unknown only while an earlier part is unprobed — the scanner probes
        // every file on ingest, so a part being played has probed siblings.
        const offset = partOffsetSeconds(stack, index);
        if (offset === null) return positionMs;
        // A report past the part's end (buffered tail, short probe) must not
        // land in the next part.
        const length = seconds(stack[index].duration_seconds);
        const inPart = length === null ? positionMs : Math.min(positionMs, length * 1000);
        return Math.round(offset * 1000 + inPart);
    } catch {
        // The report itself must not fail over the part lookup.
        return positionMs;
    }
}

/**
 * The DTO of part `index` (0-based; the part numbered index + 1) of `stack`, from
 * the movie's DTO: its own id, length and a position inside the part. Chapters
 * and trickplay describe the movie's first file, so they are dropped (trickplay
 * keeps only this part's own entry). MediaSources are left for the caller.
 */
export function toPartItem(
    movie: JellyfinBaseItemDto,
    stack: readonly PartFile[],
    index: number,
): JellyfinBaseItemDto {
    const part = stack[index];
    const item: JellyfinBaseItemDto = {
        ...movie,
        Id: part.id,
        Name: `${movie.Name} (Part ${part.part_number ?? index + 1})`,
        // The movie's Etag would make a client cache the part as the movie.
        Etag: undefined,
        RunTimeTicks: fileRunTimeTicks(part) ?? movie.RunTimeTicks,
        PartCount: undefined,
        MediaSources: undefined,
        Chapters: undefined,
        Trickplay: movie.Trickplay?.[part.id] ? { [part.id]: movie.Trickplay[part.id] } : undefined,
    };
    if (movie.UserData) {
        const offset = partOffsetSeconds(stack, index);
        const lengthTicks = fileRunTimeTicks(part) ?? 0;
        // Unknown offset: no position rather than the movie's as the part's.
        const inPart =
            offset === null ? 0 : movie.UserData.PlaybackPositionTicks - offset * 10_000_000;
        const position = inPart > 0 && inPart < lengthTicks ? Math.round(inPart) : 0;
        item.UserData = {
            ...movie.UserData,
            ItemId: part.id,
            PlaybackPositionTicks: position,
            PlayedPercentage: position > 0 && lengthTicks > 0 ? (position / lengthTicks) * 100 : 0,
        };
    }
    return item;
}
