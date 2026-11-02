// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin provider listing — unified DTO from the new task registry.
 *
 * The admin `/admin/providers` page, the plugins page's Integrations section,
 * `/api/admin/providers` (and `/api/v1/providers`, which delegates to it) and
 * the settings search list every PROVIDER-SHAPED plugin the host knows about:
 * metadata providers, integrations, trickplay providers, watch syncs, external
 * services, AND media sources (audiobookshelf / kavita / file-scanner). Every
 * plugin type is sourced from the task registry.
 *
 * Plain tasks and feature plugins are deliberately NOT listed. They are not
 * providers and no `ProviderCategory` describes them — they used to be stamped
 * `category: 'integration'`, which dragged the whole ~60-row task registry into
 * every "integrations" filter (and into the `/api/v1/providers` response). Their
 * homes are Developer → Registry and `/admin/tasks`; settings search indexes
 * them straight from the registry (`provider-search-index.ts`).
 *
 * This helper normalises all sources into the same `ProviderItem` shape and
 * the same field-authority output the admin UI consumes.
 *
 * Field-authority handling: derived from new-registry `ProviderDefinition`
 * metadata (`metadata.priority`, `metadata.fieldAuthorities`) — the legacy
 * `buildFieldAuthorityConfig(metadataPlugins)` path is no longer invoked
 * because all 5 metadata providers ship in the new registry as of Phase 3.
 */

import type {
    ExternalServiceDefinition,
    IntegrationDefinition,
    MediaSourceDefinition,
    ProviderDefinition,
    TrickplayProviderDefinition,
    WatchSyncDefinition,
} from '@sapd/lumastra-plugin-sdk';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildFieldAuthorityConfigFromDefinitions } from './field-authority-loader.js';
import { isProviderConfigured, buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { ProviderCategory } from '$lib/schemas/api-admin-responses.js';

const log = Logger.for('AdminProvidersListing');

// One definition, shared with the API response schema, so a category added
// here cannot silently fail the `/api/admin/providers` response parse.
export type { ProviderCategory };

export interface AdminProviderEntry {
    provider: string;
    label: string;
    priority: number;
    enabled: boolean;
    capabilities: Record<string, boolean>;
    configured: boolean;
    category: ProviderCategory;
    source: 'builtin' | 'external';
    hasSettings: boolean;
    version: string;
    /**
     * Which registry contract produced this row (set by pushIfNew from the
     * insertion sourceType): 'provider' | 'integration' | 'trickplay' |
     * 'watch-sync' | 'external-service' | 'media-source'. Finer than
     * `category` — watch-sync rows share `category: 'integration'` with
     * genuine `defineIntegration()` plugins, so a surface that wants ONLY the
     * latter filters on `kind === 'integration'`.
     */
    kind?: string;
}

export interface AdminFieldAuthorityEntry {
    fieldName: string;
    provider: string;
    priority: number;
    mediaType?: string;
    isAnime?: boolean;
}

/**
 * Build the full admin provider list across both registries, fan-out availability
 * checks in parallel.
 */
export async function listAdminProviders(): Promise<AdminProviderEntry[]> {
    const entries: AdminProviderEntry[] = [];

    // ── New task registry ──
    const providers = taskRegistry.getAllProviders();
    const integrations = taskRegistry.getAllIntegrations();
    const trickplays = taskRegistry.getAllTrickplays();
    const watchSyncs = taskRegistry.getAllWatchSyncs();
    const externalServices = taskRegistry.getAllExternalServices();

    // Dedup at insertion time so the same id registered across multiple
    // new-registry types (e.g., a provider whose author also added a watch sync
    // by the same id) only contributes one admin row. Earlier inserts win,
    // but cross-type id collisions almost always indicate a developer bug
    // (TaskRegistry's per-type Maps don't catch them), so log a warning so
    // the dropped registration doesn't disappear silently.
    const seen = new Set<string>();
    const pushIfNew = (entry: AdminProviderEntry, sourceType: string): void => {
        if (seen.has(entry.provider)) {
            log.warn('admin DTO: plugin id collision across types, dropping later registration', {
                id: entry.provider,
                droppedType: sourceType,
                droppedCategory: entry.category,
            });
            return;
        }
        seen.add(entry.provider);
        entry.kind = sourceType;
        entries.push(entry);
    };

    const providerEntries = await Promise.all(providers.map((p) => providerToEntry(p)));
    providerEntries.forEach((e) => pushIfNew(e, 'provider'));

    integrations.forEach((i) => pushIfNew(integrationToEntry(i), 'integration'));
    trickplays.forEach((t) => pushIfNew(trickplayToEntry(t), 'trickplay'));
    watchSyncs.forEach((w) => pushIfNew(watchSyncToEntry(w), 'watch-sync'));

    const externalServiceEntries = await Promise.all(
        externalServices.map((s) => externalServiceToEntry(s)),
    );
    externalServiceEntries.forEach((e) => pushIfNew(e, 'external-service'));

    // ── Media sources (kavita + audiobookshelf + file-scanner) ──
    const newMediaSources = taskRegistry.getAllMediaSources();
    const newMediaSourceEntries = await Promise.all(
        newMediaSources.map((m) => newMediaSourceToEntry(m)),
    );
    newMediaSourceEntries.forEach((e) => pushIfNew(e, 'media-source'));

    // Sort: category groups first, then by priority within the group.
    entries.sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.priority - b.priority;
    });

    return entries;
}

/**
 * Build manifest-derived field authorities from the new-registry
 * `ProviderDefinition.metadata` declarations.
 *
 * Mirrors the legacy `buildFieldAuthorityConfig(metadataPlugins)` output
 * shape (one `{fieldName, provider, priority}` row per provider per field),
 * using the Phase 1 new-registry counterpart.
 *
 * Settings are passed as an empty map; per-operator overrides will flow
 * through `getFieldAuthorities()` from the DB in the admin page itself.
 */
export function listAdminFieldAuthorities(): AdminFieldAuthorityEntry[] {
    const definitions = taskRegistry.getAllProviders();
    const config = buildFieldAuthorityConfigFromDefinitions(definitions, new Map());
    const out: AdminFieldAuthorityEntry[] = [];
    for (const [fieldName, providerList] of Object.entries(config.defaultPriorities)) {
        providerList.forEach((provider, idx) => {
            out.push({ fieldName, provider, priority: (idx + 1) * 10 });
        });
    }
    return out;
}

/**
 * Default metadata chain order derived from new-registry providers when the
 * DB has no explicit chain set (first boot or no admin overrides).
 *
 * Sorts by `metadata.priority` ascending (lower = higher precedence) to
 * match the legacy semantics that `+page.server.ts` and `+server.ts` relied
 * on. Providers without a declared priority fall back to 0.
 */
export function defaultMetadataChainOrder(): string[] {
    return taskRegistry
        .getAllProviders()
        .slice()
        .sort((a, b) => (a.metadata?.priority ?? 0) - (b.metadata?.priority ?? 0))
        .map((p) => p.id);
}

// ── Per-definition converters ─────────────────────────────────────────────────

async function providerToEntry(def: ProviderDefinition): Promise<AdminProviderEntry> {
    let configured: boolean;
    try {
        configured = await isProviderConfigured(def.id);
    } catch {
        // best-effort: config probe failure → treat provider as unconfigured in the admin listing.
        configured = false;
    }
    return {
        provider: def.id,
        label: def.name,
        priority: def.metadata?.priority ?? 0,
        enabled: true, // new-registry providers are always considered enabled
        capabilities: capabilitiesToRecord(def.capabilities),
        configured,
        category: 'metadata',
        source: 'builtin',
        hasSettings: !!def.settings?.fields?.length,
        version: def.version,
    };
}

function integrationToEntry(def: IntegrationDefinition): AdminProviderEntry {
    return {
        provider: def.id,
        // Integrations declare no display name, so present a title-cased id
        // ("discogs" → "Discogs") instead of a raw lowercase slug in the
        // plugins page, settings search, and command palette.
        label: def.id.charAt(0).toUpperCase() + def.id.slice(1),
        priority: 50,
        enabled: true,
        capabilities: capabilitiesToRecord(def.capabilities as unknown as Record<string, unknown>),
        configured: true,
        category: 'integration',
        source: 'builtin',
        hasSettings: !!def.settings?.fields?.length,
        version: '1.0.0',
    };
}

function trickplayToEntry(def: TrickplayProviderDefinition): AdminProviderEntry {
    return {
        provider: def.id,
        label: def.id,
        priority: 50,
        enabled: true,
        capabilities: capabilitiesToRecord(def.capabilities as unknown as Record<string, unknown>),
        configured: true,
        category: 'playback',
        source: 'builtin',
        hasSettings: !!def.settings?.fields?.length,
        version: '1.0.0',
    };
}

function watchSyncToEntry(def: WatchSyncDefinition): AdminProviderEntry {
    return {
        provider: def.id,
        label: def.id,
        priority: 50,
        enabled: true,
        capabilities: capabilitiesToRecord(def.capabilities as unknown as Record<string, unknown>),
        configured: true,
        category: 'integration',
        source: 'builtin',
        hasSettings: !!def.settings?.fields?.length,
        version: '1.0.0',
    };
}

async function newMediaSourceToEntry(def: MediaSourceDefinition): Promise<AdminProviderEntry> {
    let configured = false;
    let enabled = true;
    // Independent try/catch per check — without this, a throwing `isEnabled`
    // would force `configured = false` in the shared catch even though
    // `isConfigured` had already returned true. The two queries are independent
    // and shouldn't tear each other down.
    let ctx;
    try {
        ctx = buildPluginContext(def.id);
    } catch {
        ctx = undefined;
    }
    if (ctx) {
        try {
            if (typeof def.isConfigured === 'function') {
                configured = !!(await def.isConfigured(ctx));
            } else if (typeof def.isAvailable === 'function') {
                configured = !!(await def.isAvailable(ctx));
            }
        } catch {
            // best-effort: isConfigured/isAvailable probe failure → treat as unconfigured in the listing.
            configured = false;
        }
        try {
            if (typeof def.isEnabled === 'function') {
                enabled = !!(await def.isEnabled(ctx));
            }
        } catch {
            // Leave enabled at its default `true`; isEnabled failure shouldn't
            // hide a configured plugin from the admin UI entirely.
        }
    }
    return {
        provider: def.id,
        label: def.name || def.id,
        priority: 50,
        enabled,
        capabilities: capabilitiesToRecord(def.capabilities ?? {}),
        configured,
        category: 'library',
        source: 'builtin',
        hasSettings: !!def.settings?.fields?.length,
        version: def.version || '1.0.0',
    };
}

async function externalServiceToEntry(def: ExternalServiceDefinition): Promise<AdminProviderEntry> {
    let configured = false;
    try {
        const ctx = buildPluginContext(def.id);
        if (typeof def.isConfigured === 'function') {
            configured = !!(await def.isConfigured(ctx));
        } else if (typeof def.isAvailable === 'function') {
            configured = !!(await def.isAvailable(ctx));
        }
    } catch {
        configured = false;
    }
    return {
        provider: def.id,
        // `||` (not `??`) so an empty-string `name: ''` falls back to the id
        // instead of rendering as a blank row in the admin UI.
        label: def.name || def.id,
        priority: 50,
        enabled: true,
        capabilities: capabilitiesToRecord(def.capabilities ?? {}),
        configured,
        category: 'ai',
        source: 'builtin',
        hasSettings: !!def.settings?.fields?.length,
        version: def.version || '1.0.0',
    };
}

function capabilitiesToRecord(caps: Record<string, unknown>): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(caps)) {
        out[k] = !!v;
    }
    return out;
}
