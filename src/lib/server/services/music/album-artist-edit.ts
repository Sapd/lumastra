// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { recomputeHasFilesBatch } from '$lib/server/database/queries/media-files.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    reparentAlbumToArtist,
    ManualAlbumArtistAssignmentError,
} from '$lib/server/database/queries/artist-merge.queries.js';
import { insertScannedMediaItem } from '$lib/server/database/queries/media-items.queries.js';
import { captureMusicEdit, recordMusicEdit, MusicEditConflict } from './edit-recovery.js';

export async function albumArtistSnapshot(
    sql: postgres.Sql,
    id: string,
): Promise<string | undefined> {
    // Search GETs are plain reads. Only ownership, title, scope and protection
    // can stale an assignment; unrelated enrichment and xmin are not inputs.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact admin-selected ownership snapshot, not a catalog listing
    const [row] = await sql`
        SELECT title,parent_id,library_group_id,status,canonical_id,is_dismissed,
        metadata_locked,metadata_locked_by,metadata_locked_at::text FROM media_items
        WHERE id=${id} AND media_type='album'`;
    if (!row) return undefined;
    return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

export async function saveAlbumArtist(
    sql: postgres.Sql,
    albumId: string,
    actor: string,
    choice: { artistId: string } | { artistName: string },
    snapshot?: string,
): Promise<{ artistId: string; artistTitle: string }> {
    if (!actor.trim()) throw new MusicEditConflict('An authenticated actor is required.');
    try {
        return await withTx(sql, async (tx) => {
            await tx`SET LOCAL lock_timeout='2s'`;
            const initial = await captureMusicEdit(tx, [albumId], false);
            if (
                !initial.length ||
                initial[0].value.status !== 'active' ||
                initial[0].value.canonical_id ||
                initial[0].value.is_dismissed
            )
                throw new ManualAlbumArtistAssignmentError('missing-album');
            if (initial[0].value.media_type !== 'album')
                throw new ManualAlbumArtistAssignmentError('not-album');
            const artistId =
                'artistId' in choice
                    ? choice.artistId
                    : await insertScannedMediaItem(tx, {
                          title: choice.artistName,
                          mediaType: 'artist',
                          libraryGroupId:
                              typeof initial[0].value.library_group_id === 'string'
                                  ? initial[0].value.library_group_id
                                  : undefined,
                      });
            const oldParent = initial[0].value.parent_id;
            // Match scanner/NFO owner locking before capturing or updating any
            // container. New artists are private to this transaction until commit.
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact ownership participants in scanner UUID order
            await tx`SELECT id FROM media_items WHERE id=ANY(${[albumId, artistId, ...(typeof oldParent === 'string' ? [oldParent] : [])]}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
            const before = await captureMusicEdit(tx, [albumId]);
            if (
                !before.length ||
                before[0].value.status !== 'active' ||
                before[0].value.canonical_id ||
                before[0].value.is_dismissed
            )
                throw new ManualAlbumArtistAssignmentError('missing-album');
            if (before[0].value.media_type !== 'album')
                throw new ManualAlbumArtistAssignmentError('not-album');
            if (
                before[0].value.parent_id !== oldParent ||
                before[0].value.library_group_id !== initial[0].value.library_group_id ||
                (snapshot !== undefined && snapshot !== (await albumArtistSnapshot(tx, albumId)))
            )
                throw new MusicEditConflict(
                    'Album details changed. Search again before choosing its artist.',
                );
            if ('artistName' in choice)
                await tx`UPDATE media_items SET metadata_locked=true,metadata_locked_by=${actor},metadata_locked_at=clock_timestamp() WHERE id=${artistId}`;
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact admin-selected owner; never assign redirected or hidden artists
            const [artist] = await tx<
                { title: string }[]
            >`SELECT title FROM media_items WHERE id=${artistId}
            AND media_type='artist' AND parent_id IS NULL AND status='active' AND canonical_id IS NULL
            AND NOT is_dismissed FOR NO KEY UPDATE`;
            if (!artist) throw new ManualAlbumArtistAssignmentError('missing-artist');
            await reparentAlbumToArtist(tx, albumId, artistId, { manualActor: actor });
            await recomputeHasFilesBatch(tx, [
                albumId,
                artistId,
                ...(typeof before[0].value.parent_id === 'string'
                    ? [before[0].value.parent_id]
                    : []),
            ]);
            await recordMusicEdit(tx, albumId, 'album-artist', actor, before);
            return { artistId, artistTitle: artist.title };
        });
    } catch (error) {
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['55P03', '40P01', '40001'].includes(String(error.code))
        )
            throw new MusicEditConflict('Album or artist changed during the save. Search again.');
        throw error;
    }
}
