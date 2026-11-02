// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AniDB Plugin Config Loader
 *
 * Reads AniDB credentials with priority: ENV > config/plugins/anidb.json > default.
 * Used by the plugin's getSettings()/updateSettings() for admin UI persistence.
 */

import { existsSync, readFileSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import type postgres from 'postgres';

interface AnidbPluginConfig {
    ANIDB_CLIENT?: string;
    ANIDB_CLIENT_VER?: number;
}

// Path resolution — mirrors ConfigService logic for Docker volume compatibility
// Priority: CONFIG_DIR env > /config (Docker volume) > ./config (local dev)
export function getPluginConfigDir(): string {
    const configDir = process.env.CONFIG_DIR?.trim();
    if (configDir) return configDir;
    if (existsSync('/config')) return '/config';
    return 'config';
}

function getConfigFilePath(): string {
    return resolve(getPluginConfigDir(), 'plugins', 'anidb.json');
}

let cachedConfig: AnidbPluginConfig | null = null;

function loadJsonConfig(): AnidbPluginConfig {
    if (cachedConfig !== null) return cachedConfig;
    const path = getConfigFilePath();
    if (!existsSync(path)) {
        cachedConfig = {};
        return cachedConfig;
    }
    try {
        const content = readFileSync(path, 'utf-8');
        cachedConfig = JSON.parse(content) as AnidbPluginConfig;
        return cachedConfig;
    } catch {
        // best-effort: unreadable/corrupt config file → fall back to empty config (ENV/defaults still apply).
        cachedConfig = {};
        return cachedConfig;
    }
}

export function getAnidbSettings(): { client: string; clientVer: number } {
    const envClient = process.env.ANIDB_CLIENT;
    const envClientVer = process.env.ANIDB_CLIENT_VER;
    const json = loadJsonConfig();

    const client = envClient ?? json.ANIDB_CLIENT ?? '';
    const rawVer =
        envClientVer !== undefined ? parseInt(envClientVer, 10) : (json.ANIDB_CLIENT_VER ?? 1);
    const clientVer = Number.isNaN(rawVer) ? 1 : rawVer;

    return { client, clientVer };
}

export function isAnidbConfigured(): boolean {
    return getAnidbSettings().client.length > 0;
}

export function invalidateConfigCache(): void {
    cachedConfig = null;
}

export async function updateAnidbSettings(data: Record<string, unknown>): Promise<void> {
    const path = getConfigFilePath();
    const dir = dirname(path);

    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
    }

    let existing: AnidbPluginConfig = {};
    if (existsSync(path)) {
        try {
            existing = JSON.parse(readFileSync(path, 'utf-8')) as AnidbPluginConfig;
        } catch {
            // best-effort: corrupt existing config is replaced by the incoming write (start fresh).
            existing = {};
        }
    }

    if (typeof data.ANIDB_CLIENT === 'string') {
        existing.ANIDB_CLIENT = data.ANIDB_CLIENT;
    }
    if (typeof data.ANIDB_CLIENT_VER === 'number') {
        existing.ANIDB_CLIENT_VER = Math.max(1, Math.floor(data.ANIDB_CLIENT_VER));
    }

    await writeFile(path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    // Invalidate in-memory cache so next read picks up new values
    invalidateConfigCache();
}

// AniDB provider registry id — its settings/secrets live under this plugin_id.
export const ANIDB_PROVIDER_ID = 'anidb-metadata-provider';

/**
 * Resolve the effective AniDB client credentials across every store, in
 * priority order:
 *   1. `plugin_settings` — where the admin Settings UI persists the `string`
 *      fields ANIDB_CLIENT / ANIDB_CLIENT_VER.
 *   2. `plugin_secrets` — legacy / secret-typed installs.
 *   3. `config/plugins/anidb.json` or the ANIDB_CLIENT env var.
 *
 * `sql` is optional so callers without a DB handle (or on a fresh install)
 * still get the file/env fallback. Returns an empty `clientName` when nothing
 * is configured.
 */
export async function resolveAnidbClient(
    sql?: postgres.Sql,
): Promise<{ clientName: string; clientVer: string }> {
    let clientName = '';
    let clientVer = '1';

    if (sql) {
        // 1. plugin_settings (admin Settings UI target for string fields)
        try {
            const { getTaskSettings } =
                await import('$lib/server/database/queries/task-settings.queries.js');
            const settings = await getTaskSettings(sql, ANIDB_PROVIDER_ID);
            const s = settings['ANIDB_CLIENT'];
            if (typeof s === 'string' && s.trim().length > 0) clientName = s.trim();
            const v = settings['ANIDB_CLIENT_VER'];
            if (typeof v === 'string' && v.trim().length > 0) clientVer = v.trim();
            else if (typeof v === 'number' && Number.isFinite(v)) clientVer = String(v);
        } catch {
            /* fall through to next store */
        }

        // 2. plugin_secrets (legacy / secret-typed field)
        if (!clientName) {
            try {
                const { PluginSecrets } = await import('$lib/server/tasks/secrets.js');
                const secrets = new PluginSecrets(sql);
                const secretName = await secrets.getOptional(ANIDB_PROVIDER_ID, 'ANIDB_CLIENT');
                if (secretName && secretName.trim().length > 0) {
                    clientName = secretName.trim();
                    const secretVer = await secrets.getOptional(
                        ANIDB_PROVIDER_ID,
                        'ANIDB_CLIENT_VER',
                    );
                    if (secretVer && secretVer.trim().length > 0) clientVer = secretVer.trim();
                }
            } catch {
                /* fall through to file/env */
            }
        }
    }

    // 3. config/plugins/anidb.json or env
    if (!clientName && isAnidbConfigured()) {
        const settings = getAnidbSettings();
        clientName = settings.client;
        clientVer = String(settings.clientVer);
    }

    // AniDB client strings are canonically lowercase — the API is case-sensitive
    // and rejects any other casing with `302 client version missing or invalid`
    // (a client registered/displayed as "Lumastra" is only accepted as
    // "lumastra"). Normalize so whatever casing the operator types in the
    // Settings UI still works.
    return { clientName: clientName.toLowerCase(), clientVer };
}
