// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Capabilities Query Module
 *
 * Pure SQL queries for provider configuration management:
 * - Provider capabilities CRUD
 * - Field authority lookups
 * - Provider seeding from config
 *
 * @module queries/provider-capabilities
 */

import type postgres from 'postgres';

// =============================================================================
// Type Definitions
// =============================================================================

export interface ProviderCapabilityRow {
    provider: string;
    priority: number;
    enabled: boolean;
    capabilities: Record<string, boolean>;
    config: Record<string, unknown>;
    category: string;
    created_at: string;
    updated_at: string;
}

export interface FieldAuthorityRow {
    id: string;
    field_name: string;
    provider: string;
    priority: number;
    media_type: string | null;
    is_anime: boolean | null;
    created_at: string;
    updated_at: string;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get all providers ordered by priority (lower = higher priority).
 */
export async function getAllProviderCapabilities(
    sql: postgres.Sql,
): Promise<ProviderCapabilityRow[]> {
    const rows = await sql<ProviderCapabilityRow[]>`
        SELECT
            provider,
            priority,
            enabled,
            capabilities,
            config,
            category,
            created_at::text,
            updated_at::text
        FROM provider_capabilities
        ORDER BY priority ASC, provider ASC
    `;
    return rows;
}

/**
 * Get all field authorities ordered by field name and priority.
 */
export async function getFieldAuthorities(sql: postgres.Sql): Promise<FieldAuthorityRow[]> {
    const rows = await sql<FieldAuthorityRow[]>`
        SELECT
            id::text,
            field_name,
            provider,
            priority,
            media_type,
            is_anime,
            created_at::text,
            updated_at::text
        FROM provider_field_authorities
        ORDER BY field_name ASC, priority ASC
    `;
    return rows;
}

/**
 * Toggle provider enabled/disabled state.
 */
export async function setProviderEnabled(
    sql: postgres.Sql,
    provider: string,
    enabled: boolean,
): Promise<void> {
    await sql`
        UPDATE provider_capabilities
        SET enabled = ${enabled}, updated_at = NOW()
        WHERE provider = ${provider}
    `;
}

/**
 * Update provider priority.
 */
export async function setProviderPriority(
    sql: postgres.Sql,
    provider: string,
    priority: number,
): Promise<void> {
    await sql`
        UPDATE provider_capabilities
        SET priority = ${priority}, updated_at = NOW()
        WHERE provider = ${provider}
    `;
}

/**
 * Insert a provider capability row if it doesn't exist.
 * Used for seeding providers from config on first load.
 * Does NOT update existing rows — admin-configured values are preserved.
 */
export async function upsertProviderCapability(
    sql: postgres.Sql,
    provider: string,
    priority: number,
    enabled: boolean,
    capabilities: Record<string, boolean>,
    category?: string,
): Promise<void> {
    if (category) {
        await sql`
            INSERT INTO provider_capabilities (provider, priority, enabled, capabilities, category, created_at, updated_at)
            VALUES (${provider}, ${priority}, ${enabled}, ${sql.json(capabilities)}, ${category}, NOW(), NOW())
            ON CONFLICT (provider) DO NOTHING
        `;
    } else {
        await sql`
            INSERT INTO provider_capabilities (provider, priority, enabled, capabilities, created_at, updated_at)
            VALUES (${provider}, ${priority}, ${enabled}, ${sql.json(capabilities)}, NOW(), NOW())
            ON CONFLICT (provider) DO NOTHING
        `;
    }
}

/**
 * Get a single provider capability row.
 */
export async function getProviderCapability(
    sql: postgres.Sql,
    provider: string,
): Promise<ProviderCapabilityRow | undefined> {
    const rows = await sql<ProviderCapabilityRow[]>`
        SELECT
            provider,
            priority,
            enabled,
            capabilities,
            config,
            category,
            created_at::text,
            updated_at::text
        FROM provider_capabilities
        WHERE provider = ${provider}
    `;
    return rows[0];
}
