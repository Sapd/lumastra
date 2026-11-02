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

const TRAKT_PLUGIN_ID = 'trakt-watch-sync';

export interface TraktLinkStatus {
    providerUsername: string | null;
    createdAt: Date | null;
    authFailed: boolean;
}

/**
 * Read Trakt link status (existence + display metadata) without decrypting
 * secrets or burning an audit-log entry. Reports LINKED even when the
 * access_token has expired (still linked; token just needs refresh). Returns
 * null when there is no access_token row (never linked / fully unlinked).
 */
export async function getTraktLinkStatus(
    sql: postgres.Sql,
    userId: UserId,
): Promise<TraktLinkStatus | null> {
    const rows = await sql<{ key: string; value_encrypted: Buffer; created_at: Date | null }[]>`
        SELECT key, value_encrypted, created_at
        FROM plugin_user_credentials
        WHERE plugin_id = ${TRAKT_PLUGIN_ID} AND user_id = ${userId}::uuid
          AND key IN ('access_token', 'provider_username', 'auth_failed')
    `;
    const accessRow = rows.find((r) => r.key === 'access_token');
    if (!accessRow) return null;

    const usernameRow = rows.find((r) => r.key === 'provider_username');
    let providerUsername: string | null = null;
    if (usernameRow) {
        try {
            const masterKey = deriveMasterKey(resolveMasterKey());
            providerUsername = decrypt(
                usernameRow.value_encrypted,
                masterKey,
                pluginUserCredentialContext(TRAKT_PLUGIN_ID, userId, 'provider_username'),
            );
        } catch {
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
 * Write Trakt credentials for a user, atomically, in dependency order
 * (provider_username, refresh_token, then access_token last so a partial
 * failure leaves a consistent "not linked" state).
 */
export async function upsertTraktCredential(
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
        const tx = txRaw as unknown as postgres.Sql;
        const secrets = new PluginSecrets(tx);
        await secrets.deleteUser(TRAKT_PLUGIN_ID, params.userId, 'auth_failed');
        if (params.providerUsername !== undefined) {
            await secrets.setUser(
                TRAKT_PLUGIN_ID,
                params.userId,
                'provider_username',
                params.providerUsername,
            );
        }
        if (params.refreshToken !== undefined) {
            await secrets.setUser(
                TRAKT_PLUGIN_ID,
                params.userId,
                'refresh_token',
                params.refreshToken,
            );
        }
        await secrets.setUser(
            TRAKT_PLUGIN_ID,
            params.userId,
            'access_token',
            params.accessToken,
            params.tokenExpiresAt,
        );
    });
}

/** Delete all Trakt credentials for a user (unlink). */
export async function deleteTraktCredential(sql: postgres.Sql, userId: UserId): Promise<boolean> {
    const result = await sql`
        DELETE FROM plugin_user_credentials
        WHERE plugin_id = ${TRAKT_PLUGIN_ID} AND user_id = ${userId}::uuid
    `;
    return result.count > 0;
}

/**
 * Update only the token rows after a refresh. FOR UPDATE guard prevents
 * re-creating a ghost credential when the user unlinked concurrently.
 */
export async function updateTraktTokens(
    sql: postgres.Sql,
    userId: UserId,
    accessToken: string,
    refreshToken?: string,
    tokenExpiresAt?: Date | null,
): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const exists = await tx<{ exists: boolean }[]>`
            SELECT TRUE AS exists FROM plugin_user_credentials
            WHERE plugin_id = ${TRAKT_PLUGIN_ID} AND user_id = ${userId}::uuid AND key = 'access_token'
            FOR UPDATE
        `;
        if (exists.length === 0) return;
        const secrets = new PluginSecrets(tx);
        await secrets.deleteUser(TRAKT_PLUGIN_ID, userId, 'auth_failed');
        if (refreshToken !== undefined) {
            await secrets.setUser(TRAKT_PLUGIN_ID, userId, 'refresh_token', refreshToken);
        }
        await secrets.setUser(
            TRAKT_PLUGIN_ID,
            userId,
            'access_token',
            accessToken,
            tokenExpiresAt ?? undefined,
        );
    });
}
