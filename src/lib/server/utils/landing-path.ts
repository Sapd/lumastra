// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether `path` is a safe app-relative redirect target for the root route.
 * Rejects the self-loop '/', protocol-relative '//', scheme URLs, backslashes,
 * percent-escapes, whitespace, and control characters (open-redirect defenses).
 */
export function isValidLandingPath(path: string | null | undefined): boolean {
    if (!path || typeof path !== 'string') return false;
    if (path === '/') return false; // self-redirect loop
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false; // scheme (javascript:, http:)
    if (!path.startsWith('/')) return false;
    if (path.startsWith('//')) return false; // protocol-relative
    // eslint-disable-next-line no-control-regex
    if (/[\s\\%\x00-\x1f\x7f]/.test(path)) return false; // whitespace, backslash, %, control chars, DEL
    return true;
}
