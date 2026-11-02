// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface ProviderData {
    provider: string;
    data: Record<string, unknown>;
}

export interface MergeOptions {
    isAnime?: boolean;
    mediaType?: string;
}

export interface MergeResult {
    merged: Record<string, unknown>;
    fieldSources: Record<string, string>;
}

export interface FieldAuthorityConfig {
    /** Default field → provider priority order (first = highest priority) */
    defaultPriorities: Record<string, readonly string[]>;
    /** Admin overrides from DB (takes precedence over defaults) */
    adminOverrides?: Record<string, readonly string[]>;
    /** Anime-specific overrides */
    animeOverrides?: Record<string, readonly string[]>;
}

export class FieldAuthorityResolver {
    constructor(private readonly config: FieldAuthorityConfig) {}

    /**
     * Merge data from multiple providers using field authority priorities.
     * For each field, the highest-priority provider with a non-null value wins.
     */
    merge(providers: ProviderData[], options?: MergeOptions): MergeResult {
        const merged: Record<string, unknown> = {};
        const fieldSources: Record<string, string> = {};

        // Collect all fields across all providers
        const allFields = new Set<string>();
        for (const { data } of providers) {
            for (const key of Object.keys(data)) {
                allFields.add(key);
            }
        }

        for (const field of allFields) {
            const priority = this.getFieldPriority(field, options);

            // Sort providers by priority for this field
            const sorted = [...providers].sort((a, b) => {
                const aIdx = priority.indexOf(a.provider);
                const bIdx = priority.indexOf(b.provider);
                // Providers not in priority list go last, in original order
                if (aIdx === -1 && bIdx === -1) return 0;
                if (aIdx === -1) return 1;
                if (bIdx === -1) return -1;
                return aIdx - bIdx;
            });

            // First provider with a non-null/undefined value wins
            for (const { provider, data } of sorted) {
                const value = data[field];
                if (value != null) {
                    merged[field] = value;
                    fieldSources[field] = provider;
                    break;
                }
            }
        }

        return { merged, fieldSources };
    }

    /**
     * Get the priority order for a field, considering overrides.
     * Admin overrides > anime overrides (if applicable) > defaults.
     */
    private getFieldPriority(field: string, options?: MergeOptions): readonly string[] {
        // Admin overrides take highest precedence
        if (this.config.adminOverrides?.[field]) {
            return this.config.adminOverrides[field];
        }

        // Anime overrides if applicable
        if (options?.isAnime && this.config.animeOverrides?.[field]) {
            return this.config.animeOverrides[field];
        }

        // Default priorities
        return this.config.defaultPriorities[field] ?? [];
    }
}
