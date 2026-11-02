// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Per-user metadata-language overlay for the /j (Jellyfin-compat) surface.
 * Reuses the same resolution chain and overlay mechanics `/api/v1` already
 * applies (stored pref → PARAGLIDE_LOCALE cookie → Accept-Language header →
 * primary) so third-party Jellyfin clients (Void Player, Jellyfin
 * Android/TV, ...) see the same localized title/overview the native web app
 * renders, instead of always the server's primary metadata language.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { resolveViewerMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import type { MediaItemForSerialization } from './serializers/base-item';

/**
 * Overlays translated title/overview/tagline onto `items` in place — call
 * ONCE per request with the full batch of mapped items (post-
 * `mapRowToMediaItem`, pre-`serializeBaseItem`/`serializeBaseItems`), never
 * per item, so the underlying translation lookup batches to at most 2 DB
 * calls regardless of item count (see `applyTranslationOverlay`).
 *
 * No-ops (zero queries) when the viewer has no admin-enabled non-primary
 * language resolved — see `resolveViewerMetadataLanguages` for the full
 * chain and its own zero-query fast path.
 */
export async function applyJellyfinContentLanguage(
    sql: postgres.Sql,
    userId: UserId | null | undefined,
    items: MediaItemForSerialization[],
): Promise<void> {
    const langs = await resolveViewerMetadataLanguages(sql, userId);
    if (!langs.titleLang && !langs.textLang) return;

    await applyTranslationOverlay(sql, items, langs, {
        id: (item) => item.id,
        setTitle: (item, value) => {
            item.title = value;
        },
        setOverview: (item, value) => {
            item.overview = value;
        },
        setTagline: (item, value) => {
            item.tagline = value;
        },
    });
}
