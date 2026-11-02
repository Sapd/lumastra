// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings → Plugins & features (admin IA redesign, spec §3.6): the ONE
 * operator page for feature plugins with settings, watch-sync providers,
 * integration connections, and external plugin install/reload.
 *
 * This is a CURATED view of the plugin registry, not the full dump — the
 * complete registry (incl. the task/sync catalog, which lives on Tasks →
 * Overview now) exists exactly once, at Developer → Registry (spec §3.6
 * "the registry renders once, in Developer"). What used to be the
 * `/admin/operations/extensions` page's "Sync Plugins" section (i.e.
 * `taskRegistry.getAllTasks()`) is deliberately NOT reproduced here.
 *
 * "Dummy"/"(demo)" reference plugins (`dummy` feature, `dummy-integration`)
 * are excluded from production builds entirely (spec §3.6) — they always
 * self-register regardless of runtime env (see
 * `src/lib/server/tasks/builtin/index.ts`), so the filter has to happen at
 * the presentation layer.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isExternalPluginsEnabled } from '$lib/server/plugins';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { listAdminProviders } from '$lib/server/plugins/runtime/admin-providers-listing';
import { devFeaturesEnabled, config } from '$lib/server/config';
import { DEMO_FEATURE_IDS, DEMO_INTEGRATION_IDS } from '$lib/server/plugins/demo-plugin-ids.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { listExternalPluginsWithState } from '$lib/server/services/external-plugin-manager.service.js';
import type { ExternalPluginListItem } from '$lib/schemas/api-external-plugins.js';
import { appPath } from '$lib/shared/api-urls.js';
import {
    listRepositories,
    listCatalogEntries,
} from '$lib/server/database/queries/plugin-repositories.queries.js';
import { pickInstallableVersion, type RepositoryVersion } from '$lib/schemas/plugin-repository.js';
import { PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';
import {
    featureSwitchOff,
    pluginSetup,
    type PluginSetup,
} from '$lib/server/admin/plugin-setup-status.js';
import { hasHealthCheck } from '$lib/server/admin/provider-health.js';
import { readClusterNodes } from '$lib/server/services/cluster-heartbeat.service.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminPluginsPage');

/**
 * One browsable catalog row.
 *
 * `manifestUrl` + `signature` are carried through verbatim because installing
 * from the catalog calls the SAME verified install path an operator would reach
 * by pasting them into the form by hand — the catalog is an autofill, not a
 * second, softer door. Everything else here is advisory and is re-derived from
 * the signed manifest before anything runs.
 */
export interface CatalogPageEntry {
    /** Server-unique with `name`. The list key — a display name is neither. */
    repositoryId: string;
    name: string;
    title: string | null;
    description: string | null;
    publisher: string | null;
    homepage: string | null;
    repositoryName: string | null;
    /** The newest version THIS host can install, or null when none matches its ABI. */
    version: string | null;
    manifestUrl: string | null;
    signature: string | null;
    security: boolean;
    advisoryKeyId: string | null;
    /** Installed version, when this plugin is already present. */
    installedVersion: string | null;
}

export interface PluginsPageEntry {
    id: string;
    name: string;
    description: string;
    /** SDK-declared version, when the definition carries one (optional on
     *  FeatureDefinition for back-compat; always present on
     *  WatchSyncDefinition). Undefined renders as no version at all, same
     *  convention as the external plugin card. */
    version?: string;
    hasSettings: boolean;
    ownedTaskCount: number;
    /**
     * Watch syncs: whether the host connection it needs is set up, and where.
     * Absent when there is no rule (then nothing is claimed either way).
     */
    setup?: PluginSetup;
}

export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        redirect(302, appPath('/'));
    }

    // FeatureDefinition has no `name` field — derive a display label from
    // the id (e.g. `holiday-recommendations` → `Holiday Recommendations`)
    // so the admin UI doesn't render raw kebab-case identifiers.
    const labelFromId = (id: string): string =>
        id
            .split('-')
            .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
            .join(' ');

    // A plugin only earns a "Settings" button when it actually exposes
    // renderable fields; an empty `settings` object would open a panel that
    // just says "no settings". Mirrors the providers listing's
    // `fields?.length` test.
    const hasConfigurableSettings = (settings: { fields?: unknown[] } | undefined): boolean =>
        Array.isArray(settings?.fields) && settings.fields.length > 0;

    // Owned-task counts are unavailable post-queue-removal and surface as
    // zero (same caveat as the pre-redesign extensions page).
    const ownedTaskCount = 0;

    const featurePlugins: PluginsPageEntry[] = taskRegistry
        .getAllFeatures()
        .filter((def) => devFeaturesEnabled || !DEMO_FEATURE_IDS.has(def.id))
        .map((def) => ({
            id: def.id,
            name: labelFromId(def.id),
            description: '',
            version: def.version,
            hasSettings: hasConfigurableSettings(def.settings),
            ownedTaskCount,
            // Set only when an admin setting has the feature off (holidays).
            setup: featureSwitchOff(def.id),
        }));

    const watchSyncPlugins: PluginsPageEntry[] = taskRegistry.getAllWatchSyncs().map((def) => {
        const setup = pluginSetup(def.id);
        return {
            id: def.id,
            name: def.name,
            description: '',
            version: def.version,
            hasSettings: hasConfigurableSettings(def.settings),
            ownedTaskCount,
            ...(setup ? { setup } : {}),
        };
    });

    // Installed external plugins: the registry ⋈ live loader-state join, built by
    // the service manager (single source of truth, shared with the v1 GET). The
    // read is guarded so a null DB pool OR a rejected query degrades to an empty
    // list + an inline error banner instead of 500-ing the whole admin page.
    const externalPluginsEnabled = isExternalPluginsEnabled();
    let externalPlugins: ExternalPluginListItem[] = [];
    let trustedKeysConfigured = false;
    let externalPluginsError = false;
    const sql = getDb();
    if (externalPluginsEnabled && sql) {
        try {
            const res = await listExternalPluginsWithState(sql);
            externalPlugins = res.items;
            trustedKeysConfigured = res.trustedKeysConfigured; // from the SAME effective build
        } catch (err) {
            // Live pool but query rejected (Postgres down/unreachable). Do NOT
            // rethrow — a throw here 500s the whole admin plugins page (builtin
            // sections included). Degrade to the same empty-list + banner as null-DB.
            logger.error(
                'external plugins load failed',
                err instanceof Error ? err : { error: String(err) },
            );
            externalPlugins = [];
            trustedKeysConfigured = false;
            externalPluginsError = true;
        }
    } else if (externalPluginsEnabled && !sql) {
        externalPluginsError = true; // no pool at all: empty list + flag, no throw
    }

    // Repository catalog. Read-only here; every mutation goes through
    // /api/admin/plugins/repositories so the audit log records it. Guarded the
    // same way as the plugin list — a catalog is a convenience, and losing it
    // must not take the whole page down with it.
    let repositories: Awaited<ReturnType<typeof listRepositories>> = [];
    let catalog: CatalogPageEntry[] = [];
    if (externalPluginsEnabled && sql) {
        try {
            const installedByName = new Map(externalPlugins.map((p) => [p.name, p.version]));
            const [repos, entries] = await Promise.all([
                listRepositories(sql),
                listCatalogEntries(sql),
            ]);
            repositories = repos;
            catalog = entries.map((entry) => {
                const meta = (entry.metadata ?? {}) as Record<string, unknown>;
                const versions = entry.versions as RepositoryVersion[];
                // Resolved HERE rather than in the browser: a host on an older
                // Lumastra should be offered the newest version it can actually
                // install, not the newest that exists and would fail its ABI gate.
                const pick = pickInstallableVersion({ name: entry.name, versions }, PLUGIN_SDK_ABI);
                return {
                    repositoryId: entry.repositoryId,
                    name: entry.name,
                    title: typeof meta.title === 'string' ? meta.title : null,
                    description: typeof meta.description === 'string' ? meta.description : null,
                    publisher: typeof meta.publisher === 'string' ? meta.publisher : null,
                    homepage: typeof meta.homepage === 'string' ? meta.homepage : null,
                    repositoryName: entry.repositoryName,
                    version: pick?.version ?? null,
                    manifestUrl: pick?.manifestUrl ?? null,
                    signature: pick?.signature ?? null,
                    security: pick?.security === true,
                    advisoryKeyId: entry.advisoryKeyId,
                    installedVersion: installedByName.get(entry.name) ?? null,
                };
            });
        } catch (err) {
            logger.error(
                'plugin catalog load failed',
                err instanceof Error ? err : { error: String(err) },
            );
        }
    }

    // Integration connections (sonarr/radarr/jellyseerr/…) — these
    // used to render on the Providers page's "Library & Integration
    // Services" section, removed there per spec §3.6; this is their new
    // (and only) home.
    //
    // Filtered on `kind === 'integration'` (only `defineIntegration()` rows),
    // not `category === 'integration'`: watch-sync rows share that category
    // and already have their own section below.
    const allProviders = await listAdminProviders();
    const integrationSetup: Record<string, PluginSetup> = {};
    const integrationProviders = allProviders
        .filter((p) => p.kind === 'integration')
        .filter((p) => devFeaturesEnabled || !DEMO_INTEGRATION_IDS.has(p.provider))
        .map((p) => {
            // The registry marks every integration configured; for the ones
            // whose connection is a host setting, say whether it really is.
            const setup = pluginSetup(p.provider);
            if (!setup) return p;
            integrationSetup[p.provider] = setup;
            return { ...p, configured: setup.status === 'ready' };
        });
    const checkableIds = integrationProviders
        .filter((p) => hasHealthCheck(p.provider))
        .map((p) => p.provider);

    // The per-server install caveat only matters when there is more than one
    // server; on a single-node install it read as a warning about nothing.
    let multiNode = false;
    try {
        multiNode = (await readClusterNodes()).length > 1;
    } catch {
        // best-effort: Valkey unavailable → assume one node and skip the note.
    }

    return {
        featurePlugins,
        watchSyncPlugins,
        externalPlugins,
        externalPluginsEnabled,
        trustedKeysConfigured,
        installEnabled: config.PLUGINS_EXTERNAL_INSTALL_ENABLED,
        requireRegistry: config.PLUGINS_REQUIRE_REGISTRY,
        externalPluginsError,
        integrationProviders,
        integrationSetup,
        checkableIds,
        multiNode,
        repositories,
        catalog,
    };
};
