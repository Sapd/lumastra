// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared metadata-language overlay for the flat hero / Continue-Watching item
 * shape (`{ id, title, overview, … }`) emitted by `nextUpRowToMediaItem` /
 * `continueWatchingRowToMediaItem`. Swaps in the viewer's preferred-language
 * title/overview, keyed on each item's own media_id — the SAME overlay the
 * media modal (`catalog/media-id.ts`) applies — so the home hero + Continue
 * Watching carousel don't paint original-language titles to a viewer who
 * selected another language.
 *
 * Two passes: the item's own title/overview keyed by its media_id, then the
 * parent-series `seriesName` keyed by the SERIES id. The second pass matters
 * because the hero H1 is `seriesName ?? title` for episodes — translating only
 * the first leaves a mixed-language hero.
 *
 * Used by BOTH the `/api/recommendations` hero paths and the Next Up cache
 * warmer so a warmed entry and a live-built entry are byte-identical for the
 * same viewer language.
 */

import type postgres from 'postgres';
import type { ResolvedMetadataLanguages } from './metadata-language-resolve.js';
import { Logger } from './logger.js';

const logger = Logger.for('HeroItemTranslation');

/**
 * Language-key token appended to the per-user Next Up cache key so one
 * language's overlay is never served to another (empty when no overlay
 * applies, keeping feature-off / primary-language keys unchanged).
 */
export function heroLangCacheToken(langs: ResolvedMetadataLanguages): string {
    return langs.titleLang || langs.textLang
        ? `:l:${langs.titleLang ?? ''}.${langs.textLang ?? ''}`
        : '';
}

/**
 * Overlay `items` in place. No-op (zero queries) when no non-primary language
 * resolves or the list is empty. The item's media_id is read from a top-level
 * `id` field, falling back to `externalIds.internal` (the discovery/quality
 * library rows carry only the latter). Non-UUID ids are skipped; a failed
 * lookup — or even a failed dynamic import — leaves items on the
 * primary-language copy. NEVER throws: safe to call unguarded on request paths.
 */
export async function overlayHeroMediaItems(
    sql: postgres.Sql,
    items: Record<string, unknown>[],
    langs: ResolvedMetadataLanguages,
): Promise<void> {
    if ((!langs.titleLang && !langs.textLang) || items.length === 0) return;
    try {
        const [{ applyTranslationOverlay }, { UUID_RE }] = await Promise.all([
            import('./translation-overlay.js'),
            import('../../utils/id-patterns.js'),
        ]);
        await applyTranslationOverlay(sql, items, langs, {
            id: (it) => {
                const direct = typeof it.id === 'string' ? it.id : undefined;
                const ext =
                    it.externalIds && typeof it.externalIds === 'object'
                        ? (it.externalIds as Record<string, unknown>).internal
                        : undefined;
                const id = direct ?? (typeof ext === 'string' ? ext : undefined);
                return id && UUID_RE.test(id) ? id : null;
            },
            setTitle: (it, v) => {
                it.title = v;
            },
            setOverview: (it, v) => {
                it.overview = v;
            },
        });

        // Pass 2 — the parent-series NAME on episode items. `seriesName` is the
        // SERIES' title, a media_items row of its own, so it must be translated
        // from the series id, NOT the episode id pass 1 used. Without this the
        // home hero paints an untranslated H1 (hero-first-slide renders
        // `seriesName ?? title` as the headline) above a translated subtitle.
        // Mirrors the pass-2 already done for /api/v1 continue-watching.
        //
        // The series id lives under DIFFERENT keys in the two item shapes this
        // helper serves: `seriesInternalId` in the API mappers (whose `seriesId`
        // is the JELLYFIN id, used for image lookups) and `seriesId` in the SSR
        // ContinueWatchingItem shape (where it IS the internal UUID). The UUID
        // guard picks the right one without the caller having to know which, and
        // drops Jellyfin ids rather than issuing a lookup that cannot match.
        // Only setTitle is wired: the series' own overview must never overwrite
        // the episode synopsis.
        await applyTranslationOverlay(sql, items, langs, {
            id: (it) => {
                for (const key of ['seriesInternalId', 'seriesId']) {
                    const v = it[key];
                    if (typeof v === 'string' && UUID_RE.test(v)) return v;
                }
                return null;
            },
            setTitle: (it, v) => {
                it.seriesName = v;
            },
        });
    } catch (error) {
        logger.debug('Hero item translation overlay failed; serving primary language', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
