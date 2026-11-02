// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The returning-login group re-sync for auth-provider plugins (security review
 * 7, the plugin admin-assert cohort) — the plugin twin of `oidc.service.ts`'s
 * `syncUserOnLogin`, minus the column write: a plugin never writes
 * `users.is_admin`, so an unpinned plugin account's admin verdict comes from
 * `users.groups` (plus in-app access) alone.
 *
 * `plugin-auth.service.ts`'s `resolvePluginIdentity` decides WHAT to write
 * (reported groups only, admin names stripped per the env gates and while
 * setup is incomplete); this module writes it and applies what follows:
 * - the Formula-A verdict before and after the write drives the admin-scoped
 *   credential narrow/restore (`applyAdminStatusTransition`), exactly as the
 *   OIDC and forward-auth syncs do;
 * - a demotion that leaves no admin logs the setup-lock warning — the install
 *   stays locked (S-C5c-2; nothing here clears the lock);
 * - a promotion makes sure the setup lock exists, as every admin-creating path
 *   does since a0aff7724.
 *
 * A pinned account keeps its pinned verdict (Formula A checks the pin first),
 * so an operator's `PATCH /api/admin/users/<username>` pin still overrides the
 * provider. Only the groups write can fail the login; the follow-ups are
 * best-effort and only warn.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';
import { applyAdminStatusTransition } from '$lib/server/services/credential-revocation.service.js';
import {
    ensureSetupLocked,
    warnIfLastAdminDemoted,
} from '$lib/server/services/setup-lock.service.js';

const logger = Logger.for('PluginAuthGroupSync');

export async function syncPluginLoginGroups(
    sql: postgres.Sql,
    userId: string,
    groups: string[],
): Promise<void> {
    const user = await getUserById(sql, userId);
    if (!user) return;
    const username = user.username;

    const before = await resolveOwnerAdminStatus(sql, username);
    await syncUserGroups(sql, username, groups);
    if (!before) return;

    try {
        const after = await resolveOwnerAdminStatus(sql, username);
        if (!after) return;
        const { failedStores } = await applyAdminStatusTransition(
            sql,
            after.userId,
            username,
            before.isAdmin,
            after.isAdmin,
        );
        if (failedStores.length > 0) {
            logger.warn('Plugin login: some admin-scoped credential stores failed to sync', {
                username,
                failedStores,
            });
        }
        if (before.isAdmin && !after.isAdmin) {
            await warnIfLastAdminDemoted(sql, {
                username,
                source: 'plugin',
                adminGroupNames: config.ADMIN_GROUPS,
                demotedUserId: after.userId,
            });
        } else if (!before.isAdmin && after.isAdmin) {
            await ensureSetupLocked(sql, after.userId);
        }
    } catch (e) {
        logger.warn('Plugin login: failed to apply the admin transition after a group sync', {
            username,
            error: String(e),
        });
    }
}
