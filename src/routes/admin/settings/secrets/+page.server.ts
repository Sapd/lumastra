// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getDb } from '$lib/server/database/connection.js';
import { listPluginSecretKeys } from '$lib/server/database/queries/plugin-secrets.queries.js';
import type { PluginSecretKey } from '$lib/server/database/queries/plugin-secrets.queries.js';

export interface SecretsPageData {
    secretKeys: PluginSecretKey[];
    dbError: string | null;
}

export const load = async (): Promise<SecretsPageData> => {
    const sql = getDb();
    if (!sql) {
        return { secretKeys: [], dbError: 'Database unavailable' };
    }

    try {
        const secretKeys = await listPluginSecretKeys(sql);
        return { secretKeys, dbError: null };
    } catch (err) {
        // best-effort: load failure surfaced to the page via `dbError`, not swallowed.
        return {
            secretKeys: [],
            dbError: err instanceof Error ? err.message : 'Failed to load secrets',
        };
    }
};
