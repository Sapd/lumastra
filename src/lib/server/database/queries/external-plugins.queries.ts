// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure SQL registry module for remotely-installed, offline-signed external
 * plugins. `sql` is always the first param; no side effects beyond the query.
 *
 * NOTE: `external_plugins.updated_at` has NO database trigger — every UPDATE
 * path here MUST set `updated_at = now()` explicitly.
 */

import type postgres from 'postgres';
import {
    BundleArtifactSchema,
    INVALID_BUNDLE,
    type BundleArtifact,
    type InvalidBundle,
} from '../../plugins/external-install/bundle-artifact.js';

export interface ExternalPluginRow {
    name: string;
    version: string;
    checksum: string;
    sourceManifestUrl: string;
    signature: string;
    capabilities: Record<string, unknown> | null;
    enabled: boolean;
    status: 'installed' | 'uninstalled';
    installedBy: string | null;
    installedAt: string;
    updatedAt: string;
    /**
     * Multi-file bundle descriptor (entry + treeDigest + per-file digests), or
     * null for single-file (index.js) plugins. A stored jsonb blob that fails
     * `BundleArtifactSchema` surfaces as the fail-closed `INVALID_BUNDLE`
     * sentinel (never throws out of the query) so one corrupt row refuses only
     * that plugin's load, not the whole boot listing.
     */
    bundle: BundleArtifact | InvalidBundle | null;
    /**
     * The trusted keyId that verified this install's signature, or null for a
     * legacy/pre-migration row or a registry-less drop-in. The live source
     * (official/operator/unknown) is DERIVED at read time from the effective
     * key set (classifyKeyId), never persisted — a snapshot would go stale
     * after rotation.
     */
    signingKeyId: string | null;
    /**
     * Plugin contract ABI from the signed manifest. NULL for a row installed
     * before the column existed (migration 16.229.0) or for a registry-less
     * drop-in; the loader reads NULL as ABI 1, the only ABI such a plugin
     * could have been built against.
     */
    sdkAbi: number | null;
    /**
     * Signed catalog metadata the manifest declared (publisher, description,
     * license, sourceUrl, capabilities, minAppVersion, releasedAt). NULL when
     * the manifest declared none — the UI says "not declared" rather than
     * inventing a blank.
     */
    manifestMetadata: Record<string, unknown> | null;
}

export interface ExternalPluginUpsert {
    name: string;
    version: string;
    checksum: string;
    sourceManifestUrl: string;
    signature: string;
    capabilities: Record<string, unknown> | null;
    enabled: boolean;
    status: 'installed' | 'uninstalled';
    installedBy: string | null;
    bundle: BundleArtifact | null;
    signingKeyId: string | null;
    /**
     * Plugin contract ABI from the signed manifest.
     *
     * OPTIONAL on the write side, and omission fails CLOSED: an upsert that
     * does not know the ABI writes NULL, the loader reads NULL as ABI 1, and on
     * any host past ABI 1 that plugin then refuses to load rather than being
     * silently admitted.
     */
    sdkAbi?: number | null;
    /** Signed catalog metadata from the manifest, verbatim. */
    manifestMetadata?: Record<string, unknown> | null;
}

interface ExternalPluginDbRow {
    name: string;
    version: string;
    checksum: string;
    source_manifest_url: string;
    signature: string;
    capabilities: Record<string, unknown> | null;
    enabled: boolean;
    status: 'installed' | 'uninstalled';
    installed_by: string | null;
    installed_at: Date;
    updated_at: Date;
    bundle: unknown | null;
    signing_key_id: string | null;
    sdk_abi: number | null;
    manifest_metadata: Record<string, unknown> | null;
}

/**
 * Fail-closed parse of the stored `bundle` jsonb. NEVER `.parse` — a
 * corrupt/hand-edited blob must not throw out of `getExternalPlugin` /
 * `listExternalPlugins` (that would crash boot's `loadExternalPlugins` and the
 * admin list). On a schema failure, yield the `INVALID_BUNDLE` sentinel so the
 * loader refuses that one plugin's load.
 */
function parseBundle(raw: unknown): BundleArtifact | InvalidBundle | null {
    if (raw == null) return null;
    const r = BundleArtifactSchema.safeParse(raw);
    return r.success ? r.data : INVALID_BUNDLE;
}

function mapRow(r: ExternalPluginDbRow): ExternalPluginRow {
    return {
        name: r.name,
        version: r.version,
        checksum: r.checksum,
        sourceManifestUrl: r.source_manifest_url,
        signature: r.signature,
        capabilities: r.capabilities ?? null,
        enabled: r.enabled,
        status: r.status,
        installedBy: r.installed_by,
        installedAt: new Date(r.installed_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
        bundle: parseBundle(r.bundle),
        signingKeyId: r.signing_key_id,
        sdkAbi: r.sdk_abi,
        manifestMetadata: r.manifest_metadata,
    };
}

export async function getExternalPlugin(
    sql: postgres.Sql,
    name: string,
): Promise<ExternalPluginRow | null> {
    const rows = await sql<ExternalPluginDbRow[]>`
        SELECT name, version, checksum, source_manifest_url, signature, capabilities,
               enabled, status, installed_by, installed_at, updated_at, bundle, signing_key_id, sdk_abi,
               manifest_metadata
        FROM external_plugins WHERE name = ${name}`;
    return rows[0] ? mapRow(rows[0]) : null;
}

/** Alias of getExternalPlugin, named for the installer's anti-rollback intent. */
export const snapshotExternalPlugin = getExternalPlugin;

export async function listExternalPlugins(sql: postgres.Sql): Promise<ExternalPluginRow[]> {
    const rows = await sql<ExternalPluginDbRow[]>`
        SELECT name, version, checksum, source_manifest_url, signature, capabilities,
               enabled, status, installed_by, installed_at, updated_at, bundle, signing_key_id, sdk_abi,
               manifest_metadata
        FROM external_plugins WHERE status = 'installed' ORDER BY name`;
    return rows.map(mapRow);
}

/**
 * Like listExternalPlugins but ALSO returns `uninstalled` rows, so a
 * just-uninstalled-but-still-loaded plugin is not lost from the admin join
 * (uninstall is restart-only — the code keeps running with full host trust
 * until restart). The caller (external-plugin-manager) joins live `loaded`
 * state and filters out rows that are uninstalled AND no longer loaded.
 *
 * Do NOT use this on the loader boot path — that must stay installed-only
 * (listLoadableExternalPlugins).
 */
export async function listExternalPluginsIncludingPendingRemoval(
    sql: postgres.Sql,
): Promise<ExternalPluginRow[]> {
    const rows = await sql<ExternalPluginDbRow[]>`
        SELECT name, version, checksum, source_manifest_url, signature, capabilities,
               enabled, status, installed_by, installed_at, updated_at, bundle, signing_key_id, sdk_abi,
               manifest_metadata
        FROM external_plugins WHERE status IN ('installed', 'uninstalled') ORDER BY name`;
    return rows.map(mapRow);
}

export async function listLoadableExternalPlugins(sql: postgres.Sql): Promise<ExternalPluginRow[]> {
    const rows = await sql<ExternalPluginDbRow[]>`
        SELECT name, version, checksum, source_manifest_url, signature, capabilities,
               enabled, status, installed_by, installed_at, updated_at, bundle, signing_key_id, sdk_abi,
               manifest_metadata
        FROM external_plugins
        WHERE status = 'installed' AND enabled = true ORDER BY name`;
    return rows.map(mapRow);
}

export async function upsertExternalPlugin(
    sql: postgres.Sql,
    row: ExternalPluginUpsert,
): Promise<void> {
    await sql`
        INSERT INTO external_plugins
            (name, version, checksum, source_manifest_url, signature, capabilities, enabled, status, installed_by, bundle, signing_key_id, sdk_abi, manifest_metadata, updated_at)
        VALUES
            (${row.name}, ${row.version}, ${row.checksum}, ${row.sourceManifestUrl}, ${row.signature},
             ${row.capabilities === null ? null : sql.json(row.capabilities as Record<string, never>)}, ${row.enabled}, ${row.status}, ${row.installedBy},
             ${row.bundle === null ? null : sql.json(row.bundle)}, ${row.signingKeyId}, ${row.sdkAbi ?? null},
             ${row.manifestMetadata ? sql.json(row.manifestMetadata as never) : null}, now())
        ON CONFLICT (name) DO UPDATE SET
            version = EXCLUDED.version, checksum = EXCLUDED.checksum,
            source_manifest_url = EXCLUDED.source_manifest_url, signature = EXCLUDED.signature,
            capabilities = EXCLUDED.capabilities, enabled = EXCLUDED.enabled,
            status = EXCLUDED.status, installed_by = EXCLUDED.installed_by,
            bundle = EXCLUDED.bundle, signing_key_id = EXCLUDED.signing_key_id, sdk_abi = EXCLUDED.sdk_abi,
                manifest_metadata = EXCLUDED.manifest_metadata, updated_at = now()`;
}

export async function setExternalPluginEnabled(
    sql: postgres.Sql,
    name: string,
    enabled: boolean,
): Promise<void> {
    await sql`UPDATE external_plugins SET enabled = ${enabled}, updated_at = now() WHERE name = ${name}`;
}

export async function markExternalPluginUninstalled(
    sql: postgres.Sql,
    name: string,
): Promise<void> {
    await sql`UPDATE external_plugins SET status = 'uninstalled', enabled = false, updated_at = now() WHERE name = ${name}`;
}

export async function deleteExternalPluginRow(sql: postgres.Sql, name: string): Promise<void> {
    await sql`DELETE FROM external_plugins WHERE name = ${name}`;
}
