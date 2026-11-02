// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure collector: extracts per-language display translations
 * (title/overview/tagline) out of a raw TMDB `details` payload
 * (`append_to_response=translations`) for the admin's configured extra
 * languages. Zero extra API calls — reuses data already fetched for the
 * primary sync.
 *
 * Shared by both write paths: the single-item resync
 * (`metadata-sync-single.service.ts`) and the discovery bulk sync
 * (`ai/tmdb-metadata-sync.ts`). Defensive parsing mirrors
 * `collectTmdbTranslationTitles` in `ai/tmdb-metadata-sync.ts:77-114` —
 * `details` is `unknown` because it comes straight off an external API
 * response.
 */

import type { MediaTranslationInput } from '$lib/server/database/queries/media-translations.queries.js';
import { pickTranslationEntry } from '$lib/shared/metadata-language.js';

interface TmdbTranslationEntry {
    iso_639_1?: string;
    iso_3166_1?: string;
    data?: {
        title?: string;
        name?: string;
        overview?: string;
        tagline?: string;
    };
}

/**
 * For each requested (already-normalized) language tag, picks the
 * deterministic variant via `pickTranslationEntry` and maps it to a
 * `MediaTranslationInput`. Languages with no matching entry are skipped
 * (not emitted as null rows) — `upsertMediaTranslations` never sees them.
 */
export function collectTmdbTranslations(
    details: unknown,
    languages: string[],
): MediaTranslationInput[] {
    if (languages.length === 0) return [];

    const raw = (details ?? {}) as Record<string, unknown>;
    const translationsRaw = raw['translations'];
    const entries: TmdbTranslationEntry[] =
        translationsRaw &&
        typeof translationsRaw === 'object' &&
        Array.isArray((translationsRaw as { translations?: unknown }).translations)
            ? (translationsRaw as { translations: TmdbTranslationEntry[] }).translations
            : [];

    if (entries.length === 0) return [];

    const out: MediaTranslationInput[] = [];
    for (const language of languages) {
        const entry = pickTranslationEntry(entries, language);
        if (!entry) continue;
        const title = entry.data?.title ?? entry.data?.name ?? null;
        const overview = entry.data?.overview ?? null;
        const tagline = entry.data?.tagline ?? null;
        out.push({ language, title, overview, tagline });
    }
    return out;
}
