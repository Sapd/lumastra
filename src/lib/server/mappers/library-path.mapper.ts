// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    LibraryPathProvider,
    LibraryPathRow,
} from '$lib/server/database/queries/library-paths.queries.js';

export interface ApiLibraryPath {
    id: string;
    path: string;
    mediaType: string;
    language: string;
    provider: string;
    enabled: boolean;
    providerPath?: string;
    libraryGroupId: string;
    editionLabel?: string;
    scanChapters: boolean;
    fallbackProviders: LibraryPathProvider[];
    sourcePrefix?: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * Map a library_paths DB row to API response shape (snake_case -> camelCase).
 */
export function mapLibraryPathToApi(row: LibraryPathRow): ApiLibraryPath {
    return {
        id: row.id,
        path: row.path,
        mediaType: row.media_type,
        language: row.language,
        provider: row.provider,
        enabled: row.enabled,
        providerPath: row.provider_path ?? undefined,
        libraryGroupId: row.library_group_id,
        editionLabel: row.edition_label ?? undefined,
        scanChapters: row.scan_chapters,
        fallbackProviders: row.fallback_providers ?? [],
        sourcePrefix: row.source_prefix,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
