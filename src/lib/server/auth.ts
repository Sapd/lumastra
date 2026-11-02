// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Authentication and authorization utilities
import { config } from './config.js';
import { resolveMaxAgeFromGroups } from './utils/age-rating-resolver.js';

/**
 * User permissions computed from group membership
 */
export interface UserPermissions {
    hasWatchPermission: boolean;
    hasLiveTvPermission: boolean;
    hasRequestPermission: boolean;
    /** Can create/edit community reviews in media modals. */
    hasReviewPermission: boolean;
    /** Can view/create player community annotations: pins and chat. */
    hasMediaAnnotationPermission: boolean;
    ownerIsAdmin: boolean;
    /** Maximum content age rating. null = unrestricted. */
    maxAgeRating: number | null;
    /** Whether this user has any age restriction */
    isAgeRestricted: boolean;
    /** Has moderation privileges: can delete any user content regardless of author */
    isModerator: boolean;
    liveTvPriority: 'high' | 'low';
}

/**
 * Check if user groups include any of allowed groups
 *
 * Case-insensitive matching with whitespace normalization.
 * Config groups are trimmed and lowercased before comparison.
 *
 * @param userGroups - User's group membership (from auth headers)
 * @param allowedGroups - Permitted groups from config (may contain whitespace)
 * @returns true if user belongs to any allowed group
 */
export function hasGroupPermission(userGroups: string[], allowedGroups: string[]): boolean {
    const userGroupsLower = userGroups.map((g) => g.toLowerCase());
    return allowedGroups.some((allowedGroup) =>
        userGroupsLower.includes(allowedGroup.trim().toLowerCase()),
    );
}

/**
 * Build complete user permissions from group membership
 *
 * Empty config arrays have special semantics:
 * - Empty REQUEST_GROUPS grants permission to all users (open requests)
 * - Empty SOCIAL_REVIEW_GROUPS grants review permission to all users
 * - Empty MEDIA_ANNOTATION_GROUPS grants player community access to all users
 *
 * `isAdminOverride` lets a caller substitute the group-derived admin verdict with
 * an authoritative one (a DB `admin_pinned` value resolved elsewhere). This MUST be
 * threaded here rather than patched onto the result afterwards: every admin-implied
 * permission (watch, livetv, requests, moderation, livetv priority, age) is derived
 * from `isAdmin`, so overriding only the `isAdmin` field on the returned object
 * leaves the rest computed from groups — a pinned admin whose IdP groups don't
 * independently grant those perms would silently lack them (the "half-admin" bug
 * that bounced a pinned admin off /livetv). The override applies in BOTH directions
 * (a pin can also demote: `isAdminOverride=false` removes group-granted admin).
 *
 * `extraCapabilities` carries permissions resolved from the in-app group→capability
 * map (the standalone-multiuser layer). It is OR-merged into the group-derived
 * result with **monotonic/superset** semantics: boolean caps union (an in-app group
 * may only ADD a capability, never strip one the IdP/config grants), `liveTvPriority`
 * promotes to `high` if either source asks for high, and `maxAgeRating` takes the
 * **most-restrictive** (lowest non-null) value across both sources — a permissive
 * in-app cohort can never RAISE a user's age ceiling (a kid cohort + a default cohort
 * must not unlock adult content). When the effective `isAdmin` is true (via groups,
 * pin, or an in-app `admin` capability) every derived permission short-circuits to
 * the admin defaults exactly as before. The `forceNonAdmin` kill-switch still strips
 * elevation AFTER this function returns (in the service-token path) — that is
 * intentionally outside this pure function.
 *
 * @param userGroups - User's group membership
 * @param opts.isAdminOverride - authoritative admin verdict (e.g. from `admin_pinned`)
 * @param opts.extraCapabilities - capabilities from the in-app group map (OR-merged)
 * @returns Computed permission flags
 */
export function buildUserPermissions(
    userGroups: string[],
    opts?: { isAdminOverride?: boolean; extraCapabilities?: Partial<UserPermissions> },
): UserPermissions {
    const maxAge = resolveMaxAgeFromGroups(userGroups, config.AGE_RATING_GROUP_PREFIX);
    const extra = opts?.extraCapabilities;

    // Effective admin: an explicit pin override is authoritative (can elevate OR
    // demote). Absent a pin, admin is granted by either a config-group match OR an
    // in-app `admin` capability.
    const isAdmin =
        opts?.isAdminOverride ??
        (hasGroupPermission(userGroups, config.ADMIN_GROUPS) || extra?.ownerIsAdmin === true);

    // Most-restrictive (MIN) age merge across group-derived age and the in-app cap.
    // null means "unrestricted", which is the most permissive — so a null on either
    // side never lowers the other side's restriction.
    const extraAge = extra?.maxAgeRating;
    const mergedAge =
        maxAge === null
            ? (extraAge ?? null)
            : extraAge === null || extraAge === undefined
              ? maxAge
              : Math.min(maxAge, extraAge);

    return {
        hasWatchPermission:
            isAdmin ||
            extra?.hasWatchPermission === true ||
            hasGroupPermission(userGroups, config.WATCH_PERMISSION_GROUPS),
        hasLiveTvPermission:
            isAdmin ||
            extra?.hasLiveTvPermission === true ||
            hasGroupPermission(userGroups, config.LIVETV_GROUPS),
        hasRequestPermission:
            isAdmin ||
            extra?.hasRequestPermission === true ||
            config.REQUEST_GROUPS.length === 0 ||
            hasGroupPermission(userGroups, config.REQUEST_GROUPS),
        hasReviewPermission:
            isAdmin ||
            extra?.hasReviewPermission === true ||
            config.SOCIAL_REVIEW_GROUPS.length === 0 ||
            hasGroupPermission(userGroups, config.SOCIAL_REVIEW_GROUPS),
        hasMediaAnnotationPermission:
            isAdmin ||
            extra?.hasMediaAnnotationPermission === true ||
            config.MEDIA_ANNOTATION_GROUPS.length === 0 ||
            hasGroupPermission(userGroups, config.MEDIA_ANNOTATION_GROUPS),
        ownerIsAdmin: isAdmin,
        maxAgeRating: isAdmin ? null : mergedAge,
        isAgeRestricted: isAdmin ? false : mergedAge !== null,
        isModerator:
            isAdmin ||
            extra?.isModerator === true ||
            (config.MODERATOR_GROUPS.length > 0 &&
                hasGroupPermission(userGroups, config.MODERATOR_GROUPS)),
        liveTvPriority:
            isAdmin ||
            extra?.liveTvPriority === 'high' ||
            hasGroupPermission(userGroups, config.LIVETV_HIGH_PRIORITY_GROUPS)
                ? 'high'
                : 'low',
    };
}

/**
 * Check if user has admin privileges (case-insensitive)
 */
export function isUserAdmin(userGroups: string[] = []): boolean {
    const userGroupsLower = userGroups.map((g) => g.toLowerCase());
    return config.ADMIN_GROUPS.some((adminGroup) =>
        userGroupsLower.includes(adminGroup.trim().toLowerCase()),
    );
}

/**
 * Check if user has watch permissions (can see all users' streaming sessions, case-insensitive)
 */
export function hasWatchPermissions(userGroups: string[] = []): boolean {
    const userGroupsLower = userGroups.map((g) => g.toLowerCase());
    return config.WATCH_PERMISSION_GROUPS.some((watchGroup) =>
        userGroupsLower.includes(watchGroup.trim().toLowerCase()),
    );
}

/**
 * Check if user is admin or ARR manager (for service URLs and debug panel access, case-insensitive)
 */
export function isAdminOrArrManager(userGroups: string[] = []): boolean {
    const userGroupsLower = userGroups.map((g) => g.toLowerCase());
    const allPrivilegedGroups = [...config.ADMIN_GROUPS, ...config.ARR_MANAGER_GROUPS];
    return allPrivilegedGroups.some((group) =>
        userGroupsLower.includes(group.trim().toLowerCase()),
    );
}
