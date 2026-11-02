// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    listAdminProviders,
    type AdminProviderEntry,
} from '$lib/server/plugins/runtime/admin-providers-listing';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import type { ProviderSearchEntry } from '$lib/utils/admin/settings-search';

/**
 * Extra keyword aliases for sub-features that are NOT their own provider row.
 * Keyed by provider id. e.g. AcoustID is an API-key field on MusicBrainz.
 */
const PROVIDER_KEYWORD_ALIASES: Record<string, string[]> = {
    'musicbrainz-metadata-provider': ['acoustid', 'fingerprint', 'musicbrainz'],
    'tmdb-metadata-provider': ['themoviedb', 'tmdb'],
    'anidb-metadata-provider': ['anidb', 'anime'],
    'mdblist-metadata-provider': ['mdblist'],
};

/**
 * Operator-facing name for what a row IS, shown beside each search hit (settings
 * search, command palette). The raw category id leaked through before, so a
 * background task showed up as "integration" under a "Providers" heading.
 */
const CATEGORY_LABELS: Record<AdminProviderEntry['category'], string> = {
    metadata: 'Metadata provider',
    library: 'Library source',
    integration: 'Integration',
    ai: 'AI provider',
    playback: 'Playback provider',
};

/**
 * Where a row's settings live. The providers and plugins pages open a row's
 * settings modal via ?settings=; the playback page has no per-provider modal
 * (trickplay is tuned there as a whole), so its rows land on the page itself.
 */
const CATEGORY_HREFS: Record<AdminProviderEntry['category'], string> = {
    metadata: '/admin/settings/providers',
    ai: '/admin/settings/ai',
    library: '/admin/settings/plugins',
    integration: '/admin/settings/plugins',
    playback: '/admin/settings/playback',
};

export function buildProviderIndex(providers: AdminProviderEntry[]): ProviderSearchEntry[] {
    return providers.map((p) => {
        const href = CATEGORY_HREFS[p.category];
        return {
            id: p.provider,
            label: p.label,
            category: CATEGORY_LABELS[p.category],
            keywords: [
                p.label.toLowerCase(),
                p.category,
                ...(PROVIDER_KEYWORD_ALIASES[p.provider] ?? []),
            ],
            // Route each row to the surface that actually renders its settings,
            // rather than dumping everything on /admin/settings/plugins with no
            // anchor.
            href,
            settingsParam: p.hasSettings && p.category !== 'playback' ? p.provider : undefined,
        };
    });
}

/** A task or feature plugin as the search index needs it. */
export interface RegistryIndexRow {
    id: string;
    label: string;
    hasSettings: boolean;
}

/**
 * Background tasks and feature plugins are not providers, so
 * `listAdminProviders()` does not carry them; index them straight from the
 * registry. Ids already indexed as a provider row are skipped (the listing's
 * own cross-type dedup used to drop them the same way).
 */
export function buildRegistryIndex(
    tasks: RegistryIndexRow[],
    features: RegistryIndexRow[],
    skipIds: ReadonlySet<string> = new Set(),
): ProviderSearchEntry[] {
    const out: ProviderSearchEntry[] = [];
    for (const t of tasks) {
        if (skipIds.has(t.id)) continue;
        // Background tasks configure on their own detail page. Land on the
        // settings tab when the task has settings; otherwise its overview.
        const base = `/admin/tasks/${encodeURIComponent(t.id)}`;
        out.push({
            id: t.id,
            label: t.label,
            category: 'Background task',
            keywords: [t.label.toLowerCase(), 'task'],
            href: t.hasSettings ? `${base}?tab=settings` : base,
        });
    }
    for (const f of features) {
        if (skipIds.has(f.id)) continue;
        out.push({
            id: f.id,
            label: f.label,
            category: 'Feature plugin',
            keywords: [f.label.toLowerCase(), 'feature'],
            href: '/admin/settings/plugins',
            settingsParam: f.hasSettings ? f.id : undefined,
        });
    }
    return out;
}

export async function loadProviderSearchIndex(): Promise<ProviderSearchEntry[]> {
    const providerIndex = buildProviderIndex(await listAdminProviders());
    const registryIndex = buildRegistryIndex(
        taskRegistry.getAllTasks().map((t) => ({
            id: t.id,
            label: t.name,
            hasSettings: !!t.settings?.fields?.length,
        })),
        taskRegistry.getAllFeatures().map((f) => ({
            id: f.id,
            label: f.id,
            hasSettings: !!f.settings?.fields?.length,
        })),
        new Set(providerIndex.map((e) => e.id)),
    );
    return [...providerIndex, ...registryIndex];
}
