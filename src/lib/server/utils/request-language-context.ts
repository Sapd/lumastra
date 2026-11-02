// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-scoped language signals for the metadata translation overlay.
 *
 * ~30 call sites resolve the overlay language synchronously via
 * `resolveMetadataLanguage(prefs)`, deep inside handlers that never see the
 * Request. They already read request-scoped ambient state (Paraglide's own
 * AsyncLocalStorage, via `getLocale()`); this module carries the RAW signals
 * so the metadata path can negotiate them against the admin-enabled metadata
 * set instead of the UI locale set.
 *
 * Raw on purpose: negotiation needs `config`, and the hook that populates this
 * must stay free of config reads. AsyncLocalStorage propagates across awaits
 * and keeps concurrent requests isolated. Outside a scope the getter returns
 * null and callers fall back to legacy behavior — which is what background
 * tasks (cache warming, schedulers) get.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestLanguageHint {
    /** Raw `PARAGLIDE_LOCALE` cookie value (or FORCE_LOCALE), unvalidated. */
    cookieLocale: string | null;
    /** Raw `Accept-Language` header value, unparsed. */
    acceptLanguage: string | null;
}

const storage = new AsyncLocalStorage<RequestLanguageHint>();

/** Run `fn` with `hint` bound to the current async context. */
export function runWithRequestLanguage<T>(hint: RequestLanguageHint, fn: () => T): T {
    return storage.run(hint, fn);
}

/** The active request's language signals, or null outside a request. */
export function getRequestLanguageHint(): RequestLanguageHint | null {
    return storage.getStore() ?? null;
}

/**
 * Runs `fn` with NO request language hint, even when called inside a request.
 *
 * Background passes that act on behalf of OTHER users (cache warming iterates
 * every active user) must not inherit the triggering request's language, or
 * they resolve every pref-less user's language from the caller's headers.
 * AsyncLocalStorage.exit() detaches the current store for the duration.
 */
export function escapeRequestLanguage<T>(fn: () => T): T {
    return storage.exit(fn);
}
