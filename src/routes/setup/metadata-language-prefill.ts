// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prefill logic for the setup wizard's "Primary metadata language" field.
 *
 * Lives in a non-`+` sibling module (SvelteKit reserves `+` route files'
 * exports) so the resume-path behavior can be unit-tested: a resumed wizard
 * (admin exists, no library yet — e.g. after the OIDC round-trip) must show
 * the PREVIOUSLY SAVED TMDB_LANGUAGE, not re-derive a browser-locale guess
 * that would silently overwrite the saved value on Finish/Skip.
 */

import { REGION_PREFERENCE } from '$lib/shared/metadata-language';

/**
 * Resolves the initial value for the wizard's primary-metadata-language input.
 *
 * @param configured The currently-configured TMDB_LANGUAGE, or null when it is
 *   genuinely unset (equal to the schema default — `saveConfig` drops
 *   default-equal keys from settings.json, so "explicitly set to the default"
 *   is unrepresentable in persisted state; the server load() maps that case to
 *   null).
 * @param locale The wizard's current UI locale (paraglide `getLocale()`).
 * @returns The configured value verbatim when set; otherwise a locale-derived
 *   guess (`de` → `de-DE`, `en` → `en-US` via the shared REGION_PREFERENCE
 *   map, falling back to `-US` for unmapped locales).
 */
export function resolveTmdbLanguagePrefill(configured: string | null, locale: string): string {
    if (configured && configured.trim().length > 0) return configured;
    return `${locale}-${REGION_PREFERENCE[locale] ?? 'US'}`;
}
