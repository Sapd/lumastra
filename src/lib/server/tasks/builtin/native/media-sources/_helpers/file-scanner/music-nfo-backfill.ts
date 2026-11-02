// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import type postgres from 'postgres';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import {
    readAlbumNfo,
    readArtistNfo,
    type AlbumNfoData,
    type ArtistNfoData,
} from '$lib/server/utils/nfo-parser.js';
import { withTx, isInOpenTransaction } from '$lib/server/database/with-tx.js';
import {
    readMusicNfoSnapshot,
    lockMusicNfoSnapshot,
    readMusicNfoFolderEvidence,
    type MusicNfoFolderEvidence,
    writeMusicNfoBackfill,
    type MusicNfoSnapshot,
    type MusicNfoSource,
} from '$lib/server/database/queries/music-nfo.queries.js';
import {
    DISC_FOLDER_PATTERN,
    folderAlbumTitle,
    hasMatchingDiscTitles,
    resolveAlbumDir,
} from '$lib/server/utils/music-scanner-utils.js';
import type { FileScannerContext } from './shared.js';

// Same NFC/whitespace/case comparison as folder album matching. Do not invent
// identity from a filename or force a historical display title over real tags.
function normalized(value: unknown): string {
    return typeof value === 'string'
        ? value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
        : '';
}
function albumTitleKey(value: unknown, discEvidence: boolean): string {
    return normalized(typeof value === 'string' ? folderAlbumTitle(value, discEvidence) : value);
}
function compatibleId(incoming: string | undefined, evidence: unknown[]): boolean {
    const ids = new Set(evidence.map(normalized).filter(Boolean));
    if (incoming) ids.add(normalized(incoming));
    return ids.size <= 1;
}
async function mtime(filePath: string): Promise<string | null> {
    try {
        return (await safeStat(filePath)).mtime.toISOString();
    } catch {
        return null;
    }
}
function albumCompatible(
    data: AlbumNfoData,
    snapshot: MusicNfoSnapshot,
    rows: MusicNfoFolderEvidence[],
): boolean {
    if (rows.length >= 1001 || rows.some((row) => row.album_id !== snapshot.album.id)) return false;
    const taggedTitles = [
        snapshot.track_metadata?.album,
        ...rows.map((row) => row.track_metadata.album),
    ].filter((v) => normalized(v));
    const titles = taggedTitles.length ? taggedTitles : [snapshot.album.title];
    const discEvidence =
        rows.some((row) => resolveAlbumDir(row.file_path).discNumber !== null) ||
        titles.some((title) => typeof title === 'string' && hasMatchingDiscTitles(title, titles));
    if (
        data.title &&
        titles.some(
            (title) =>
                albumTitleKey(title, discEvidence) !== albumTitleKey(data.title, discEvidence),
        )
    )
        return false;
    const albumMeta = snapshot.album.custom_metadata;
    return (
        compatibleId(data.musicbrainzAlbumId, [
            albumMeta?.musicbrainz_album_id,
            snapshot.track_metadata?.musicbrainz_album_id,
            ...snapshot.identities
                .filter((id) => id.provider === 'musicbrainz_release')
                .map((id) => id.external_id),
            ...rows.flatMap((row) => [...row.release_ids, row.track_metadata.musicbrainz_album_id]),
        ]) &&
        compatibleId(data.musicbrainzReleaseGroupId, [
            albumMeta?.musicbrainz_releasegroup_id,
            snapshot.track_metadata?.musicbrainz_releasegroup_id,
            ...snapshot.identities
                .filter((id) => id.provider === 'musicbrainz_releasegroup')
                .map((id) => id.external_id),
            ...rows.flatMap((row) => [
                ...row.release_group_ids,
                row.track_metadata.musicbrainz_releasegroup_id,
            ]),
        ])
    );
}
function artistCompatible(
    data: ArtistNfoData,
    snapshot: MusicNfoSnapshot,
    rows: MusicNfoFolderEvidence[],
): boolean {
    const artist = snapshot.artist;
    if (!artist || (data.name && normalized(data.name) !== normalized(artist.title))) return false;
    const tagIds = [
        snapshot.track_metadata,
        ...rows
            .filter((row) => row.album_id === snapshot.album.id)
            .map((row) => row.track_metadata),
    ].flatMap((meta) => {
        const ids = meta?.musicbrainz_album_artist_ids;
        // Plural collaboration credits and track-performer IDs do not assert a
        // single album-artist identity. Do not invent a precedence for them.
        return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' ? [ids[0]] : [];
    });
    return compatibleId(data.musicbrainzArtistId, [
        ...tagIds,
        artist.custom_metadata?.musicbrainz_artist_id,
        ...snapshot.identities
            .filter((id) => id.media_id === artist.id && id.provider === 'musicbrainz')
            .map((id) => id.external_id),
    ]);
}

async function backfill(
    sql: postgres.Sql,
    source: MusicNfoSource,
    snapshot: MusicNfoSnapshot,
    kind: 'album' | 'artist',
    albumDir: string,
    context: FileScannerContext,
    signal?: AbortSignal,
): Promise<void> {
    const owner = kind === 'album' ? snapshot.album : snapshot.artist;
    if (!owner || owner.metadata_locked || signal?.aborted || context.abortSignal?.aborted) return;
    const dir = kind === 'album' ? albumDir : path.dirname(albumDir);
    if (kind === 'artist') {
        // Preserve the existing artist-directory policy, including its NFC rule.
        const directoryKey = (s: string): string =>
            s
                .normalize('NFC')
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9 ]/g, '');
        if (directoryKey(path.basename(dir)) !== directoryKey(owner.title)) return;
    }
    const nfoPath = path.join(dir, `${kind}.nfo`);
    const initialMtime = await mtime(nfoPath);
    if (!initialMtime) return;
    if (
        owner.custom_metadata?.nfo_source_path === nfoPath &&
        owner.custom_metadata.nfo_mtime === initialMtime
    )
        return;
    const rows = await readMusicNfoFolderEvidence(sql, albumDir, DISC_FOLDER_PATTERN.source);
    if (rows.length >= 1001) return;
    // A later independent attachment may linearize after this bounded check.
    // Existing evidence, however, must be locked and remain unchanged.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted || context.abortSignal?.aborted) return;
        const currentMtime = attempt === 0 ? initialMtime : await mtime(nfoPath);
        if (!currentMtime) return;
        if (
            owner.custom_metadata?.nfo_source_path === nfoPath &&
            owner.custom_metadata.nfo_mtime === currentMtime
        )
            return;
        const data = kind === 'album' ? await readAlbumNfo(dir) : await readArtistNfo(dir);
        if (signal?.aborted || context.abortSignal?.aborted) return;
        // A changed/disappearing sidecar is stale evidence, never a successful check.
        if ((await mtime(nfoPath)) !== currentMtime) return;
        const updates: Record<string, unknown> = {
            nfo_source_path: nfoPath,
            nfo_mtime: currentMtime,
        };
        const existing = owner.custom_metadata ?? {};
        let year = owner.year;
        if (kind === 'album') {
            const album = data as AlbumNfoData;
            if (!albumCompatible(album, snapshot, rows)) return;
            if (!(
                album.year ||
                album.genre ||
                album.review ||
                album.musicbrainzAlbumId ||
                album.musicbrainzReleaseGroupId
            ))
                return;
            if (!existing.genre && album.genre) updates.genre = album.genre;
            if (!existing.description && album.review) updates.description = album.review;
            if (!existing.musicbrainz_album_id && album.musicbrainzAlbumId)
                updates.musicbrainz_album_id = album.musicbrainzAlbumId;
            if (!existing.musicbrainz_releasegroup_id && album.musicbrainzReleaseGroupId)
                updates.musicbrainz_releasegroup_id = album.musicbrainzReleaseGroupId;
            if (!year && album.year) year = album.year;
        } else {
            const artist = data as ArtistNfoData;
            if (!artistCompatible(artist, snapshot, rows)) return;
            if (!(artist.biography || artist.genre || artist.musicbrainzArtistId)) return;
            if (!existing.biography && artist.biography) updates.biography = artist.biography;
            if (!existing.genre && artist.genre) updates.genre = artist.genre;
            if (!existing.musicbrainz_artist_id && artist.musicbrainzArtistId)
                updates.musicbrainz_artist_id = artist.musicbrainzArtistId;
        }
        try {
            const changed = await withTx(sql, async (tx) => {
                await lockMusicNfoSnapshot(tx, source, snapshot, rows, false);
                if (signal?.aborted || context.abortSignal?.aborted) return false;
                const current = await readMusicNfoSnapshot(tx, source);
                if (!current || JSON.stringify(current.token) !== JSON.stringify(snapshot.token))
                    return false;
                if (
                    JSON.stringify(
                        await readMusicNfoFolderEvidence(tx, albumDir, DISC_FOLDER_PATTERN.source),
                    ) !== JSON.stringify(rows)
                )
                    return false;
                if (signal?.aborted || context.abortSignal?.aborted) return false;
                const written = await writeMusicNfoBackfill(
                    tx,
                    owner,
                    { ...existing, ...updates },
                    year,
                );
                signal?.throwIfAborted();
                context.abortSignal?.throwIfAborted();
                return written;
            });
            if (changed)
                context.logger.debug(`[FileScanner] Backfilled ${kind} from NFO`, {
                    id: owner.id,
                    nfoPath,
                });
            return;
        } catch (error) {
            if ((error as { code?: string }).code !== '55P03') throw error;
            if (attempt === 2 || signal?.aborted || context.abortSignal?.aborted) return;
            // This transaction does NO filesystem work and makes NO metadata
            // writes. Once contention settles it releases every lock BEFORE the
            // next read/stat. Preserve the original DB snapshot: user corrections
            // still suppress the stale scan rather than becoming its new input.
            await withTx(sql, (tx) => lockMusicNfoSnapshot(tx, source, snapshot, rows));
        }
    }
}

/** Both scanner paths supply the actual linked physical file, never a loose target id. */
export async function backfillMusicNfo(
    sql: postgres.Sql,
    source: MusicNfoSource,
    albumDir: string,
    context: FileScannerContext,
    signal?: AbortSignal,
): Promise<void> {
    // Savepoint release does not release row locks. Real scanner callers use
    // transaction-free handles; a nested caller must defer to a later scan,
    // rather than carry an outer transaction's locks through sidecar I/O.
    if (await isInOpenTransaction(sql)) {
        context.logger.debug('[FileScanner] Deferred NFO backfill inside an open transaction', {
            fileId: source.fileId,
        });
        return;
    }
    const snapshot = await readMusicNfoSnapshot(sql, source);
    if (!snapshot) return;
    await backfill(sql, source, snapshot, 'album', albumDir, context, signal);
    // Refresh after our own album write, but never follow a reparent into a new
    // artist/album using evidence from the old caller's file context.
    const current = await readMusicNfoSnapshot(sql, source);
    if (
        !current ||
        current.album.id !== snapshot.album.id ||
        current.artist?.id !== snapshot.artist?.id
    )
        return;
    await backfill(sql, source, current, 'artist', albumDir, context, signal);
}
