// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { normalizeLanguageTag } from '$lib/shared/metadata-language.js';

/**
 * Route-scoped SSR loader (mirrors settings/devices): metadata language
 * options for the descriptions/titles pickers, computed only when this
 * section is actually viewed. `primary` is config.TMDB_LANGUAGE normalized
 * to its bare language code (e.g. en-US → en) — the canonical "primary"
 * form the playback-preferences PUT handler validates against; `additional`
 * mirrors config.METADATA_ADDITIONAL_LANGUAGES. An empty `additional` list
 * means the multilingual-metadata feature is off — DisplaySection hides
 * both pickers entirely (and skips its preference fetch) in that case.
 */
export const load: PageServerLoad = async () => {
    const primaryBare = config.TMDB_LANGUAGE.split('-')[0];
    return {
        metadataLanguages: {
            primary: normalizeLanguageTag(primaryBare) ?? primaryBare,
            additional: config.METADATA_ADDITIONAL_LANGUAGES,
        },
    };
};
