// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Append an upstream endpoint to an operator-configured server URL. A leading
 * slash is relative to that server's base path, never to its origin. Normalize
 * path separators only: query values and encoded path segments stay intact.
 * Callers must still encode individual untrusted IDs with encodePathSegment.
 */
export function joinUpstreamUrl(base: string, endpoint: string): string {
    const trimmedBase = base.trim();
    // Public browser links may be root-relative. The parsing origin is never
    // returned or contacted; server-to-upstream requests use absolute bases.
    const rootRelative = /^\/(?![/\\])/.test(trimmedBase);
    const url = rootRelative ? new URL(trimmedBase, 'http://localhost') : new URL(trimmedBase);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Upstream URL must use http or https');
    }
    const hashAt = endpoint.indexOf('#');
    const hash = hashAt < 0 ? '' : endpoint.slice(hashAt);
    endpoint = hashAt < 0 ? endpoint : endpoint.slice(0, hashAt);
    const queryAt = endpoint.indexOf('?');
    const path = queryAt < 0 ? endpoint : endpoint.slice(0, queryAt);
    // WHATWG parsing turns backslashes into slashes and strips some controls.
    // Reject these before checking dot segments so pathname's setter cannot
    // resolve disguised traversal and erase the reverse-proxy prefix.
    if (
        /[\\\p{Cc}]/u.test(path) ||
        path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
    ) {
        throw new Error('Invalid upstream endpoint path');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(
        /\/{2,}/g,
        '/',
    );
    if (!path) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (queryAt >= 0) {
        const query = endpoint.slice(queryAt + 1);
        if (query) url.search = url.search ? `${url.search}&${query}` : `?${query}`;
    }
    url.hash = hash;
    return rootRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

/** Render-time links must disappear on invalid configuration, never break a page. */
export function tryJoinUpstreamUrl(base: string, endpoint: string): string | null {
    try {
        return joinUpstreamUrl(base, endpoint);
    } catch {
        return null;
    }
}
