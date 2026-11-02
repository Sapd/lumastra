// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read-path translation overlay: swaps a per-item title/overview/tagline
 * for the resolved title/text languages (see `resolveMetadataLanguage`) via
 * caller-provided setters. Batches at most 2 `getTranslationMapForItems`
 * calls total — one per distinct non-null language — regardless of item
 * count. Translation is best-effort: a failed lookup is caught and logged,
 * never thrown, so a broken overlay can never 500 an endpoint.
 */

import {
    getTranslationMapForItems,
    type MediaTranslationFields,
} from '$lib/server/database/queries/media-translations.queries.js';
import type postgres from 'postgres';

import { Logger } from './logger.js';

const logger = Logger.for('TranslationOverlay');

/** Resolved overlay languages — `null` means "primary; skip that field". */
export interface TranslationOverlayLanguages {
    titleLang: string | null;
    textLang: string | null;
}

export interface TranslationOverlayOptions<T> {
    /** Extracts the media_items.id (uuid) to look up; null/undefined → item is left untouched. */
    id: (item: T) => string | null | undefined;
    setTitle?: (item: T, value: string) => void;
    setOverview?: (item: T, value: string) => void;
    setTagline?: (item: T, value: string) => void;
}

function isNonEmpty(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

/**
 * Overlays translated title/overview/tagline onto `items` in place via the
 * provided setters. No-ops (zero queries) when both languages are null or
 * `items` is empty. Items whose `id` accessor returns null/undefined are
 * left untouched; a failed translation lookup leaves ALL items untouched
 * rather than partially applying.
 */
export async function applyTranslationOverlay<T>(
    sql: postgres.Sql,
    items: T[],
    langs: TranslationOverlayLanguages,
    opts: TranslationOverlayOptions<T>,
): Promise<void> {
    const { titleLang, textLang } = langs;
    if (items.length === 0 || (!titleLang && !textLang)) return;

    const ids = [...new Set(items.map((item) => opts.id(item)).filter((id): id is string => !!id))];
    if (ids.length === 0) return;

    // Dedupe when titleLang === textLang so we never issue the same lookup twice.
    const distinctLangs = [...new Set([titleLang, textLang].filter((l): l is string => !!l))];

    let maps: Map<string, MediaTranslationFields>[];
    try {
        maps = await Promise.all(
            distinctLangs.map((lang) => getTranslationMapForItems(sql, ids, lang)),
        );
    } catch (err) {
        logger.warn('Translation overlay lookup failed; serving primary-language fields', {
            langs: distinctLangs,
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    const byLang = new Map(distinctLangs.map((lang, i) => [lang, maps[i]]));
    const titleMap = titleLang ? byLang.get(titleLang) : undefined;
    const textMap = textLang ? byLang.get(textLang) : undefined;
    if (!titleMap && !textMap) return;

    for (const item of items) {
        const id = opts.id(item);
        if (!id) continue;

        if (titleMap && opts.setTitle) {
            const title = titleMap.get(id)?.title;
            if (isNonEmpty(title)) opts.setTitle(item, title);
        }
        if (textMap) {
            const row = textMap.get(id);
            if (opts.setOverview && isNonEmpty(row?.overview)) opts.setOverview(item, row.overview);
            if (opts.setTagline && isNonEmpty(row?.tagline)) opts.setTagline(item, row.tagline);
        }
    }
}
