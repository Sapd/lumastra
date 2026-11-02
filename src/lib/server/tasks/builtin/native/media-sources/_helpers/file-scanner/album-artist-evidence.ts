// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { deriveArtistName, resolveAlbumDir } from '$lib/server/utils/music-scanner-utils.js';
import {
    propagateHasFiles,
    recomputeHasFilesBatch,
} from '$lib/server/database/queries/media-files.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    findDuplicateAlbumByTitle,
    reparentTracksToAlbum,
    deleteEmptyAlbum,
    reparentAlbumToArtist,
} from '$lib/server/database/queries/artist-merge.queries.js';
import { findAlbumArtistEvidence } from '$lib/server/database/queries/music-album-folder.queries.js';
import {
    albumFileCredit,
    resolveAlbumArtist,
    type AlbumArtistDecision,
    type AlbumFileCredit,
    VARIOUS_ARTISTS_MBID,
} from './album-artist-rule.js';
import {
    getRelease,
    getReleaseGroup,
    getArtist,
    type MBArtistCredit,
} from '$lib/server/providers/implementations/musicbrainz/api-client.js';
import { getArtistCreditEvidence } from './artist-credit-evidence.js';
import { resolveArtistCredit } from './artist-credit.js';
import type { FileScannerContext } from './shared.js';

/** All maintenance passes consult the same album-wide precedence rule. */
export async function albumArtistDecision(
    sql: postgres.Sql,
    albumId: string,
    context: { logger: Pick<FileScannerContext['logger'], 'info'> },
): Promise<AlbumArtistDecision | undefined> {
    const row = await findAlbumArtistEvidence(sql, albumId);
    if (!row) return undefined;
    const evidence = await getArtistCreditEvidence(sql);
    const files = row.track_metadata.map((meta) => {
        const file = albumFileCredit(meta);
        file.releaseMbid ??= row.release_mbid ?? undefined;
        file.releaseGroupMbid ??= row.release_group_mbid ?? undefined;
        if (!Array.isArray(meta.artists) && file.primaryArtist)
            file.primaryArtist = resolveArtistCredit(file.primaryArtist, evidence)[0];
        return file;
    });
    // Stored evidence only: this function is also called under FOR UPDATE locks.
    const result = resolveAlbumArtist(files, {
        locked: row.metadata_locked,
        currentArtist: row.artist_title ?? undefined,
        creditEvidence: evidence,
        fallbackArtist: row.file_path
            ? deriveArtistName({
                  filePath: row.file_path,
                  albumDir: resolveAlbumDir(row.file_path).albumDir,
                  libraryRoot: row.library_root ?? undefined,
              })
            : 'Unknown Artist',
    });
    if (result.inconsistentAlbumArtists)
        context.logger.info(
            '[FileScanner] Inconsistent ALBUMARTIST tags; using album fallback evidence',
            { albumId },
        );
    return result;
}

/** Keep folder identity while correcting an unlocked display parent. */
export async function alignFolderAlbumParent(
    sql: postgres.Sql,
    albumId: string,
    artistId: string,
    ruleSource: AlbumArtistDecision['source'] = 'album-tag',
): Promise<string> {
    return withTx(sql, async (tx) => {
        const [album] = await tx<
            { title: string; parent_id: string | null; metadata_locked: boolean }[]
        >`
            SELECT title,parent_id,metadata_locked FROM media_items WHERE id=${albumId} FOR UPDATE
        `;
        if (!album || album.metadata_locked || album.parent_id === artistId) return albumId;
        // A locked track also locks its curated album placement. Never move
        // it indirectly by reparenting or emptying its containing album.
        const [lockedTrack] =
            await tx`SELECT id FROM media_items WHERE parent_id=${albumId} AND metadata_locked LIMIT 1`;
        if (lockedTrack) return albumId;
        const duplicate = await findDuplicateAlbumByTitle(tx, artistId, album.title);
        if (duplicate && duplicate !== albumId) {
            const [lockedTargetTrack] =
                await tx`SELECT id FROM media_items WHERE parent_id=${duplicate} AND metadata_locked LIMIT 1`;
            if (lockedTargetTrack) return albumId;
            await reparentTracksToAlbum(tx, albumId, duplicate);
            await deleteEmptyAlbum(tx, albumId, duplicate, ruleSource);
            await propagateHasFiles(tx, duplicate);
            if (album.parent_id) await recomputeHasFilesBatch(tx, [albumId, album.parent_id]);
            return duplicate;
        }
        await reparentAlbumToArtist(tx, albumId, artistId, {
            respectMetadataLock: true,
            ruleSource,
        });
        await propagateHasFiles(tx, albumId);
        if (album.parent_id) await recomputeHasFilesBatch(tx, [album.parent_id]);
        return albumId;
    });
}

interface ReleaseArtistCredit {
    ids: string[];
    name: string;
}
const mbCreditCache = new Map<string, { at: number; value: Promise<ReleaseArtistCredit | null> }>();

async function mbCredit(
    kind: 'release' | 'group' | 'artist',
    id: string,
): Promise<ReleaseArtistCredit | null> {
    const key = `${kind}:${id}`;
    const cached = mbCreditCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const value = (async (): Promise<ReleaseArtistCredit | null> => {
        if (kind === 'artist') {
            const artist = await getArtist(id);
            return artist ? { ids: [artist.id], name: artist.name } : null;
        }
        const release = kind === 'release' ? await getRelease(id) : await getReleaseGroup(id);
        const credits: MBArtistCredit[] = release?.['artist-credit'] ?? [];
        return credits.length
            ? {
                  ids: credits.map((c) => c.artist.id),
                  name: credits
                      .map((c) => (c.name || c.artist.name) + (c.joinphrase ?? ''))
                      .join(''),
              }
            : null;
    })();
    if (mbCreditCache.size >= 1000) mbCreditCache.clear();
    mbCreditCache.set(key, { at: Date.now(), value });
    try {
        return await value;
    } catch (error) {
        mbCreditCache.delete(key);
        throw error;
    }
}

/** Fetch release credits only below ALBUMARTIST; reuse the rate-limited client. */
export async function loadReleaseArtistEvidence(
    files: AlbumFileCredit[],
    context: { logger: Pick<FileScannerContext['logger'], 'info'> },
): Promise<void> {
    if (resolveAlbumArtist(files).source === 'album-tag') return;
    const failed = new Set<string>();
    for (const file of files) {
        const key = file.releaseMbid ?? file.releaseGroupMbid ?? file.releaseArtistIds?.join();
        if (key && failed.has(key)) continue;
        try {
            const credit = file.releaseMbid
                ? await mbCredit('release', file.releaseMbid)
                : file.releaseGroupMbid
                  ? await mbCredit('group', file.releaseGroupMbid)
                  : null;
            if (credit) {
                file.releaseArtistIds = credit.ids;
                file.releaseArtist = credit.name;
            } else if (
                file.releaseArtistIds?.length &&
                !file.releaseArtist &&
                !file.releaseArtistIds.includes(VARIOUS_ARTISTS_MBID)
            ) {
                const artists: (ReleaseArtistCredit | null)[] = [];
                for (const id of file.releaseArtistIds) artists.push(await mbCredit('artist', id));
                if (artists.every((a) => a !== null))
                    file.releaseArtist = artists.map((a) => a?.name).join(' & ');
            }
        } catch (error) {
            if (key) failed.add(key);
            context.logger.info(
                '[FileScanner] MusicBrainz release artist unavailable; using remaining album evidence',
                {
                    error: error instanceof Error ? error.message : String(error),
                },
            );
        }
    }
}
