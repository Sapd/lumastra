// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Federated-identity service.
 *
 * Resolves and provisions local `users` rows from external identities recorded in
 * `user_identities` (provider, subject) → users(id). Backs OIDC login and keeps a
 * native / forward_auth identity ledger. Pure logic over the query modules so it
 * can be unit/integration tested; HTTP/session concerns live in the callers.
 *
 * AGPL-core. See user-identities.queries.ts and migration 16.44.0.
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getIdentity,
    upsertIdentity,
    insertIdentityIfAbsent,
} from '$lib/server/database/queries/user-identities.queries.js';
import { insertFederatedUser } from '$lib/server/database/queries/index.js';
// This is the one sanctioned direct import of upsertUserGroups: it writes inside a
// withTx (the pure query needs the transaction's own client, not the syncUserGroups
// wrapper) and invalidates via invalidateGroupDerivedCaches only AFTER the
// transaction commits, at provisionUserWithIdentity's `return result;` below.
// eslint-disable-next-line no-restricted-imports -- see comment above
import { upsertUserGroups } from '$lib/server/database/queries/index.js';
import {
    lockAdminEmailLinkTarget,
    adminExists,
    markSetupCompleted,
    FIRST_ADMIN_LOCK_KEY,
} from '$lib/server/database/queries/users.queries.js';
import { isReservedUsername } from '$lib/server/services/reserved-usernames.js';
import { invalidateGroupDerivedCaches } from '$lib/server/services/user-groups.service.js';

const logger = Logger.for('UserIdentity');

/** Provider key for the native (username/password) login ledger. */
export const PROVIDER_NATIVE = 'native';
/** Provider key for the forward-auth (reverse-proxy header) login ledger. */
export const PROVIDER_FORWARD_AUTH = 'forward_auth';

/**
 * Stable, issuer-scoped provider key for an OIDC issuer: `oidc:<sha256(issuer)>`.
 * Scoping by issuer hash means two different IdPs can never collide on the same
 * `sub` value, and the issuer URL itself isn't leaked into the provider column.
 */
export function oidcProviderKey(issuer: string): string {
    const hash = createHash('sha256').update(issuer).digest('hex');
    return `oidc:${hash}`;
}

export interface IdentityRef {
    provider: string;
    subject: string;
}

/** Resolve the local user id an external identity is linked to, or null. */
export async function resolveUserIdByIdentity(
    sql: postgres.Sql,
    provider: string,
    subject: string,
): Promise<string | null> {
    const row = await getIdentity(sql, provider, subject);
    return row?.user_id ?? null;
}

/**
 * Record / refresh an identity link for an ALREADY-KNOWN user (login through an
 * existing link, or the native/forward_auth ledger). Best-effort: failures are
 * logged and swallowed so the identity ledger can never break an otherwise-valid
 * authentication. Returns true on success.
 */
export async function recordIdentityBestEffort(
    sql: postgres.Sql,
    params: {
        provider: string;
        subject: string;
        userId: string;
        email?: string | null;
        emailVerified?: boolean;
    },
): Promise<boolean> {
    try {
        await upsertIdentity(sql, params);
        return true;
    } catch (error) {
        logger.warn('Failed to record identity (non-fatal)', {
            provider: params.provider,
            error: String(error),
        });
        return false;
    }
}

/**
 * Email linking is authentication, so a best-effort ledger write is insufficient.
 * Require a current administrator-attested email and a successful exclusive
 * provider binding before returning the target account. The row lock also fences
 * an administrator changing/clearing that email during the link decision.
 */
export async function linkUserByAdminEmail(
    sql: postgres.Sql,
    params: { userId: string; email: string; identity: IdentityRef },
): Promise<{ id: string; username: string; is_admin: boolean } | null> {
    return withTx(sql, async (tx) => {
        const target = await lockAdminEmailLinkTarget(tx, params.userId, params.email);
        if (!target) return null;
        const inserted = await insertIdentityIfAbsent(tx, {
            provider: params.identity.provider,
            subject: params.identity.subject,
            userId: target.id,
            email: params.email.trim().toLowerCase(),
            emailVerified: true,
        });
        if (inserted) return target;
        // Another callback may already have completed this exact same link.
        // A different sub at this provider, or this sub owned by a different
        // account, is never accepted as an authenticated target.
        const identity = await getIdentity(tx, params.identity.provider, params.identity.subject);
        return identity?.user_id === target.id ? target : null;
    });
}

/** Raised when a brand-new subject was linked concurrently mid-provision. */
export class IdentityProvisionRaceError extends Error {
    constructor() {
        super('Identity linked concurrently during provisioning');
        this.name = 'IdentityProvisionRaceError';
    }
}

/** Raised when no free username could be derived after the suffix cap. */
export class UsernameAllocationError extends Error {
    constructor(base: string) {
        super(`Could not allocate a unique username from base "${base}"`);
        this.name = 'UsernameAllocationError';
    }
}

/**
 * Raised by a first-run provision (`firstRunSetup`) when, under the first-admin
 * lock, setup turns out to be complete already (another bootstrap path won the
 * race, or the install is locked). Nothing was written.
 */
export class FirstRunAlreadyCompletedError extends Error {
    constructor() {
        super('First-run setup was completed concurrently');
        this.name = 'FirstRunAlreadyCompletedError';
    }
}

const MAX_USERNAME_SUFFIX_ATTEMPTS = 50;

/**
 * Transactionally provision a NEW local user for a federated identity and link it.
 *
 * The user is inserted with insertFederatedUser (which FAILS on a username
 * collision rather than merging into an unrelated account); on collision we append
 * a numeric suffix and retry. The identity is then inserted with
 * insertIdentityIfAbsent — if a concurrent callback already linked this exact
 * subject, we throw IdentityProvisionRaceError and the transaction rolls the
 * just-created user back, leaving the winner's link intact (a subject is never
 * bound to two accounts). Groups are persisted so the session-derived UserContext
 * reflects them immediately.
 *
 * `baseUsername` must already be normalized/validated by the caller — EXCEPT
 * for reservation: this function is the last line of defence against minting
 * a username reserved for an internal actor (`reserved-usernames.ts`), because
 * not every caller runs `baseUsername` through `normalizeUsername` first (an
 * installed auth plugin's asserted `identity.username` reaches here largely
 * as-is via `plugin-auth.service.ts`). A reserved candidate — the bare base or
 * a numeric-suffixed one — is treated exactly like a collision: skipped in
 * favour of the next suffix.
 *
 * `firstRunSetup` marks this provision as a first-run admin bootstrap (the OIDC
 * callback before any admin exists). It then runs the same check-then-act as
 * `createNativeAdmin()` and `completeForwardAuthSetup()`: take
 * `FIRST_ADMIN_LOCK_KEY`, re-check the setup gate, and write the setup lock in
 * the same transaction as the new user. When the gate already says "set up",
 * it throws `FirstRunAlreadyCompletedError` without writing anything.
 */
export async function provisionUserWithIdentity(
    sql: postgres.Sql,
    params: {
        baseUsername: string;
        isAdmin: boolean;
        groups: string[];
        email?: string | null;
        emailVerified?: boolean;
        displayName?: string | null;
        identity: IdentityRef;
        firstRunSetup?: { adminGroupNames: readonly string[] };
    },
): Promise<{ userId: string; username: string }> {
    const result = await withTx(sql, async (tx) => {
        if (params.firstRunSetup) {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
            if (await adminExists(tx, params.firstRunSetup.adminGroupNames)) {
                throw new FirstRunAlreadyCompletedError();
            }
        }

        let username = params.baseUsername;
        let userId: string | null = null;

        for (let attempt = 1; attempt <= MAX_USERNAME_SUFFIX_ATTEMPTS; attempt++) {
            if (isReservedUsername(username)) {
                // Never mint a reserved username — treat it exactly like a
                // collision and move straight to the next suffix candidate.
                username = `${params.baseUsername}-${attempt + 1}`;
                continue;
            }
            userId = await insertFederatedUser(tx, {
                username,
                isAdmin: params.isAdmin,
                groups: params.groups,
                email: params.emailVerified ? params.email?.trim().toLowerCase() || null : null,
                displayName: params.displayName ?? null,
            });
            if (userId) break;
            username = `${params.baseUsername}-${attempt + 1}`;
        }

        if (!userId) throw new UsernameAllocationError(params.baseUsername);

        // Persist groups via the canonical group-sync path too (keeps
        // groups_updated_at semantics consistent with forward-auth).
        await upsertUserGroups(tx, username, params.groups);

        const inserted = await insertIdentityIfAbsent(tx, {
            provider: params.identity.provider,
            subject: params.identity.subject,
            userId,
            email: params.emailVerified ? params.email?.trim().toLowerCase() || null : null,
            emailVerified: params.emailVerified ?? false,
        });
        if (!inserted) {
            // A concurrent provision linked this subject first — abort so the TX
            // rolls back our orphan user; the caller re-resolves the winner.
            throw new IdentityProvisionRaceError();
        }

        if (params.firstRunSetup) await markSetupCompleted(tx, userId);

        logger.info('Provisioned new user for federated identity', {
            provider: params.identity.provider,
            username,
            isAdmin: params.isAdmin,
        });
        return { userId, username };
    });

    // Invalidate the admin/max-age caches the group write above feeds ONLY
    // AFTER the transaction has committed (security review 5, C4 + Shape C).
    // Never inside `withTx`'s callback: invalidating before commit would
    // drop the cache for a row that might still roll back (a later attempt
    // throwing IdentityProvisionRaceError / UsernameAllocationError), and
    // races a concurrent reader against a write that is not yet visible to
    // it. `syncUserGroups` isn't used here — the pure query must run against
    // the transaction's own client, not a fresh connection.
    invalidateGroupDerivedCaches(result.username);

    return result;
}
