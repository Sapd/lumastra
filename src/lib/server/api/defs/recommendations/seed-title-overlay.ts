// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Overlays because-you-watched SEED titles in the viewer's metadata language.
 *
 * A seed title is media metadata, so it follows the metadata language — not the
 * UI locale that renders the surrounding "Because you watched {title}" template.
 * Used by both the /feed section header (feed-byw-sections.ts) and the
 * per-item reason.label (because-you-watched.strategy.ts) so the two agree.
 *
 * `textLang: null` is deliberate: the overlay fetches one map per distinct
 * non-null language, and only `setTitle` is supplied here — passing the
 * viewer's full langs would issue a second lookup no setter consumes.
 *
 * The `titleLang` gate is REQUIRED, not redundant: the overlay's internal guard
 * is `(!titleLang && !textLang)`, so a viewer with only `textLang` set would
 * still trigger a query this call has nothing to apply.
 *
 * Mutates in place. Seed rows come from fresh per-request queries
 * (because-you-watched.strategy.ts:98-109, :150-160), so that is safe today —
 * if seed sourcing ever gains a cache, clone before calling.
 */

import type postgres from 'postgres';
import type { ResolvedMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';

export interface OverlayableSeed {
    id: string;
    title: string;
}

export async function overlaySeedTitles(
    sql: postgres.Sql | null | undefined,
    seeds: OverlayableSeed[],
    langs: ResolvedMetadataLanguages | null | undefined,
): Promise<void> {
    if (!sql || !langs?.titleLang || seeds.length === 0) return;

    const { applyTranslationOverlay } = await import('$lib/server/utils/translation-overlay.js');
    await applyTranslationOverlay(
        sql,
        seeds,
        { titleLang: langs.titleLang, textLang: null },
        {
            id: (seed) => seed.id,
            setTitle: (seed, value) => {
                seed.title = value;
            },
        },
    );
}
