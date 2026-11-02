// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser-side scrub for free text that leaves the tab in a diagnostic (error
 * messages, stacks). The server redacts again on ingest; this pass exists so a
 * grant, token or api_key never crosses the network in the first place.
 */

import { stripSecrets } from '$lib/shared/transcode-failure-report.js';

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
/** The query and fragment of any URL or path: search terms, grants and tokens live there. */
const URL_QUERY =
    /((?:[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#'"`()]*)?\/[^\s?#'"`()]*)[?#][^\s'"`()]*/gi;
/** A query string that stands on its own (`?api_key=…` without a path in front). */
const BARE_QUERY = /(^|[\s'"`(])\?[^\s'"`()]+/g;

/** `"grant": "…"` / `token: '…'` — a credential in serialized or logged object form. */
const SECRET_KEY_VALUE =
    /(["']?\b(?:grant|token|access_token|refresh_token|api_?key|stream_token|password|secret)\b["']?\s*[:=]\s*)(["']?)[^\s"',;&}]+\2/gi;
/** A long opaque run (≥ 32 chars, letters and digits) is a token or a key, not prose. */
const OPAQUE = /[A-Za-z0-9_-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Scrubbing runs inside error handlers: cap the input so no regex can stall the tab. */
const INPUT_MAX = 16 * 1024;

export function scrubClientText(text: string, origin?: string): string {
    let out = stripSecrets(text.slice(0, INPUT_MAX))
        .replace(SECRET_KEY_VALUE, '$1$2[redacted]$2')
        .replace(OPAQUE, (run) =>
            UUID.test(run) || !/\d/.test(run) || !/[A-Za-z]/.test(run) ? run : '[token]',
        )
        .replace(BEARER, '$1 [redacted]')
        .replace(URL_QUERY, '$1')
        .replace(BARE_QUERY, '$1?[redacted]')
        .replace(EMAIL, '[email]');
    // The server's own origin is noise in every stack frame.
    if (origin) out = out.split(origin).join('');
    return out;
}
