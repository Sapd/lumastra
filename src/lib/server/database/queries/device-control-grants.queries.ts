// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device control grants: which users may remote-control whose devices.
 *
 * Usernames are matched case-insensitively. The match runs on a SQL `lower()`
 * candidate set and is confirmed with the app's own fold (`foldUsername`), so
 * the two Unicode tables cannot disagree about who a name is.
 */

import { defineQuery, defineWriteQuery } from '../typed-query.js';
import { foldUsername } from '$lib/shared/username-fold.js';
import type postgres from 'postgres';

export interface GrantRow {
    /** The other party's user id (grantee for an owner's list, owner for a helper's). */
    user_id: string;
    username: string;
    created_at: Date;
}

export const listGrantsByOwner = defineQuery<{ ownerUserId: string }, GrantRow>(
    'listGrantsByOwner',
    (sql, { ownerUserId }) => sql`
        SELECT u.id AS user_id, u.username, g.created_at
        FROM device_control_grants g
        JOIN users u ON u.id = g.grantee_user_id
        WHERE g.owner_user_id = ${ownerUserId}::uuid
          AND u.deleted_at IS NULL
          AND u.disabled_at IS NULL
        ORDER BY lower(u.username)
    `,
);

export const listGrantsByGrantee = defineQuery<{ granteeUserId: string }, GrantRow>(
    'listGrantsByGrantee',
    (sql, { granteeUserId }) => sql`
        SELECT u.id AS user_id, u.username, g.created_at
        FROM device_control_grants g
        JOIN users u ON u.id = g.owner_user_id
        WHERE g.grantee_user_id = ${granteeUserId}::uuid
          AND u.deleted_at IS NULL
          AND u.disabled_at IS NULL
        ORDER BY lower(u.username)
    `,
);

/** Most people one owner may allow. */
export const MAX_GRANTS_PER_OWNER = 20;

export interface AddGrantResult {
    /** `added` = new, `exists` = already allowed, `limit` = the owner is at the cap. */
    status: 'added' | 'exists' | 'limit';
    /** The stored creation time (`null` for `limit`). */
    createdAt: Date | null;
}

/**
 * Adds a grant. The per-owner advisory lock makes the cap exact: concurrent adds
 * of the same owner queue up instead of all reading the old count.
 */
export async function addGrantCapped(
    sql: postgres.Sql,
    params: { ownerUserId: string; granteeUserId: string },
): Promise<AddGrantResult> {
    const { ownerUserId, granteeUserId } = params;
    return sql.begin(async (tx): Promise<AddGrantResult> => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('device_control_grants'), hashtext(${ownerUserId}))`;
        const existing = await tx<{ created_at: Date }[]>`
            SELECT created_at FROM device_control_grants
            WHERE owner_user_id = ${ownerUserId}::uuid
              AND grantee_user_id = ${granteeUserId}::uuid
        `;
        if (existing[0]) return { status: 'exists', createdAt: existing[0].created_at };
        const [{ n }] = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM device_control_grants
            WHERE owner_user_id = ${ownerUserId}::uuid
        `;
        if (n >= MAX_GRANTS_PER_OWNER) return { status: 'limit', createdAt: null };
        const [row] = await tx<{ created_at: Date }[]>`
            INSERT INTO device_control_grants (owner_user_id, grantee_user_id)
            VALUES (${ownerUserId}::uuid, ${granteeUserId}::uuid)
            RETURNING created_at
        `;
        return { status: 'added', createdAt: row.created_at };
    });
}

/** Removes a grant; returns a row when one existed. */
export const removeGrant = defineWriteQuery<
    { ownerUserId: string; granteeUserId: string },
    { owner_user_id: string }
>(
    'removeGrant',
    (sql, { ownerUserId, granteeUserId }) => sql`
        DELETE FROM device_control_grants
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND grantee_user_id = ${granteeUserId}::uuid
        RETURNING owner_user_id
    `,
);

/** Finds a user by username, case-insensitively. `null` when unknown. */
export async function findUserByUsernameFolded(
    sql: postgres.Sql,
    username: string,
): Promise<{ id: string; username: string } | null> {
    const wanted = foldUsername(username);
    if (!wanted) return null;
    const rows = await sql<{ id: string; username: string }[]>`
        SELECT id, username FROM users WHERE lower(username) = lower(${username.trim()})
          AND deleted_at IS NULL AND disabled_at IS NULL
        ORDER BY id LIMIT 5
    `;
    return rows.find((r) => foldUsername(r.username) === wanted) ?? null;
}

export interface ControllableDeviceRow {
    device_session_id: string;
    device_name: string | null;
    owner_username: string;
}

/** Most devices `GET /devices/controllable` reads. */
export const MAX_CONTROLLABLE_DEVICES = 200;

/**
 * Every live device session of every active owner who granted `granteeUserId`
 * control: one query, however many owners there are.
 */
export const listControllableDevices = defineQuery<
    { granteeUserId: string },
    ControllableDeviceRow
>(
    'listControllableDevices',
    (sql, { granteeUserId }) => sql`
        SELECT DISTINCT ON (t.device_session_id)
               t.device_session_id,
               t.device_name,
               u.username AS owner_username
        FROM device_control_grants g
        JOIN users u ON u.id = g.owner_user_id
                    AND u.deleted_at IS NULL AND u.disabled_at IS NULL
        JOIN oauth_refresh_tokens t ON t.user_id = g.owner_user_id
                                   AND t.revoked_at IS NULL
                                   AND t.device_session_id IS NOT NULL
        WHERE g.grantee_user_id = ${granteeUserId}::uuid
        ORDER BY t.device_session_id, t.created_at DESC
        LIMIT ${MAX_CONTROLLABLE_DEVICES}
    `,
);

/** The live device sessions of one user (the inboxes a grant's removal cleans). */
export const listDeviceSessionIdsOfUser = defineQuery<
    { userId: string },
    { device_session_id: string }
>(
    'listDeviceSessionIdsOfUser',
    (sql, { userId }) => sql`
        SELECT DISTINCT device_session_id
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND revoked_at IS NULL
          AND device_session_id IS NOT NULL
        LIMIT 500
    `,
);
