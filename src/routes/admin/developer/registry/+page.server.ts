// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Developer → Registry (admin IA redesign, spec §3.7): the raw, complete
 * plugin/task runtime registry, rendered exactly ONCE. Every other admin
 * surface that used to dump the full registry (the old `/admin/providers`
 * "Library & Integration Services" section, `/admin/operations/extensions`'s
 * feature/sync/watch-sync/external cards) now shows a CURATED subset
 * instead — this page is the one place the complete list lives (spec §2
 * "one source of truth").
 *
 * Raw ids, mono styling expected here — this is a developer surface, not an
 * operator one. "Dummy"/"(demo)" reference plugins are excluded even here:
 * they're gated on `devFeaturesEnabled` (a build/runtime-env signal), not on
 * the "Show developer tools" admin toggle this whole section already sits
 * behind — a production deployment with dev tools flipped on for
 * troubleshooting should still never see them.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireDevTools } from '$lib/server/admin/require-dev-tools.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { devFeaturesEnabled } from '$lib/server/config';
import {
    DEMO_FEATURE_IDS,
    DEMO_INTEGRATION_IDS,
    DEMO_TASK_IDS,
} from '$lib/server/plugins/demo-plugin-ids.js';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export interface RegistryEntry {
    id: string;
    name: string;
    version: string;
    hasSettings: boolean;
}

export interface RegistryGroup {
    /** Stable key for `#each` — also used as the i18n lookup key. */
    kind: string;
    entries: RegistryEntry[];
}

// FeatureDefinition/IntegrationDefinition/TrickplayProviderDefinition carry
// no `name`/`version` in the SDK — derive a display label from the id (e.g.
// `holiday-recommendations` → `Holiday Recommendations`) instead of
// rendering raw kebab-case, same helper as the pages this replaces used.
function labelFromId(id: string): string {
    return id
        .split('-')
        .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
        .join(' ');
}

function hasConfigurableSettings(settings: { fields?: unknown[] } | undefined): boolean {
    return Array.isArray(settings?.fields) && settings.fields.length > 0;
}

export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        redirect(302, appPath('/'));
    }
    requireDevTools();

    const metadataProviders: RegistryEntry[] = taskRegistry.getAllProviders().map((def) => ({
        id: def.id,
        name: def.name,
        version: def.version,
        hasSettings: hasConfigurableSettings(def.settings),
    }));

    const syncTasks: RegistryEntry[] = taskRegistry
        .getAllTasks()
        .filter((def) => devFeaturesEnabled || !DEMO_TASK_IDS.has(def.id))
        .map((def) => ({
            id: def.id,
            name: def.name,
            version: def.version,
            hasSettings: hasConfigurableSettings(def.settings),
        }));

    const featurePlugins: RegistryEntry[] = taskRegistry
        .getAllFeatures()
        .filter((def) => devFeaturesEnabled || !DEMO_FEATURE_IDS.has(def.id))
        .map((def) => ({
            id: def.id,
            name: labelFromId(def.id),
            // Declared, or empty. '1.0.0' was a fabricated number shown to
            // operators as though the author had chosen it.
            version: def.version ?? '',
            hasSettings: hasConfigurableSettings(def.settings),
        }));

    const watchSyncPlugins: RegistryEntry[] = taskRegistry.getAllWatchSyncs().map((def) => ({
        id: def.id,
        name: def.name,
        version: def.version,
        hasSettings: hasConfigurableSettings(def.settings),
    }));

    const integrations: RegistryEntry[] = taskRegistry
        .getAllIntegrations()
        .filter((def) => devFeaturesEnabled || !DEMO_INTEGRATION_IDS.has(def.id))
        .map((def) => ({
            id: def.id,
            name: labelFromId(def.id),
            // Declared, or empty. '1.0.0' was a fabricated number shown to
            // operators as though the author had chosen it.
            version: def.version ?? '',
            hasSettings: hasConfigurableSettings(def.settings),
        }));

    const mediaSources: RegistryEntry[] = taskRegistry.getAllMediaSources().map((def) => ({
        id: def.id,
        name: def.name || def.id,
        version: def.version || '1.0.0',
        hasSettings: hasConfigurableSettings(def.settings),
    }));

    const externalServices: RegistryEntry[] = taskRegistry.getAllExternalServices().map((def) => ({
        id: def.id,
        name: def.name || def.id,
        version: def.version || '1.0.0',
        hasSettings: hasConfigurableSettings(def.settings),
    }));

    const trickplayProviders: RegistryEntry[] = taskRegistry.getAllTrickplays().map((def) => ({
        id: def.id,
        name: labelFromId(def.id),
        version: def.version ?? '',
        hasSettings: false,
    }));

    // The three newest families. Omitting them did not merely hide a row: this
    // page is the ONE place the registry renders in full, so an operator who
    // installed a subtitle, lyrics or auth plugin could see it nowhere at all.
    const subtitleProviders: RegistryEntry[] = taskRegistry
        .getAllSubtitleProviders()
        .map((def) => ({
            id: def.id,
            name: def.name || def.id,
            version: def.version || '1.0.0',
            hasSettings: hasConfigurableSettings(def.settings),
        }));

    const lyricsProviders: RegistryEntry[] = taskRegistry.getAllLyricsProviders().map((def) => ({
        id: def.id,
        name: def.name || def.id,
        version: def.version || '1.0.0',
        hasSettings: hasConfigurableSettings(def.settings),
    }));

    const authProviders: RegistryEntry[] = taskRegistry.getAllAuthProviders().map((def) => ({
        id: def.id,
        name: def.name || def.id,
        version: def.version || '1.0.0',
        hasSettings: hasConfigurableSettings(def.settings),
    }));

    const groups: RegistryGroup[] = [
        { kind: 'metadataProviders', entries: metadataProviders },
        { kind: 'aiServices', entries: externalServices },
        { kind: 'syncTasks', entries: syncTasks },
        { kind: 'featurePlugins', entries: featurePlugins },
        { kind: 'watchSyncPlugins', entries: watchSyncPlugins },
        { kind: 'integrations', entries: integrations },
        { kind: 'mediaSources', entries: mediaSources },
        { kind: 'trickplayProviders', entries: trickplayProviders },
        { kind: 'subtitleProviders', entries: subtitleProviders },
        { kind: 'lyricsProviders', entries: lyricsProviders },
        { kind: 'authProviders', entries: authProviders },
    ];

    return {
        groups,
        totalCount: groups.reduce((sum, g) => sum + g.entries.length, 0),
    };
};
