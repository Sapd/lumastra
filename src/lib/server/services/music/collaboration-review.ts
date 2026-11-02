// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { captureMusicEdit, recordMusicEdit } from './edit-recovery.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import {
    getCollaborationArtist,
    getCollaborationFingerprint,
    listCollaborationTracks,
    listCollaborationWitnessTags,
    setCollaborationReviewed,
} from '$lib/server/database/queries/collaboration-review.queries.js';
import {
    ArtistCreditReviewError,
    confirmArtistCredits,
    getArtistCreditReview,
} from './artist-credit-review.js';
import {
    buildArtistCreditEvidence,
    atomizeArtistCredit,
    normalizeCreditName,
    resolveArtistCredit,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit.js';
import type { ArtistCreditChoice, ArtistCreditReview } from '$lib/schemas/music-credit-review.js';
import type { CollaborationMember } from '$lib/schemas/collaboration-review.js';

export class CollaborationReviewError extends Error {
    constructor(
        readonly kind: 'missing' | 'invalid' | 'conflict',
        message: string,
    ) {
        super(message);
    }
}

export interface CollaborationTrackPreview {
    id: string;
    title: string | null;
    albumId: string | null;
    albumTitle: string | null;
    albumArtistId: string | null;
    albumArtistTitle: string | null;
    sourceTag: string | null;
    fileCount: number;
    status: 'eligible' | 'already-resolved' | 'abstain';
    reason: string | null;
    before: ArtistCreditReview['credits'];
    after: ArtistCreditChoice[];
    reviewSnapshot: string | null;
}

export interface CollaborationPreview {
    artist: { id: string; title: string };
    members: CollaborationMember[];
    suggestedNames: string[];
    witnesses: Array<{ member: string; tags: string[] }>;
    tracks: CollaborationTrackPreview[];
    overflow: boolean;
    albums: Array<{
        id: string;
        title: string | null;
        ownerId: string | null;
        ownerTitle: string | null;
    }>;
    snapshot: string;
    reviewed: boolean;
}

function nameOf(member: CollaborationMember): string {
    return 'newName' in member ? member.newName : member.name;
}

function tagFor(
    meta: Record<string, unknown>,
    combinedName: string,
    scalarKey: string,
    arrayKey: string,
): string | null {
    const arrayValue = meta[arrayKey];
    const values = [
        meta[scalarKey],
        ...(Array.isArray(arrayValue)
            ? arrayValue.filter((value: unknown): value is string => typeof value === 'string')
            : []),
    ];
    const key = normalizeCreditName(combinedName);
    const found = values.find(
        (value): value is string => typeof value === 'string' && normalizeCreditName(value) === key,
    );
    return found ?? null;
}

function creditIdentity(credit: ArtistCreditChoice): string {
    return 'id' in credit.artist ? credit.artist.id : normalizeCreditName(credit.artist.newName);
}

function samePerformers(
    before: ArtistCreditReview['credits'],
    after: ArtistCreditChoice[],
): boolean {
    const old = before.filter((credit) => credit.role === 'performer');
    const next = after.filter((credit) => credit.role === 'performer');
    return (
        old.length === next.length &&
        old.every(
            (credit, index) =>
                credit.id === creditIdentity(next[index]) &&
                credit.creditedAs === next[index].creditedAs,
        )
    );
}

/** Read-only bounded proposal. The exact tag witnesses are returned with it. */
export async function previewCollaboration(
    sql: postgres.Sql,
    artistId: string,
    members: CollaborationMember[] = [],
): Promise<CollaborationPreview> {
    const artist = await getCollaborationArtist(sql, artistId);
    if (
        !artist ||
        artist.status !== 'active' ||
        artist.is_dismissed ||
        artist.canonical_id !== null
    )
        throw new CollaborationReviewError('missing', 'Active canonical artist not found.');
    if (
        artist.custom_metadata.no_split === true ||
        artist.custom_metadata.musicbrainz_artist_id ||
        artist.has_mbid
    )
        throw new CollaborationReviewError('invalid', 'This identified single act is protected.');
    const { tracks, overflow } = await listCollaborationTracks(sql, artistId);
    const tags = await listCollaborationWitnessTags(sql);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only evidence review needs the global protected-act names; no user catalog projection.
    const knownActs = await sql<{ title: string }[]>`
        SELECT title FROM media_items WHERE media_type='artist' AND status='active'
          AND (custom_metadata->>'no_split'='true' OR COALESCE(custom_metadata->>'musicbrainz_artist_id','')<>'')`;
    const evidence = buildArtistCreditEvidence(
        tags,
        knownActs.map((row) => row.title),
    );
    const suggestedNames = resolveArtistCredit(artist.title, evidence);
    const witnessRows = members.map((member) => {
        const name = nameOf(member);
        const key = normalizeCreditName(name);
        const partners = members.filter((candidate) => candidate !== member).map(nameOf);
        const supporting = tags.filter((tag) => {
            const atoms = atomizeArtistCredit(tag).map(normalizeCreditName);
            return (
                atoms.includes(key) &&
                !partners.some((partner) => atoms.includes(normalizeCreditName(partner)))
            );
        });
        return { member: name, tags: supporting.slice(0, 20) };
    });
    const memberNames = members.map((member) => normalizeCreditName(nameOf(member)));
    const newNames = members.flatMap((member) =>
        'newName' in member ? [member.newName.normalize('NFC').trim().toLocaleLowerCase()] : [],
    );
    const existingNames = newNames.length
        ? // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only identity collision check across the canonical artist namespace.
          await sql<{ title: string }[]>`
        SELECT title FROM media_items WHERE media_type='artist' AND status='active'
          AND LOWER(TRIM(normalize(title,NFC)))=ANY(${newNames}::text[])`
        : [];
    const duplicateMemberNames = new Set(memberNames).size !== memberNames.length;
    const memberCollision = duplicateMemberNames || existingNames.length > 0;
    const proposals: CollaborationTrackPreview[] = [];
    for (const track of tracks) {
        // Keep the operator's dismissal visible as a blocker, rather than
        // sending this track to an editor that deliberately refuses it.
        if (track.is_dismissed) {
            proposals.push({
                id: track.id,
                title: track.title,
                albumId: track.album_id,
                albumTitle: track.album_title,
                albumArtistId: track.album_artist_id,
                albumArtistTitle: track.album_artist_title,
                sourceTag: tagFor(track.custom_metadata, artist.title, 'artist', 'artists'),
                fileCount: track.file_count,
                status: 'abstain',
                reason: 'dismissed',
                before: [],
                after: [],
                reviewSnapshot: null,
            });
            continue;
        }
        let review: ArtistCreditReview;
        try {
            review = await getArtistCreditReview(sql, track.id);
        } catch (error) {
            if (error instanceof ArtistCreditReviewError)
                throw new CollaborationReviewError(
                    'conflict',
                    'A track changed during review. Load a fresh preview.',
                );
            throw error;
        }
        const performerTag = tagFor(track.custom_metadata, artist.title, 'artist', 'artists');
        const existingRemixer = review.credits.filter((credit) => credit.role === 'remixer');
        const replacement: ArtistCreditChoice[] = members.map((member) => ({
            artist: member,
            creditedAs: nameOf(member),
            role: 'performer',
        }));
        const oldPerformers = review.credits.filter((credit) => credit.role === 'performer');
        const isCombined = (credit: ArtistCreditReview['credits'][number]): boolean =>
            credit.id === artistId ||
            (credit.id === null &&
                normalizeCreditName(credit.creditedAs) === normalizeCreditName(artist.title));
        const combinedIndex = oldPerformers.findIndex(isCombined);
        const retained = oldPerformers
            .filter((credit) => !isCombined(credit))
            .flatMap((credit) =>
                credit.id && credit.name
                    ? [
                          {
                              artist: { id: credit.id, name: credit.name },
                              creditedAs: credit.creditedAs,
                              role: 'performer' as const,
                          },
                      ]
                    : [],
            );
        const incompleteCredits =
            oldPerformers.some((credit) => !isCombined(credit) && (!credit.id || !credit.active)) ||
            existingRemixer.some((credit) => !credit.id || !credit.active);
        const after = [
            ...(combinedIndex < 0
                ? retained
                : [
                      ...retained.slice(0, combinedIndex),
                      ...replacement,
                      ...retained.slice(combinedIndex),
                  ]),
            ...existingRemixer
                .filter((credit) => credit.id && credit.name)
                .map((credit) => ({
                    artist: { id: credit.id!, name: credit.name! },
                    creditedAs: credit.creditedAs,
                    role: 'remixer' as const,
                })),
        ];
        const alreadyResolved =
            members.length >= 2 &&
            members.every((member) =>
                oldPerformers.some((credit) =>
                    'id' in member
                        ? credit.id === member.id
                        : normalizeCreditName(credit.name ?? credit.creditedAs) ===
                          normalizeCreditName(member.newName),
                ),
            ) &&
            !oldPerformers.some(isCombined) &&
            samePerformers(review.credits, after);
        // Album-artist fields can acknowledge an already-resolved performer
        // credit only when this combined artist still owns the album. They are
        // never evidence for replacing performer credits.
        const albumTag =
            track.album_artist_id === artistId
                ? tagFor(track.custom_metadata, artist.title, 'album_artist', 'album_artists')
                : null;
        const tag = performerTag ?? (alreadyResolved ? albumTag : null);
        let reason: string | null = null;
        // Source tags authorize changing performer credits. A disposition-only
        // acknowledgment of identical canonical credits needs no tag rewrite.
        if (!tag && !alreadyResolved) reason = 'missing-source-tag';
        else if (track.file_count !== 1) reason = 'uncertain-files';
        else if (track.metadata_locked && !alreadyResolved) reason = 'locked';
        else if (members.length < 2) reason = 'choose-members';
        else if (memberCollision && (duplicateMemberNames || !alreadyResolved))
            reason = 'identity-collision';
        else if (
            review.credits.some((credit) => credit.role === 'remixer' && credit.id === artistId)
        )
            reason = 'combined-remixer';
        else if (
            oldPerformers.some((credit) => !isCombined(credit) && (!credit.id || !credit.active))
        )
            reason = 'unsupported-performer';
        else if (existingRemixer.some((credit) => !credit.id || !credit.active))
            reason = 'unsupported-remixer';
        else if (
            new Set(after.filter((credit) => credit.role === 'performer').map(creditIdentity))
                .size !== after.filter((credit) => credit.role === 'performer').length
        )
            reason = 'identity-collision';
        const status = reason ? 'abstain' : alreadyResolved ? 'already-resolved' : 'eligible';
        proposals.push({
            id: track.id,
            title: track.title,
            albumId: track.album_id,
            albumTitle: track.album_title,
            albumArtistId: track.album_artist_id,
            albumArtistTitle: track.album_artist_title,
            sourceTag: tag,
            fileCount: track.file_count,
            status,
            reason,
            before: review.credits,
            after: incompleteCredits ? [] : after,
            reviewSnapshot: review.snapshot,
        });
    }
    const albums = [
        ...new Map(
            proposals
                .filter((row) => row.albumId)
                .map((row) => [
                    row.albumId!,
                    {
                        id: row.albumId!,
                        title: row.albumTitle,
                        ownerId: row.albumArtistId,
                        ownerTitle: row.albumArtistTitle,
                    },
                ]),
        ).values(),
    ];
    const fingerprint = await getCollaborationFingerprint(sql, artistId);
    if (!fingerprint) throw new CollaborationReviewError('missing', 'Artist not found.');
    const snapshot = createHash('sha256')
        .update(
            JSON.stringify({
                fingerprint,
                artistVersion: artist.version,
                albums,
                members,
                witnesses: witnessRows,
                suggestedNames,
                tracks: proposals.map((row) => [row.id, row.reviewSnapshot, row.status]),
                overflow,
            }),
        )
        .digest('hex');
    return {
        artist: { id: artist.id, title: artist.title },
        members,
        suggestedNames,
        witnesses: witnessRows,
        tracks: proposals,
        overflow,
        albums,
        snapshot,
        reviewed: artist.custom_metadata.collaboration_reviewed === fingerprint,
    };
}

export async function applyCollaboration(
    sql: postgres.Sql,
    artistId: string,
    actor: string,
    input: {
        snapshot: string;
        members: CollaborationMember[];
        trackIds: string[];
        markReviewed?: boolean;
        albumOwnerAcknowledged?: boolean;
        keepDismissed?: boolean;
    },
): Promise<{ changedTracks: number; unchangedAlbums: number; reviewed: boolean }> {
    if (!actor.trim())
        throw new CollaborationReviewError('invalid', 'An authenticated actor is required.');
    try {
        return await withTx(sql, async (tx) => {
            await tx`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
            await tx`SET LOCAL lock_timeout='2s'`;
            const [gate] = await tx<{ acquired: boolean }[]>`
                SELECT pg_try_advisory_xact_lock(hashtext('file-scanner-postpass:mergeCollaborationArtists')) AS acquired`;
            if (!gate?.acquired)
                throw new CollaborationReviewError(
                    'conflict',
                    'Scanner is reviewing collaborations. Retry with a fresh preview.',
                );
            const before = await previewCollaboration(tx, artistId, input.members);
            const owners = [
                artistId,
                ...before.albums.map((album) => album.id),
                ...before.tracks.map((track) => track.id),
                ...input.members.flatMap((member) => ('id' in member ? [member.id] : [])),
            ];
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact reviewed UUID set, deterministic lock order
            await tx`SELECT id FROM media_items WHERE id=ANY(${[...new Set(owners)].sort()}::uuid[]) ORDER BY id FOR NO KEY UPDATE NOWAIT`;
            const current = await previewCollaboration(tx, artistId, input.members);
            if (current.snapshot !== input.snapshot)
                throw new CollaborationReviewError(
                    'conflict',
                    'Credits, tags or ownership changed. Load a fresh preview.',
                );
            const selected = new Set(input.trackIds);
            if (selected.size !== input.trackIds.length)
                throw new CollaborationReviewError('invalid', 'Duplicate selected track.');
            for (const id of selected) {
                if (!current.tracks.some((track) => track.id === id && track.status === 'eligible'))
                    throw new CollaborationReviewError(
                        'invalid',
                        'Only eligible preview tracks may be selected.',
                    );
            }
            // Dismissal is an explicit decision to leave a track alone. A lock
            // protects edits but cannot certify still-joined credits as resolved.
            const complete =
                current.tracks.length > 0 &&
                !current.overflow &&
                current.tracks.every(
                    (track) =>
                        track.status === 'already-resolved' ||
                        (track.status === 'eligible' && selected.has(track.id)) ||
                        track.reason === 'dismissed',
                );
            if (!selected.size && !complete)
                throw new CollaborationReviewError(
                    'invalid',
                    'Choose tracks with editable credits first.',
                );
            const recovery = await captureMusicEdit(tx, [artistId, ...selected]);
            const created = new Map<string, { id: string; name: string }>();
            let changedTracks = 0;
            for (const track of current.tracks.filter((row) => selected.has(row.id))) {
                if (!track.reviewSnapshot)
                    throw new CollaborationReviewError('invalid', 'Track has no editable review.');
                const credits = track.after.map((credit) => {
                    if ('newName' in credit.artist) {
                        const existing = created.get(normalizeCreditName(credit.artist.newName));
                        if (existing) return { ...credit, artist: existing };
                    }
                    return credit;
                });
                await confirmArtistCredits(
                    tx,
                    track.id,
                    actor,
                    {
                        snapshot: track.reviewSnapshot,
                        credits,
                    },
                    { batchReceipt: true },
                );
                for (const member of input.members) {
                    if (!('newName' in member) || created.has(normalizeCreditName(member.newName)))
                        continue;
                    // The canonical confirmation created and locked it; find the exact name under this transaction.
                    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only confirmation resolves the identity just created in this transaction.
                    const [artist] = await tx<{ id: string; title: string }[]>`
                        SELECT id,title FROM media_items WHERE media_type='artist' AND status='active'
                          AND LOWER(TRIM(normalize(title,NFC)))=LOWER(TRIM(normalize(${member.newName}::text,NFC))) LIMIT 1`;
                    if (artist)
                        created.set(normalizeCreditName(member.newName), {
                            id: artist.id,
                            name: artist.title,
                        });
                }
                changedTracks++;
            }
            let reviewed = false;
            if (complete) {
                const fingerprint = await getCollaborationFingerprint(tx, artistId);
                if (!fingerprint)
                    throw new CollaborationReviewError('conflict', 'Artist changed during review.');
                reviewed = await setCollaborationReviewed(tx, artistId, fingerprint);
            }
            await recordMusicEdit(tx, artistId, 'collaboration', actor, recovery);
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor,
                action: 'music.collaboration.review',
                target: artistId,
                outcome: 'ok',
                detail: {
                    before: current.tracks
                        .filter((row) => selected.has(row.id))
                        .map((row) => ({ id: row.id, credits: row.before })),
                    after: current.tracks
                        .filter((row) => selected.has(row.id))
                        .map((row) => ({ id: row.id, credits: row.after })),
                    members: input.members,
                    albumsRetained: current.albums,
                    dismissedTracksRetained: current.tracks
                        .filter((row) => row.reason === 'dismissed')
                        .map((row) => row.id),
                    changedTracks,
                    reviewed,
                },
            });
            return { changedTracks, unchangedAlbums: current.albums.length, reviewed };
        });
    } catch (error) {
        if (error instanceof CollaborationReviewError) throw error;
        if (error instanceof ArtistCreditReviewError)
            throw new CollaborationReviewError(error.kind, error.message);
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['40001', '40P01', '55P03', '57014', '23505'].includes(String(error.code))
        )
            throw new CollaborationReviewError(
                'conflict',
                'Concurrent catalog edit. Load a fresh preview.',
            );
        throw error;
    }
}

export async function returnCollaborationToQueue(
    sql: postgres.Sql,
    artistId: string,
    actor: string,
): Promise<boolean> {
    return withTx(sql, async (tx) => {
        const updated = await setCollaborationReviewed(tx, artistId, null);
        if (updated)
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor,
                action: 'music.collaboration.return-to-review',
                target: artistId,
                outcome: 'ok',
                detail: { creditsChanged: false },
            });
        return updated;
    });
}
