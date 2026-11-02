// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

const PLUGIN = 'jellyfin-setup-sync';

export async function lockJellyfinSetup(sql: postgres.Sql): Promise<void> {
    await sql`SET LOCAL lock_timeout = '2s'`;
    await sql`SELECT pg_advisory_xact_lock(hashtext('jellyfin-setup-sync'))`;
}

export async function saveJellyfinSetupValue(
    sql: postgres.Sql,
    key: string,
    value: postgres.JSONValue,
): Promise<void> {
    await sql`
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
        VALUES (${PLUGIN}, ${key}, ${sql.json(value)}, now())
        ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
}

export async function getJellyfinInventoryWave(
    sql: postgres.Sql,
    bucket: number,
): Promise<string | undefined> {
    const [row] = await sql<{ run_id: string }[]>`
        SELECT value->>'runId' AS run_id FROM plugin_settings
        WHERE plugin_id = ${PLUGIN} AND key = 'inventory-wave' AND value->>'bucket' = ${String(bucket)}
    `;
    return row?.run_id;
}

export async function hasPendingJellyfinPull(sql: postgres.Sql): Promise<boolean> {
    const [row] = await sql<{ pending: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM plugin_settings WHERE plugin_id = ${PLUGIN} AND key = 'pending-pull') AS pending
    `;
    return row?.pending ?? false;
}

export async function consumePendingJellyfinPull(sql: postgres.Sql): Promise<void> {
    await sql`DELETE FROM plugin_settings WHERE plugin_id = ${PLUGIN} AND key = 'pending-pull'`;
}
