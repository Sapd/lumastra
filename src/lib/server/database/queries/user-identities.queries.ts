// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Identities Query Module
 *
 * Pure SQL for the `user_identities` federation table — maps an external identity
 * `(provider, subject)` to a local `users(id)`. Backs OIDC login resolution plus a
 * native / forward_auth identity ledger. Each function takes `sql` as its first
 * argument and performs no side effects beyond the single statement it runs.
 *
 * See migration 16.44.0_user_identities. AGPL-core.
 *
 * @module queries/user-identities
 */

import type postgres from 'postgres';

export interface UserIdentityRow {
    provider: string;
    subject: string;
    user_id: string;
    email: string | null;
    email_verified: boolean;
    created_at: Date;
    last_login_at: Date | null;
}

/**
 * Resolve the local user id for an external identity. Returns the full identity
 * row (so callers can read the recorded email/verified flag) or null when this
 * `(provider, subject)` has never been linked.
 */
export async function getIdentity(
    sql: postgres.Sql,
    provider: string,
    subject: string,
): Promise<UserIdentityRow | null> {
    const rows = await sql<UserIdentityRow[]>`
        SELECT provider, subject, user_id, email, email_verified, created_at, last_login_at
        FROM user_identities
        WHERE provider = ${provider} AND subject = ${subject}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Upsert an identity link and stamp last_login_at=NOW().
 *
 * On a fresh link this inserts the row pointing at `userId`. On a repeat login it
 * refreshes the recorded email/verified flag and the login timestamp. The
 * `user_id` is intentionally NOT updated on conflict: a given `(provider, subject)`
 * is owned by exactly one local user for life — re-pointing it would be an account
 * takeover, so a changed `user_id` is ignored (the original link wins).
 */
export async function upsertIdentity(
    sql: postgres.Sql,
    params: {
        provider: string;
        subject: string;
        userId: string;
        email?: string | null;
        emailVerified?: boolean;
    },
): Promise<void> {
    await sql`
        INSERT INTO user_identities (provider, subject, user_id, email, email_verified, created_at, last_login_at)
        VALUES (
            ${params.provider},
            ${params.subject},
            ${params.userId},
            ${params.email ?? null},
            ${params.emailVerified ?? false},
            NOW(),
            NOW()
        )
        ON CONFLICT (provider, subject) DO UPDATE SET
            email          = ${params.email ?? null},
            email_verified = ${params.emailVerified ?? false},
            last_login_at  = NOW()
    `;
}

/**
 * Insert a NEW identity link only if `(provider, subject)` is not already present.
 * Returns true if a row was inserted, false if the subject OR the provider/user
 * binding already exists. The latter prevents replacing a provider subject via
 * email linking. Used during
 * provisioning to detect a concurrent first-login race (two callbacks for the same
 * brand-new subject): the loser rolls back its just-created user and re-resolves
 * the winner, so a subject is never bound to two accounts.
 */
export async function insertIdentityIfAbsent(
    sql: postgres.Sql,
    params: {
        provider: string;
        subject: string;
        userId: string;
        email?: string | null;
        emailVerified?: boolean;
    },
): Promise<boolean> {
    const rows = await sql`
        INSERT INTO user_identities (provider, subject, user_id, email, email_verified, created_at, last_login_at)
        VALUES (
            ${params.provider},
            ${params.subject},
            ${params.userId},
            ${params.email ?? null},
            ${params.emailVerified ?? false},
            NOW(),
            NOW()
        )
        ON CONFLICT DO NOTHING
        RETURNING provider
    `;
    return rows.length > 0;
}

/** All identities linked to a user (admin/debug; cascades on user delete). */
export async function getIdentitiesForUser(
    sql: postgres.Sql,
    userId: string,
): Promise<UserIdentityRow[]> {
    return sql<UserIdentityRow[]>`
        SELECT provider, subject, user_id, email, email_verified, created_at, last_login_at
        FROM user_identities
        WHERE user_id = ${userId}
        ORDER BY created_at ASC
    `;
}

/**
 * Unlink an identity from a user (admin action). Scoped to BOTH the identity key
 * and the owning user id so an admin can only remove a link they're looking at —
 * never another user's. Returns true if a row was deleted. After unlinking, a
 * future login with that subject re-resolves (provisions or re-links per policy).
 */
export async function deleteIdentityForUser(
    sql: postgres.Sql,
    userId: string,
    provider: string,
    subject: string,
): Promise<boolean> {
    const rows = await sql`
        DELETE FROM user_identities
        WHERE user_id = ${userId} AND provider = ${provider} AND subject = ${subject}
        RETURNING provider
    `;
    return rows.length > 0;
}
