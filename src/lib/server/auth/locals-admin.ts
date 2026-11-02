// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one admin decision for request handlers.
 *
 * `locals.user.isAdmin` is the credential OWNER's flag. A scoped PAT, a device
 * grant or a service token of an admin owner keeps it `true` while the
 * credential itself carries no admin capability (`locals.principal.isAdmin`
 * is false), so reading the owner flag hands that token admin powers. Ask this
 * helper instead; the `no-restricted-syntax` lint rule bans
 * `locals.user.isAdmin` in server code.
 *
 * Only the principal decides. Every credential builds one: resolveAuth for
 * sessions, forward auth and tokens, the /j middleware (`jellyfin_compat`) and
 * the /j play-token routes (`stream_token`). No principal means not admin, and
 * a user object that claims admin without one is logged once per auth method
 * (a builder that forgot its principal). Subsonic keeps its own auth context
 * and never reaches this.
 */

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LocalsAdmin');
const warnedAuthMethods = new Set<string>();

export interface AdminDecisionLocals {
    user?: { ownerIsAdmin?: boolean } | null;
    principal?: { isAdmin?: boolean } | null;
    authMethod?: string;
}

/**
 * Admin by the credential's verdict, or an ARR manager by group (service URLs,
 * the debug panel). Replaces the group-only `isAdminOrArrManager` in handlers.
 */
export function localsIsAdminOrArrManager(
    locals: (AdminDecisionLocals & { user?: { userGroups?: string[] } | null }) | null | undefined,
): boolean {
    if (localsIsAdmin(locals)) return true;
    const groups = new Set((locals?.user?.userGroups ?? []).map((g) => g.toLowerCase()));
    return config.ARR_MANAGER_GROUPS.some((g) => groups.has(g.trim().toLowerCase()));
}

export function localsIsAdmin(locals: AdminDecisionLocals | null | undefined): boolean {
    if (!locals) return false;
    if (locals.principal) return locals.principal.isAdmin === true;
    if (locals.user?.ownerIsAdmin === true) {
        const method = locals.authMethod ?? 'unknown';
        if (!warnedAuthMethods.has(method)) {
            warnedAuthMethods.add(method);
            logger.warn('Admin user without a principal; treated as non-admin', {
                authMethod: method,
            });
        }
    }
    return false;
}
