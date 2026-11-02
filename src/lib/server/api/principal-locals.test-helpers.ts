// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `event.locals` exactly as resolveAuth leaves them, for tests of handlers that
 * decide admin rights (spec 2026-10-07-auth-route-policy-design §5.1).
 *
 * The principal is built by the real producer (`buildPrincipal`, with device
 * scopes from `mapRequestedScopeToRaw`). `locals.user` carries the OWNER's live
 * permissions, as every token branch of forward-auth spreads them. That gap is
 * the bug class: `adminOwnersDeviceToken()` has `user.isAdmin === true` and a
 * non-admin principal. A handler that grants admin rights to it read the wrong
 * field.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { buildPrincipal, type PrincipalKind } from '$lib/server/api/principal.js';
import { mapRequestedScopeToRaw } from '$lib/server/oauth/device-scope-map.js';
import type { UserId } from '$lib/shared/user-id.js';

export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;

export interface LocalsOptions {
    kind: PrincipalKind;
    ownerIsAdmin: boolean;
    tokenScopes?: string[];
    username?: string;
    userId?: UserId;
}

export function principalLocals(opts: LocalsOptions): RequestEvent['locals'] {
    const isSession = opts.kind === 'session' || opts.kind === 'forward_auth';
    const username = opts.username ?? 'alice';
    const userId = opts.userId ?? TEST_USER_ID;
    const userGroups = opts.ownerIsAdmin ? ['admins'] : ['users'];
    const principal = buildPrincipal({
        kind: opts.kind,
        userId,
        username,
        userGroups,
        tokenScopes: opts.tokenScopes ?? [],
        sessionIsAdmin: isSession ? opts.ownerIsAdmin : false,
        ownerIsAdmin: opts.ownerIsAdmin,
    });
    return {
        principal,
        user: {
            userId,
            username,
            groups: userGroups.join('|'),
            userGroups,
            ownerIsAdmin: opts.ownerIsAdmin,
            isModerator: opts.ownerIsAdmin,
            hasWatchPermission: true,
            hasLiveTvPermission: opts.ownerIsAdmin,
            hasRequestPermission: true,
            hasReviewPermission: opts.ownerIsAdmin,
            hasMediaAnnotationPermission: opts.ownerIsAdmin,
            isAgeRestricted: false,
            maxAgeRating: null,
        },
    } as unknown as RequestEvent['locals'];
}

/** THE case: an admin's OAuth device token (no admin scope). Principal non-admin. */
export const adminOwnersDeviceToken = (
    requested: string | null = 'media',
): RequestEvent['locals'] =>
    principalLocals({
        kind: 'bearer',
        ownerIsAdmin: true,
        tokenScopes: mapRequestedScopeToRaw(requested),
    });

/** An admin's read/write PAT (no admin scope). Principal non-admin. */
export const adminOwnersReadWritePat = (): RequestEvent['locals'] =>
    principalLocals({ kind: 'pat', ownerIsAdmin: true, tokenScopes: ['read', 'write'] });

/** Control: an admin's browser session. Principal admin. */
export const adminSession = (): RequestEvent['locals'] =>
    principalLocals({ kind: 'session', ownerIsAdmin: true });

/** Control: an admin-scoped PAT of an admin. Principal admin. */
export const adminScopedPat = (): RequestEvent['locals'] =>
    principalLocals({ kind: 'pat', ownerIsAdmin: true, tokenScopes: ['admin'] });

/** `locals.user` says admin, but no principal was set: must be treated as non-admin. */
export const adminUserWithoutPrincipal = (): RequestEvent['locals'] => {
    const l = adminSession() as unknown as Record<string, unknown>;
    delete l.principal;
    return l as unknown as RequestEvent['locals'];
};
