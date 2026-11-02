// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import type postgres from 'postgres';
import { findMusicAlbumFolderTracks } from '$lib/server/database/queries/music-album-folder.queries.js';
import {
    resolveAlbumDir,
    folderAlbumTitle,
    hasMatchingDiscTitles,
    cleanAlbumTitle,
} from '$lib/server/utils/music-scanner-utils.js';
import type { AudioTagResult } from './audio-tag-parser.js';

function normalized(value: unknown): string {
    return typeof value === 'string'
        ? value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
        : '';
}

function albumTitleKey(value: unknown, discEvidence: boolean): string {
    return normalized(typeof value === 'string' ? folderAlbumTitle(value, discEvidence) : value);
}

function creditKey(scalar: unknown, multiple: unknown): string {
    const values = Array.isArray(multiple) && multiple.length > 1 ? multiple : [scalar];
    return JSON.stringify(values.map(normalized));
}

function compatibleIds(incoming: string | undefined, stored: unknown[]): boolean {
    const ids = new Set(stored.map(normalized).filter(Boolean));
    if (incoming) ids.add(normalized(incoming));
    return ids.size <= 1;
}

/**
 * An album's display parent can change independently of its files' ALBUMARTIST
 * (e.g. a curated compilation filed under VA). Before the parent/title upsert,
 * reuse a compatible album already owning this folder and these file credits.
 * An unrepaired disc split prefers its exact title, then the oldest album.
 * Never infer identity from the track performer, year, or release-group alone.
 * Paths remain case-sensitive and literal; only CD/Disc folders collapse.
 */
export async function findExistingFolderAlbum(
    sql: postgres.Sql,
    albumDir: string,
    title: string,
    tags: AudioTagResult,
    libraryGroupId: string | null,
    excludeFilePath?: string,
    allowInconsistentAlbumArtists = false,
    discEvidence = false,
    folderCompilation = false,
): Promise<string | null> {
    if (!tags.album?.trim()) return null;
    const found = await findMusicAlbumFolderTracks(sql, albumDir + path.sep, libraryGroupId);
    if (found.length >= 1001) return null;
    // A retag's metadata has already been persisted. It must not use itself
    // as evidence that its newly changed album artist belongs to the old album.
    const rows = found.filter(
        (row) =>
            row.file_path !== excludeFilePath &&
            resolveAlbumDir(row.file_path).albumDir === albumDir,
    );
    discEvidence ||= hasMatchingDiscTitles(
        tags.album,
        rows.flatMap((row) => [row.album_title, row.track_metadata.album]),
    );
    const credit = creditKey(tags.albumArtist, tags.albumArtists);
    const candidates = rows.filter((row) => {
        const aliases: unknown = row.album_metadata.scan_aliases;
        const titles = [row.album_title, ...(Array.isArray(aliases) ? aliases : [])];
        return (
            titles.some(
                (v) => albumTitleKey(v, discEvidence) === albumTitleKey(title, discEvidence),
            ) &&
            albumTitleKey(row.track_metadata.album, discEvidence) ===
                albumTitleKey(tags.album, discEvidence) &&
            (row.album_locked ||
                allowInconsistentAlbumArtists ||
                folderCompilation ||
                creditKey(row.track_metadata.album_artist, row.track_metadata.album_artists) ===
                    credit)
        );
    });
    // Keep the existing ambiguity guard for releases without disc evidence.
    if (
        !discEvidence &&
        !folderCompilation &&
        new Set(candidates.map((row) => row.album_id)).size > 1
    )
        return null;
    // Keep an unrepaired split on its exact raw title where possible,
    // otherwise reuse the oldest candidate. Sorted here, not in SQL: an
    // ORDER BY would defeat the query's LIMIT early stop on large prefixes.
    const ordered = [...candidates].sort(
        (a, b) =>
            new Date(a.album_created_at).getTime() - new Date(b.album_created_at).getTime() ||
            a.album_id.localeCompare(b.album_id),
    );
    const incomingTitle = normalized(cleanAlbumTitle(tags.album));
    const exact = ordered.find(
        (row) => normalized(cleanAlbumTitle(row.album_title)) === incomingTitle,
    );
    const albumId = exact?.album_id ?? ordered[0]?.album_id;
    if (!albumId) return null;
    // Inspect every file of the selected album, including conflicting credits.
    const selected = rows.filter((row) => row.album_id === albumId);
    if (selected.length !== candidates.filter((row) => row.album_id === albumId).length)
        return null;
    // A compilation can reuse a fragment despite per-track album credits, but
    // every candidate must agree about the release before choosing a survivor.
    const evidence = folderCompilation ? candidates : selected;
    if (
        !compatibleIds(
            tags.releaseMbid,
            evidence.flatMap((row) => [
                ...row.release_ids,
                row.album_metadata.musicbrainz_album_id,
                row.track_metadata.musicbrainz_album_id,
            ]),
        )
    )
        return null;
    if (
        !compatibleIds(
            tags.releaseGroupMbid,
            evidence.flatMap((row) => [
                ...row.release_group_ids,
                row.album_metadata.musicbrainz_releasegroup_id,
                row.track_metadata.musicbrainz_releasegroup_id,
            ]),
        )
    )
        return null;
    return albumId;
}
