// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { CompilationRepairPreview } from '$lib/schemas/album-merge.js';
import { resolveAlbumDir } from '$lib/server/utils/music-scanner-utils.js';
import {
    albumFileCredit,
    normalizeAlbumArtist,
    resolveAlbumArtist,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/album-artist-rule.js';

interface Evidence {
    id: string;
    title: string;
    parent_id: string | null;
    created_at: Date;
    metadata_locked: boolean;
    release_ids: string[];
    track_id: string | null;
    track_type: string | null;
    track_status: string | null;
    track_locked: boolean | null;
    track_metadata: Record<string, unknown>;
    file_path: string | null;
    library_group_id: string | null;
    is_missing: boolean | null;
}

/** All children and all their files: never infer a whole album's folder from its first track. */
async function evidence(sql: postgres.Sql, ids: string[]): Promise<Evidence[]> {
    // Internal maintenance over explicitly selected album IDs, with no viewer.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<Evidence[]>`
        SELECT a.id,a.title,a.parent_id,a.created_at,a.metadata_locked,
          ARRAY(SELECT e.external_id FROM external_ids e WHERE e.media_id=a.id AND e.provider='musicbrainz_release'
                UNION SELECT a.custom_metadata->>'musicbrainz_album_id') release_ids,
          t.id track_id,t.media_type track_type,t.status track_status,t.metadata_locked track_locked,
          COALESCE(t.custom_metadata,'{}'::jsonb) || jsonb_build_object('title',t.title) track_metadata,
          f.file_path,f.library_group_id,f.is_missing
        FROM media_items a LEFT JOIN media_items t ON t.parent_id=a.id
        LEFT JOIN media_file_items fi ON fi.media_item_id=t.id
        LEFT JOIN media_files f ON f.id=fi.file_id
        WHERE a.id=ANY(${ids}::uuid[]) AND a.media_type='album' AND a.status='active'
        ORDER BY a.created_at,a.id,t.id,f.file_path LIMIT 10001
    `;
}

function groupEvidence(rows: Evidence[]): {
    groups: string[][];
    skipped: { ids: string[]; reason: string }[];
} {
    const albums = new Map<string, Evidence[]>();
    for (const row of rows) albums.set(row.id, [...(albums.get(row.id) ?? []), row]);
    const folders = new Map<string, Evidence[][]>();
    const skipped: { ids: string[]; reason: string }[] = [];
    for (const album of albums.values()) {
        const live = album.filter(
            (r) => r.track_status === 'active' && r.file_path && r.is_missing !== true,
        );
        const dirs = new Set(
            live.map((r) =>
                JSON.stringify([resolveAlbumDir(r.file_path!).albumDir, r.library_group_id]),
            ),
        );
        const reason = !live.length
            ? 'missing-folder'
            : dirs.size !== 1
              ? 'multiple-folders'
              : album.some((r) => r.track_id && r.track_type !== 'track')
                ? 'non-track-child'
                : live.some(
                        (r) =>
                            normalizeAlbumArtist(String(r.track_metadata.album ?? '')) !==
                            normalizeAlbumArtist(r.title),
                    )
                  ? 'tag-title-mismatch'
                  : null;
        if (reason) {
            skipped.push({ ids: [album[0].id], reason });
            continue;
        }
        const key = [...dirs][0];
        folders.set(key, [...(folders.get(key) ?? []), album]);
    }
    const groups: string[][] = [];
    for (const albums of folders.values()) {
        if (albums.length < 2) continue;
        const all = albums.flat();
        const ids = albums.map((a) => a[0].id);
        const live = [
            ...new Map(
                all
                    .filter(
                        (r) => r.track_status === 'active' && r.file_path && r.is_missing !== true,
                    )
                    .map((r) => [r.track_id, r]),
            ).values(),
        ];
        const credits = live.map((r) => albumFileCredit(r.track_metadata));
        const releaseIds = new Set(
            all
                .flatMap((r) => [...r.release_ids, r.track_metadata.musicbrainz_album_id])
                .filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
                .map(normalizeAlbumArtist),
        );
        const artists = new Set(
            credits.map((c) => normalizeAlbumArtist(c.primaryArtist ?? '')).filter(Boolean),
        );
        const reason = all.some((r) => r.metadata_locked || r.track_locked)
            ? 'locked'
            : releaseIds.size > 1
              ? 'release-conflict'
              : artists.size < 2 || !resolveAlbumArtist(credits).various
                ? 'album-artist-evidence'
                : null;
        if (reason) skipped.push({ ids, reason });
        else groups.push(ids);
    }
    return { groups, skipped };
}

/** Builds on 16.445's whole-folder evidence. No writes, even for an unambiguous group. */
export async function previewFolderCompilations(
    sql: postgres.Sql,
    albumId: string,
): Promise<CompilationRepairPreview> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-selected album and bounded exact-title candidates, no user browse projection
    const candidates = await sql<
        { id: string; artist_title: string | null }[]
    >`SELECT a.id,owner.title AS artist_title
        FROM media_items a JOIN media_items seed ON seed.id=${albumId} AND seed.media_type='album'
        LEFT JOIN media_items owner ON owner.id=a.parent_id AND owner.media_type='artist'
        WHERE a.media_type='album' AND a.status='active' AND NOT a.is_dismissed AND a.canonical_id IS NULL
          AND lower(trim(normalize(a.title,NFC)))=lower(trim(normalize(seed.title,NFC)))
        ORDER BY a.created_at,a.id LIMIT 201`;
    if (candidates.length > 200) return { groups: [], skipped: [], truncated: true };
    const rows = await evidence(
        sql,
        candidates.map((row) => row.id),
    );
    if (rows.length >= 10001) return { groups: [], skipped: [], truncated: true };
    // Preview never extrapolates from only the available subset of an album.
    const unsupported = new Set(
        rows
            .filter(
                (row) =>
                    !row.track_id ||
                    row.track_status !== 'active' ||
                    !row.file_path ||
                    row.is_missing,
            )
            .map((row) => row.id),
    );
    const plan = groupEvidence(rows.filter((row) => !unsupported.has(row.id)));
    return {
        groups: plan.groups
            .filter((ids) => ids.includes(albumId))
            .map((ids) => ({
                albums: ids.map((id) => ({
                    id,
                    title: rows.find((row) => row.id === id)!.title,
                    artistTitle: candidates.find((row) => row.id === id)?.artist_title ?? null,
                })),
                trackCount: new Set(
                    rows.filter((row) => ids.includes(row.id)).map((row) => row.track_id),
                ).size,
            })),
        skipped: [
            ...plan.skipped
                .filter((row) => row.ids.includes(albumId))
                .map((row) => ({ albumIds: row.ids, reason: row.reason })),
            ...[...unsupported]
                .filter((id) => id === albumId)
                .map((id) => ({ albumIds: [id], reason: 'incomplete-files' })),
        ],
        truncated: false,
    };
}
