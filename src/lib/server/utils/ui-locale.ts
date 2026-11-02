// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import {
    baseLocale,
    extractLocaleFromHeader,
    isLocale,
    type Locale,
} from '$lib/paraglide/runtime.js';
import { getRequestLanguageHint } from '$lib/server/utils/request-language-context.js';

/**
 * UI-chrome locale for this request: explicit cookie first, then
 * Accept-Language, then baseLocale.
 *
 * The cookie MUST be validated: compiled Paraglide messages are
 * `if (locale === 'en') return en; return de;`, so ANY unvalidated non-'en'
 * string silently renders German.
 *
 * This mirrors the Paraglide strategy array (cookie → preferredLanguage →
 * baseLocale) on purpose — G2 requires an explicit locale, never ambient.
 *
 * Shared rather than copied. It used to live inside the /feed def, whose own
 * comment warned that a second copy would let chrome fork between surfaces;
 * the audiobooks destination now renders the same server-built section, so it
 * needed the identical answer.
 */
export function resolveUiLocale(event: RequestEvent): Locale {
    // Branches on cookie PRESENCE, never on the cookie's result — mirrors
    // resolveAmbient in metadata-language-resolve.ts. A present-but-
    // unsatisfiable cookie (e.g. an operator-configured FORCE_LOCALE that
    // isn't a Paraglide locale) must stop at baseLocale here rather than
    // falling through to Accept-Language, or metadata and chrome could pick
    // two different languages for the same response.
    const cookie = getRequestLanguageHint()?.cookieLocale;
    if (cookie) return isLocale(cookie) ? cookie : baseLocale;
    return extractLocaleFromHeader(event.request) ?? baseLocale;
}
