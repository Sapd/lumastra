// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Preference Query Module
 *
 * Pure SQL queries for per-media provider override management.
 * Used by the /api/media/:id/provider-preference endpoint.
 *
 * Queries cover the GET (read preference + available providers),
 * POST (validate and set preference), and DELETE (reset preference) flows.
 */

import type postgres from 'postgres';

// =============================================================================
// Types
// =============================================================================

export interface MediaPreferenceRow {
    media_id: string;
    title: string;
    media_type: string;
    preferred_provider: string | null;
    effective_provider: string | null;
}

export interface AvailableProviderRow {
    provider: string;
    fetched_at: Date;
}

export interface MediaExistsRow {
    id: string;
    title: string;
}

export interface MediaWithProviderRow {
    id: string;
    preferred_provider: string | null;
}

export interface ProviderExistsRow {
    provider: string;
}

export interface MetadataExistsRow {
    provider: string;
}

export interface EffectiveProviderRow {
    effective_provider: string | null;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Get the current provider preference and effective provider for a media item
 * using the v_media_metadata view.
 */
export async function getMediaProviderPreference(
    sql: postgres.Sql,
    internalId: string,
): Promise<MediaPreferenceRow | null> {
    const rows = await sql<MediaPreferenceRow[]>`
        SELECT
            vm.media_id,
            vm.title,
            vm.media_type,
            vm.preferred_provider,
            vm.effective_provider
        FROM v_media_metadata vm
        WHERE vm.media_id = ${internalId}::uuid
    `;
    return rows[0] ?? null;
}

/**
 * Get all available (enabled) providers that have metadata for a media item,
 * ordered by provider capability priority.
 */
export async function getAvailableProviders(
    sql: postgres.Sql,
    internalId: string,
): Promise<AvailableProviderRow[]> {
    return sql<AvailableProviderRow[]>`
        SELECT pm.provider, pm.fetched_at
        FROM provider_metadata pm
        JOIN provider_capabilities pc ON pc.provider = pm.provider
        WHERE pm.media_id = ${internalId}::uuid
          AND pc.enabled = true
        ORDER BY pc.priority
    `;
}

/**
 * Check whether a media item exists and is active.
 * Returns the item's id and title if found.
 */
export async function checkMediaExists(
    sql: postgres.Sql,
    internalId: string,
): Promise<MediaExistsRow | null> {
    const rows = await sql<MediaExistsRow[]>`
        SELECT id, title FROM media_items
        WHERE id = ${internalId}::uuid AND status = 'active'
    `;
    return rows[0] ?? null;
}

/**
 * Check whether a media item exists with its preferred_provider column.
 * Used in the DELETE flow to detect whether an override was set.
 */
export async function checkMediaWithProvider(
    sql: postgres.Sql,
    internalId: string,
): Promise<MediaWithProviderRow | null> {
    const rows = await sql<MediaWithProviderRow[]>`
        SELECT id, preferred_provider FROM media_items
        WHERE id = ${internalId}::uuid AND status = 'active'
    `;
    return rows[0] ?? null;
}

/**
 * Check whether a provider is enabled in provider_capabilities.
 */
export async function checkProviderEnabled(
    sql: postgres.Sql,
    provider: string,
): Promise<ProviderExistsRow | null> {
    const rows = await sql<ProviderExistsRow[]>`
        SELECT provider FROM provider_capabilities
        WHERE provider = ${provider} AND enabled = true
    `;
    return rows[0] ?? null;
}

/**
 * Check whether a provider has metadata stored for a specific media item.
 */
export async function checkProviderHasMetadata(
    sql: postgres.Sql,
    internalId: string,
    provider: string,
): Promise<MetadataExistsRow | null> {
    const rows = await sql<MetadataExistsRow[]>`
        SELECT provider FROM provider_metadata
        WHERE media_id = ${internalId}::uuid AND provider = ${provider}
    `;
    return rows[0] ?? null;
}

/**
 * Set the preferred provider for a media item.
 */
export async function setPreferredProvider(
    sql: postgres.Sql,
    internalId: string,
    provider: string,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET preferred_provider = ${provider}
        WHERE id = ${internalId}::uuid
    `;
}

/**
 * Reset the preferred provider to NULL (default chain).
 */
export async function resetPreferredProvider(sql: postgres.Sql, internalId: string): Promise<void> {
    await sql`
        UPDATE media_items
        SET preferred_provider = NULL
        WHERE id = ${internalId}::uuid
    `;
}

/**
 * Get the effective provider for a media item after resetting preference.
 * Reads from v_media_metadata view.
 */
export async function getEffectiveProvider(
    sql: postgres.Sql,
    internalId: string,
): Promise<EffectiveProviderRow | null> {
    const rows = await sql<EffectiveProviderRow[]>`
        SELECT effective_provider FROM v_media_metadata
        WHERE media_id = ${internalId}::uuid
    `;
    return rows[0] ?? null;
}
