// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Syncing plugin repositories into the local catalog.
 *
 * The catalog is an AUTOFILL for the existing verified install path — nothing
 * more. It records the `(manifestUrl, signature)` pairs an operator would
 * otherwise paste, and installing from it calls exactly the same
 * `installExternalPlugin` with exactly the same inputs. A trust bypass is
 * therefore structurally impossible rather than policy-enforced.
 *
 * Which means every value stored here is ADVISORY. `sdkAbi`, `keyId` and the
 * descriptive fields exist so the browse view can filter and label without
 * fetching every manifest; all of them are re-derived from signed bytes before
 * anything installs. A repository that lies produces a clean install failure.
 *
 * PRIVACY: with no repositories configured — the shipped default — this makes
 * no outbound request at all. Adding a repository IS the consent to poll it;
 * there is no hidden update endpoint and no telemetry.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithGuards } from '$lib/server/plugins/external-install/fetch-and-verify.js';
import {
    PluginRepositoryIndexSchema,
    PLUGIN_REPOSITORY_SCHEMA_VERSION,
    compareVersions,
    type RepositoryVersion,
} from '$lib/schemas/plugin-repository.js';
import {
    listRepositories,
    replaceCatalogEntries,
    recordSyncResult,
    type PluginRepositoryRow,
} from '$lib/server/database/queries/plugin-repositories.queries.js';

const logger = Logger.for('PluginRepository');

/** Consumer-enforced caps. Never trusted from the producer. */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_PLUGINS_PER_INDEX = 2000;
const MAX_VERSIONS_PER_PLUGIN = 20;

export interface SyncOutcome {
    repositoryId: string;
    url: string;
    /** How many catalog entries this repository now advertises. */
    entries: number;
    error?: string;
}

/*
 * NO `unchanged` FLAG, AND NO CONDITIONAL GET — yet.
 *
 * There was one, and it was inert: nothing ever set it, no `If-None-Match` was
 * ever sent, and `last_etag` was overwritten with null on every sync. A field
 * documented as "true when the server answered 304" that can never be true is
 * worse than no field, because the next reader believes it.
 *
 * Conditional GETs are worth having — this task re-downloads every index every
 * 12h — but the fetch they would have to go through is the SSRF-guarded,
 * multi-hop `fetchWithGuards`, and threading request headers plus a 304 path
 * through a redirect chain there is a change to a security boundary, not an
 * optimisation. It is a deliberate, separately-reviewed increment.
 *
 * The `last_etag` column stays, unclobbered, as the slot for it.
 */

/**
 * Fetch and store one repository's index.
 *
 * Never throws: a failure is recorded on the row and reported, so one broken
 * repository cannot take a sync pass — or the admin page — down with it.
 */
export async function syncRepository(
    sql: postgres.Sql,
    repo: PluginRepositoryRow,
): Promise<SyncOutcome> {
    const base: SyncOutcome = {
        repositoryId: repo.id,
        url: repo.url,
        entries: 0,
    };

    let bytes: Buffer;
    try {
        const fetched = await fetchWithGuards(repo.url, {
            maxBytes: MAX_INDEX_BYTES,
            allowPrivate: config.PLUGIN_INSTALL_ALLOW_PRIVATE,
            timeoutMs: config.PLUGIN_INSTALL_FETCH_TIMEOUT_MS,
        });
        bytes = fetched.bytes;
    } catch (err) {
        const error = `fetch failed: ${String(err)}`;
        await recordSyncResult(sql, repo.id, { error });
        return { ...base, error };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
        const error = 'index is not valid JSON';
        await recordSyncResult(sql, repo.id, { error });
        return { ...base, error };
    }

    const result = PluginRepositoryIndexSchema.safeParse(parsed);
    if (!result.success) {
        const error = `invalid index: ${result.error.message}`;
        await recordSyncResult(sql, repo.id, { error });
        return { ...base, error };
    }
    const index = result.data;

    if (index.schemaVersion > PLUGIN_REPOSITORY_SCHEMA_VERSION) {
        // Refuse rather than guess. A newer schema may mean fields whose
        // absence changes meaning, and a half-understood index is worse than
        // none — the operator gets told to upgrade instead.
        const error =
            `index declares schemaVersion ${index.schemaVersion}, this host understands ` +
            `${PLUGIN_REPOSITORY_SCHEMA_VERSION} — upgrade Lumastra to use this repository`;
        await recordSyncResult(sql, repo.id, { error });
        return { ...base, error };
    }

    if (index.plugins.length > MAX_PLUGINS_PER_INDEX) {
        const error = `index advertises ${index.plugins.length} plugins, limit ${MAX_PLUGINS_PER_INDEX}`;
        await recordSyncResult(sql, repo.id, { error });
        return { ...base, error };
    }

    const entries = index.plugins.map((p) => {
        // Newest first, capped. The cap is ours, not the index's — an index
        // shipping a thousand historical versions per plugin is a resource
        // problem for us, not for whoever published it.
        const versions = [...p.versions]
            .sort((a, b) => compareVersions(b.version, a.version))
            .slice(0, MAX_VERSIONS_PER_PLUGIN);
        const newest: RepositoryVersion | undefined = versions[0];
        return {
            name: p.name,
            latestVersion: newest?.version ?? null,
            versions,
            metadata: {
                title: p.title,
                description: p.description,
                publisher: p.publisher,
                iconUrl: p.iconUrl,
                homepage: p.homepage,
                changelogUrl: p.changelogUrl,
                tags: p.tags,
            },
            // Advisory only, and labelled as such everywhere it is shown: a
            // malicious repository will happily claim an official key id.
            advisoryKeyId: newest?.keyId ?? null,
        };
    });

    await replaceCatalogEntries(sql, repo.id, entries);
    await recordSyncResult(sql, repo.id, {
        name: index.name,
        indexUpdatedAt: index.updatedAt ?? null,
        error: null,
    });

    logger.info('synced plugin repository', { url: repo.url, entries: entries.length });
    return { ...base, entries: entries.length };
}

/**
 * Sync every enabled repository.
 *
 * With none configured this returns immediately having made no network call —
 * the default state of a Lumastra install is silent.
 */
export async function syncAllRepositories(sql: postgres.Sql): Promise<SyncOutcome[]> {
    const repos = (await listRepositories(sql)).filter((r) => r.enabled);
    if (repos.length === 0) return [];
    // Sequential: a handful of repositories, each one a guarded fetch. Doing
    // them concurrently would buy nothing and make one slow host's timeout
    // harder to attribute.
    const out: SyncOutcome[] = [];
    for (const repo of repos) {
        out.push(await syncRepository(sql, repo));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Update detection
// ---------------------------------------------------------------------------

export interface AvailableUpdate {
    name: string;
    fromVersion: string;
    toVersion: string;
    manifestUrl: string;
    signature: string;
    security: boolean;
}

export interface InstalledForUpdate {
    name: string;
    version: string;
    signingKeyId: string | null;
}

/**
 * Which installed plugins have a newer, installable version advertised.
 *
 * Matching requires the catalog entry's advisory key id to equal the key that
 * actually installed the plugin. Without that rule ANY repository could
 * generate "updates" for plugins it does not publish — notification spam that
 * grooms an operator into force-installing a stranger's build over a trusted
 * one, which is the same takeover signing-key continuity blocks at install.
 * Here it stops the invitation ever appearing.
 *
 * A plugin whose install predates key recording (NULL) is not offered updates
 * from a catalog: there is nothing to match against, and guessing is exactly
 * what this rule exists to prevent.
 */
export function findAvailableUpdates(
    installed: InstalledForUpdate[],
    catalog: Array<{
        name: string;
        advisoryKeyId: string | null;
        versions: RepositoryVersion[];
    }>,
    hostAbi: number,
): AvailableUpdate[] {
    const out: AvailableUpdate[] = [];

    for (const plugin of installed) {
        if (plugin.signingKeyId === null) continue;

        for (const entry of catalog) {
            if (entry.name !== plugin.name) continue;
            if (entry.advisoryKeyId !== plugin.signingKeyId) continue;

            const compatible = entry.versions.filter(
                (v) =>
                    (v.sdkAbi ?? 1) === hostAbi && compareVersions(v.version, plugin.version) > 0,
            );
            if (compatible.length === 0) continue;

            const newest = compatible.reduce((best, v) =>
                compareVersions(v.version, best.version) > 0 ? v : best,
            );
            out.push({
                name: plugin.name,
                fromVersion: plugin.version,
                toVersion: newest.version,
                manifestUrl: newest.manifestUrl,
                signature: newest.signature,
                security: newest.security === true,
            });
            break;
        }
    }
    return out;
}
