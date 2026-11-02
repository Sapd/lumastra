// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    PluginSecrets,
    decrypt,
    deriveMasterKey,
    pluginUserCredentialContext,
} from '$lib/server/tasks/secrets.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';

// TODO(plugin-sdk): some of these MAL-specific helpers could route through the
// generic SDK `userCredentials` surface now that it exists
// (`buildUserCredentialStore` in tasks/context-primitives.ts). Kept as-is for
// now because they own MAL-specific flows (transactional 3-row upserts,
// FOR UPDATE ghost-credential guard, borrower-list ordering) that the generic
// API doesn't model. Refactor only if a future change forces a touch here.
const MAL_PLUGIN_ID = 'mal-watch-sync';

export interface MalLinkStatus {
    providerUsername: string | null;
    createdAt: Date | null;
    authFailed: boolean;
}

/**
 * Read MAL link status (existence + display metadata) for a user.
 *
 * Uses a single raw query against `plugin_user_credentials` — does NOT decrypt
 * the encrypted blobs, since the status route only needs display fields
 * (provider_username, created_at). This avoids burning an audit log entry on
 * every poll of /api/integrations/mal/status, and — critically — reports the
 * user as LINKED even when their access_token has expired (the user is still
 * linked; the token just needs to refresh).
 *
 * Returns null when the user has no access_token row at all (i.e., never
 * linked or fully unlinked).
 */
export async function getMalLinkStatus(
    sql: postgres.Sql,
    userId: UserId,
): Promise<MalLinkStatus | null> {
    const rows = await sql<
        {
            key: string;
            value_encrypted: Buffer;
            created_at: Date | null;
        }[]
    >`
        SELECT key, value_encrypted, created_at
        FROM plugin_user_credentials
        WHERE plugin_id = ${MAL_PLUGIN_ID} AND user_id = ${userId}::uuid
          AND key IN ('access_token', 'provider_username', 'auth_failed')
    `;

    const accessRow = rows.find((r) => r.key === 'access_token');
    if (!accessRow) return null;

    const usernameRow = rows.find((r) => r.key === 'provider_username');
    let providerUsername: string | null = null;
    if (usernameRow) {
        // provider_username is non-sensitive display data, but the schema
        // stores it encrypted. Decrypt directly (no audit log — this is a
        // status ping, not a credential read).
        try {
            const masterKey = deriveMasterKey(resolveMasterKey());
            providerUsername = decrypt(
                usernameRow.value_encrypted,
                masterKey,
                pluginUserCredentialContext(MAL_PLUGIN_ID, userId, 'provider_username'),
            );
        } catch {
            // best-effort: decrypt failure on non-sensitive display field → omit it (status ping stays responsive).
            providerUsername = null;
        }
    }

    return {
        providerUsername,
        createdAt: accessRow.created_at,
        authFailed: rows.some((r) => r.key === 'auth_failed'),
    };
}

/**
 * Write MAL credentials for a user. Writes rows in dependency order:
 * provider_username first, refresh_token second, access_token last.
 * A missing access_token row means not-linked, so partial failures
 * leave a consistent "not linked" state.
 *
 * Wraps all three writes in a transaction to guarantee atomicity.
 */
export async function upsertMalCredential(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        providerUsername?: string;
        accessToken: string;
        refreshToken?: string;
        tokenExpiresAt?: Date;
    },
): Promise<void> {
    await sql.begin(async (txRaw) => {
        // TransactionSql and Sql are typed differently; cast per project convention
        const tx = txRaw as unknown as postgres.Sql;
        const secrets = new PluginSecrets(tx);
        await secrets.deleteUser(MAL_PLUGIN_ID, params.userId, 'auth_failed');
        if (params.providerUsername !== undefined) {
            await secrets.setUser(
                MAL_PLUGIN_ID,
                params.userId,
                'provider_username',
                params.providerUsername,
            );
        }
        if (params.refreshToken !== undefined) {
            await secrets.setUser(
                MAL_PLUGIN_ID,
                params.userId,
                'refresh_token',
                params.refreshToken,
            );
        }
        await secrets.setUser(
            MAL_PLUGIN_ID,
            params.userId,
            'access_token',
            params.accessToken,
            params.tokenExpiresAt,
        );
    });
}

/**
 * Delete all MAL credentials for a user (unlink).
 */
export async function deleteMalCredential(sql: postgres.Sql, userId: UserId): Promise<boolean> {
    const result = await sql`
        DELETE FROM plugin_user_credentials
        WHERE plugin_id = ${MAL_PLUGIN_ID} AND user_id = ${userId}::uuid
    `;
    return result.count > 0;
}

/**
 * Update only the token rows for a user (used after a successful token refresh).
 * Does not touch provider_username.
 */
export async function updateMalTokens(
    sql: postgres.Sql,
    userId: UserId,
    accessToken: string,
    refreshToken?: string,
    tokenExpiresAt?: Date | null,
): Promise<void> {
    await sql.begin(async (txRaw) => {
        // TransactionSql and Sql are typed differently; cast per project convention
        const tx = txRaw as unknown as postgres.Sql;

        // Guard against re-creating a "ghost" credential row when the user
        // unlinked between the original token read and this refresh write.
        // FOR UPDATE so a concurrent DELETE serialises behind us — if the
        // access_token row is absent at this point, the user is no longer
        // linked and we drop the refreshed tokens on the floor.
        const exists = await tx<{ exists: boolean }[]>`
            SELECT TRUE AS exists FROM plugin_user_credentials
            WHERE plugin_id = ${MAL_PLUGIN_ID}
              AND user_id = ${userId}::uuid
              AND key = 'access_token'
            FOR UPDATE
        `;
        if (exists.length === 0) return;

        const secrets = new PluginSecrets(tx);
        await secrets.deleteUser(MAL_PLUGIN_ID, userId, 'auth_failed');
        if (refreshToken !== undefined) {
            await secrets.setUser(MAL_PLUGIN_ID, userId, 'refresh_token', refreshToken);
        }
        await secrets.setUser(
            MAL_PLUGIN_ID,
            userId,
            'access_token',
            accessToken,
            tokenExpiresAt ?? undefined,
        );
    });
}

/**
 * List borrower candidates: users with a valid access_token, ordered by
 * most recently accessed. Also fetches each user's refresh_token via a
 * second bulk decrypt rather than N getUser() round-trips.
 *
 * Expired rows and decrypt failures are skipped automatically inside
 * listUserBindings.
 */
export async function listMalBorrowerCredentials(
    sql: postgres.Sql,
    limit: number,
): Promise<Array<{ userId: string; accessToken: string; refreshToken: string | null }>> {
    const secrets = new PluginSecrets(sql);
    const accessBindings = await secrets.listUserBindings(MAL_PLUGIN_ID, 'access_token', limit);
    if (accessBindings.length === 0) return [];

    // Bulk-load refresh tokens for the same user set in one query, then zip.
    // listUserBindings is keyed by (plugin_id, key) — paged independently —
    // but the access_token result already constrains the user set we care
    // about, so we filter the wider refresh_token list down to those users.
    const accessUserIds = new Set(accessBindings.map((b) => b.userId));
    const refreshBindings = await secrets.listUserBindings(
        MAL_PLUGIN_ID,
        'refresh_token',
        Math.max(limit, accessUserIds.size),
    );
    const refreshByUser = new Map<string, string>();
    for (const r of refreshBindings) {
        if (accessUserIds.has(r.userId)) refreshByUser.set(r.userId, r.value);
    }

    return accessBindings.map((binding) => ({
        userId: binding.userId,
        accessToken: binding.value,
        refreshToken: refreshByUser.get(binding.userId) ?? null,
    }));
}

/** Mark the existing link as unusable without recreating an unlinked account. */
export async function markMalAuthFailed(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const rows = await tx`SELECT key FROM plugin_user_credentials
            WHERE plugin_id = ${MAL_PLUGIN_ID} AND user_id = ${userId}::uuid AND key = 'access_token'
            FOR UPDATE`;
        if (rows.length === 0) return;
        await new PluginSecrets(tx).setUser(MAL_PLUGIN_ID, userId, 'auth_failed', 'true');
    });
}
