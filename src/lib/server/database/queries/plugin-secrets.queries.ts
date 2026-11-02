// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface PluginSecretKey {
    pluginId: string;
    key: string;
    encryptionVersion: number;
    createdAt: Date;
}

/**
 * Lists (plugin_id, key, encryption_version, created_at) rows from
 * plugin_secrets. Value columns are never selected — this is metadata-only.
 */
export async function listPluginSecretKeys(sql: postgres.Sql): Promise<PluginSecretKey[]> {
    const rows = await sql<
        Array<{
            plugin_id: string;
            key: string;
            encryption_version: number;
            created_at: Date;
        }>
    >`
        SELECT plugin_id, key, encryption_version, created_at
        FROM plugin_secrets
        ORDER BY plugin_id, key
    `;

    return rows.map((r) => ({
        pluginId: r.plugin_id,
        key: r.key,
        encryptionVersion: r.encryption_version,
        createdAt: r.created_at,
    }));
}
