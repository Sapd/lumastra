// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { getDb } from '$lib/server/database/connection.js';

let cachedId: string | undefined;

export function _resetServerIdCache(): void {
    cachedId = undefined;
}

/**
 * Keep the generated-once identity in the existing DB settings store, where
 * replicas can arbitrate inserts. The plugin and task settings write APIs
 * explicitly reserve core.server; settings.json cannot arbitrate replicas.
 */
export async function getServerId(database?: postgres.Sql): Promise<string | null> {
    if (cachedId) return cachedId;
    try {
        const sql = database ?? getDb();
        if (!sql) return null;
        let rows = await sql<{ value: unknown }[]>`SELECT value FROM plugin_settings
            WHERE plugin_id = 'core.server' AND key = 'SERVER_ID'`;
        if (rows.length === 0) {
            await sql`INSERT INTO plugin_settings (plugin_id, key, value)
                VALUES ('core.server', 'SERVER_ID', to_jsonb(${randomUUID()}::text))
                ON CONFLICT (plugin_id, key) DO NOTHING`;
            // Fresh snapshot observes the winning insert from another replica.
            rows = await sql<{ value: unknown }[]>`SELECT value FROM plugin_settings
                WHERE plugin_id = 'core.server' AND key = 'SERVER_ID'`;
        }
        let parsed = z.string().uuid().safeParse(rows[0]?.value);
        if (!parsed.success && rows.length > 0) {
            // Compare-and-swap: concurrent repairs must not replace a winner.
            const previous = JSON.stringify(rows[0].value);
            await sql`UPDATE plugin_settings SET value = to_jsonb(${randomUUID()}::text)
                WHERE plugin_id = 'core.server' AND key = 'SERVER_ID'
                AND value = ${previous}::jsonb`;
            rows = await sql<{ value: unknown }[]>`SELECT value FROM plugin_settings
                WHERE plugin_id = 'core.server' AND key = 'SERVER_ID'`;
            parsed = z.string().uuid().safeParse(rows[0]?.value);
        }
        if (!parsed.success) return null;
        cachedId = parsed.data;
        return cachedId;
    } catch {
        cachedId = undefined;
        return null;
    }
}
