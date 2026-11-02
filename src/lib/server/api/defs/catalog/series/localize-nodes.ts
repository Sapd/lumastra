// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';

/** Preserve the catalog's best-effort per-viewer metadata overlay on previews. */
export async function localizeNodes<
    T extends { id: string; catalogId: string | null; title: string; overview?: string },
>(sql: postgres.Sql, userId: UserId | undefined, nodes: T[]): Promise<void> {
    if (!userId || !config.METADATA_ADDITIONAL_LANGUAGES.length) return;
    try {
        const langs = resolveMetadataLanguage(await getPlaybackPreferences.one(sql, { userId }));
        await applyTranslationOverlay(sql, nodes, langs, {
            id: (node) => node.catalogId,
            setTitle: (node, title) => {
                node.title = title;
            },
            setOverview: (node, overview) => {
                node.overview = overview;
            },
        });
    } catch {
        // Metadata preferences are optional; the primary-language node is complete.
    }
}
