// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Discogs token accessor.
 *
 * The Discogs personal access token is a SINGLE shared credential used by
 * multiple background tasks (artist-enrichment, album-enrichment). Its
 * canonical home is the `discogs` integration plugin — stored as
 * `plugin_secrets (plugin_id='discogs', key='DISCOGS_TOKEN')` and editable from
 * the /admin/settings/plugins integrations section.
 *
 * Historically the token was entered per-task (once on each enrichment task's
 * settings tab), which meant it had to be set twice and the setup wizard only
 * ever wrote the artist-enrichment copy. Migration 16.156.0 copies any existing
 * per-task token to the shared `discogs` plugin; `readDiscogsToken` still falls
 * back to a legacy per-task secret so installs that never re-run the migration
 * (or set a task-local token afterwards) keep working.
 */

import type postgres from 'postgres';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';

/** Canonical plugin id that owns the shared Discogs token. */
export const DISCOGS_PLUGIN_ID = 'discogs';
/** Secret key under which the token is stored (same across shared + legacy). */
export const DISCOGS_TOKEN_KEY = 'DISCOGS_TOKEN';

/**
 * Read the shared Discogs token. Prefers the canonical `discogs` integration
 * secret; falls back to a legacy per-task secret (`plugin_id=legacyPluginId`)
 * for back-compat. Returns `''` when no token is configured anywhere.
 */
export async function readDiscogsToken(
    sql: postgres.Sql,
    legacyPluginId?: string,
): Promise<string> {
    const secrets = new PluginSecrets(sql);
    const shared = await secrets.getOptional(DISCOGS_PLUGIN_ID, DISCOGS_TOKEN_KEY);
    if (shared) return shared;
    if (legacyPluginId && legacyPluginId !== DISCOGS_PLUGIN_ID) {
        const legacy = await secrets.getOptional(legacyPluginId, DISCOGS_TOKEN_KEY);
        if (legacy) return legacy;
    }
    return '';
}

/**
 * Whether a Discogs token is configured (shared or legacy per-task). Used by the
 * enrichment "source configured?" guards to decide whether a discogs-only chain
 * is runnable.
 */
export async function hasDiscogsToken(
    sql: postgres.Sql,
    legacyPluginId?: string,
): Promise<boolean> {
    return (await readDiscogsToken(sql, legacyPluginId)) !== '';
}
