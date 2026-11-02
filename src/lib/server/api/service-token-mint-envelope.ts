// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * No-escalation rule for a service token minted BY another service token.
 *
 * The child is owned by the minter's owner (`created_by`, a real user), so
 * without this check a narrowly scoped minter could mint a child that acts as
 * the owner with none of the minter's restrictions. `denyUnlessMayMint()`
 * (token-minting.ts) still runs for every caller; this adds the per-token
 * envelope a user-session caller does not have.
 *
 * The SQL twin of this rule is the repair in migration 16.286.0 — keep them in
 * step.
 */

import { callerHolds } from '$lib/server/api/token-minting.js';
import { normalizeIp } from '$lib/server/oauth/ip-literal.js';

/** The minting service token, as read from `service_tokens`. */
export interface MinterEnvelope {
    id: number;
    name: string;
    createdBy: string;
    /** `service_tokens.owner_user_id`; the child inherits it. */
    ownerUserId: string | null;
    /** `users.id` the minter impersonates, or null. */
    actAsUser: string | null;
    scopes: string[];
    allowedIps: string[] | null;
    allowedPathPrefixes: string[] | null;
    allowedMethods: string[] | null;
    forceNonAdmin: boolean;
    expiresAt: Date | null;
}

/** What the caller asked the child token to be. */
export interface ChildMintRequest {
    scopes: readonly string[];
    /** Resolved `users.id` of the child's actAsUser, when one was requested. */
    actAsUserId?: string;
    allowedIps?: readonly string[];
    allowedPathPrefixes?: readonly string[];
    allowedMethods?: readonly string[];
    forceNonAdmin?: boolean;
    /** null = never expires. */
    expiresAt: Date | null;
}

/**
 * Whether every request path the `child` prefix admits is also admitted by
 * `minter`, under the request-time rule in `tokenEnvelopeDenial()`
 * (token-identity.ts): a prefix matches itself exactly or anything below
 * `prefix/`.
 */
export function pathPrefixCoveredBy(child: string, minter: string): boolean {
    if (child === minter) return true;
    const boundary = minter.endsWith('/') ? minter : `${minter}/`;
    return child.startsWith(boundary);
}

/** Grants that `admin` does not imply: a child may carry one only when the minter literally holds it. */
const LITERAL_HOLD_GRANTS: readonly string[] = ['integrations:read', 'diagnostics:read'];

/**
 * Returns why the child would exceed its minter, or null when it stays inside.
 * An empty or missing list on the minter means "unrestricted"; on the child it
 * means "unrestricted" too, so a restricted minter needs a non-empty list.
 */
export function mintEnvelopeViolation(
    minter: MinterEnvelope,
    child: ChildMintRequest,
): string | null {
    if (!minter.scopes.includes('admin')) {
        return 'A service token needs the admin scope to mint service tokens';
    }

    // `admin` implies every gate scope (`callerHolds`), but not the
    // `integrations:read` or `diagnostics:read` grants: a child may carry
    // either only when the minter literally holds it.
    const lacking = child.scopes.filter(
        (s) =>
            !callerHolds(minter.scopes, s) ||
            (LITERAL_HOLD_GRANTS.includes(s) && !minter.scopes.includes(s)),
    );
    if (lacking.length > 0) {
        return `The minting token does not hold scopes (${lacking.join(', ')})`;
    }

    if (minter.actAsUser) {
        // Without actAsUser the child would act as the OWNER, which this
        // minter cannot do; with another user it would impersonate someone the
        // minter cannot.
        if (child.actAsUserId !== minter.actAsUser) {
            return 'The minting token acts as one user; the new token must set actAsUser to that same user';
        }
    }

    const minterPaths = minter.allowedPathPrefixes ?? [];
    if (minterPaths.length > 0) {
        const childPaths = child.allowedPathPrefixes ?? [];
        if (childPaths.length === 0) {
            return 'The minting token is path-restricted; the new token must set allowedPathPrefixes inside it';
        }
        const outside = childPaths.filter(
            (p) => !minterPaths.some((m) => pathPrefixCoveredBy(p, m)),
        );
        if (outside.length > 0) {
            return `Path prefixes outside the minting token (${outside.join(', ')})`;
        }
    }

    const minterMethods = (minter.allowedMethods ?? []).map((m) => m.toUpperCase());
    if (minterMethods.length > 0) {
        const childMethods = (child.allowedMethods ?? []).map((m) => m.toUpperCase());
        if (childMethods.length === 0) {
            return 'The minting token is method-restricted; the new token must set allowedMethods inside it';
        }
        const extra = childMethods.filter((m) => !minterMethods.includes(m));
        if (extra.length > 0) {
            return `HTTP methods the minting token lacks (${extra.join(', ')})`;
        }
    }

    const minterIps = (minter.allowedIps ?? []).map(normalizeIp);
    if (minterIps.length > 0) {
        const childIps = child.allowedIps ?? [];
        if (childIps.length === 0) {
            return 'The minting token is IP-restricted; the new token must set allowedIps inside it';
        }
        const extra = childIps.filter((ip) => !minterIps.includes(normalizeIp(ip)));
        if (extra.length > 0) {
            return `IPs outside the minting token (${extra.join(', ')})`;
        }
    }

    if (minter.forceNonAdmin && child.forceNonAdmin !== true) {
        return 'The minting token has forceNonAdmin; the new token must set it too';
    }

    if (minter.expiresAt) {
        if (!child.expiresAt || child.expiresAt.getTime() > minter.expiresAt.getTime()) {
            return `The new token must expire no later than the minting token (${minter.expiresAt.toISOString()})`;
        }
    }

    return null;
}
