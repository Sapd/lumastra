// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { IMAGE_PROVIDERS } from '$lib/schemas/image-candidates.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import type postgres from 'postgres';
import { withTx } from '../with-tx.js';
import type {
    ImageCandidate,
    ImageProvider,
    CandidateRole,
} from '$lib/schemas/image-candidates.js';

/** All candidates are references; registering one never downloads bytes. */
export interface RegisterImageCandidate {
    mediaItemId: string;
    role: CandidateRole;
    provider: ImageProvider;
    providerRef: string;
    filePath?: string;
    remoteUrl?: string;
    language?: string;
    width?: number;
    height?: number;
}
export async function registerImageCandidate(
    sql: postgres.Sql,
    candidate: RegisterImageCandidate,
): Promise<string | null> {
    const [row] = await sql<{ id: string }[]>`SELECT register_image_candidate(
        ${candidate.mediaItemId}::uuid, ${candidate.role}, ${candidate.provider}, ${candidate.providerRef},
        ${candidate.filePath ?? null}, ${candidate.remoteUrl ?? null}, ${candidate.language ?? ''},
        ${candidate.width && Number.isInteger(candidate.width) && candidate.width > 0 ? candidate.width : null}, ${candidate.height && Number.isInteger(candidate.height) && candidate.height > 0 ? candidate.height : null}) AS id`;
    return row?.id ?? null;
}

export async function listImageCandidates(
    sql: postgres.Sql,
    id: string,
    role?: CandidateRole,
): Promise<ImageCandidate[]> {
    return await sql<
        ImageCandidate[]
    >`SELECT id, media_item_id, person_ref, artwork_type, provider, provider_ref,
        language, width, height, chosen_by, to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fetched_at, locked, selected, suppressed, selection_order, sort_order, file_path, remote_url
        FROM image_candidates WHERE (media_item_id = ${isUuid(id) ? id : null}::uuid OR person_ref = ${isUuid(id) ? null : id})
        AND (${role ?? null}::text IS NULL OR artwork_type = ${role ?? null})
        ORDER BY artwork_type, selected DESC, selection_order, sort_order, created_at, id`;
}

export async function getSelectedImageCandidate(
    sql: postgres.Sql,
    id: string,
    role: CandidateRole,
    index = 0,
): Promise<ImageCandidate | null> {
    const rows = await sql<
        ImageCandidate[]
    >`SELECT id, media_item_id, person_ref, artwork_type, provider, provider_ref,
        language, width, height, chosen_by, to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fetched_at, locked, selected, suppressed, selection_order, sort_order, file_path, remote_url
        FROM image_candidates WHERE (media_item_id = ${isUuid(id) ? id : null}::uuid OR person_ref = ${isUuid(id) ? null : id}) AND artwork_type = ${role} AND selected AND NOT suppressed
        ORDER BY selection_order, sort_order, created_at, id LIMIT 1 OFFSET ${index}`;
    return rows[0] ?? null;
}

/** Owner locking is the caller's responsibility (same order as every local artwork writer). */
export async function selectImageCandidate(
    sql: postgres.Sql,
    owner: string,
    candidate: string,
    locked: boolean,
    select: boolean,
): Promise<boolean> {
    const [row] = await sql<
        {
            artwork_type: CandidateRole;
            selected: boolean;
            provider: ImageProvider;
            file_path: string | null;
        }[]
    >`
        SELECT artwork_type, selected,provider,file_path FROM image_candidates WHERE id = ${candidate}::uuid AND (media_item_id = ${isUuid(owner) ? owner : null}::uuid OR person_ref = ${isUuid(owner) ? null : owner})`;
    if (!row) return false;
    if (select || locked) {
        await allowImageProviderRole(sql, owner, row.provider, row.artwork_type);
        if (isUuid(owner))
            await sql`DELETE FROM media_artwork_suppressions WHERE media_item_id=${owner}
            AND artwork_type=${row.artwork_type} AND file_path IN (${row.file_path},'admin:hidden')`;
        await sql`UPDATE image_candidates SET suppressed=false WHERE id=${candidate}::uuid`;
    }
    if ((select || locked) && row.artwork_type !== 'backdrop') {
        await sql`UPDATE image_candidates SET selected = false, locked = false
            WHERE (media_item_id = ${isUuid(owner) ? owner : null}::uuid OR person_ref = ${isUuid(owner) ? null : owner}) AND artwork_type = ${row.artwork_type} AND (selected OR locked)`;
    }
    await sql`UPDATE image_candidates SET chosen_by = 'admin', locked = ${locked}, updated_at = now()
        WHERE id = ${candidate}::uuid AND (media_item_id = ${isUuid(owner) ? owner : null}::uuid OR person_ref = ${isUuid(owner) ? null : owner}) AND NOT suppressed`;
    // Unlocked manual selection takes effect immediately, until the next automatic election.
    if (select || locked) {
        if (row.artwork_type !== 'backdrop')
            await sql`UPDATE image_candidates SET selected = false WHERE (media_item_id = ${isUuid(owner) ? owner : null}::uuid OR person_ref = ${isUuid(owner) ? null : owner})
            AND artwork_type = ${row.artwork_type} AND selected AND id <> ${candidate}::uuid`;
        await sql`UPDATE image_candidates SET selected = true WHERE id = ${candidate}::uuid`;
    }
    return true;
}

export async function suppressProviderImageCandidates(
    sql: postgres.Sql,
    ownerId: string,
    provider: ImageProvider,
    role?: CandidateRole,
): Promise<number> {
    const id = isUuid(ownerId) ? normalizeUuid(ownerId) : ownerId;
    // Archive references and keep all provider metadata and image files intact.
    await sql`INSERT INTO image_provider_suppressions (owner,provider,role)
        VALUES (${id},${provider},${role ?? '*'}) ON CONFLICT DO NOTHING`;
    const rows = await sql`UPDATE image_candidates SET suppressed=true,selected=false,locked=false
        WHERE (media_item_id = ${isUuid(id) ? id : null}::uuid OR person_ref = ${isUuid(id) ? null : id})
        AND provider = ${provider} AND (${role ?? null}::text IS NULL OR artwork_type = ${role ?? null}) RETURNING id`;
    return rows.length;
}

/** An explicit picture choice overrides hiding for this slot, retaining other slot policies. */
export async function allowImageProviderRole(
    sql: postgres.Sql,
    owner: string,
    provider: ImageProvider,
    role: CandidateRole,
): Promise<void> {
    const removed = await sql<
        { provider: string; role: string }[]
    >`DELETE FROM image_provider_suppressions
        WHERE image_provider_suppressions.owner=${owner} AND
            ((image_provider_suppressions.provider='*' AND image_provider_suppressions.role=${role})
            OR (image_provider_suppressions.provider=${provider} AND image_provider_suppressions.role IN ('*',${role})))
        RETURNING provider,role`;
    if (removed.some((row) => row.provider === provider && row.role === '*')) {
        for (const other of ['poster', 'thumb', 'backdrop', 'logo', 'banner']) {
            if (other !== role)
                await sql`INSERT INTO image_provider_suppressions (owner,provider,role)
                VALUES (${owner},${provider},${other}) ON CONFLICT DO NOTHING`;
        }
    }
}

export async function updateImageSelectionPolicy(
    sql: postgres.Sql,
    order: readonly string[],
    preference: 'provider' | 'generated',
): Promise<void> {
    await sql`UPDATE image_selection_policy SET provider_order = ${[...order]},
        episode_thumbnail_preference = ${preference}, generation = generation + 1,
        election_cursor = '', election_pending = true WHERE singleton AND
        (provider_order IS DISTINCT FROM ${[...order]} OR episode_thumbnail_preference IS DISTINCT FROM ${preference})`;
    for (;;) {
        const done = await withTx(sql, async (tx) => {
            const [policy] = await tx<{ election_pending: boolean; election_cursor: string }[]>`
                SELECT election_pending,election_cursor FROM image_selection_policy WHERE singleton FOR UPDATE`;
            if (!policy.election_pending) return true;
            const owners = await tx<
                { key: string; media_item_id: string | null; person_ref: string | null }[]
            >`
                SELECT DISTINCT COALESCE('m:' || media_item_id::text, 'p:' || person_ref) AS key, media_item_id,person_ref
                FROM image_candidates WHERE COALESCE('m:' || media_item_id::text, 'p:' || person_ref) > ${policy.election_cursor}
                ORDER BY key LIMIT 100`;
            for (const owner of owners) {
                if (owner.media_item_id)
                    await tx`SELECT reselect_image_candidates(${owner.media_item_id}::uuid)`;
                else await tx`SELECT reselect_person_images(${owner.person_ref})`;
            }
            await tx`UPDATE image_selection_policy SET election_cursor = ${owners.at(-1)?.key ?? policy.election_cursor},
                election_pending = ${owners.length > 0} WHERE singleton`;
            return owners.length === 0;
        });
        if (done) return;
    }
}

export async function getSuppressedImageProviders(
    sql: postgres.Sql,
    owner: string,
    role: string,
): Promise<string[]> {
    const rows = await sql<{ provider: string }[]>`SELECT provider FROM image_provider_suppressions
        WHERE image_provider_suppressions.owner = ${isUuid(owner) ? normalizeUuid(owner) : owner} AND image_provider_suppressions.role IN ('*',${role})`;
    return rows.some((r) => r.provider === '*')
        ? [...IMAGE_PROVIDERS]
        : rows.map((r) => r.provider);
}

export async function registerPersonImageCandidate(
    sql: postgres.Sql,
    personId: string,
    path: string,
): Promise<string | null> {
    const [row] = await sql<
        { id: string }[]
    >`SELECT register_person_image_candidate(${'tmdb:' + personId}, 'tmdb', ${path}) AS id`;
    return row?.id ?? null;
}

export async function hasPersonImageOwner(sql: postgres.Sql, handle: string): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM person_image_owners WHERE person_ref = ${handle}`;
    return rows.length > 0;
}
export async function isImageCandidateFileReferenced(
    sql: postgres.Sql,
    filePath: string,
): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM image_candidates WHERE file_path = ${filePath} LIMIT 1`;
    return rows.length > 0;
}
