// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Captures the raw per-request language signals for the metadata overlay.
 *
 * FORCE_LOCALE is read from config rather than from the cookie jar because
 * `paraglideHandle` injects it by REWRITING `event.request` (hooks.server.ts),
 * while `event.cookies` was parsed from the original request — so a
 * cookie-only read would miss it entirely.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import type { RequestLanguageHint } from '$lib/server/utils/request-language-context.js';

/** Paraglide's locale cookie name. Kept as a literal — we read it, we never write it. */
const PARAGLIDE_LOCALE_COOKIE = 'PARAGLIDE_LOCALE';

export function buildRequestLanguageHint(event: RequestEvent): RequestLanguageHint {
    return {
        // `||`, NOT `??`: config.FORCE_LOCALE defaults to '' (not nullish), so `??`
        // would make the cookie read dead code and silently discard every explicit
        // language choice in favour of the ambient header. The existing
        // paraglideHandle guards this same getter with `if (config.FORCE_LOCALE)`.
        cookieLocale: config.FORCE_LOCALE || event.cookies.get(PARAGLIDE_LOCALE_COOKIE) || null,
        acceptLanguage: event.request.headers.get('accept-language'),
    };
}
