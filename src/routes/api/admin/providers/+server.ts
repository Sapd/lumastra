// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Dashboard API
 *
 * GET   — Returns operation mode, provider config, provider list, and field authorities.
 * PATCH — Updates a `provider_capabilities` row's enabled state or priority.
 * PUT   — Saves the metadata chain order (METADATA_PROVIDERS) from the admin UI.
 *
 * Auth: providers:admin (all methods). Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    setProviderEnabled,
    setProviderPriority,
    getProviderCapability,
} from '$lib/server/database/queries/provider-capabilities.queries.js';
import {
    ProvidersResponseSchema,
    ProviderUpdateResponseSchema,
    MetadataChainReorderResponseSchema,
} from '$lib/schemas/api-admin-responses.js';
import { reloadProviderConfigFromDb } from '$lib/server/providers/provider-config-loader.js';
import { getFieldAuthorities } from '$lib/server/database/queries/provider-capabilities.queries.js';
import {
    getMetadataChainView,
    saveMetadataChain,
    MetadataChainError,
} from '$lib/server/admin/metadata-chain.js';
import { operationMode } from '$lib/server/operation-mode.js';
import { getProviderConfig } from '$lib/server/utils/provider-config.js';
import {
    listAdminProviders,
    listAdminFieldAuthorities,
} from '$lib/server/plugins/runtime/admin-providers-listing.js';
import {
    buildFieldAuthorityConfigFromDefinitions,
    invalidateProviderSettingsCache,
    loadProviderSettings,
} from '$lib/server/plugins/runtime/field-authority-loader.js';
import { setEffectiveFieldPriorities } from '$lib/server/database/queries/metadata-aggregation.queries.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { devFeaturesEnabled } from '$lib/server/config.js';
import { DEMO_INTEGRATION_IDS } from '$lib/server/plugins/demo-plugin-ids.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const PatchBodySchema = z.object({
    provider: z.string().min(1),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
});

const PutBodySchema = z.object({
    chain: z.array(z.string().min(1)).min(1).max(20),
});

// ---------------------------------------------------------------------------
// Shared helper: invalidate + reload field-authority cache after config change
// ---------------------------------------------------------------------------

async function refreshFieldAuthorities(): Promise<void> {
    await invalidateProviderSettingsCache();
    try {
        const definitions = taskRegistry.getAllProviders();
        const sql = await aiDbService.getSql();
        if (!sql) return;
        const settings = await loadProviderSettings(
            sql,
            definitions.map((d) => d.id),
        );
        const faConfig = buildFieldAuthorityConfigFromDefinitions(definitions, settings);
        setEffectiveFieldPriorities(faConfig.defaultPriorities);
    } catch {
        // Logged inside loadProviderSettings; do not propagate.
    }
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    visibility: 'internal',
    request: {
        body: z.union([PatchBodySchema, PutBodySchema]).optional(),
    },
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const providerConfig = getProviderConfig();

            function getOperationModeString():
                'standalone' | 'jellyfin-enhanced' | 'jellyfin-unreachable' | 'degraded' {
                if (operationMode.isStandalone) return 'standalone';
                if (operationMode.isJellyfinEnhanced) return 'jellyfin-enhanced';
                if (operationMode.isDegraded) return 'degraded';
                return 'jellyfin-unreachable';
            }

            // Reference plugins (dummy-integration) always self-register; keep
            // them out of production listings, as the plugins page does.
            const providers = (await listAdminProviders()).filter(
                (p) => devFeaturesEnabled || !DEMO_INTEGRATION_IDS.has(p.provider),
            );
            const manifestFieldAuthorities = listAdminFieldAuthorities();

            const dbFaRows = await getFieldAuthorities(sql);
            const dbFieldAuthorities = dbFaRows.map((row) => ({
                fieldName: row.field_name,
                provider: row.provider,
                priority: row.priority,
                mediaType: row.media_type ?? undefined,
                isAnime: row.is_anime ?? undefined,
            }));

            const faMap = new Map<
                string,
                {
                    fieldName: string;
                    provider: string;
                    priority: number;
                    mediaType?: string;
                    isAnime?: boolean;
                }
            >();
            for (const fa of manifestFieldAuthorities)
                faMap.set(`${fa.fieldName}:${fa.provider}`, fa);
            for (const fa of dbFieldAuthorities) faMap.set(`${fa.fieldName}:${fa.provider}`, fa);
            const fieldAuthorities = Array.from(faMap.values());

            const metadataChainOrder = getMetadataChainView().chain;

            return json(
                ProvidersResponseSchema.parse({
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
                    metadataChainOrder,
                }),
            );
        },

        PATCH: async (event) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }
            const parsed = PatchBodySchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const { provider, enabled, priority } = parsed.data;

            const existing = await getProviderCapability(sql, provider);
            if (!existing) {
                return ApiProblem.notFound(`Provider "${provider}" not found`);
            }

            if (enabled !== undefined) await setProviderEnabled(sql, provider, enabled);
            if (priority !== undefined) await setProviderPriority(sql, provider, priority);

            await reloadProviderConfigFromDb(sql);
            await refreshFieldAuthorities();

            const updated = await getProviderCapability(sql, provider);
            if (!updated) return ApiProblem.internalError('Provider disappeared after update');

            return json(
                ProviderUpdateResponseSchema.parse({
                    provider: updated.provider,
                    priority: updated.priority,
                    enabled: updated.enabled,
                }),
            );
        },

        PUT: async (event) => {
            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }
            const parsed = PutBodySchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            try {
                const chain = await saveMetadataChain(parsed.data.chain);
                return json(MetadataChainReorderResponseSchema.parse({ success: true, chain }));
            } catch (err) {
                if (err instanceof MetadataChainError) {
                    return err.kind === 'env-locked'
                        ? ApiProblem.conflict(err.message)
                        : ApiProblem.validationFailed(err.message);
                }
                throw err;
            }
        },
    },
});

export const { GET, PATCH, PUT } = mount(def, { surface: 'internal' });
