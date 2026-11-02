// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolve a login/display username to its stable `users.id` UUID (a branded
 * {@link UserId}) — the canonical user-data key since migration 16.46.0.
 *
 * Used by the auth populators that derive identity from a TOKEN payload
 * (PAT/JWT/service-token impersonation) or a streaming session, where only the
 * username travels and the UUID must be looked up fresh. A `UserId` is minted
 * ONLY here via {@link toUserId} on a real `users.id` DB read — never coerced.
 *
 * Unlike forward-auth's `resolveOrProvisionUserId`, this NEVER provisions a row:
 * a token/session for a user implies the row already exists (it was created at
 * enrolment time). Returns `null` when the username has no `users` row; throws
 * AuthDependencyUnavailableError when the DB is unavailable — the caller fails closed (a token-derived context with no
 * resolvable UUID must not become an identity-less UserContext).
 *
 * Reads through the shared username→userId L1 cache (user-admin-cache.ts), so a
 * warm forward-auth/native request and a token request share the same mapping
 * and invalidation.
 */

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getCachedUserId, setCachedUserId } from '$lib/server/cache/user-admin-cache.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('Auth');

/**
 * Resolve `username` → `UserId`, or `null` if no `users` row exists. Dependency failures throw.
 * Usernames are normalized to lowercase (matching the storage convention).
 */
export async function resolveUserIdByUsername(username: string): Promise<UserId | null> {
    const key = username.toLowerCase();
    const cached = getCachedUserId(key);
    if (cached) return toUserId(cached);
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) throw new AuthDependencyUnavailableError();
        const { getUserByUsername } = await import('$lib/server/database/queries/users.queries.js');
        const row = await getUserByUsername(sql, key);
        if (!row) return null;
        setCachedUserId(key, row.id);
        return toUserId(row.id);
    } catch (e) {
        logger.warn('resolveUserIdByUsername failed', { username: key, error: String(e) });
        if (isDependencyError(e)) throw new AuthDependencyUnavailableError(e);
        return null;
    }
}
