// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin repository list + the synced catalog cache (migration 16.233.0).
 */

import type postgres from 'postgres';

export interface PluginRepositoryRow {
    id: string;
    url: string;
    name: string | null;
    enabled: boolean;
    addedBy: string | null;
    lastSyncedAt: string | null;
    lastEtag: string | null;
    lastError: string | null;
    /** The index's own `updatedAt`, so the UI can show how stale it is. */
    indexUpdatedAt: string | null;
    createdAt: string;
}

export interface CatalogEntryRow {
    repositoryId: string;
    repositoryName: string | null;
    name: string;
    latestVersion: string | null;
    versions: unknown[];
    metadata: Record<string, unknown> | null;
    advisoryKeyId: string | null;
    syncedAt: string;
}

interface RepoDbRow {
    id: string;
    url: string;
    name: string | null;
    enabled: boolean;
    added_by: string | null;
    last_synced_at: string | null;
    last_etag: string | null;
    last_error: string | null;
    index_updated_at: string | null;
    created_at: string;
}

function toRepo(r: RepoDbRow): PluginRepositoryRow {
    return {
        id: r.id,
        url: r.url,
        name: r.name,
        enabled: r.enabled,
        addedBy: r.added_by,
        lastSyncedAt: r.last_synced_at,
        lastEtag: r.last_etag,
        lastError: r.last_error,
        indexUpdatedAt: r.index_updated_at,
        createdAt: r.created_at,
    };
}

export async function listRepositories(sql: postgres.Sql): Promise<PluginRepositoryRow[]> {
    const rows = await sql<RepoDbRow[]>`
        SELECT id, url, name, enabled, added_by, last_synced_at, last_etag,
               last_error, index_updated_at, created_at
        FROM plugin_repositories ORDER BY created_at
    `;
    return rows.map(toRepo);
}

export async function addRepository(
    sql: postgres.Sql,
    url: string,
    addedBy: string | null,
): Promise<PluginRepositoryRow> {
    const rows = await sql<RepoDbRow[]>`
        INSERT INTO plugin_repositories (url, added_by)
        VALUES (${url}, ${addedBy})
        ON CONFLICT (url) DO UPDATE SET enabled = true
        RETURNING id, url, name, enabled, added_by, last_synced_at, last_etag,
                  last_error, index_updated_at, created_at
    `;
    return toRepo(rows[0]);
}

export async function removeRepository(sql: postgres.Sql, id: string): Promise<void> {
    // Catalog entries cascade; an installed plugin's `source_repository_id`
    // goes NULL rather than the plugin disappearing with the repository.
    await sql`DELETE FROM plugin_repositories WHERE id = ${id}::uuid`;
}

export async function setRepositoryEnabled(
    sql: postgres.Sql,
    id: string,
    enabled: boolean,
): Promise<void> {
    await sql`UPDATE plugin_repositories SET enabled = ${enabled} WHERE id = ${id}::uuid`;
}

/**
 * Replace one repository's catalog entries, transactionally.
 *
 * Per-repository and all-or-nothing: a half-applied sync would leave the browse
 * view showing a mixture of two index versions, and a failure part-way must not
 * blank what was already there.
 */
export async function replaceCatalogEntries(
    sql: postgres.Sql,
    repositoryId: string,
    entries: Array<{
        name: string;
        latestVersion: string | null;
        versions: unknown[];
        metadata: Record<string, unknown> | null;
        advisoryKeyId: string | null;
    }>,
): Promise<void> {
    await sql.begin(async (tx) => {
        await tx`DELETE FROM plugin_catalog_entries WHERE repository_id = ${repositoryId}::uuid`;
        for (const e of entries) {
            await tx`
                INSERT INTO plugin_catalog_entries
                    (repository_id, name, latest_version, versions, metadata, advisory_key_id)
                VALUES (
                    ${repositoryId}::uuid, ${e.name}, ${e.latestVersion},
                    ${tx.json(e.versions as never)},
                    ${e.metadata ? tx.json(e.metadata as never) : null},
                    ${e.advisoryKeyId}
                )
            `;
        }
    });
}

export async function recordSyncResult(
    sql: postgres.Sql,
    repositoryId: string,
    result: {
        name?: string | null;
        etag?: string | null;
        indexUpdatedAt?: string | null;
        error?: string | null;
    },
): Promise<void> {
    await sql`
        UPDATE plugin_repositories
        SET last_synced_at = now(),
            name = COALESCE(${result.name ?? null}, name),
            -- COALESCE, not overwrite: nothing sets an etag yet, and clobbering
            -- it with null on every sync would keep the column permanently empty
            -- for whenever conditional GETs are wired.
            last_etag = COALESCE(${result.etag ?? null}, last_etag),
            index_updated_at = COALESCE(${result.indexUpdatedAt ?? null}, index_updated_at),
            last_error = ${result.error ?? null}
        WHERE id = ${repositoryId}::uuid
    `;
}

/** Everything currently advertised, newest sync first, with its repository. */
export async function listCatalogEntries(sql: postgres.Sql): Promise<CatalogEntryRow[]> {
    const rows = await sql<
        {
            repository_id: string;
            repository_name: string | null;
            name: string;
            latest_version: string | null;
            versions: unknown[];
            metadata: Record<string, unknown> | null;
            advisory_key_id: string | null;
            synced_at: string;
        }[]
    >`
        SELECT c.repository_id, r.name AS repository_name, c.name, c.latest_version,
               c.versions, c.metadata, c.advisory_key_id, c.synced_at
        FROM plugin_catalog_entries c
        JOIN plugin_repositories r ON r.id = c.repository_id
        WHERE r.enabled = true
        ORDER BY c.name
    `;
    return rows.map((r) => ({
        repositoryId: r.repository_id,
        repositoryName: r.repository_name,
        name: r.name,
        latestVersion: r.latest_version,
        versions: Array.isArray(r.versions) ? r.versions : [],
        metadata: r.metadata,
        advisoryKeyId: r.advisory_key_id,
        syncedAt: r.synced_at,
    }));
}

/** An installed plugin the catalog says has a newer version. */
export interface PluginUpdateRow {
    name: string;
    installedVersion: string;
    availableVersion: string;
}

/**
 * Installed plugins with a newer version advertised by a repository.
 *
 * `setAvailableUpdate` has been writing `available_version` since the update
 * CHECK task shipped, and nothing read it — so the check ran, recorded its
 * answer, and no surface ever showed it. This is the read side.
 *
 * Enabled-only: a disabled plugin is not running, so telling its operator to
 * update it is noise about software they have already switched off.
 */
export async function listPluginsWithAvailableUpdate(
    sql: postgres.Sql,
): Promise<PluginUpdateRow[]> {
    const rows = await sql<{ name: string; version: string; available_version: string }[]>`
        SELECT name, version, available_version
          FROM external_plugins
         WHERE available_version IS NOT NULL
           AND available_version <> version
           AND enabled = true
           AND status = 'installed'
         ORDER BY name
    `;
    return rows.map((r) => ({
        name: r.name,
        installedVersion: r.version,
        availableVersion: r.available_version,
    }));
}

/** Record (or clear) an available update on an installed plugin. */
export async function setAvailableUpdate(
    sql: postgres.Sql,
    name: string,
    update: { version: string; manifestUrl: string; signature: string } | null,
): Promise<void> {
    await sql`
        UPDATE external_plugins
        SET available_version = ${update?.version ?? null},
            available_manifest_url = ${update?.manifestUrl ?? null},
            available_signature = ${update?.signature ?? null}
        WHERE name = ${name}
    `;
}
