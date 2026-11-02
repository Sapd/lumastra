// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "could not reach Jellyfin" message shown in the setup wizard and the
 * connection settings. It names the address that was tried and the cause in
 * plain words. The cause comes only from known error codes; the error's own
 * text is never copied, because fetch errors can quote the whole URL (with
 * user:password, ?api_key=, or a percent-encoded key) and other errors can echo
 * tokens. The address never includes userinfo, query string, hash, or a path
 * that carries the API key.
 */

import {
    connectionFailureCause,
    connectionFailureHint,
    urlHasUserinfo,
} from '$lib/server/utils/fetch-error-cause.js';

import * as m from '$lib/paraglide/messages';

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

/**
 * `scheme://host[:port][/path]` with no user:password, query string or hash.
 * The path is dropped when it contains one of the secrets (for example a key
 * placed in the path). Returns undefined when the URL cannot be parsed.
 */
function safeAddress(url: string, secrets: readonly string[]): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.origin === 'null') return undefined;
    const path = parsed.pathname.replace(/\/+$/, '');
    const decodedPath = safeDecode(path);
    const pathHoldsSecret = secrets.some(
        (secret) => secret !== '' && (path.includes(secret) || decodedPath.includes(secret)),
    );
    return `${parsed.origin}${pathHoldsSecret ? '' : path}`;
}

/**
 * Builds the user-facing explanation for a failed connection probe.
 *
 * @param url the Jellyfin base URL that was tried
 * @param err what the probe threw (its text is never copied into the message)
 * @param secrets values that must never appear in the message (the API key)
 */
export function describeJellyfinUnreachable(
    url: string,
    err: unknown,
    secrets: readonly string[] = [],
): string {
    // Our own header builder rejects keys with characters a header cannot carry.
    // Matched by its fixed text, never echoed: the cause is a fixed sentence.
    if (err instanceof Error && err.message === 'Invalid Jellyfin token') {
        return m.setup_jellyfin_invalid_token();
    }
    if (urlHasUserinfo(url)) {
        return m.setup_jellyfin_url_credentials();
    }
    const address = safeAddress(url, secrets);
    if (!address) {
        return m.setup_jellyfin_unreachable({
            address: m.setup_connection_address(),
            cause: m.setup_connection_invalid_url(),
        });
    }
    const cause = connectionFailureCause(err);
    return [m.setup_jellyfin_unreachable({ address, cause }), connectionFailureHint(err, url)]
        .filter(Boolean)
        .join(' ');
}
