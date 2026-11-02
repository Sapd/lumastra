// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { captureMusicEdit, recordMusicEdit } from './edit-recovery.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { insertScannedMediaItem } from '$lib/server/database/queries/media-items.queries.js';
import { isVariousArtistsName } from '$lib/shared/various-artists.js';
import type { ArtistCreditReview, ConfirmArtistCredits } from '$lib/schemas/music-credit-review.js';

interface Item {
    id: string;
    title: string | null;
    title_source: string | null;
    parent_id: string | null;
    media_type: string;
    status: string;
    is_dismissed: boolean;
    canonical_id: string | null;
    is_various_artists: boolean;
    metadata_locked: boolean;
    metadata_locked_by: string | null;
    lock_version: string | null;
    library_group_id: string | null;
    custom_metadata: Record<string, unknown>;
    version: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function ids(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && UUID.test(id))
        : [];
}
function stored(value: unknown): Array<{ id: string | null; credited_name: string }> {
    if (!Array.isArray(value)) return [];
    const entries: readonly unknown[] = value;
    return entries.flatMap((entry) => {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !('credited_name' in entry) ||
            typeof entry.credited_name !== 'string'
        )
            return [];
        const identity = 'id' in entry ? entry.id : null;
        return [
            {
                id: typeof identity === 'string' && UUID.test(identity) ? identity : null,
                credited_name: entry.credited_name,
            },
        ];
    });
}
export class ArtistCreditReviewError extends Error {
    constructor(
        readonly kind: 'missing' | 'invalid' | 'conflict',
        message: string,
    ) {
        super(message);
    }
}
async function item(sql: postgres.Sql, id: string): Promise<Item | undefined> {
    // Internal metadata endpoint enforces auth.kind=admin for credit reads and confirmations.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- upstream admin gate permits explicit canonical identity and ownership review
    const [row] = await sql<
        Item[]
    >`SELECT id,title,title_source,parent_id,media_type,status,is_dismissed,canonical_id,is_various_artists,
        metadata_locked,metadata_locked_by,EXTRACT(EPOCH FROM metadata_locked_at)::text AS lock_version,
        library_group_id,COALESCE(custom_metadata,'{}'::jsonb) AS custom_metadata,xmin::text AS version
        FROM media_items WHERE id=${id}`;
    return row;
}
function eligible(row: Item | undefined, type: string): row is Item {
    return (
        !!row &&
        row.media_type === type &&
        row.status === 'active' &&
        !row.is_dismissed &&
        row.canonical_id === null &&
        (type !== 'artist' || row.parent_id === null)
    );
}
async function state(sql: postgres.Sql, id: string) {
    const track = await item(sql, id);
    if (!track) throw new ArtistCreditReviewError('missing', 'Track not found.');
    if (!eligible(track, 'track'))
        throw new ArtistCreditReviewError(
            'invalid',
            'Only active canonical tracks can be reviewed.',
        );
    const album = track.parent_id ? await item(sql, track.parent_id) : undefined;
    const owner = album?.parent_id ? await item(sql, album.parent_id) : undefined;
    const meta = track.custom_metadata;
    let performers = stored(meta.track_artist_credits);
    if (!performers.length && typeof meta.artist === 'string' && meta.artist.trim())
        performers = [{ id: null, credited_name: meta.artist }];
    const remixers = stored(meta.track_remixer_credits);
    const remixerIds = ids(meta.remixer_artist_ids);
    const artistIds = [
        ...new Set([
            ...performers.flatMap((credit) => (credit.id ? [credit.id] : [])),
            ...remixers.flatMap((credit) => (credit.id ? [credit.id] : [])),
            ...remixerIds,
        ]),
    ];
    const artists = artistIds.length
        ? // eslint-disable-next-line callback-safety/no-unscoped-media-items -- same admin-only credit review reads all referenced identities, including unavailable ones
          await sql<
              Item[]
          >`SELECT id,title,title_source,parent_id,media_type,status,is_dismissed,canonical_id,is_various_artists,
        metadata_locked,metadata_locked_by,EXTRACT(EPOCH FROM metadata_locked_at)::text AS lock_version,
        library_group_id,COALESCE(custom_metadata,'{}'::jsonb) AS custom_metadata,xmin::text AS version
        FROM media_items WHERE id=ANY(${artistIds}::uuid[]) ORDER BY id`
        : [];
    const byId = new Map(artists.map((artist) => [artist.id, artist]));
    const describe = (
        credit: { id: string | null; credited_name: string },
        role: 'performer' | 'remixer',
    ) => ({
        id: credit.id,
        name: credit.id ? (byId.get(credit.id)?.title ?? null) : null,
        creditedAs: credit.credited_name,
        role,
        active:
            !!credit.id &&
            eligible(byId.get(credit.id), 'artist') &&
            !byId.get(credit.id)?.is_various_artists &&
            !isVariousArtistsName(byId.get(credit.id)?.title ?? ''),
    });
    // Structured credits are authoritative, including unresolved rows. The
    // membership projection only supplies older identities absent from them.
    const structuredIds = new Set(remixers.flatMap((credit) => (credit.id ? [credit.id] : [])));
    const effectiveRemixers = [
        ...remixers,
        ...remixerIds
            .filter((artistId) => !structuredIds.has(artistId))
            .map((artistId) => ({
                id: artistId,
                credited_name: byId.get(artistId)?.title ?? artistId,
            })),
    ];
    const snapshot = createHash('sha256')
        .update(JSON.stringify({ track, album: album ?? null, owner: owner ?? null, artists }))
        .digest('hex');
    const rawEvidence = Object.fromEntries(
        [
            'raw_artist_tags',
            'artist',
            'artists',
            'album_artist',
            'album_artists',
            'remixer',
            'musicbrainz_artist_ids',
            'artist_credit_source',
        ]
            .filter((key) => meta[key] !== undefined)
            .map((key) => [key, meta[key]]),
    );
    const review: ArtistCreditReview = {
        track: { id, title: track.title, titleSource: track.title_source },
        album: album ? { id: album.id, title: album.title } : null,
        albumArtist: owner ? { id: owner.id, title: owner.title } : null,
        protection: {
            locked: track.metadata_locked,
            lockedBy: track.metadata_locked_by,
            lockedAt: track.lock_version,
        },
        credits: [
            ...performers.map((credit) => describe(credit, 'performer')),
            ...effectiveRemixers.map((credit) => describe(credit, 'remixer')),
        ],
        rawEvidence,
        snapshot,
    };
    return { track, album, owner, artists, review };
}
export async function getArtistCreditReview(
    sql: postgres.Sql,
    id: string,
): Promise<ArtistCreditReview> {
    return (await state(sql, id)).review;
}

/** All reviewed identities, memberships, protection and audit commit together. */
export async function confirmArtistCredits(
    sql: postgres.Sql,
    id: string,
    actor: string,
    expected: ConfirmArtistCredits,
    options: { batchReceipt?: boolean } = {},
): Promise<void> {
    if (!actor.trim())
        throw new ArtistCreditReviewError('invalid', 'An authenticated actor is required.');
    try {
        await withTx(sql, async (tx) => {
            await tx`SET LOCAL lock_timeout='2s'`;
            const [gate] = await tx<
                { acquired: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(hashtext(${id})) AS acquired`;
            if (!gate?.acquired)
                throw new ArtistCreditReviewError(
                    'conflict',
                    'Track is being updated. Reload and review again.',
                );
            const before = await state(tx, id);
            const existing = expected.credits.flatMap((credit) =>
                'id' in credit.artist ? [credit.artist.id] : [],
            );
            const owners = [
                ...new Set([
                    id,
                    ...existing,
                    ...before.artists.map((artist) => artist.id),
                    ...(before.album ? [before.album.id] : []),
                    ...(before.owner ? [before.owner.id] : []),
                ]),
            ].sort();
            // Metadata confirmation is admin-gated; lock the exact reviewed identities atomically.
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- upstream admin gate owns access; this is transactional identity locking
            await tx`SELECT id FROM media_items WHERE id=ANY(${owners}::uuid[]) ORDER BY id FOR NO KEY UPDATE NOWAIT`;
            const current = await state(tx, id);
            if (
                (current.album && !eligible(current.album, 'album')) ||
                (current.owner && !eligible(current.owner, 'artist'))
            )
                throw new ArtistCreditReviewError(
                    'conflict',
                    'Album ownership is no longer canonical. Review it before editing credits.',
                );
            if (current.review.snapshot !== expected.snapshot)
                throw new ArtistCreditReviewError(
                    'conflict',
                    'Track, credits or ownership changed. Reload and review again.',
                );
            const names = [
                ...new Set(
                    expected.credits.flatMap((credit) =>
                        'newName' in credit.artist
                            ? [credit.artist.newName.normalize('NFC').trim()]
                            : [],
                    ),
                ),
            ].sort();
            const created = new Map<string, string>();
            for (const name of names) {
                if (isVariousArtistsName(name))
                    throw new ArtistCreditReviewError(
                        'invalid',
                        'Compilation markers cannot be performing artists.',
                    );
                const key = name.toLocaleLowerCase().trim();
                if (created.has(key)) continue;
                await tx`SELECT pg_advisory_xact_lock(hashtext(${`artist-credit-name:${key}`}))`;
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin confirmation must detect name collisions across the canonical artist catalog
                const collisions = await tx<
                    { id: string }[]
                >`SELECT id FROM media_items WHERE media_type='artist' AND parent_id IS NULL AND status='active'
                    AND (LOWER(TRIM(normalize(title,NFC)))=LOWER(TRIM(normalize(${name}::text,NFC)))
                        OR (custom_metadata ? 'scan_aliases' AND music_artist_alias_keys(custom_metadata) @> ARRAY[LOWER(TRIM(normalize(${name}::text,NFC)))])) LIMIT 1`;
                if (collisions.length)
                    throw new ArtistCreditReviewError(
                        'conflict',
                        'An artist with this name already exists. Select the existing identity.',
                    );
                const artistId = await insertScannedMediaItem(tx, {
                    title: name,
                    mediaType: 'artist',
                    libraryGroupId: current.track.library_group_id ?? undefined,
                });
                await tx`UPDATE media_items SET metadata_locked=true,metadata_locked_by=${actor},metadata_locked_at=clock_timestamp() WHERE id=${artistId}`;
                created.set(key, artistId);
            }
            const rows: Array<{
                id: string;
                credited_name: string;
                role: 'performer' | 'remixer';
            }> = [];
            for (const credit of expected.credits) {
                if (isVariousArtistsName(credit.creditedAs))
                    throw new ArtistCreditReviewError(
                        'invalid',
                        'Compilation markers cannot be performing credits.',
                    );
                let artistId: string;
                if ('newName' in credit.artist)
                    artistId = created.get(
                        credit.artist.newName.normalize('NFC').trim().toLocaleLowerCase(),
                    )!;
                else {
                    const artist = await item(tx, credit.artist.id);
                    if (!eligible(artist, 'artist') || artist.title !== credit.artist.name)
                        throw new ArtistCreditReviewError(
                            'conflict',
                            'Selected artist changed. Select the current identity again.',
                        );
                    if (artist.is_various_artists || isVariousArtistsName(artist.title ?? ''))
                        throw new ArtistCreditReviewError(
                            'invalid',
                            'Compilation markers cannot be performing artists.',
                        );
                    artistId = artist.id;
                }
                if (rows.some((row) => row.id === artistId && row.role === credit.role))
                    throw new ArtistCreditReviewError('invalid', 'Duplicate artist and role.');
                rows.push({ id: artistId, credited_name: credit.creditedAs, role: credit.role });
            }
            const recovery = await captureMusicEdit(tx, [id]);
            const meta = current.track.custom_metadata;
            const performerRows = rows
                .filter((row) => row.role === 'performer')
                .map(({ id, credited_name }) => ({ id, credited_name }));
            const remixerRows = rows
                .filter((row) => row.role === 'remixer')
                .map(({ id, credited_name }) => ({ id, credited_name }));
            const previousOwned = new Set([
                ...ids(meta.file_artist_ids),
                ...ids(meta.album_artist_ids),
                ...ids(meta.remixer_artist_ids),
                ...stored(meta.track_artist_credits).flatMap((credit) =>
                    credit.id ? [credit.id] : [],
                ),
                ...stored(meta.track_remixer_credits).flatMap((credit) =>
                    credit.id ? [credit.id] : [],
                ),
            ]);
            const independent = ids(meta.additional_artist_ids).filter(
                (artistId) => !previousOwned.has(artistId),
            );
            const performerIds = performerRows.map((row) => row.id);
            const remixerIds = remixerRows.map((row) => row.id);
            const patch = {
                artist_credit_source: 'manual',
                track_artist_credits: performerRows,
                track_remixer_credits: remixerRows,
                file_artist_ids: performerIds,
                remixer_artist_ids: remixerIds,
                independent_remixer_artist_ids: remixerIds,
                title_remixer_artist_ids: ids(meta.title_remixer_artist_ids).filter((artistId) =>
                    remixerIds.includes(artistId),
                ),
                additional_artist_ids: [
                    ...new Set([
                        ...independent,
                        ...performerIds,
                        ...ids(meta.album_artist_ids),
                        ...remixerIds,
                    ]),
                ],
            };
            await tx`UPDATE media_items SET custom_metadata=COALESCE(custom_metadata,'{}'::jsonb) || ${tx.json(patch)},
                metadata_locked=true,metadata_locked_by=${actor},metadata_locked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${id}`;
            if (!options.batchReceipt) await recordMusicEdit(tx, id, 'credits', actor, recovery);
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor,
                action: 'music.track.credits.confirm',
                target: id,
                outcome: 'ok',
                detail: {
                    before: current.review.credits,
                    after: rows,
                    createdArtists: [...created.values()],
                    albumId: current.album?.id ?? null,
                    albumArtistId: current.owner?.id ?? null,
                    ownershipChanged: false,
                },
            });
        });
    } catch (error) {
        if (error instanceof ArtistCreditReviewError) throw error;
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['23505', '55P03', '40P01'].includes(String(error.code))
        )
            throw new ArtistCreditReviewError(
                'conflict',
                'An artist or track changed during review. Reload and select current identities.',
            );
        throw error;
    }
}
