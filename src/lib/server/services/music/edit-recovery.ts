// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MusicEditReceipt } from '$lib/schemas/music-credit-review.js';
import { recomputeHasFilesBatch } from '$lib/server/database/queries/media-files.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { config } from '$lib/server/config.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { isRecord } from '$lib/utils/data-extraction.js';

export class MusicEditConflict extends Error {}
export interface MusicEditState {
    id: string;
    value: { [key: string]: postgres.JSONValue };
    revision: string;
}

/** Only canonical membership keys contain catalog UUIDs; MusicBrainz UUIDs are external IDs. */
function referencedIds(states: MusicEditState[]): string[] {
    const result = new Set<string>();
    const add = (id: unknown): void => {
        if (
            typeof id === 'string' &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
        )
            result.add(id.toLowerCase());
    };
    for (const row of states) {
        add(row.value.parent_id);
        const meta = row.value.custom_metadata;
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
        for (const [key, value] of Object.entries(meta)) {
            if (
                [
                    'additional_artist_ids',
                    'file_artist_ids',
                    'album_artist_ids',
                    'remixer_artist_ids',
                    'title_remixer_artist_ids',
                    'independent_remixer_artist_ids',
                ].includes(key) &&
                Array.isArray(value)
            )
                for (const id of value) add(id);
            if (
                ['track_artist_credits', 'track_remixer_credits'].includes(key) &&
                Array.isArray(value)
            )
                for (const credit of value) if (isRecord(credit)) add(credit.id);
        }
    }
    return [...result].sort();
}

/** Capture under deterministic owner locks; discovery may explicitly request a plain read. */
export async function captureMusicEdit(
    sql: postgres.Sql,
    ids: string[],
    lock = true,
): Promise<MusicEditState[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact admin-selected recovery participants, no user-facing catalog projection
    return sql<MusicEditState[]>`SELECT id,xmin::text AS revision,
        jsonb_build_object('custom_metadata',custom_metadata,'parent_id',parent_id,
            'title_source',title_source,'metadata_locked',metadata_locked,
            'metadata_locked_by',metadata_locked_by,'metadata_locked_at',metadata_locked_at,
            'library_group_id',library_group_id,'status',status,'canonical_id',canonical_id,'is_dismissed',is_dismissed,
            'media_type',media_type) AS value
        FROM media_items WHERE id=ANY(${ids}::uuid[]) ORDER BY id ${lock ? sql`FOR NO KEY UPDATE` : sql``}`;
}

export async function recordMusicEdit(
    sql: postgres.Sql,
    target: string,
    kind: MusicEditReceipt['kind'],
    actor: string,
    before: MusicEditState[],
    inputFingerprint?: string,
): Promise<string> {
    const after = await captureMusicEdit(
        sql,
        before.map((row) => row.id),
    );
    const ids = [
        ...new Set([...before.map((row) => row.id), ...referencedIds([...before, ...after])]),
    ];
    // Keep existing recovery references alive during the save. Invalid pre-existing IDs stay raw evidence.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact recovery references, not a user catalog query
    const references = await sql<
        { id: string }[]
    >`SELECT id FROM media_items WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR KEY SHARE`;
    const [receipt] = await sql<{ id: string }[]>`INSERT INTO music_edit_receipts
        (target_id,kind,actor,before_state,after_state,input_fingerprint,reference_ids)
        VALUES (${target},${kind},${actor},${sql.json(before.map(({ id, value, revision }) => ({ id, value, revision })))},${sql.json(after.map(({ id, value, revision }) => ({ id, value, revision })))},${inputFingerprint ?? null},${references.map((row) => row.id)}::uuid[]) RETURNING id`;
    return receipt.id;
}

/** Durable recovery stays discoverable after navigation or a lost save response. */
export async function listMusicEdits(
    sql: postgres.Sql,
    target: string,
): Promise<MusicEditReceipt[]> {
    return sql<
        MusicEditReceipt[]
    >`SELECT id,kind,created_at::text AS "createdAt",undone_at IS NOT NULL AS undone
        FROM music_edit_receipts WHERE target_id=${target} ORDER BY created_at DESC,id DESC LIMIT 20`;
}

/** Restore exact metadata/credit ordering, memberships, parent and protection together. */
export async function undoMusicEdit(
    sql: postgres.Sql,
    target: string,
    receiptId: string,
    actor: string,
): Promise<void> {
    if (!actor.trim()) throw new MusicEditConflict('An authenticated actor is required.');
    try {
        await withTx(sql, async (tx) => {
            await tx`SET LOCAL lock_timeout='2s'`;
            const [receipt] = await tx<
                {
                    before_state: MusicEditState[];
                    after_state: MusicEditState[];
                    reference_ids: string[];
                    undone_at: string | null;
                }[]
            >`
                SELECT before_state,after_state,reference_ids,undone_at FROM music_edit_receipts
                WHERE id=${receiptId} AND target_id=${target} FOR UPDATE`;
            if (!receipt) throw new MusicEditConflict('Saved change is no longer available.');
            if (receipt.undone_at) return;
            const current = await captureMusicEdit(
                tx,
                receipt.after_state.map((row) => row.id),
            );
            if (
                current.length !== receipt.after_state.length ||
                current.some(
                    (row, i) =>
                        row.id !== receipt.after_state[i].id ||
                        row.revision !== receipt.after_state[i].revision ||
                        JSON.stringify(row.value) !== JSON.stringify(receipt.after_state[i].value),
                )
            )
                throw new MusicEditConflict(
                    'Music details changed since this save. Reload and choose the current credits or album artist.',
                );
            // Before-state parents and credited identities can have been explicitly removed or merged.
            // Never recreate them, follow a redirect, or replace a later edit to make Undo succeed.
            const references = new Set(
                referencedIds(receipt.before_state).filter((id) =>
                    receipt.reference_ids.includes(id),
                ),
            );
            if (references.size) {
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact recovery references must still exist canonically; does not expose catalog rows
                const live = await tx<
                    { id: string }[]
                >`SELECT id FROM media_items WHERE id::text=ANY(${[...references]}::text[])
                    AND status='active' AND canonical_id IS NULL AND NOT is_dismissed ORDER BY id FOR NO KEY UPDATE`;
                if (live.length !== references.size)
                    throw new MusicEditConflict(
                        'An original artist or album is no longer available. Choose the current credits or album artist.',
                    );
            }
            for (const row of receipt.before_state) {
                await tx`UPDATE media_items m SET
                    custom_metadata=s.custom_metadata,parent_id=s.parent_id,title_source=s.title_source,
                    metadata_locked=s.metadata_locked,metadata_locked_by=s.metadata_locked_by,
                    metadata_locked_at=s.metadata_locked_at,updated_at=clock_timestamp()
                    FROM jsonb_populate_record(NULL::media_items,${tx.json(row.value)}) s WHERE m.id=${row.id}`;
            }
            await recomputeHasFilesBatch(tx, [
                ...current.map((row) => row.id),
                ...current.flatMap((row) =>
                    typeof row.value.parent_id === 'string' ? [row.value.parent_id] : [],
                ),
                ...references,
            ]);
            await tx`UPDATE music_edit_receipts SET undone_at=clock_timestamp(),undone_by=${actor} WHERE id=${receiptId}`;
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor,
                action: 'music.edit.undo',
                target,
                outcome: 'ok',
                detail: {
                    receiptId,
                    restoredIds: receipt.before_state.map((row) => row.id),
                    createdArtistsRetained: true,
                },
            });
        });
    } catch (error) {
        if (error instanceof MusicEditConflict) throw error;
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['23505', '23503', '40P01', '55P03', '40001'].includes(String(error.code))
        )
            throw new MusicEditConflict(
                'Music details changed during Undo. Reload and choose the current credits or album artist.',
            );
        throw error;
    }
}
