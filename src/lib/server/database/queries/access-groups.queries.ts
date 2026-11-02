// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Access Groups Query Module (Tier 1 — pure SQL).
 *
 * CRUD for the standalone multi-user access layer: access_groups, the
 * group→capability map (access_group_capabilities), and the membership join
 * (user_access_groups). All functions take `sql: postgres.Sql` as the first
 * param and perform no side effects beyond the single statement.
 *
 * Multi-statement / transactional orchestration (replace-capabilities,
 * delete-with-system-guard, cache invalidation) lives in the service tier
 * (access-control.service.ts).
 */

import type postgres from 'postgres';
import type { AccessCapability } from '$lib/schemas/api-admin-access.js';
import { config } from '$lib/server/config.js';
import { hasGroupPermission } from '$lib/server/auth.js';
import { stripAgeRatingGroupNames } from '$lib/server/utils/age-rating-resolver.js';

// =============================================================================
// Row types
// =============================================================================

export interface AccessGroupRow {
    id: string;
    name: string;
    display_name: string;
    description: string | null;
    is_system: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface AccessGroupCapabilityRow {
    group_id: string;
    capability: AccessCapability;
    value: string | null;
}

export interface AccessGroupMemberRow {
    user_id: string;
    username: string;
    display_name: string | null;
    assigned_at: Date;
    assigned_by: string | null;
}

/** A group row with its capabilities and member count, for list/detail. */
export interface AccessGroupWithCapsRow extends AccessGroupRow {
    member_count: number;
    capabilities: { capability: AccessCapability; value: string | null }[];
}

// =============================================================================
// Group reads
// =============================================================================

/** List all access groups with capabilities + member counts. */
export async function listAccessGroups(sql: postgres.Sql): Promise<AccessGroupWithCapsRow[]> {
    return sql<AccessGroupWithCapsRow[]>`
        SELECT
            g.id,
            g.name,
            g.display_name,
            g.description,
            g.is_system,
            g.created_at,
            g.updated_at,
            COALESCE(m.member_count, 0)::int AS member_count,
            COALESCE(c.capabilities, '[]'::jsonb) AS capabilities
        FROM access_groups g
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS member_count
            FROM user_access_groups uag
            WHERE uag.group_id = g.id
        ) m ON TRUE
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object('capability', cap.capability, 'value', cap.value)) AS capabilities
            FROM access_group_capabilities cap
            WHERE cap.group_id = g.id
        ) c ON TRUE
        ORDER BY g.is_system DESC, LOWER(g.name) ASC
    `;
}

/** Fetch one group with capabilities + member count, or null. */
export async function getAccessGroupById(
    sql: postgres.Sql,
    groupId: string,
): Promise<AccessGroupWithCapsRow | null> {
    const rows = await sql<AccessGroupWithCapsRow[]>`
        SELECT
            g.id,
            g.name,
            g.display_name,
            g.description,
            g.is_system,
            g.created_at,
            g.updated_at,
            COALESCE(m.member_count, 0)::int AS member_count,
            COALESCE(c.capabilities, '[]'::jsonb) AS capabilities
        FROM access_groups g
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS member_count
            FROM user_access_groups uag
            WHERE uag.group_id = g.id
        ) m ON TRUE
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object('capability', cap.capability, 'value', cap.value)) AS capabilities
            FROM access_group_capabilities cap
            WHERE cap.group_id = g.id
        ) c ON TRUE
        WHERE g.id = ${groupId}::uuid
    `;
    return rows[0] ?? null;
}

/** Bare group row by case-insensitive name, or null. */
export async function getAccessGroupByName(
    sql: postgres.Sql,
    name: string,
): Promise<AccessGroupRow | null> {
    const rows = await sql<AccessGroupRow[]>`
        SELECT id, name, display_name, description, is_system, created_at, updated_at
        FROM access_groups
        WHERE LOWER(name) = LOWER(${name})
    `;
    return rows[0] ?? null;
}

// =============================================================================
// Group writes
// =============================================================================

/** Insert a new access group. Returns the created row. */
export async function insertAccessGroup(
    sql: postgres.Sql,
    params: { name: string; displayName: string; description: string | null; isSystem?: boolean },
): Promise<AccessGroupRow> {
    const rows = await sql<AccessGroupRow[]>`
        INSERT INTO access_groups (name, display_name, description, is_system)
        VALUES (
            ${params.name},
            ${params.displayName},
            ${params.description},
            ${params.isSystem ?? false}
        )
        RETURNING id, name, display_name, description, is_system, created_at, updated_at
    `;
    return rows[0];
}

/**
 * Update mutable group fields. Only fields present in `params` are changed:
 * `displayName` is updated when provided; `description` is updated only when the
 * key is present (allowing an explicit null to clear it). Touches updated_at.
 */
export async function updateAccessGroup(
    sql: postgres.Sql,
    groupId: string,
    params: { displayName?: string; description?: string | null },
): Promise<void> {
    const hasDescription = Object.prototype.hasOwnProperty.call(params, 'description');
    await sql`
        UPDATE access_groups
        SET
            display_name = COALESCE(${params.displayName ?? null}, display_name),
            description = ${hasDescription ? (params.description ?? null) : sql`description`},
            updated_at = NOW()
        WHERE id = ${groupId}::uuid
    `;
}

/** Delete a group (cascades to capabilities + memberships). */
export async function deleteAccessGroup(sql: postgres.Sql, groupId: string): Promise<void> {
    await sql`DELETE FROM access_groups WHERE id = ${groupId}::uuid`;
}

// =============================================================================
// Capability writes
// =============================================================================

/** Remove all capability rows for a group. */
export async function deleteAccessGroupCapabilities(
    sql: postgres.Sql,
    groupId: string,
): Promise<void> {
    await sql`DELETE FROM access_group_capabilities WHERE group_id = ${groupId}::uuid`;
}

/** Insert capability rows for a group (no-op for empty input). */
export async function insertAccessGroupCapabilities(
    sql: postgres.Sql,
    groupId: string,
    caps: { capability: AccessCapability; value: string | null }[],
): Promise<void> {
    if (caps.length === 0) return;
    const values = caps.map((c) => ({
        group_id: groupId,
        capability: c.capability,
        value: c.value,
    }));
    await sql`
        INSERT INTO access_group_capabilities ${sql(values, 'group_id', 'capability', 'value')}
        ON CONFLICT (group_id, capability) DO UPDATE SET value = EXCLUDED.value
    `;
}

// =============================================================================
// Membership
// =============================================================================

/** List members of a group. */
export async function listAccessGroupMembers(
    sql: postgres.Sql,
    groupId: string,
): Promise<AccessGroupMemberRow[]> {
    return sql<AccessGroupMemberRow[]>`
        SELECT u.id AS user_id, u.username, u.display_name, uag.assigned_at, uag.assigned_by
        FROM user_access_groups uag
        JOIN users u ON u.id = uag.user_id
        WHERE uag.group_id = ${groupId}::uuid
        ORDER BY LOWER(u.username) ASC
    `;
}

/** Add a user to a group (idempotent). */
export async function addAccessGroupMember(
    sql: postgres.Sql,
    groupId: string,
    userId: string,
    assignedBy: string | null,
): Promise<void> {
    await sql`
        INSERT INTO user_access_groups (user_id, group_id, assigned_by)
        VALUES (${userId}::uuid, ${groupId}::uuid, ${assignedBy ? sql`${assignedBy}::uuid` : null})
        ON CONFLICT (user_id, group_id) DO NOTHING
    `;
}

/** Remove a user from a group. */
export async function removeAccessGroupMember(
    sql: postgres.Sql,
    groupId: string,
    userId: string,
): Promise<void> {
    await sql`
        DELETE FROM user_access_groups
        WHERE group_id = ${groupId}::uuid AND user_id = ${userId}::uuid
    `;
}

// =============================================================================
// Effective access resolution (the merge source)
// =============================================================================

/**
 * Fetch the in-app group names a user belongs to, plus the union of all
 * capability rows across those groups. One round-trip; the service tier merges
 * these into the effective permission set.
 */
export async function getEffectiveGroupsAndCaps(
    sql: postgres.Sql,
    userId: string,
): Promise<{ groupNames: string[]; capabilities: AccessGroupCapabilityRow[] }> {
    const groupRows = await sql<{ name: string }[]>`
        SELECT g.name
        FROM user_access_groups uag
        JOIN access_groups g ON g.id = uag.group_id
        WHERE uag.user_id = ${userId}::uuid
    `;
    const capRows = await sql<AccessGroupCapabilityRow[]>`
        SELECT cap.group_id, cap.capability, cap.value
        FROM user_access_groups uag
        JOIN access_group_capabilities cap ON cap.group_id = uag.group_id
        WHERE uag.user_id = ${userId}::uuid
    `;
    return {
        groupNames: groupRows.map((r) => r.name),
        capabilities: capRows,
    };
}

/**
 * Count active (non-disabled) users OTHER than `exceptUserId` who hold the
 * `admin` capability via membership in ANY in-app access group. Used to extend
 * last-admin protection to in-app-conferred admins.
 */
export async function countOtherInAppAdmins(
    sql: postgres.Sql,
    exceptUserId: string,
): Promise<number> {
    const rows = await sql<{ n: number }[]>`
        SELECT COUNT(DISTINCT u.id)::int AS n
        FROM users u
        JOIN user_access_groups uag ON uag.user_id = u.id
        JOIN access_group_capabilities cap ON cap.group_id = uag.group_id
        WHERE cap.capability = 'admin'
          AND u.disabled_at IS NULL
          AND u.deleted_at IS NULL
          AND u.id <> ${exceptUserId}::uuid
    `;
    return rows[0]?.n ?? 0;
}

/**
 * Advisory-lock key that serializes every last-admin guard with the change it
 * guards. Each guard reads the admin count and then writes, so two guarded
 * changes running side by side (two admins demoting each other, or two
 * members removed from the last admin group) could each see the other admin
 * and both commit, leaving none. Holding this lock across the read and the
 * write makes the second guard read after the first one has committed.
 *
 * Non-guarded writers (the forward-auth / OIDC group sync) do not take it:
 * the identity provider is authoritative for those, and they are not an
 * in-app decision to refuse.
 */
export const LAST_ADMIN_GUARD_LOCK_KEY = 'lumastra:admin:last-admin-guard';

/**
 * Run `fn` while holding {@link LAST_ADMIN_GUARD_LOCK_KEY}, for a guard whose
 * write is not one transaction with its read (`eraseUserData` opens its own).
 * The lock is session-level on a reserved connection and `fn` uses the pool,
 * so `fn` must finish its guarded write before returning, and must not call
 * another guarded operation (that would wait on this lock forever).
 */
export async function withLastAdminGuardLock<T>(
    sql: postgres.Sql,
    fn: () => Promise<T>,
): Promise<T> {
    const reserved = await sql.reserve();
    const lockSql = reserved as unknown as postgres.Sql;
    try {
        await lockSql`SELECT pg_advisory_lock(hashtext(${LAST_ADMIN_GUARD_LOCK_KEY}))`;
        try {
            return await fn();
        } finally {
            await lockSql`SELECT pg_advisory_unlock(hashtext(${LAST_ADMIN_GUARD_LOCK_KEY}))`;
        }
    } finally {
        reserved.release();
    }
}

/**
 * Take {@link LAST_ADMIN_GUARD_LOCK_KEY} for the rest of transaction `tx`.
 * Call it before the guarded write, so the count that follows the write sees
 * every guarded change committed before this one.
 */
export async function lockLastAdminGuardInTx(tx: postgres.Sql): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${LAST_ADMIN_GUARD_LOCK_KEY}))`;
}

interface AdminCandidateRow {
    id: string;
    is_admin: boolean;
    admin_pinned: boolean;
    groups: (string | null)[] | null;
    inapp_names: string[];
    inapp_admin: boolean;
}

/**
 * Ids of the active users Formula A calls admin, from ONE statement (one
 * snapshot).
 *
 * Formula A is the verdict `buildUserPermissions()` (`auth.ts`) gives the same
 * user at sign-in (`native-session.ts`, `resolve-owner-admin-status.ts`):
 * `admin_pinned` makes `is_admin` authoritative in both directions; otherwise
 * admin is an `ADMIN_GROUPS` name match over the synced IdP groups plus the
 * in-app group names (age-convention names dropped, as `resolveEffectiveAccess`
 * does), or an in-app `admin` capability.
 *
 * The name match calls `hasGroupPermission()` itself. It is never folded in
 * SQL: Postgres and V8 lowercase some letters differently (Greek final sigma,
 * dotted İ), and a last-admin guard that counts someone the runtime does not
 * treat as admin can let the real last admin go. For the same reason a pinned
 * non-admin in an admin group and an unpinned row whose `is_admin` column is
 * stale do not count.
 *
 * SQL only drops rows that cannot be admin whatever the names say: disabled or
 * deleted users, pinned non-admins, and unpinned users with no groups and no
 * in-app membership.
 */
async function readEffectiveAdminIds(
    sql: postgres.Sql,
    adminGroupNames: readonly string[],
): Promise<Set<string>> {
    const rows = await sql<AdminCandidateRow[]>`
        SELECT
            u.id,
            u.is_admin,
            u.admin_pinned IS TRUE AS admin_pinned,
            u.groups,
            ARRAY(
                SELECT g.name
                FROM user_access_groups uag
                JOIN access_groups g ON g.id = uag.group_id
                WHERE uag.user_id = u.id
            ) AS inapp_names,
            EXISTS (
                SELECT 1
                FROM user_access_groups uag
                JOIN access_group_capabilities cap
                    ON cap.group_id = uag.group_id AND cap.capability = 'admin'
                WHERE uag.user_id = u.id
            ) AS inapp_admin
        FROM users u
        WHERE u.disabled_at IS NULL
          AND u.deleted_at IS NULL
          AND (
            (u.admin_pinned IS TRUE AND u.is_admin = true)
            OR (
                u.admin_pinned IS NOT TRUE
                AND (
                    cardinality(u.groups) > 0
                    OR EXISTS (SELECT 1 FROM user_access_groups uag WHERE uag.user_id = u.id)
                )
            )
          )
    `;
    const ids = new Set<string>();
    for (const row of rows) {
        if (isFormulaAAdmin(row, adminGroupNames)) ids.add(row.id);
    }
    return ids;
}

function isFormulaAAdmin(row: AdminCandidateRow, adminGroupNames: readonly string[]): boolean {
    if (row.admin_pinned) return row.is_admin === true;
    if (row.inapp_admin) return true;
    const synced = (row.groups ?? []).filter((g): g is string => typeof g === 'string');
    const inApp = stripAgeRatingGroupNames(row.inapp_names, config.AGE_RATING_GROUP_PREFIX);
    return hasGroupPermission([...synced, ...inApp], [...adminGroupNames]);
}

/**
 * Count active effective admins OTHER than `exceptUserId`, by Formula A (see
 * `readEffectiveAdminIds`). `adminGroupNames` is `config.ADMIN_GROUPS`.
 */
export async function countOtherEffectiveAdmins(
    sql: postgres.Sql,
    exceptUserId: string,
    adminGroupNames: readonly string[],
): Promise<number> {
    const ids = await readEffectiveAdminIds(sql, adminGroupNames);
    ids.delete(exceptUserId);
    return ids.size;
}

/**
 * Count ALL active effective admins (no exclusion), by Formula A. Used by the
 * access-API guards, which make the change inside a transaction and then check
 * that at least one effective admin remains before committing.
 */
export async function countEffectiveAdmins(
    sql: postgres.Sql,
    adminGroupNames: readonly string[],
): Promise<number> {
    return (await readEffectiveAdminIds(sql, adminGroupNames)).size;
}

/**
 * True when `userId` is an active effective admin and no other active user is
 * one, by Formula A, read in one statement. A disabled, deleted or non-admin
 * target is never the last admin. Call it under the guard lock
 * ({@link withLastAdminGuardLock}), together with the write it guards.
 */
export async function isLastEffectiveAdmin(
    sql: postgres.Sql,
    userId: string,
    adminGroupNames: readonly string[],
): Promise<boolean> {
    const ids = await readEffectiveAdminIds(sql, adminGroupNames);
    return ids.has(userId) && ids.size === 1;
}

/** User IDs of every member of a group (for cache invalidation on group edits). */
export async function getAccessGroupMemberIds(
    sql: postgres.Sql,
    groupId: string,
): Promise<string[]> {
    const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM user_access_groups WHERE group_id = ${groupId}::uuid
    `;
    return rows.map((r) => r.user_id);
}
