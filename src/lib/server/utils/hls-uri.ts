// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Credentials may only travel to relative children or this origin's API. */
export function withHlsParams(uri: string, params: URLSearchParams, origin?: string): string {
    if (uri.includes('\\')) return uri;
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(uri.trim()) || uri.trim().startsWith('//');
    try {
        const base = new URL(origin ?? 'https://hls.invalid');
        const child = new URL(uri, base);
        if (child.origin !== base.origin || !['http:', 'https:'].includes(child.protocol))
            return uri;
        if (absolute && (!origin || !child.pathname.includes('/api/'))) return uri;
    } catch {
        return uri;
    }
    if (!params.size) return uri;
    const hashIndex = uri.indexOf('#');
    const fragment = hashIndex < 0 ? '' : uri.slice(hashIndex);
    const target = hashIndex < 0 ? uri : uri.slice(0, hashIndex);
    const queryIndex = target.indexOf('?');
    const path = queryIndex < 0 ? target : target.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex < 0 ? '' : target.slice(queryIndex + 1));
    for (const [key, value] of params) query.set(key, value);
    return `${path}?${query.toString()}${fragment}`;
}
