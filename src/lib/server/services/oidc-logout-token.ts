// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenID Connect Back-Channel Logout 1.0 — Logout Token validation (§2.4 / §2.6).
 *
 * Verifies the JWT signature against the OP JWKS and enforces every normative
 * claim check: iss/aud/iat/exp, the required `events` backchannel-logout member,
 * presence of `sub` or `sid` (or both), and the MANDATORY ABSENCE of `nonce`
 * (a nonce makes the token a forged ID token — reject). `alg:none` is rejected by
 * pinning the accepted algorithms. The key is injected so the core is unit-testable
 * with a locally generated keypair; `validateLogoutTokenFromConfig` wires the real
 * OP JWKS.
 *
 * AGPL-core.
 */

import {
    jwtVerify,
    createRemoteJWKSet,
    errors as joseErrors,
    type JWTVerifyGetKey,
    type CryptoKey,
    type KeyObject,
} from 'jose';
import { config } from '$lib/server/config.js';
import { getOidcServerMetadata } from '$lib/server/services/oidc.service.js';

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Algorithms we accept for a logout token. NEVER includes `none`. */
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'];

/**
 * Jose error codes that indicate a bad/malformed/untrusted token (→ 400 LogoutTokenError,
 * do-not-retry). Any other JOSEError code (e.g. ERR_JOSE_GENERIC from a JWKS HTTP failure,
 * ERR_JWKS_TIMEOUT) is treated as an infrastructure fault (→ 503 OidcBackchannelInfraError).
 */
const TOKEN_FAULT_CODES = new Set([
    'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWT_EXPIRED',
    'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWS_INVALID',
    'ERR_JWT_INVALID',
    'ERR_JOSE_ALG_NOT_ALLOWED',
    'ERR_JWKS_NO_MATCHING_KEY',
    'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

/** Upper bound on (now - iat). Logout tokens are short-lived; this caps replay of
 *  a captured-but-unexpired token even if the OP set a generous `exp`. */
const MAX_TOKEN_AGE = '5 minutes';

/** Token is malformed / fails a normative check → HTTP 400 (do not retry). */
export class LogoutTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LogoutTokenError';
    }
}

/** A transient infrastructure failure (JWKS fetch, discovery) → HTTP 503 so the
 *  OP retries instead of treating a temporary outage as a bad token. */
export class OidcBackchannelInfraError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OidcBackchannelInfraError';
    }
}

export interface LogoutTokenClaims {
    iss: string;
    sub?: string;
    sid?: string;
    jti: string;
    iat: number;
    exp: number;
}

/**
 * Key type accepted by `validateLogoutToken`. In jose v6, `KeyLike` was removed;
 * the concrete union is `CryptoKey | KeyObject | Uint8Array` for static keys, plus
 * `JWTVerifyGetKey` for JWKS resolver functions (used by `validateLogoutTokenFromConfig`).
 */
type ResolvedKey = CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey;

/** Non-empty string or undefined — treat `''` as absent (OP quirk guard). */
function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function validateLogoutToken(
    jwt: string,
    opts: { key: ResolvedKey; issuer: string; audience: string; clockToleranceSec?: number },
): Promise<LogoutTokenClaims> {
    let payload: Record<string, unknown>;
    try {
        const verified = await jwtVerify(jwt, opts.key as Parameters<typeof jwtVerify>[1], {
            issuer: opts.issuer,
            audience: opts.audience,
            algorithms: ALLOWED_ALGS,
            requiredClaims: ['iss', 'aud', 'iat', 'exp', 'jti'],
            clockTolerance: opts.clockToleranceSec ?? 60,
            maxTokenAge: MAX_TOKEN_AGE,
        });
        payload = verified.payload;
    } catch (error) {
        // Explicit allowlist: only token-fault jose codes become 400 (LogoutTokenError).
        // Everything else — including JWKS HTTP failures (ERR_JOSE_GENERIC), timeouts
        // (ERR_JWKS_TIMEOUT), and non-jose errors — becomes 503 (OidcBackchannelInfraError)
        // so the OP retries rather than treating a transient outage as a bad token.
        if (error instanceof joseErrors.JOSEError && TOKEN_FAULT_CODES.has(error.code)) {
            throw new LogoutTokenError(`signature/claims invalid: ${error.code}`);
        }
        throw new OidcBackchannelInfraError(
            `logout-token verification unavailable: ${String(error)}`,
        );
    }

    // events MUST contain the backchannel-logout member whose value is a JSON object.
    const events = payload.events;
    if (typeof events !== 'object' || events === null) {
        throw new LogoutTokenError('events claim is not an object');
    }
    const eventMember = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
    if (
        eventMember === undefined ||
        typeof eventMember !== 'object' ||
        eventMember === null ||
        Array.isArray(eventMember)
    ) {
        throw new LogoutTokenError('missing/invalid backchannel-logout events member');
    }

    // nonce MUST NOT be present (a nonce makes it a forged ID token).
    if ('nonce' in payload) {
        throw new LogoutTokenError('nonce is prohibited in a logout token');
    }

    // If aud is multi-valued, the spec requires azp to identify the intended RP.
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== opts.audience) {
        throw new LogoutTokenError('multi-audience token without matching azp');
    }

    const sub = nonEmpty(payload.sub);
    const sid = nonEmpty(payload.sid);
    if (!sub && !sid) {
        throw new LogoutTokenError('logout token has neither sub nor sid');
    }

    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
        throw new LogoutTokenError('non-numeric iat/exp');
    }

    return { iss: String(payload.iss), sub, sid, jti: String(payload.jti), iat, exp };
}

// Cache the JWKS resolver per jwks_uri (createRemoteJWKSet caches keys + handles
// rotation internally; recreating it per request would defeat that cache).
let jwksUriCached: string | null = null;
let jwksResolver: JWTVerifyGetKey | null = null;

function getJwksResolver(jwksUri: string): JWTVerifyGetKey {
    if (jwksResolver && jwksUriCached === jwksUri) return jwksResolver;
    jwksResolver = createRemoteJWKSet(new URL(jwksUri));
    jwksUriCached = jwksUri;
    return jwksResolver;
}

/** Drop the cached JWKS resolver (mirrors resetOidcConfigCache; mainly for tests). */
export function resetJwksResolver(): void {
    jwksResolver = null;
    jwksUriCached = null;
}

export async function validateLogoutTokenFromConfig(jwt: string): Promise<LogoutTokenClaims> {
    let issuer: string;
    let jwksUri: string;
    try {
        ({ issuer, jwksUri } = await getOidcServerMetadata());
    } catch (error) {
        // Discovery unavailable is an infra failure, not a bad token.
        throw new OidcBackchannelInfraError(`OP metadata unavailable: ${String(error)}`);
    }
    return validateLogoutToken(jwt, {
        key: getJwksResolver(jwksUri),
        issuer,
        audience: config.AUTH_OIDC_CLIENT_ID,
    });
}
