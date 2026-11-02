// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Access Control Service (Tier 2 — standalone multi-user identity & access).
 *
 * Resolves a user's *effective* access by merging their IdP/synced groups with
 * their in-app access-group memberships, and produces both:
 *   - effectiveGroups: dedupe(syncedGroups ∪ inAppGroupNames) — fed to
 *     buildUserPermissions so existing config-name matching keeps working.
 *   - capabilities: a Partial<UserPermissions> OR-merged from the in-app group→
 *     capability map — passed to buildUserPermissions as `extraCapabilities`.
 *
 * Merge rules (per resolved spec decisions):
 *   - boolean caps: OR (union) — an in-app group only ADDs capabilities.
 *   - max_age_rating: MIN (most-restrictive) — a permissive cohort can never
 *     raise a user's age ceiling.
 *   - livetv priority: high wins.
 *   - an in-app `admin` capability confers admin (and thus everything, via
 *     buildUserPermissions).
 *
 * Also owns the transactional group/membership/capability writes and the
 * per-user L1 access cache + its invalidation.
 */

import type postgres from 'postgres';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { config } from '$lib/server/config.js';
import type { UserPermissions } from '$lib/server/auth.js';
import type { AccessCapability } from '$lib/schemas/api-admin-access.js';
import { Logger } from '$lib/server/utils/logger.js';
import { stripAgeRatingGroupNames } from '$lib/server/utils/age-rating-resolver.js';
import {
    getEffectiveGroupsAndCaps,
    insertAccessGroup,
    insertAccessGroupCapabilities,
    deleteAccessGroupCapabilities,
    updateAccessGroup,
    deleteAccessGroup,
    addAccessGroupMember,
    removeAccessGroupMember,
    getAccessGroupById,
    getAccessGroupByName,
    getAccessGroupMemberIds,
    countEffectiveAdmins,
    lockLastAdminGuardInTx,
    type AccessGroupCapabilityRow,
    type AccessGroupWithCapsRow,
} from '$lib/server/database/queries/access-groups.queries.js';
import {
    getCachedUserAccess,
    setCachedUserAccess,
    invalidateUserAccessCache,
    invalidateUserAccessCacheMany,
    type ResolvedUserAccess,
} from '$lib/server/cache/user-access-cache.js';

const logger = Logger.for('AccessControl');

/**
 * X1(b) (security review 2026-09-23, final fix wave): every in-app write that
 * can change a user's EFFECTIVE (Formula A) admin verdict — joining/leaving a
 * group, a group's capability set gaining/losing `admin`, an admin-conferring
 * group's deletion — must narrow/restore that user's admin-scoped credentials
 * the same way every other admin-affecting transition does. Before this fix
 * these write paths narrowed/restored NOTHING: a user removed from their only
 * admin-conferring group kept a still-`['admin']`-scoped PAT/service-token
 * forever (this is the second half of the X1 blocker chain — the ceiling in
 * the defs, above, stops a NON-admin from re-granting; this stops the
 * credential itself from surviving a legitimate admin's removal).
 *
 * `ownerAdminStatus()`/`applyAdminTransition()` use a DYNAMIC import for
 * `resolve-owner-admin-status.ts` — a STATIC import would be a real cycle:
 * that module imports `resolveEffectiveAccess` from THIS file for its own
 * in-app OR-term.
 */
async function ownerAdminStatus(
    sql: postgres.Sql,
    userId: string,
): Promise<{ userId: string; username: string; isAdmin: boolean } | null> {
    const { resolveOwnerAdminStatusById } =
        await import('$lib/server/auth/resolve-owner-admin-status.js');
    return resolveOwnerAdminStatusById(sql, userId);
}

/**
 * Apply the shared narrow/restore transition for ONE user, given their
 * Formula-A verdict captured BEFORE a write (`null` if the user could not be
 * resolved, e.g. deleted mid-request — treated as "nothing to do") and
 * re-resolved AFTER it. An unavailable verdict only narrows credentials.
 * Logs (never throws) on a post-write lookup or credential-store
 * failure, matching every other admin-transition call site's posture.
 */
async function applyAdminTransition(
    sql: postgres.Sql,
    before: { userId: string; username: string; isAdmin: boolean } | null,
    context: Record<string, unknown>,
): Promise<void> {
    if (!before) return;
    let isAdminNow = false;
    try {
        const after = await ownerAdminStatus(sql, before.userId);
        isAdminNow = after?.isAdmin === true;
    } catch (error) {
        // Unknown access can only narrow credentials; it must never restore admin scopes.
        logger.warn('In-app admin transition: current admin status unavailable; narrowing only', {
            ...context,
            error: String(error),
        });
    }
    try {
        const { applyAdminStatusTransition } =
            await import('$lib/server/services/credential-revocation.service.js');
        const { failedStores } = await applyAdminStatusTransition(
            sql,
            before.userId,
            before.username,
            before.isAdmin,
            isAdminNow,
        );
        if (failedStores.length > 0) {
            logger.warn('In-app admin transition: some credential stores failed to sync', {
                ...context,
                failedStores,
            });
        }
    } catch (error) {
        logger.warn('In-app admin transition: credential sync failed after write', {
            ...context,
            error: String(error),
        });
    }
}

/**
 * Reduce a list of (group-spanning) capability rows into a Partial<UserPermissions>
 * suitable as `extraCapabilities`. Pure; exported for unit testing.
 */
export function mergeCapabilityRows(
    caps: readonly { capability: AccessCapability; value: string | null }[],
): Partial<UserPermissions> {
    const result: Partial<UserPermissions> = {};
    let minAge: number | null | undefined; // undefined = no age cap seen yet

    for (const cap of caps) {
        switch (cap.capability) {
            case 'admin':
                result.ownerIsAdmin = true;
                break;
            case 'watch':
                result.hasWatchPermission = true;
                break;
            case 'livetv':
                result.hasLiveTvPermission = true;
                break;
            case 'requests':
                result.hasRequestPermission = true;
                break;
            case 'moderator':
                result.isModerator = true;
                break;
            case 'livetv_high_priority':
                result.liveTvPriority = 'high';
                break;
            case 'arr_manager':
                // No dedicated UserPermissions field; arr-manager is resolved via
                // config groups (ARR_MANAGER_GROUPS) against effectiveGroups. The
                // group's NAME in effectiveGroups covers it when config lists it;
                // no extra capability flag to set here.
                break;
            case 'max_age_rating': {
                // Parameterized: parse the numeric cap. MIN across groups (most
                // restrictive). A missing/invalid value means "no cap from this row".
                const parsed = cap.value != null ? Number.parseInt(cap.value, 10) : NaN;
                if (Number.isFinite(parsed) && parsed >= 0) {
                    minAge = minAge === undefined ? parsed : Math.min(minAge as number, parsed);
                }
                break;
            }
        }
    }

    if (minAge !== undefined) {
        result.maxAgeRating = minAge;
    }
    return result;
}

/**
 * Build the case-insensitive matcher for the age-rating group-name convention
 * (`{prefix}{N}`, e.g. `age-18`). In-app group NAMES matching this pattern must
 * NOT participate in the effective-group set: `resolveMaxAgeFromGroups` takes the
 * MAX across matching names, so a permissive in-app group literally named
 * `age-18` would RAISE a synced/pinned child's age ceiling — directly violating
 * the "a permissive group must never raise a child's ceiling" invariant. The
 * in-app layer drives age ONLY through the MIN-merged `max_age_rating` capability
 * (see mergeCapabilityRows). Synced/IdP age groups are unaffected — they are
 * never routed through this filter.
 */
function buildAgePrefixPattern(): RegExp {
    const escaped = config.AGE_RATING_GROUP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}\\d+$`, 'i');
}

/** Drop in-app group names that match the age-rating prefix convention. */
function stripInAppAgeNames(inAppNames: readonly string[]): string[] {
    return stripAgeRatingGroupNames(inAppNames, config.AGE_RATING_GROUP_PREFIX);
}

/**
 * Resolve effective access for a user, using the L1 cache.
 *
 * Returns:
 *  - inAppGroupNames: the user's in-app access-group names (age-prefix names
 *    filtered out — see stripInAppAgeNames). This is what an auth path should
 *    pass as `extraGroups` (it AUGMENTS the synced list; passing the already-
 *    merged set would double-feed the synced groups).
 *  - effectiveGroups: dedupe(syncedGroups ∪ inAppGroupNames) — the merged set for
 *    paths that consume a single flat group list.
 *  - capabilities: OR-merged in-app capability map (extraCapabilities).
 */
export async function resolveEffectiveAccess(
    sql: postgres.Sql,
    userId: string,
    syncedGroups: readonly string[],
): Promise<{
    inAppGroupNames: string[];
    effectiveGroups: string[];
    capabilities: Partial<UserPermissions>;
}> {
    const cached = getCachedUserAccess(userId);
    const inApp: ResolvedUserAccess = cached ?? (await loadAndCacheUserAccess(sql, userId));

    const inAppGroupNames = stripInAppAgeNames(inApp.groupNames);
    const effectiveGroups = dedupeGroups([...syncedGroups, ...inAppGroupNames]);
    return { inAppGroupNames, effectiveGroups, capabilities: inApp.capabilities };
}

/** Load a user's in-app access from the DB and populate the cache. */
async function loadAndCacheUserAccess(
    sql: postgres.Sql,
    userId: string,
): Promise<ResolvedUserAccess> {
    const { groupNames, capabilities } = await getEffectiveGroupsAndCaps(sql, userId);
    const access: ResolvedUserAccess = {
        groupNames,
        capabilities: mergeCapabilityRows(capabilities),
    };
    setCachedUserAccess(userId, access);
    return access;
}

/** Case-insensitive dedupe preserving first-seen casing (matches users.groups semantics). */
function dedupeGroups(groups: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const g of groups) {
        const key = g.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(g);
        }
    }
    return out;
}

// =============================================================================
// Admin write orchestration
// =============================================================================

export type AccessServiceResult<T = undefined> =
    { ok: true; data: T } | { ok: false; status: number; message: string };

/** Sentinel thrown inside a guarded transaction to force a rollback. */
class LastAdminGuardError extends Error {
    constructor() {
        super('last-admin-guard');
        this.name = 'LastAdminGuardError';
    }
}

/** True when the postgres error is a unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
    return (err as { code?: unknown } | null | undefined)?.code === '23505';
}

/**
 * True if a group confers admin — either it carries the `admin` capability, OR
 * its NAME is in config.ADMIN_GROUPS (the config-compat name path that
 * buildUserPermissions honors via hasGroupPermission). Both must be considered
 * by the last-admin guards (a name-only admin group is a real admin source).
 *
 * Exported (security review 2026-09-23 final fix wave, X1a) so the
 * `access/groups/[id]/members.ts` def can apply the SAME admin-ceiling
 * predicate to "does adding this member confer admin" that this file's own
 * last-admin guards use for "does removing them revoke it" — one definition
 * of "admin-conferring group", not two.
 */
export function groupConfersAdmin(group: {
    name: string;
    capabilities: { capability: AccessCapability }[];
}): boolean {
    if (group.capabilities.some((c) => c.capability === 'admin')) return true;
    const adminNames = config.ADMIN_GROUPS.map((g) => g.trim().toLowerCase());
    return adminNames.includes(group.name.trim().toLowerCase());
}

/**
 * Returns true when `name` collides with a config-significant permission group,
 * i.e. it would shadow a group that config.* already treats as granting a
 * privileged capability. Checked case-insensitively.
 *
 * Covers: ADMIN_GROUPS, LIVETV_GROUPS, ARR_MANAGER_GROUPS,
 *         LIVETV_HIGH_PRIORITY_GROUPS, MODERATOR_GROUPS, WATCH_PERMISSION_GROUPS,
 *         REQUEST_GROUPS, SOCIAL_REVIEW_GROUPS, MEDIA_ANNOTATION_GROUPS,
 *         and any name matching the AGE_RATING_GROUP_PREFIX pattern (e.g. "age-18").
 *
 * Exported so the route layer can surface the same check in validation if needed.
 */
export function isReservedGroupName(name: string): boolean {
    const lower = name.trim().toLowerCase();
    const reservedArrays = [
        config.ADMIN_GROUPS,
        config.LIVETV_GROUPS,
        config.ARR_MANAGER_GROUPS,
        config.LIVETV_HIGH_PRIORITY_GROUPS,
        config.MODERATOR_GROUPS,
        config.WATCH_PERMISSION_GROUPS,
        config.REQUEST_GROUPS,
        config.SOCIAL_REVIEW_GROUPS,
        config.MEDIA_ANNOTATION_GROUPS,
    ];
    for (const arr of reservedArrays) {
        if (arr.some((g) => g.trim().toLowerCase() === lower)) return true;
    }
    return buildAgePrefixPattern().test(lower);
}

/** Normalize capability rows from a request body into DB-ready rows. */
function normalizeCaps(
    caps: { capability: AccessCapability; value?: string | null }[] | undefined,
): { capability: AccessCapability; value: string | null }[] {
    if (!caps) return [];
    // Dedupe by capability (PK is (group_id, capability)); last wins.
    const map = new Map<AccessCapability, string | null>();
    for (const c of caps) {
        map.set(c.capability, c.value ?? null);
    }
    return Array.from(map.entries()).map(([capability, value]) => ({ capability, value }));
}

/** Create an access group with optional initial capabilities (transactional). */
export async function createAccessGroup(
    sql: postgres.Sql,
    params: {
        name: string;
        displayName?: string;
        description?: string | null;
        capabilities?: { capability: AccessCapability; value?: string | null }[];
    },
): Promise<AccessServiceResult<AccessGroupWithCapsRow>> {
    // Reject names that collide with config-significant permission groups.  A
    // user-created group shadowing e.g. config.ADMIN_GROUPS would silently grant
    // its members unexpected privileges via the config-name path in
    // buildUserPermissions. Must be checked before the LOWER(name) uniqueness
    // check so the error message is actionable (not just "already exists").
    if (isReservedGroupName(params.name)) {
        return {
            ok: false,
            status: 409,
            message:
                'Name reserved — collides with a configured permission group. Choose a different name or update the corresponding environment variable.',
        };
    }
    const existing = await getAccessGroupByName(sql, params.name);
    if (existing) {
        return { ok: false, status: 409, message: 'A group with that name already exists' };
    }
    const caps = normalizeCaps(params.capabilities);
    let created: { id: string };
    try {
        // eslint-disable-next-line callback-safety/no-direct-sql-begin
        created = await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            const group = await insertAccessGroup(tx, {
                name: params.name,
                displayName: params.displayName?.trim() || params.name,
                description: params.description ?? null,
                isSystem: false,
            });
            await insertAccessGroupCapabilities(tx, group.id, caps);
            return group;
        });
    } catch (err) {
        // TOCTOU: the getAccessGroupByName pre-check is outside the tx, so two
        // concurrent creates with the same name can both pass it and race the
        // case-insensitive unique index (idx_access_groups_name_lower). Map the
        // resulting 23505 to a clean 409 instead of letting it surface as a 500.
        if (isUniqueViolation(err)) {
            return { ok: false, status: 409, message: 'A group with that name already exists' };
        }
        throw err;
    }
    const full = await getAccessGroupById(sql, created.id);
    return full
        ? { ok: true, data: full }
        : { ok: false, status: 500, message: 'Group created but could not be re-read' };
}

/**
 * Update a group's display/description and (when provided) replace its full
 * capability set. Invalidates the access cache for every member afterward — a
 * capability change can grant/revoke for all current members.
 */
export async function updateAccessGroupWithCaps(
    sql: postgres.Sql,
    groupId: string,
    params: {
        displayName?: string;
        description?: string | null;
        capabilities?: { capability: AccessCapability; value?: string | null }[];
    },
): Promise<AccessServiceResult<AccessGroupWithCapsRow>> {
    const existing = await getAccessGroupById(sql, groupId);
    if (!existing) return { ok: false, status: 404, message: 'Group not found' };

    const replaceCaps = params.capabilities !== undefined;
    const caps = normalizeCaps(params.capabilities);

    // Last-admin protection: PATCH-replacing capabilities can STRIP the `admin`
    // capability from an admin-conferring group, revoking admin from every member
    // atomically. If that would leave the instance with zero effective admins,
    // refuse. We only need to guard when (a) the group currently confers admin via
    // its capability and (b) the replacement set drops `admin`. (A name-conferred
    // admin group keeps conferring admin through its name regardless of caps, so a
    // cap edit there can't remove the last admin.)
    const currentlyHasAdminCap = existing.capabilities.some((c) => c.capability === 'admin');
    const replacementDropsAdmin = replaceCaps && !caps.some((c) => c.capability === 'admin');
    const nameConfersAdmin = config.ADMIN_GROUPS.map((g) => g.trim().toLowerCase()).includes(
        existing.name.trim().toLowerCase(),
    );
    const mustGuardAdmin = currentlyHasAdminCap && replacementDropsAdmin && !nameConfersAdmin;

    // X1(b): capture each CURRENT member's Formula-A verdict before a real
    // capability replace — a replace can add OR drop `admin` and cross the
    // threshold for some members while leaving others (e.g. a name-conferred
    // admin) unaffected; comparing the ACTUAL before/after verdict per user
    // (rather than reasoning about the capability diff in the abstract)
    // handles both directions and every such edge case uniformly.
    const memberIdsForTransition = replaceCaps ? await getAccessGroupMemberIds(sql, groupId) : [];
    const beforeStatuses = await Promise.all(
        memberIdsForTransition.map((uid) => ownerAdminStatus(sql, uid)),
    );

    try {
        // eslint-disable-next-line callback-safety/no-direct-sql-begin
        await sql.begin(async (txRaw) => {
            const txSql = txRaw as unknown as postgres.Sql;
            // Serialize with every other last-admin guard (see LAST_ADMIN_GUARD_LOCK_KEY).
            if (mustGuardAdmin) await lockLastAdminGuardInTx(txSql);
            await updateAccessGroup(txSql, groupId, {
                displayName: params.displayName,
                ...(Object.prototype.hasOwnProperty.call(params, 'description')
                    ? { description: params.description ?? null }
                    : {}),
            });
            if (replaceCaps) {
                await deleteAccessGroupCapabilities(txSql, groupId);
                await insertAccessGroupCapabilities(txSql, groupId, caps);
            }
            if (mustGuardAdmin) {
                // Count effective admins AFTER the cap drop, inside the tx. Zero →
                // throw to roll back the whole update.
                const remaining = await countEffectiveAdmins(txSql, config.ADMIN_GROUPS);
                if (remaining === 0) throw new LastAdminGuardError();
            }
        });
    } catch (err) {
        if (err instanceof LastAdminGuardError) {
            return {
                ok: false,
                status: 409,
                message: 'Cannot remove the admin capability from the last admin-conferring group.',
            };
        }
        throw err;
    }

    // Invalidate cache for all members (capabilities may have changed).
    const memberIds = await getAccessGroupMemberIds(sql, groupId);
    invalidateUserAccessCacheMany(memberIds);

    // X1(b): apply the transition for every member whose Formula-A verdict we
    // captured above — invalidation just ran, so this re-read is fresh.
    await Promise.all(
        beforeStatuses.map((before) =>
            applyAdminTransition(sql, before, { groupId, reason: 'capability-replace' }),
        ),
    );

    const full = await getAccessGroupById(sql, groupId);
    return full
        ? { ok: true, data: full }
        : { ok: false, status: 500, message: 'Group updated but could not be re-read' };
}

/** Delete a group. System groups are protected. Invalidates members' caches. */
export async function deleteAccessGroupGuarded(
    sql: postgres.Sql,
    groupId: string,
): Promise<AccessServiceResult> {
    const existing = await getAccessGroupById(sql, groupId);
    if (!existing) return { ok: false, status: 404, message: 'Group not found' };
    if (existing.is_system) {
        return { ok: false, status: 403, message: 'System groups cannot be deleted' };
    }
    const memberIds = await getAccessGroupMemberIds(sql, groupId);

    // Last-admin protection: deleting a non-system group that CONFERS admin (via
    // the `admin` capability OR a config.ADMIN_GROUPS name) atomically revokes
    // admin from all its members. If that would leave zero effective admins,
    // refuse — a user-created admin-conferring group is the only admin source on a
    // fresh standalone install that renamed/replaced the seeded `admins` cohort.
    const mustGuardAdmin = groupConfersAdmin(existing);

    // X1(b): capture each member's Formula-A verdict BEFORE the delete, only
    // when this group could actually change anyone's admin status (a group
    // that doesn't confer admin can't affect isAdmin for anyone by being
    // deleted — its members' Formula A never depended on it for that axis).
    const beforeStatuses = mustGuardAdmin
        ? await Promise.all(memberIds.map((uid) => ownerAdminStatus(sql, uid)))
        : [];

    try {
        // eslint-disable-next-line callback-safety/no-direct-sql-begin
        await sql.begin(async (txRaw) => {
            const txSql = txRaw as unknown as postgres.Sql;
            if (mustGuardAdmin) await lockLastAdminGuardInTx(txSql);
            await deleteAccessGroup(txSql, groupId);
            if (mustGuardAdmin) {
                const remaining = await countEffectiveAdmins(txSql, config.ADMIN_GROUPS);
                if (remaining === 0) throw new LastAdminGuardError();
            }
        });
    } catch (err) {
        if (err instanceof LastAdminGuardError) {
            return {
                ok: false,
                status: 409,
                message: 'Cannot delete the last admin-conferring group.',
            };
        }
        throw err;
    }

    invalidateUserAccessCacheMany(memberIds);

    await Promise.all(
        beforeStatuses.map((before) =>
            applyAdminTransition(sql, before, { groupId, reason: 'group-delete' }),
        ),
    );

    return { ok: true, data: undefined };
}

/**
 * Add a user to a group; invalidates that user's access cache.
 *
 * X1(b): joining a group can itself promote the user to admin (the group
 * confers `admin`, possibly combined with membership crossing the Formula-A
 * threshold). Captures the verdict before/after and restores admin-scoped
 * credentials on a real promotion — the false→true counterpart of
 * `removeMember()`'s narrow.
 */
export async function addMember(
    sql: postgres.Sql,
    groupId: string,
    userId: string,
    assignedBy: string | null,
): Promise<AccessServiceResult> {
    const existing = await getAccessGroupById(sql, groupId);
    if (!existing) return { ok: false, status: 404, message: 'Group not found' };
    if (!(await getUserById(sql, userId)))
        return { ok: false, status: 404, message: 'User not found' };

    const before = await ownerAdminStatus(sql, userId);

    await addAccessGroupMember(sql, groupId, userId, assignedBy);
    invalidateUserAccessCache(userId);

    await applyAdminTransition(sql, before, { userId, groupId, reason: 'add-member' });
    return { ok: true, data: undefined };
}

/**
 * Remove a user from a group; invalidates that user's access cache.
 *
 * Last-admin protection: removing the last member of (or the last admin-carrying
 * membership from) an admin-conferring group can drop the instance's effective
 * admin count to zero — a complete lockout. Guard when the group confers admin
 * (capability OR config.ADMIN_GROUPS name): perform the removal inside a tx, then
 * count remaining effective admins and roll back if none remain.
 *
 * X1(b): the last-admin guard above protects the INSTANCE from having zero
 * admins; it says nothing about THIS user's own admin-scoped credentials
 * (which may need narrowing even when other admins remain). Captures this
 * user's Formula-A verdict before/after and narrows on a real demotion — this
 * is the second half of the X1 blocker chain: without it, a user removed
 * from their only admin-conferring group kept a still-admin-scoped
 * PAT/service-token indefinitely.
 */
export async function removeMember(
    sql: postgres.Sql,
    groupId: string,
    userId: string,
): Promise<AccessServiceResult> {
    const group = await getAccessGroupById(sql, groupId);
    // If the group no longer exists, the removal is a no-op success (idempotent).
    const mustGuardAdmin = group ? groupConfersAdmin(group) : false;
    const before = await ownerAdminStatus(sql, userId);

    try {
        // eslint-disable-next-line callback-safety/no-direct-sql-begin
        await sql.begin(async (txRaw) => {
            const txSql = txRaw as unknown as postgres.Sql;
            if (mustGuardAdmin) await lockLastAdminGuardInTx(txSql);
            await removeAccessGroupMember(txSql, groupId, userId);
            if (mustGuardAdmin) {
                const remaining = await countEffectiveAdmins(txSql, config.ADMIN_GROUPS);
                if (remaining === 0) throw new LastAdminGuardError();
            }
        });
    } catch (err) {
        if (err instanceof LastAdminGuardError) {
            return {
                ok: false,
                status: 409,
                message: 'Cannot remove the last effective admin from the instance.',
            };
        }
        throw err;
    }

    invalidateUserAccessCache(userId);
    await applyAdminTransition(sql, before, { userId, groupId, reason: 'remove-member' });
    return { ok: true, data: undefined };
}

export { type AccessGroupCapabilityRow };
