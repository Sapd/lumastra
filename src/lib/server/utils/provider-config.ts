// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Configuration Utilities
 *
 * Centralized configuration for metadata providers. Reads from environment
 * variables and provides typed access to provider settings.
 *
 * This module is the single source of truth for provider configuration.
 */

import { config } from '../config.js';
import { Logger } from './logger.js';

const logger = Logger.for('provider-config');

// =============================================================================
// Provider Type Definitions
// =============================================================================

/**
 * External ID providers - services that provide unique identifiers for media
 * Note: 'internal' represents our own UUID-based identifiers
 */
export type ExternalIdProvider =
    'internal' | 'tmdb' | 'imdb' | 'tvdb' | 'trakt' | 'mal' | 'jellyfin';

/**
 * External id namespaces that can be a configured PRIMARY / image / search
 * provider. `jellyfin` is a namespace in `external_ids` (written and read by the
 * optional Jellyfin sync) but never an API-facing id, so it is excluded here.
 */
export type ApiExternalIdProvider = Exclude<ExternalIdProvider, 'jellyfin'>;

/**
 * Metadata providers - services that provide media metadata
 * 'aggregated' is a virtual provider representing merged metadata from all sources
 */
export type MetadataProviderType = 'aggregated' | 'tmdb' | 'mdblist' | 'trakt' | 'imdb';

/**
 * Provider capability types
 */
export type ProviderCapability =
    | 'search'
    | 'fetchById'
    | 'crossReferences'
    | 'people'
    | 'images'
    | 'trailers'
    | 'ratings'
    | 'keywords'
    | 'trending';

/**
 * Image provider configuration
 */
export interface ImageProviderConfig {
    provider: string;
    baseUrl: string;
    sizeMappings: {
        thumb: string;
        medium: string;
        full: string;
    };
    rateLimit?: number; // ms between requests
    cacheTtl?: number; // days
}

// =============================================================================
// Provider Configuration
// =============================================================================

/**
 * Full provider configuration
 */
export interface ProviderConfig {
    /** Primary external ID provider (used for lookups when provider not specified) */
    primaryExternalId: ApiExternalIdProvider;
    /** Ordered list of metadata providers for aggregation */
    metadataProviderChain: MetadataProviderType[];
    /** All enabled external ID providers */
    enabledExternalIds: ApiExternalIdProvider[];
    /** Primary image provider (may differ from metadata) */
    primaryImageProvider: ApiExternalIdProvider;
    /** Primary search provider (may differ from metadata) */
    primarySearchProvider: ApiExternalIdProvider;
}

// Cache for provider config, keyed by the settings it was derived from so a
// saved change (on this replica or, via the config-change broadcast, another)
// takes effect without a restart.
let _cachedConfig: ProviderConfig | null = null;
let _cachedFor: string | null = null;

/**
 * Sources an operator can put in the metadata chain from the admin UI: the ones
 * that actually write `provider_metadata` rows the chain ranks. Other names the
 * parser accepts (imdb, trakt, tvdb, mal) are external-ID namespaces — they
 * stay settable through METADATA_PROVIDERS but have no rows to order.
 */
export const EDITABLE_CHAIN_SOURCES = ['tmdb', 'mdblist'] as const;

/**
 * Known external ID providers (for filtering from METADATA_PROVIDERS)
 */
const EXTERNAL_ID_PROVIDERS: ReadonlySet<string> = new Set([
    'tmdb',
    'imdb',
    'trakt',
    'tvdb',
    'mal',
]);

/** A configured image/search provider, if it is an API-facing id namespace. */
function asApiProvider(value: unknown, settingName: string): ApiExternalIdProvider | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const v = value.trim().toLowerCase();
    if (EXTERNAL_ID_PROVIDERS.has(v)) return v as ApiExternalIdProvider;
    logger.warn(
        `[provider-config] ${settingName}="${value}" is not an id provider — using the primary one. Known: ${[...EXTERNAL_ID_PROVIDERS].join(', ')}`,
    );
    return null;
}

/**
 * Get the full provider configuration
 * Parses environment variables and returns structured config
 */
export function getProviderConfig(): ProviderConfig {
    const cacheKey = [
        config.METADATA_PROVIDERS,
        config.PRIMARY_IMAGE_PROVIDER,
        config.PRIMARY_SEARCH_PROVIDER,
    ].join('|');
    if (_cachedConfig && _cachedFor === cacheKey) return _cachedConfig;

    // Parse METADATA_PROVIDERS (comma-separated, ordered by priority)
    const providersStr = config.METADATA_PROVIDERS || 'tmdb';
    const supportedProviders = new Set([
        'tmdb',
        'aggregated',
        'tvdb',
        'imdb',
        'trakt',
        'mdblist',
        'mal',
    ]);
    const providers = providersStr
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => {
            if (!p) return false;
            if (supportedProviders.has(p)) return true;
            logger.warn(
                `[provider-config] Unknown provider "${p}" in METADATA_PROVIDERS — ignoring. Known providers: ${[...supportedProviders].join(', ')}`,
            );
            return false;
        });

    // Extract external ID providers from the list
    const enabledExternalIds = providers.filter((p) =>
        EXTERNAL_ID_PROVIDERS.has(p),
    ) as ApiExternalIdProvider[];

    // Primary external ID is first in list, or 'tmdb' as fallback
    const primaryExternalId: ApiExternalIdProvider = enabledExternalIds[0] || 'tmdb';

    // Build metadata chain: 'aggregated' first, then enabled providers
    const metadataProviderChain: MetadataProviderType[] = [
        'aggregated',
        ...providers.filter((p) => p !== 'aggregated'),
    ] as MetadataProviderType[];

    // Image and search providers can be overridden via config. Only an
    // API-facing id namespace is accepted (never `jellyfin`, never a typo);
    // anything else falls back to the primary external id provider.
    const primaryImageProvider =
        asApiProvider(config.PRIMARY_IMAGE_PROVIDER, 'PRIMARY_IMAGE_PROVIDER') ?? primaryExternalId;
    const primarySearchProvider =
        asApiProvider(config.PRIMARY_SEARCH_PROVIDER, 'PRIMARY_SEARCH_PROVIDER') ??
        primaryExternalId;

    _cachedConfig = {
        primaryExternalId,
        metadataProviderChain,
        enabledExternalIds,
        primaryImageProvider,
        primarySearchProvider,
    };
    _cachedFor = cacheKey;

    return _cachedConfig;
}

// =============================================================================
// Convenience Accessors
// =============================================================================

/**
 * Get the primary external ID provider
 * Used when provider is not specified in lookups
 */
export function getPrimaryProvider(): ApiExternalIdProvider {
    return getProviderConfig().primaryExternalId;
}

/**
 * Get the primary external ID provider.
 * Alias for getPrimaryProvider() for semantic clarity in provider-agnostic code.
 *
 * @returns The configured primary external ID provider
 */
export function getPrimaryExternalIdProvider(): ApiExternalIdProvider {
    return getPrimaryProvider();
}

/**
 * Get the ordered list of metadata providers ('aggregated' first).
 *
 * METADATA_PROVIDERS is the one source of truth — the admin chain editor
 * writes it. (A second copy in `provider_capabilities` rows used to override
 * it whenever such rows existed, so the page and the runtime could disagree.)
 */
export function getMetadataProviderChain(): MetadataProviderType[] {
    return getProviderConfig().metadataProviderChain;
}

/**
 * Get enabled external ID providers
 */
export function getEnabledExternalIdProviders(): ApiExternalIdProvider[] {
    return getProviderConfig().enabledExternalIds;
}

/**
 * Get the primary image provider
 */
export function getPrimaryImageProvider(): ApiExternalIdProvider {
    return getProviderConfig().primaryImageProvider;
}

/**
 * Get the primary search provider
 */
export function getPrimarySearchProvider(): ApiExternalIdProvider {
    return getProviderConfig().primarySearchProvider;
}

/**
 * Check if a provider is enabled
 */
export function isProviderEnabled(provider: string): boolean {
    const chain = getMetadataProviderChain();
    return chain.includes(provider as MetadataProviderType);
}

/**
 * Reset cached config (for testing or dynamic reconfiguration)
 */
export function resetProviderConfig(): void {
    _cachedConfig = null;
    _cachedFor = null;
}

// =============================================================================
// Image Provider Configurations
// =============================================================================

/**
 * Default image provider configurations
 */
export const IMAGE_PROVIDER_CONFIGS: Record<string, ImageProviderConfig> = {
    tmdb: {
        provider: 'tmdb',
        baseUrl: 'https://image.tmdb.org/t/p',
        sizeMappings: {
            thumb: 'w342',
            medium: 'w500',
            full: 'w780',
        },
        rateLimit: 100,
        cacheTtl: 180,
    },
};

/**
 * Get image configuration for a provider
 */
export function getImageProviderConfig(provider: string): ImageProviderConfig | undefined {
    return IMAGE_PROVIDER_CONFIGS[provider.toLowerCase()];
}
