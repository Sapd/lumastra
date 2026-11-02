// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure OIDC claim parsing — no network, no DB, no openid-client import, so the
 * security-relevant decisions (verified-email flag, group extraction, username
 * derivation) are trivially unit-testable in isolation.
 */

import { isReservedUsername } from './reserved-usernames.js';

/** The normalized identity we extract from a verified ID token / userinfo. */
export interface OidcClaims {
    /** Issuer (`iss`). */
    issuer: string;
    /** Stable subject (`sub`). */
    subject: string;
    /** Email, if present. */
    email: string | null;
    /** Whether the IdP attests the email as verified (STRICT — drives linking). */
    emailVerified: boolean;
    /** preferred_username, if present. */
    preferredUsername: string | null;
    /** Display name (`name`), if present. */
    name: string | null;
    /** Group/role membership extracted from the configured claim. */
    groups: string[];
    /**
     * Profile picture (`picture`), unvalidated: a URL or a `data:` URI as the IdP
     * sent it. Only idp-avatar-sync.service.ts reads it, and it does its own
     * checks. Optional so hand-built claims in tests need not set it.
     */
    picture?: string | null;
}

/** Username shape accepted by the local users table (mirrors native-auth). */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

/**
 * Strict interpretation of an `email_verified` claim. Only an explicit boolean
 * `true` (or its stringified `"true"`, which some non-conformant IdPs send) counts
 * as verified; everything else — false, "false", undefined, null, a number — is
 * treated as UNVERIFIED. This is the load-bearing half of the account-takeover
 * guard, so it fails closed.
 */
export function parseEmailVerified(value: unknown): boolean {
    return value === true || value === 'true';
}

/**
 * Resolve a possibly-nested claim by dot path (e.g. `realm_access.roles`). The
 * terminal node must itself be the array/string of groups; an ARRAY intermediate
 * yields undefined (we don't index into array elements), so a path that traverses
 * through an array returns no groups. The OIDC service warns when a nested path
 * resolves to empty so this misconfiguration isn't silent.
 */
function getClaimByPath(claims: Record<string, unknown>, path: string): unknown {
    if (!path.includes('.')) return claims[path];
    let cur: unknown = claims;
    for (const segment of path.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
}

/**
 * Extract a group list from the configured claim. Accepts an array of strings (the
 * common shape: Authentik `groups`, Keycloak `realm_access.roles`, Entra `roles`)
 * or a single delimited string (comma/space separated). Anything else → empty.
 * Values are trimmed; empties dropped. Case is preserved (downstream group
 * matching is case-insensitive).
 */
export function extractGroups(claims: Record<string, unknown>, claimPath: string): string[] {
    const raw = getClaimByPath(claims, claimPath);
    if (Array.isArray(raw)) {
        return raw
            .filter((g): g is string => typeof g === 'string')
            .map((g) => g.trim())
            .filter((g) => g.length > 0);
    }
    if (typeof raw === 'string') {
        return raw
            .split(/[,\s]+/)
            .map((g) => g.trim())
            .filter((g) => g.length > 0);
    }
    return [];
}

/**
 * Normalize an arbitrary string into a valid local username, or null if nothing
 * salvageable remains. Lowercases, maps disallowed characters to `-`, strips
 * leading/trailing punctuation, collapses repeats, and truncates to 63 chars.
 *
 * A name reserved for an internal actor (see `reserved-usernames.ts`) is
 * treated as unsalvageable too: an IdP asserting `preferred_username: 'system'`
 * must never mint the local account of the same name, so this returns null and
 * the caller falls through to its next candidate / generic fallback.
 */
export function normalizeUsername(raw: string): string | null {
    if (typeof raw !== 'string') return null;
    let s = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-') // disallowed → dash
        .replace(/-{2,}/g, '-') // collapse dash runs
        .replace(/^[._-]+/, '') // strip leading punctuation (regex needs alnum first)
        .replace(/[._-]+$/, ''); // strip trailing punctuation (tidy)
    if (s.length > 63) s = s.slice(0, 63).replace(/[._-]+$/, '');
    if (!USERNAME_RE.test(s) || isReservedUsername(s)) return null;
    return s;
}

/**
 * The username explicitly signalled by the claims — normalized `preferred_username`,
 * else the normalized local-part of `email`, else null. Unlike {@link deriveBaseUsername}
 * this has NO generic fallback, so link-by-username never matches a literal "user"
 * account when the token carries no real username signal.
 */
export function deriveUsernameCandidate(claims: OidcClaims): string | null {
    for (const candidate of [claims.preferredUsername, claims.email?.split('@')[0] ?? null]) {
        if (!candidate) continue;
        const normalized = normalizeUsername(candidate);
        if (normalized) return normalized;
    }
    return null;
}

/**
 * Derive a stable base username from the claims, preferring `preferred_username`,
 * then the local-part of `email`, then a safe constant. Always returns a valid
 * username; the caller collision-suffixes if it is already taken.
 */
export function deriveBaseUsername(claims: OidcClaims): string {
    return deriveUsernameCandidate(claims) ?? 'user';
}

/**
 * Parse a verified claims object (ID token merged with optional userinfo) into our
 * normalized {@link OidcClaims}. Throws nothing — callers validate `subject`/`issuer`.
 */
export function parseClaims(claims: Record<string, unknown>, groupsClaimPath: string): OidcClaims {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    return {
        issuer: str(claims.iss) ?? '',
        subject: str(claims.sub) ?? '',
        email: str(claims.email),
        emailVerified: parseEmailVerified(claims.email_verified),
        preferredUsername: str(claims.preferred_username),
        name: str(claims.name),
        groups: extractGroups(claims, groupsClaimPath),
        picture: str(claims.picture),
    };
}
