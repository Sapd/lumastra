// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export interface MediaChangeReceipt {
    id: string;
    before_state: unknown;
    after_state: unknown;
    undone_at: Date | null;
}

/** Caller holds the subject lock; the receipt commits with the mutation. */
export async function recordMediaChange(
    sql: postgres.Sql,
    owner: string,
    kind: string,
    before: unknown,
    after: unknown,
    actor: string,
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO admin_media_change_receipts (owner,media_item_id,kind,before_state,after_state,actor)
        VALUES (${owner},${isUuid(owner) ? owner : null},${kind},
            ${sql.json(before as postgres.JSONValue)}::jsonb,${sql.json(after as postgres.JSONValue)}::jsonb,${actor}) RETURNING id`;
    return row.id;
}

export async function getMediaChange(
    sql: postgres.Sql,
    owner: string,
    kind: string,
    id: string,
): Promise<MediaChangeReceipt | null> {
    const [row] = await sql<MediaChangeReceipt[]>`
        SELECT id,before_state,after_state,undone_at FROM admin_media_change_receipts
        WHERE id=${id} AND owner=${owner} AND kind=${kind} FOR UPDATE`;
    return row ?? null;
}

export async function latestMediaChange(
    sql: postgres.Sql,
    owner: string,
    kind: string,
): Promise<string | undefined> {
    const [row] = await sql<{ id: string }[]>`
        SELECT id FROM admin_media_change_receipts WHERE owner=${owner} AND kind=${kind}
            AND undone_at IS NULL AND after_state->>'publicationPending' IS DISTINCT FROM 'true'
        ORDER BY created_at DESC,id DESC LIMIT 1`;
    return row?.id;
}

export async function markMediaChangeUndone(sql: postgres.Sql, id: string): Promise<void> {
    await sql`UPDATE admin_media_change_receipts SET undone_at=now() WHERE id=${id}`;
}

/** PostgreSQL jsonb equality avoids object property-order differences after a round trip. */
export async function sameMediaChangeState(
    sql: postgres.Sql,
    first: unknown,
    second: unknown,
): Promise<boolean> {
    const [row] = await sql<{ same: boolean }[]>`
        SELECT ${sql.json(first as postgres.JSONValue)}::jsonb = ${sql.json(second as postgres.JSONValue)}::jsonb AS same`;
    return row.same;
}
