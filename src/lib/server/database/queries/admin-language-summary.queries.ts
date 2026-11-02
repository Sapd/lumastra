// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { basename } from 'node:path';
import type postgres from 'postgres';
import type {
    FileLanguageSummary,
    EpisodeLanguageSummary,
    LanguageTrack,
} from '$lib/schemas/admin-language-summary.js';
/** Constant query count for an entire list, scoped to the actual physical files. */
export async function getFileLanguageSummaries(
    sql: postgres.Sql,
    ids: string[],
): Promise<Map<string, FileLanguageSummary>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const [files, embedded, sidecars] = await Promise.all([
        // Admin-only file inventory: the files/episodes EndpointDefs enforce auth.kind=admin.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<
            { id: string; probed: boolean; is_missing: boolean; original_language: string | null }[]
        >`SELECT mf.id,(mf.probed_at IS NOT NULL AND NOT mf.is_missing) AS probed,mf.is_missing,
            (SELECT pm.metadata->>'original_language'
             FROM media_file_items link
             JOIN media_items item ON item.id = link.media_item_id
             LEFT JOIN media_items parent ON parent.id = item.parent_id
             LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
             JOIN provider_metadata pm ON pm.media_id IN (item.id, CASE WHEN item.media_type = 'episode' THEN COALESCE(grandparent.id, item.id) WHEN item.media_type = 'season' THEN COALESCE(parent.id, item.id) ELSE item.id END)
             WHERE link.file_id = mf.id AND NULLIF(pm.metadata->>'original_language', '') IS NOT NULL
             ORDER BY (pm.media_id = item.id), CASE pm.provider WHEN 'aggregated' THEN 0 WHEN 'tmdb' THEN 1 ELSE 2 END, item.id
             LIMIT 1) AS original_language
            FROM media_files mf WHERE mf.id=ANY(${unique}::uuid[])`,
        sql<
            {
                file_id: string;
                stream_type: string;
                language: string | null;
                is_default: boolean | null;
                is_forced: boolean | null;
            }[]
        >`SELECT file_id,stream_type,language,is_default,is_forced FROM media_streams WHERE file_id=ANY(${unique}::uuid[]) AND stream_type IN ('audio','subtitle') ORDER BY file_id,stream_index,id`,
        sql<
            { file_id: string; language: string | null; is_forced: boolean | null }[]
        >`SELECT file_id,language,is_forced FROM external_subtitle_files WHERE file_id=ANY(${unique}::uuid[]) ORDER BY file_id,language NULLS LAST,subtitle_path,id`,
    ]);
    const result = new Map<string, FileLanguageSummary>(
        files.map((file) => [
            file.id,
            {
                originalLanguage: file.original_language ?? undefined,
                fileId: file.id,
                probed: file.probed,
                isMissing: file.is_missing,
                audio: [],
                subtitles: [],
            },
        ]),
    );
    for (const row of embedded) {
        const file = result.get(row.file_id);
        if (!file) continue;
        const track: LanguageTrack = {
            language: row.language,
            isDefault: row.is_default,
            isForced: row.is_forced,
            source: 'embedded',
        };
        (row.stream_type === 'audio' ? file.audio : file.subtitles).push(track);
    }
    for (const row of sidecars)
        result.get(row.file_id)?.subtitles.push({
            language: row.language,
            isDefault: null,
            isForced: row.is_forced,
            source: 'sidecar',
        });
    return result;
}
/** Default playback association stays separate from every alternate version. */
export async function getEpisodeLanguageSummaries(
    sql: postgres.Sql,
    ids: string[],
): Promise<Map<string, EpisodeLanguageSummary>> {
    if (!ids.length) return new Map();
    const links = await sql<
        {
            media_item_id: string;
            file_id: string;
            is_default: boolean;
            label: string | null;
            edition: string | null;
            file_path: string;
        }[]
    >`
        SELECT l.media_item_id,l.file_id,l.is_default,l.label,f.edition,f.file_path FROM media_file_items l JOIN media_files f ON f.id=l.file_id
        WHERE l.media_item_id=ANY(${ids}::uuid[]) ORDER BY l.media_item_id,l.is_default DESC NULLS LAST,l.sort_order NULLS LAST,f.id`;
    const files = await getFileLanguageSummaries(
        sql,
        links.map((link) => link.file_id),
    );
    const result = new Map<string, EpisodeLanguageSummary>(
        ids.map((id) => [id, { selectedFileId: null, selection: 'none', files: [] }]),
    );
    for (const link of links) {
        const summary = result.get(link.media_item_id);
        const file = files.get(link.file_id);
        if (!summary || !file) continue;
        summary.files.push({
            ...file,
            label: link.label || link.edition || basename(link.file_path),
            isDefault: link.is_default,
        });
    }
    for (const summary of result.values()) {
        const chosen = summary.files.find((file) => file.isDefault) ?? summary.files[0];
        if (chosen) {
            summary.selectedFileId = chosen.fileId;
            summary.selection = chosen.isDefault ? 'default' : 'fallback';
        }
    }
    return result;
}
