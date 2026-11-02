// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Opaque base used to confine a candidate redirect to its own origin. */
const CONFINEMENT_BASE = 'https://redirect.invalid';

/** ASCII control characters (incl. TAB/LF/CR) + DEL — browsers strip these. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Sanitize a post-login redirect target to a SAME-SITE absolute path, defeating
 * open-redirect abuse. Only a path that begins with a single `/`, carries no
 * control characters, and resolves to the SAME origin is accepted; anything else
 * falls back to `fallback`. On success the original (unmodified) path is returned.
 *
 * Hardened against the scheme-relative class (cf. the Audiobookshelf token-leak
 * advisory where `//attacker.example` was accepted as "relative"):
 *   - reject control characters (TAB/LF/CR/…) that browsers strip from URLs —
 *     `"/\t/evil"` would otherwise collapse to scheme-relative `"//evil"`;
 *   - reject `//host` and `/\host` protocol-relative escapes explicitly;
 *   - ORIGIN-CONFINEMENT: resolve the candidate against an opaque base and require
 *     the result to stay on that origin, catching encoding/backslash edge cases the
 *     prefix checks alone might miss.
 *
 * Independently, our auth flows never place tokens in the redirect URL — the
 * session is an HttpOnly, origin-scoped cookie — so even a regression here cannot
 * leak credentials cross-origin, only phish.
 */
export function sanitizeRedirect(target: string | null | undefined, fallback = '/'): string {
    if (!target) return fallback;
    if (CONTROL_CHARS.test(target)) return fallback;
    // Must be an absolute path on this origin.
    if (!target.startsWith('/')) return fallback;
    // Reject protocol-relative ("//evil.com") and backslash variants ("/\evil").
    if (target.startsWith('//') || target.startsWith('/\\')) return fallback;
    // Reject anything that parses as having a scheme/host (defensive).
    if (/^\/[^/]*:/.test(target)) return fallback;
    // Origin-confinement: the candidate must resolve back onto the opaque base
    // origin; any host-bearing / protocol-relative form (however encoded) escapes
    // it and is rejected.
    try {
        if (new URL(target, CONFINEMENT_BASE).origin !== CONFINEMENT_BASE) return fallback;
    } catch {
        return fallback;
    }
    // Never bounce back into the auth surface itself.
    if (target === '/login' || target.startsWith('/login?') || target === '/setup') {
        return fallback;
    }
    return target;
}
