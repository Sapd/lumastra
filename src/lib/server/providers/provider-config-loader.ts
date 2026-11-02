// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Config Loader
 *
 * Loads per-field authority overrides from the DB into runtime caches.
 * Called on server startup (after migrations) and after admin PATCH.
 *
 * The metadata chain is NOT loaded here: METADATA_PROVIDERS is its only source
 * (see getMetadataProviderChain).
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger';
import { getFieldAuthorities } from '$lib/server/database/queries/provider-capabilities.queries';
import {
    setFieldAuthorityOverride,
    resetFieldAuthorityCache,
} from '$lib/server/database/queries/metadata-aggregation.queries';
import { resetProviderArrayCache } from '$lib/server/database/queries/builders/provider-metadata.builder';

const logger = Logger.for('ProviderConfigLoader');

/**
 * Load provider configuration from DB and update runtime caches.
 * Safe to call multiple times (idempotent).
 *
 * @returns true if loaded successfully, false if DB unavailable
 */
export async function loadProviderConfigFromDb(sql: postgres.Sql): Promise<boolean> {
    try {
        // Load field authorities from DB
        const fieldAuthRows = await getFieldAuthorities(sql);
        if (fieldAuthRows.length > 0) {
            const defaultMap: Record<string, string[]> = {};
            const animeMap: Record<string, string[]> = {};

            for (const row of fieldAuthRows) {
                if (row.is_anime === true) {
                    if (!animeMap[row.field_name]) animeMap[row.field_name] = [];
                    animeMap[row.field_name].push(row.provider);
                } else if (row.is_anime === null && row.media_type === null) {
                    if (!defaultMap[row.field_name]) defaultMap[row.field_name] = [];
                    defaultMap[row.field_name].push(row.provider);
                }
                // media_type-specific overrides not yet supported in DB
            }

            setFieldAuthorityOverride(defaultMap, animeMap);
            logger.info('Loaded field authorities from DB', {
                defaultFields: Object.keys(defaultMap).length,
                animeFields: Object.keys(animeMap).length,
            });
        } else {
            logger.info('No field authorities in DB — using hard-coded defaults');
        }

        return true;
    } catch (error) {
        logger.warn(
            'Failed to load provider config from DB — using env var fallback',
            error instanceof Error ? { error: error.message } : undefined,
        );
        return false;
    }
}

/**
 * Reload provider config from DB, resetting all caches first.
 * Called after admin PATCH/PUT to invalidate and reload.
 */
export async function reloadProviderConfigFromDb(sql: postgres.Sql): Promise<boolean> {
    resetFieldAuthorityCache();
    resetProviderArrayCache();
    return loadProviderConfigFromDb(sql);
}
