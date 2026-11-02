// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Split-file parts ("Movie - Part1.mkv" + "Movie - Part2.mkv") are confirmed
 * against the folder, as Jellyfin stacks them: a part number counts only when
 * another video in the same folder has the same name apart from the part token
 * and a different part number.
 *
 * The filename parser alone matched every "Part N" — film titles included —
 * so "Milo Farrow and the Distant Harbors Part 1 (2010) - Bluray-1080p.mkv"
 * was stored as part 1 (249 items on prod, 2026-10-03). A lone part is harmless
 * until a second unlabelled version of the same film arrives: both carry
 * "part 1" and playback concatenated them, the film twice in a row.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { splitPartToken } from '$lib/server/utils/filename-parser';
import { MEDIA_EXTENSIONS } from '$lib/server/utils/walk-directory';

export interface StackedPart {
    /** The confirmed part number, or undefined when the "part" is a title. */
    part: number | undefined;
    /** The other parts of the stack, by absolute path. */
    siblings: Array<{ filePath: string; part: number }>;
}

/** Confirm `parsedPart` against the other videos in the file's folder. */
export async function confirmStackedPart(
    filePath: string,
    parsedPart: number | undefined,
): Promise<StackedPart> {
    if (parsedPart === undefined) return { part: undefined, siblings: [] };
    const own = splitPartToken(filePath);
    if (!own) return { part: undefined, siblings: [] };

    const dir = path.dirname(filePath);
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        // Folder unreadable right now: keep the parsed value rather than
        // flipping a real stack to "no part" on a transient error.
        return { part: parsedPart, siblings: [] };
    }

    const ownName = path.basename(filePath);
    const siblings: StackedPart['siblings'] = [];
    for (const name of names) {
        if (name === ownName) continue;
        if (!MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        const other = splitPartToken(name);
        if (!other || other.stackKey !== own.stackKey || other.part === own.part) continue;
        siblings.push({ filePath: path.join(dir, name), part: other.part });
    }
    return siblings.length > 0 ? { part: parsedPart, siblings } : { part: undefined, siblings };
}

/**
 * A part that arrived before its siblings was stored without a part number.
 * Once the stack is confirmed, give the known siblings theirs, so the parts
 * play in order instead of the un-numbered one sorting last.
 */
export async function backfillSiblingParts(
    sql: postgres.Sql,
    siblings: StackedPart['siblings'],
): Promise<void> {
    for (const sibling of siblings) {
        await sql`
            UPDATE media_files
            SET part_number = ${sibling.part}, updated_at = NOW()
            WHERE file_path = ${sibling.filePath}
              AND part_number IS NULL
        `;
    }
}
