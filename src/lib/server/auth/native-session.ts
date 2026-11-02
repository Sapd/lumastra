// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for the native-login session cookie and for materializing a
 * UserContext from a validated session row. Used by the auth endpoints
 * (login/logout/setup/change-password) and the hooks.server.ts session populator.
 */

import type { Cookies, RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';
import { buildUserPermissions, type UserPermissions } from '$lib/server/auth.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { ValidatedSessionRow } from '$lib/server/database/queries/user-sessions.queries.js';

/**
 * Resolved in-app access merged into the session identity. Kept as an explicit
 * parameter so `buildUserContextFromSession` stays pure/synchronous (the DB
 * lookup happens in the async session populator that calls this). `extraGroups`
 * augments the session's group list (config-name matching keeps working);
 * `extraCapabilities` is OR-merged into the permission result.
 */
export interface SessionEffectiveAccess {
    extraGroups?: string[];
    extraCapabilities?: Partial<UserPermissions>;
}

/**
 * Session cookie name. HttpOnly + SameSite=Lax + Path=/; Secure when the
 * browser used HTTPS (cookie-transport.ts, applied to every request in
 * hooks.server.ts), so plain-HTTP LAN access can sign in.
 */
export const SESSION_COOKIE_NAME = 'lumastra_session';

/**
 * Set the session cookie. `maxAgeSeconds` aligns the cookie lifetime with the
 * server-side session expiry. We intentionally do NOT pass `secure`: the
 * request's cookie defaults (cookie-transport.ts) set it from the protocol the
 * browser used, honouring ORIGIN and the forwarded protocol from a trusted proxy.
 */
export function setSessionCookie(cookies: Cookies, token: string, maxAgeSeconds: number): void {
    cookies.set(SESSION_COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: maxAgeSeconds,
    });
}

/**
 * Cookie Max-Age (seconds) for a session expiring at `expiresAt`, clamped to a
 * positive value so clock skew (or an already-past expiry) can never produce a
 * negative Max-Age — which a browser would treat as a session-only / immediately
 * expired cookie, silently logging the user out.
 */
export function sessionMaxAgeSeconds(expiresAt: Date): number {
    return Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}

/** Clear the session cookie (logout / invalid session). */
export function clearSessionCookie(cookies: Cookies): void {
    cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}

/** Read the raw session token from the request cookies, or null. */
export function readSessionCookie(cookies: Cookies): string | null {
    return cookies.get(SESSION_COOKIE_NAME) ?? null;
}

/**
 * Build a UserContext from a validated session row, applying the same
 * "group-derived permissions with DB pin override" semantics as forward auth
 * (handleForwardAuth) so a native session and a forward-auth session produce an
 * identical identity shape for the ~398 downstream `locals.user` consumers.
 */
export function buildUserContextFromSession(
    row: ValidatedSessionRow,
    access?: SessionEffectiveAccess,
): UserContext {
    const syncedGroups = row.groups ?? [];
    // Merge in-app group names (standalone multi-user) so config-name matching
    // keeps working; dedupe case-insensitively (matches users.groups semantics).
    const userGroups = mergeGroups(syncedGroups, access?.extraGroups);

    // Honor an admin's manual pin (admin_pinned) over the group-derived verdict by
    // threading it INTO buildUserPermissions, so every admin-implied permission
    // (watch/livetv/requests/moderation/priority) is recomputed from the effective
    // isAdmin — not just the top-level flag (avoids the "half-admin" pin bug).
    // In-app group capabilities are OR-merged via extraCapabilities.
    const permissions = buildUserPermissions(userGroups, {
        ...(row.admin_pinned ? { isAdminOverride: row.is_admin } : {}),
        ...(access?.extraCapabilities ? { extraCapabilities: access.extraCapabilities } : {}),
    });

    // Age rating: admin is always unrestricted (null). Otherwise apply the
    // independent age pin (age_rating_pinned) AND the in-app / group-derived
    // ceiling from buildUserPermissions, taking the MOST-RESTRICTIVE (MIN). A pin
    // is an explicit ceiling but must NOT raise a more-restrictive in-app cohort:
    // a child pinned at 18 who is also in a max_age_rating=6 cohort stays capped
    // at 6 (matches the forward-auth path's mergeMaxAge behavior). null on either
    // side = unrestricted, so it never lowers the other side's restriction.
    const pinnedAge = row.age_rating_pinned ? row.max_age_rating : null;
    const maxAgeRating = permissions.ownerIsAdmin
        ? null
        : mergeMaxAge(pinnedAge, permissions.maxAgeRating);

    return {
        userId: toUserId(row.user_id),
        username: row.username,
        groups: userGroups.join('|'),
        userGroups,
        ...permissions,
        maxAgeRating,
        isAgeRestricted: maxAgeRating !== null,
    };
}

/**
 * Most-restrictive (MIN) merge of two age ceilings. null = unrestricted (most
 * permissive), so a null on either side never lowers the other side's restriction.
 */
function mergeMaxAge(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
}

/** Case-insensitive dedupe union, preserving first-seen casing. */
function mergeGroups(synced: string[], extra?: string[]): string[] {
    if (!extra || extra.length === 0) return synced;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const g of [...synced, ...extra]) {
        const key = g.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(g);
        }
    }
    return out;
}

/** True if the request carries a native session cookie (presence only). */
export function hasSessionCookie(event: RequestEvent): boolean {
    return !!event.cookies.get(SESSION_COOKIE_NAME);
}
