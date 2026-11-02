// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { Logger } from '$lib/server/utils/logger.js';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { captureMusicEdit, recordMusicEdit } from './edit-recovery.js';
import { recomputeHasFilesBatch } from '$lib/server/database/queries/media-files.queries.js';

interface SourceTrack {
    id: string;
    status: string;
    is_dismissed: boolean;
    metadata_locked: boolean;
    canonical_id: string | null;
    metadata: Record<string, unknown>;
    source: string;
    file_count: number;
    missing: boolean;
    wrong_scope: boolean;
    shared_file: boolean;
    library_group_id: string | null;
}
function normalized(value: string): string {
    return value.normalize('NFC').trim().toLowerCase();
}
function singleTag(
    meta: Record<string, unknown>,
    scalar: string,
    plural: string,
): string | undefined {
    const array = meta[plural];
    if (Array.isArray(array) && array.length) {
        if (!array.every((v): v is string => typeof v === 'string' && !!v.trim())) return;
        const names = [...new Set(array.map(normalized))];
        if (names.length !== 1) return;
        const tag = meta[scalar];
        if (typeof tag === 'string' && tag.trim() && normalized(tag) !== names[0]) return;
        return names[0];
    }
    const tag = meta[scalar];
    return typeof tag === 'string' && tag.trim() ? normalized(tag) : undefined;
}

/** Provider IDs are stronger evidence than names. Never link across a known disagreement. */
async function conflictsWithMusicBrainz(
    sql: postgres.Sql,
    id: string,
    provider: string,
    key: string,
    observed: string[],
): Promise<boolean> {
    if (!observed.length) return false;
    if (new Set(observed).size !== 1) return true;
    await sql`SELECT media_id FROM external_ids WHERE media_id=${id} AND provider=${provider} FOR SHARE`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact maintenance target and provider identity collision check, no user browse projection
    const [row] = await sql<{ conflict: boolean }[]>`SELECT (
        EXISTS(SELECT 1 FROM external_ids e WHERE e.media_id=${id} AND e.provider=${provider} AND e.external_id<>ALL(${observed}::text[]))
        OR EXISTS(SELECT 1 FROM external_ids e WHERE e.media_id<>${id} AND e.provider=${provider} AND e.external_id=ANY(${observed}::text[]))
        OR EXISTS(SELECT 1 FROM media_items m WHERE m.id=${id} AND COALESCE(m.custom_metadata->>${key},'')<>'' AND m.custom_metadata->>${key}<>ALL(${observed}::text[]))
        OR EXISTS(SELECT 1 FROM media_items m WHERE m.id<>${id} AND m.status='active' AND m.canonical_id IS NULL
            AND m.media_type=${provider === 'musicbrainz' ? 'artist' : 'album'} AND m.custom_metadata->>${key}=ANY(${observed}::text[]))
    ) AS conflict`;
    return row.conflict;
}
function providerTagIds(tracks: SourceTrack[], key: string): string[] {
    return tracks.flatMap((track) => {
        const value = track.metadata[key];
        return (Array.isArray(value) ? value : [value])
            .filter((id): id is string => typeof id === 'string' && !!id.trim())
            .map((id) => id.trim().toLowerCase());
    });
}

/** Only fill a missing parent from unanimous current file tags and one existing scoped identity.
 * Each transaction is bounded. A keyset walk lets ambiguous early rows coexist with later repairs.
 * No identities are created/removed and Undo prevents repeating the same automatic decision.
 */
export async function repairOrphanMusicLinks(
    sql: postgres.Sql,
    shouldStop: () => boolean = () => false,
): Promise<number> {
    let after = '00000000-0000-0000-0000-000000000000';
    let repaired = 0;
    for (;;) {
        if (shouldStop()) break;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal music maintenance, exact missing-parent candidates only
        const candidates = await sql<{ id: string }[]>`SELECT id FROM media_items
            WHERE media_type IN ('album','track') AND parent_id IS NULL AND status='active'
                AND canonical_id IS NULL AND NOT is_dismissed AND NOT metadata_locked
                AND id>${after}::uuid ORDER BY id LIMIT 50`;
        if (!candidates.length) break;
        for (const candidate of candidates) {
            if (shouldStop()) return repaired;
            let changed = false;
            try {
                changed = await withTx(sql, async (tx) => {
                    // NO KEY UPDATE permits scanner FK checks. Serializable
                    // evidence reads also fence concurrent new descendants/links.
                    await tx`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
                    await tx`SET LOCAL lock_timeout='2s'`;
                    await tx`SET LOCAL statement_timeout='10s'`;
                    // Discover the full owner set without taking album-first
                    // locks. Lock all containers together after resolving it.
                    const initial = await captureMusicEdit(tx, [candidate.id], false);
                    const row = initial[0];
                    if (
                        !row ||
                        row.value.parent_id ||
                        row.value.metadata_locked ||
                        row.value.is_dismissed ||
                        row.value.status !== 'active' ||
                        row.value.canonical_id
                    )
                        return false;
                    const isAlbum = row.value.media_type === 'album';
                    if (isAlbum) {
                        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact album owner; malformed descendants are a conflict, never ignored
                        const [shape] = await tx<
                            { bad: boolean }[]
                        >`SELECT EXISTS(SELECT 1 FROM media_items WHERE parent_id=${row.id} AND media_type<>'track') AS bad`;
                        if (shape.bad) return false;
                    }
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact bounded source set for owner discovery; locked below after containers
                    const sources = await tx<
                        { id: string }[]
                    >`SELECT id FROM media_items WHERE media_type='track'
                    AND ${isAlbum ? tx`parent_id=${row.id}` : tx`id=${row.id}`} ORDER BY id LIMIT 201`;
                    if (!sources.length || sources.length > 200) return false;
                    // Read every child/file, including inactive, missing, locked and hidden ones. Those are blockers, not evidence to omit.
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact orphan's source evidence, bounded with explicit overflow refusal
                    const tracks = await tx<
                        SourceTrack[]
                    >`SELECT t.id,t.status,t.is_dismissed,t.metadata_locked,t.canonical_id,
                    COALESCE(t.custom_metadata,'{}'::jsonb) metadata,t.library_group_id,
                    string_agg(jsonb_build_array(f.id,f.file_mtime,f.file_size_bytes,f.file_hash_head)::text,'|' ORDER BY f.id) source,
                    count(f.id)::int file_count,COALESCE(bool_or(f.is_missing),false) missing,
                    bool_or(f.library_group_id IS DISTINCT FROM t.library_group_id) wrong_scope,
                    bool_or(EXISTS(SELECT 1 FROM media_file_items other WHERE other.file_id=f.id AND other.media_item_id<>t.id)) shared_file
                    FROM media_items t LEFT JOIN media_file_items fi ON fi.media_item_id=t.id
                    LEFT JOIN media_files f ON f.id=fi.file_id
                    WHERE t.media_type='track' AND ${isAlbum ? tx`t.parent_id=${row.id}` : tx`t.id=${row.id}`}
                    GROUP BY t.id ORDER BY t.id LIMIT 201`;
                    if (
                        !tracks.length ||
                        tracks.length > 200 ||
                        tracks.some(
                            (t) =>
                                t.file_count !== 1 ||
                                t.missing ||
                                t.wrong_scope ||
                                t.shared_file ||
                                t.metadata_locked ||
                                t.is_dismissed ||
                                t.status !== 'active' ||
                                t.canonical_id,
                        )
                    )
                        return false;
                    const names = tracks.map((t) => ({
                        album: singleTag(t.metadata, 'album', 'albums'),
                        artist: singleTag(t.metadata, 'album_artist', 'album_artists'),
                    }));
                    if (
                        names.some((n) => !n.album || !n.artist) ||
                        new Set(names.map((n) => JSON.stringify(n))).size !== 1
                    )
                        return false;
                    // An album's own label must agree too. Nothing guesses from track performer names.
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact orphan identity, no viewer
                    const [title] = await tx<
                        { title: string; library_group_id: string | null }[]
                    >`SELECT title,library_group_id FROM media_items WHERE id=${row.id}`;
                    if (isAlbum && normalized(title.title) !== names[0].album) return false;
                    if (tracks.some((t) => t.library_group_id !== title.library_group_id))
                        return false;
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- unique scoped existing artist identity; no fuzzy title or conjunction inference
                    const artists = await tx<
                        { id: string }[]
                    >`SELECT id FROM media_items WHERE media_type='artist' AND parent_id IS NULL
                    AND status='active' AND NOT is_dismissed AND canonical_id IS NULL AND NOT metadata_locked
                    AND library_group_id IS NOT DISTINCT FROM ${title.library_group_id}
                    AND lower(trim(normalize(title,NFC)))=${names[0].artist!} ORDER BY id LIMIT 2`;
                    if (artists.length !== 1) return false;
                    const artistIds = providerTagIds(tracks, 'musicbrainz_album_artist_ids');
                    const releaseIds = providerTagIds(tracks, 'musicbrainz_album_id');
                    let target = artists[0].id;
                    if (!isAlbum) {
                        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- unique scoped existing album with the unanimous tagged owner
                        const albums = await tx<
                            { id: string }[]
                        >`SELECT id FROM media_items WHERE media_type='album'
                        AND parent_id=${target} AND status='active' AND NOT is_dismissed AND canonical_id IS NULL AND NOT metadata_locked
                        AND library_group_id IS NOT DISTINCT FROM ${title.library_group_id}
                        AND lower(trim(normalize(title,NFC)))=${names[0].album!} ORDER BY id LIMIT 2`;
                        if (albums.length !== 1) return false;
                        target = albums[0].id;
                    }
                    const containers = [...new Set([artists[0].id, isAlbum ? row.id : target])];
                    // Match NFO/manual reparenting: all containers in UUID
                    // order, without blocking the scanner's FK KEY SHARE checks.
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact resolved maintenance owners, scanner-compatible lock order
                    await tx`SELECT id FROM media_items WHERE id=ANY(${containers}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
                    // Only leaf tracks need FOR UPDATE, to fence new file links.
                    // Serializable row locks reject evidence changed after discovery.
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact previously discovered source tracks, after container locks
                    await tx`SELECT id FROM media_items WHERE id=ANY(${sources.map((t) => t.id)}::uuid[]) ORDER BY id FOR UPDATE`;
                    await tx`SELECT fi.file_id FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id
                        WHERE fi.media_item_id=ANY(${sources.map((t) => t.id)}::uuid[]) FOR SHARE OF fi,f`;
                    const before = await captureMusicEdit(tx, [candidate.id]);
                    if (
                        await conflictsWithMusicBrainz(
                            tx,
                            artists[0].id,
                            'musicbrainz',
                            'musicbrainz_artist_id',
                            artistIds,
                        )
                    )
                        return false;
                    if (
                        await conflictsWithMusicBrainz(
                            tx,
                            isAlbum ? row.id : target,
                            'musicbrainz_release',
                            'musicbrainz_album_id',
                            releaseIds,
                        )
                    )
                        return false;
                    const fingerprint = createHash('sha256')
                        .update(
                            JSON.stringify({
                                target,
                                names,
                                artistIds,
                                releaseIds,
                                tracks: tracks.map((t) => [t.id, t.source]),
                            }),
                        )
                        .digest('hex');
                    const [undone] =
                        await tx`SELECT id FROM music_edit_receipts WHERE target_id=${row.id} AND kind='hierarchy'
                    AND input_fingerprint=${fingerprint} AND undone_at IS NOT NULL LIMIT 1`;
                    if (undone) return false;
                    await tx`UPDATE media_items SET parent_id=${target},updated_at=clock_timestamp() WHERE id=${row.id}`;
                    await recomputeHasFilesBatch(tx, [row.id, target, artists[0].id]);
                    await recordMusicEdit(
                        tx,
                        row.id,
                        'hierarchy',
                        'system task',
                        before,
                        fingerprint,
                    );
                    return true;
                });
            } catch (error) {
                Logger.for('OrphanMusicLinks').warn(
                    'Skipped missing music link after conflicting source update',
                    { mediaId: candidate.id },
                    error instanceof Error ? error : undefined,
                );
            }
            if (changed) repaired++;
            after = candidate.id;
        }
    }
    return repaired;
}
