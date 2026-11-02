// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    getChaptersForFile,
    getChaptersForEpisode,
    type EpisodeChapterRow,
} from '$lib/server/database/queries/episode-chapters.queries.js';

/** Selected-file chapters, with the legacy episode fallback only for the default cut. */
export async function resolveEffectiveChapters(
    sql: postgres.Sql,
    internalId: string,
    selectedFile: { id: string; is_default?: boolean | null },
): Promise<EpisodeChapterRow[]> {
    const chapters = await getChaptersForFile(sql, selectedFile.id, internalId);
    return chapters.length > 0 || !selectedFile.is_default
        ? chapters
        : getChaptersForEpisode(sql, internalId);
}
