// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { aiDbService } from '$lib/server/services/database.service';
import { getFieldAuthorities } from '$lib/server/database/queries/provider-capabilities.queries';
import { getMetadataChainView, type MetadataChainView } from '$lib/server/admin/metadata-chain';
import { hasHealthCheck } from '$lib/server/admin/provider-health';
import { operationMode } from '$lib/server/operation-mode';
import { getProviderConfig } from '$lib/server/utils/provider-config';
import {
    listAdminProviders,
    listAdminFieldAuthorities,
    type AdminProviderEntry,
    type ProviderCategory,
} from '$lib/server/plugins/runtime/admin-providers-listing';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { appPath } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminSettingsProviders');

// Re-export so existing imports of PluginProviderEntry / ProviderCategory keep working.
export type PluginProviderEntry = AdminProviderEntry;
export type { ProviderCategory };

export type ProviderDashboardData = {
    operationMode: {
        mode: 'standalone' | 'jellyfin-enhanced' | 'jellyfin-unreachable' | 'degraded';
        jellyfinEnabled: boolean;
        jellyfinAvailable: boolean;
        canLiveTV: boolean;
    };
    providerConfig: {
        primaryExternalId: string;
        metadataProviderChain: string[];
        enabledExternalIds: string[];
        primaryImageProvider: string;
        primarySearchProvider: string;
    };
    providers: PluginProviderEntry[];
    fieldAuthorities: Array<{
        fieldName: string;
        provider: string;
        priority: number;
        mediaType?: string;
        isAnime?: boolean;
    }>;
    metadataChain: MetadataChainView;
    /** Provider ids with a live connectivity check ("Check" renders only for these). */
    checkableIds: string[];
    /** The provider data could not be loaded; what is shown is a placeholder. */
    loadError?: string;
};

function getOperationModeString():
    'standalone' | 'jellyfin-enhanced' | 'jellyfin-unreachable' | 'degraded' {
    if (operationMode.isStandalone) return 'standalone';
    if (operationMode.isJellyfinEnhanced) return 'jellyfin-enhanced';
    if (operationMode.isDegraded) return 'degraded';
    return 'jellyfin-unreachable';
}

const DB_UNAVAILABLE_FALLBACK: ProviderDashboardData = {
    operationMode: {
        mode: 'standalone',
        jellyfinEnabled: false,
        jellyfinAvailable: false,
        canLiveTV: false,
    },
    providerConfig: {
        primaryExternalId: 'tmdb',
        metadataProviderChain: ['tmdb'],
        enabledExternalIds: ['tmdb'],
        primaryImageProvider: 'tmdb',
        primarySearchProvider: 'tmdb',
    },
    providers: [],
    fieldAuthorities: [],
    metadataChain: { chain: ['tmdb'], addable: [], envLocked: false },
    checkableIds: [],
};

export const load = (async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    // Only the metadata keys: service connections live on Settings → Connections.
    const loaded = await loadSettingsForSections(['metadata']);
    // METADATA_PROVIDERS is edited by the metadata-source-order card above the
    // form; a second free-text control for the same list only invited the two
    // to be read as different settings.
    const settingsData = {
        ...loaded,
        schema: {
            ...loaded.schema,
            settings: loaded.schema.settings.filter((st) => st.key !== 'METADATA_PROVIDERS'),
        },
    };
    const exposure = await loadSearchExposure();

    try {
        const providerConfig = getProviderConfig();

        // Unified provider listing across new task registry + legacy media-source registry.
        const providers = await listAdminProviders();

        // Manifest-derived field authorities (from new-registry ProviderDefinition metadata).
        const manifestFieldAuthorities = listAdminFieldAuthorities();

        // DB-stored overrides take precedence over manifest defaults.
        const sql = await aiDbService.getSql();
        let dbFieldAuthorities: ProviderDashboardData['fieldAuthorities'] = [];

        if (sql) {
            const dbFaRows = await getFieldAuthorities(sql);
            dbFieldAuthorities = dbFaRows.map((row) => ({
                fieldName: row.field_name,
                provider: row.provider,
                priority: row.priority,
                mediaType: row.media_type ?? undefined,
                isAnime: row.is_anime ?? undefined,
            }));
        }

        const faMap = new Map<string, ProviderDashboardData['fieldAuthorities'][number]>();
        for (const fa of manifestFieldAuthorities) {
            faMap.set(`${fa.fieldName}:${fa.provider}`, fa);
        }
        for (const fa of dbFieldAuthorities) {
            faMap.set(`${fa.fieldName}:${fa.provider}`, fa);
        }
        const fieldAuthorities = Array.from(faMap.values()).sort(
            (a, b) => a.fieldName.localeCompare(b.fieldName) || a.priority - b.priority,
        );

        return {
            ...settingsData,
            ...exposure,
            operationMode: {
                mode: getOperationModeString(),
                jellyfinEnabled: operationMode.isJellyfinEnabled,
                jellyfinAvailable: operationMode.isJellyfinAvailable,
                canLiveTV: operationMode.canLiveTV,
            },
            providerConfig: {
                primaryExternalId: providerConfig.primaryExternalId,
                metadataProviderChain: providerConfig.metadataProviderChain as string[],
                enabledExternalIds: providerConfig.enabledExternalIds as string[],
                primaryImageProvider: providerConfig.primaryImageProvider,
                primarySearchProvider: providerConfig.primarySearchProvider,
            },
            providers,
            fieldAuthorities,
            metadataChain: getMetadataChainView(),
            checkableIds: providers
                .filter((p) => hasHealthCheck(p.provider))
                .map((p) => p.provider),
        };
    } catch (error) {
        // Render the placeholder state, but say so and log why: a bare catch
        // showed a made-up "TMDB only, not ENV-locked" chain for ANY failure,
        // hiding both the real cause and a real ENV lock.
        logger.warn('Provider settings could not be loaded', error as Error);
        let metadataChain = DB_UNAVAILABLE_FALLBACK.metadataChain;
        try {
            metadataChain = getMetadataChainView();
        } catch {
            // Keep the placeholder chain.
        }
        return {
            ...settingsData,
            ...exposure,
            ...DB_UNAVAILABLE_FALLBACK,
            metadataChain,
            loadError: error instanceof Error ? error.message : String(error),
        };
    }
}) satisfies PageServerLoad;

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
