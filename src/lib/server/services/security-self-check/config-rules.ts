// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Self-Check — Config-static rules.
 *
 * Pure functions over the live `config` object (re-read on each access).
 * Covers Tier 1 (catastrophic single-flag misconfigs), Tier 3 config-static
 * checks, and the Tier 4 device.verification-base-url check.
 *
 * All checks are READ-ONLY. No secret VALUES ever appear in findings — only
 * names, counts, prefixes, and `file:line` evidence.
 *
 * `runConfigRules()` is the public entry-point. It is defensive: a rule that
 * throws is caught and surfaced as an `error`-status finding, never propagated.
 */

import { config, devFeaturesEnabled, features } from '$lib/server/config';
import { forwardAuthTrustPosture, clientIpProxiesPinned } from '$lib/server/utils/client-ip';
import {
    describeWideTrustedProxyRanges,
    MIN_TRUSTED_PROXY_PREFIX_V4,
    runsOnKubernetes,
} from '$lib/server/utils/trusted-proxy-ranges';
import {
    DISABLED_HEADER_RECENT_MS,
    getIgnoredForwardAuthSighting,
} from '$lib/server/utils/forward-auth-disabled-observer';
import {
    getUndecryptableConfigKeys,
    get as getConfigValue,
} from '$lib/server/config/config.service';
import { getMasterKeySource } from '$lib/server/crypto/master-key.js';
import { finding } from './finding';
import type { SecuritySelfCheckFinding } from '$lib/schemas/security-self-check';

// ── Tier 1 — Catastrophic single-flag misconfigs ────────────────────────────

/**
 * OIDC TLS verification disabled (AUTH_OIDC_ALLOW_INSECURE=true).
 * Sets NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide — a MITM on the token
 * endpoint can forge any ID token → instant admin login.
 */
export function checkOidcAllowInsecure(): SecuritySelfCheckFinding {
    const insecure = config.AUTH_OIDC_ALLOW_INSECURE;
    if (insecure) {
        return finding({
            id: 'oidc.allow-insecure',
            method: 'oidc',
            type: 'config-static',
            status: 'fail',
            title: 'OIDC TLS verification disabled',
            detail: 'AUTH_OIDC_ALLOW_INSECURE=true disables TLS verification process-wide (NODE_TLS_REJECT_UNAUTHORIZED=0). A MITM on the OIDC token endpoint can forge any ID token and gain admin access.',
            remediation:
                'Unset AUTH_OIDC_ALLOW_INSECURE in production. Use a trusted CA or add the IdP cert to NODE_EXTRA_CA_CERTS instead.',
            evidence: 'config.ts:388; oidc.service.ts:127,148,154',
        });
    }
    return finding({
        id: 'oidc.allow-insecure',
        method: 'oidc',
        type: 'config-static',
        status: 'pass',
        title: 'OIDC TLS verification enabled',
        detail: 'AUTH_OIDC_ALLOW_INSECURE is not set; TLS verification is active.',
        evidence: 'config.ts:388',
    });
}

/**
 * Dev features enabled on a non-dev deployment (ALLOW_DEV_FEATURES=true or
 * NODE_ENV !== 'production'). The dev-user fallback can synthesize an admin
 * identity with no real authentication.
 */
export function checkDevFeaturesEnabled(): SecuritySelfCheckFinding {
    // devFeaturesEnabled is already computed at module load from process.env
    // (not via configService) so the gate itself can never be flipped in prod.
    if (devFeaturesEnabled) {
        return finding({
            id: 'dev.features-enabled',
            method: 'forward-auth',
            type: 'config-static',
            status: 'fail',
            title: 'Dev features are enabled',
            detail: 'ALLOW_DEV_FEATURES=true or NODE_ENV is not "production". The dev-user fallback can synthesize an admin identity without real authentication.',
            remediation:
                'Ensure NODE_ENV=production and unset ALLOW_DEV_FEATURES on public deployments.',
            evidence: 'config.ts:17-20; forward-auth.ts:1605',
        });
    }
    return finding({
        id: 'dev.features-enabled',
        method: 'forward-auth',
        type: 'config-static',
        status: 'pass',
        title: 'Dev features disabled',
        detail: 'ALLOW_DEV_FEATURES is not set and NODE_ENV=production. Dev-user bypass is inactive.',
        evidence: 'config.ts:17-20',
    });
}

/**
 * JWT secret missing — config.JWT_SECRET resolves to empty string (env unset
 * AND master-key derivation failed). All token mint/verify will throw.
 *
 * JWT secret weak — live JWT_SECRET < 32 chars (FAIL) or < 8 unique chars
 * (WARN). HS256 secret is brute-forceable from one captured token.
 *
 * Returns one finding: 'jwt.secret-missing', 'jwt.secret-weak-length',
 * 'jwt.secret-weak-entropy', or 'jwt.secret-ok'.
 * We report all three ids but the function returns whichever is most severe.
 * For table-driven testability we split into two exported sub-functions.
 */
export function checkJwtSecretMissing(): SecuritySelfCheckFinding {
    const secret = config.JWT_SECRET;
    if (!secret) {
        return finding({
            id: 'jwt.secret-missing',
            method: 'secrets',
            type: 'config-static',
            status: 'fail',
            title: 'JWT secret is missing',
            detail: 'JWT_SECRET is empty and master-key derivation returned nothing. All token mint/verify operations will throw, making token-based auth non-functional.',
            remediation:
                'Set JWT_SECRET to a strong random value: openssl rand -hex 32. Or ensure LUMASTRA_MASTER_KEY is set so the secret can be derived.',
            evidence: 'config.ts:1629-1630; jwt.ts:37',
        });
    }
    return finding({
        id: 'jwt.secret-missing',
        method: 'secrets',
        type: 'config-static',
        status: 'pass',
        title: 'JWT secret is present',
        detail: 'JWT_SECRET (or a derived equivalent) is set.',
        evidence: 'config.ts:1629',
    });
}

/**
 * Evaluates JWT secret strength from its length and unique-character count.
 * Accepts the raw secret VALUE so pure unit tests can supply fixtures without
 * touching process.env.
 *
 * NEVER call this with a value you intend to log — it takes the raw secret
 * only to measure it and never places the value in the returned finding.
 */
export function evaluateJwtSecretStrength(
    secretLength: number,
    uniqueCharCount: number,
): SecuritySelfCheckFinding {
    if (secretLength < 32) {
        return finding({
            id: 'jwt.secret-weak',
            method: 'secrets',
            type: 'config-static',
            status: 'fail',
            title: 'JWT secret is too short',
            detail: `JWT_SECRET is ${secretLength} character(s) — minimum 32 required. An HS256 secret this short is brute-forceable from a captured token.`,
            remediation: 'Generate a secure secret: openssl rand -hex 32',
            evidence: 'config.ts:3092,3100',
        });
    }
    if (uniqueCharCount < 8) {
        return finding({
            id: 'jwt.secret-weak',
            method: 'secrets',
            type: 'config-static',
            status: 'warn',
            title: 'JWT secret has low entropy',
            detail: `JWT_SECRET has only ${uniqueCharCount} unique character(s) — a low-entropy secret is nearly as weak as a short one.`,
            remediation: 'Generate a secure secret: openssl rand -hex 32',
            evidence: 'config.ts:3092,3100',
        });
    }
    return finding({
        id: 'jwt.secret-weak',
        method: 'secrets',
        type: 'config-static',
        status: 'pass',
        title: 'JWT secret strength is acceptable',
        detail: `JWT_SECRET meets the minimum length (${secretLength} chars) and entropy (${uniqueCharCount} unique chars) requirements.`,
        evidence: 'config.ts:3092,3100',
    });
}

export function checkJwtSecretStrength(): SecuritySelfCheckFinding {
    const secret = config.JWT_SECRET;
    // If secret is missing, the missing-check owns the diagnosis.
    if (!secret) {
        return finding({
            id: 'jwt.secret-weak',
            method: 'secrets',
            type: 'config-static',
            status: 'skipped',
            title: 'JWT secret strength check skipped',
            detail: 'JWT_SECRET is not set — strength cannot be evaluated. See jwt.secret-missing.',
        });
    }
    return evaluateJwtSecretStrength(secret.length, new Set(secret).size);
}

/**
 * OIDC enabled but AUTH_OIDC_SCOPES lacks 'openid'.
 * Without the openid scope, no ID token is returned — SSO is broken/undefined.
 */
export function checkOidcScopesMissingOpenid(): SecuritySelfCheckFinding {
    const oidcEnabled = config.AUTH_OIDC_ENABLED;
    if (!oidcEnabled) {
        return finding({
            id: 'oidc.scopes-missing-openid',
            method: 'oidc',
            type: 'config-static',
            status: 'skipped',
            title: 'OIDC scopes check skipped',
            detail: 'AUTH_OIDC_ENABLED is false — OIDC scope check is not applicable.',
        });
    }
    const scopes = config.AUTH_OIDC_SCOPES;
    const scopeList = scopes.split(/\s+/).filter(Boolean);
    const hasOpenid = scopeList.includes('openid');
    if (!hasOpenid) {
        return finding({
            id: 'oidc.scopes-missing-openid',
            method: 'oidc',
            type: 'config-static',
            status: 'fail',
            title: 'OIDC scopes missing "openid"',
            detail: `AUTH_OIDC_SCOPES does not include "openid". Without it, no ID token is returned by the IdP, resulting in broken or undefined SSO behaviour. Current configured scopes: ${scopeList.length} scope(s).`,
            remediation:
                'Add "openid" to AUTH_OIDC_SCOPES, e.g. AUTH_OIDC_SCOPES="openid profile email".',
            evidence: 'config.ts:343; oidc.service.ts:220',
        });
    }
    return finding({
        id: 'oidc.scopes-missing-openid',
        method: 'oidc',
        type: 'config-static',
        status: 'pass',
        title: 'OIDC scopes include "openid"',
        detail: 'AUTH_OIDC_SCOPES includes "openid" — ID token will be returned by the IdP.',
        evidence: 'config.ts:343',
    });
}

/**
 * LUMASTRA_TRUST_ANY_PROXY=true (non-dev).
 * Any TCP peer can then forge identity headers.
 */
export function checkProxyTrustAny(): SecuritySelfCheckFinding {
    const posture = forwardAuthTrustPosture();
    if (posture === 'trust-any' && config.FORWARD_AUTH_ENABLED !== true) {
        return finding({
            id: 'proxy.trust-any',
            method: 'forward-auth',
            type: 'config-static',
            status: 'pass',
            title: 'LUMASTRA_TRUST_ANY_PROXY has no effect (forward auth is off)',
            detail: 'LUMASTRA_TRUST_ANY_PROXY=true, but FORWARD_AUTH_ENABLED is off, so identity headers are ignored from every peer. Turning forward auth on would trust them from ANY peer; pin TRUSTED_PROXY_IPS first.',
            evidence: 'forward-auth.ts:identityHeaderVerdict',
        });
    }
    if (posture === 'trust-any' && !devFeaturesEnabled) {
        return finding({
            id: 'proxy.trust-any',
            method: 'forward-auth',
            type: 'config-static',
            status: 'fail',
            title: 'Forward-auth headers trusted from ANY peer',
            detail: 'LUMASTRA_TRUST_ANY_PROXY=true and TRUSTED_PROXY_IPS is empty. Any TCP peer can forge USERHEADER/GROUPHEADER and impersonate any user, including admins.',
            remediation:
                'Set TRUSTED_PROXY_IPS to the IP address(es) of your reverse proxy. Remove LUMASTRA_TRUST_ANY_PROXY.',
            evidence: 'client-ip.ts',
        });
    }
    if (posture === 'trust-any' && devFeaturesEnabled) {
        // Trust-any in dev mode: warn rather than fail because the dev fallback
        // already owns the catastrophic fail above.
        return finding({
            id: 'proxy.trust-any',
            method: 'forward-auth',
            type: 'config-static',
            status: 'warn',
            title: 'Forward-auth headers trusted from ANY peer (dev mode)',
            detail: 'LUMASTRA_TRUST_ANY_PROXY=true with dev features enabled. Acceptable only on a local dev instance.',
            remediation: 'Pin TRUSTED_PROXY_IPS when moving to production.',
            evidence: 'client-ip.ts',
        });
    }
    return finding({
        id: 'proxy.trust-any',
        method: 'forward-auth',
        type: 'config-static',
        status: 'pass',
        title: 'Forward-auth peer trust is not set to "any"',
        detail: `Forward-auth trust posture is "${posture}". LUMASTRA_TRUST_ANY_PROXY is not active.`,
        evidence: 'client-ip.ts',
    });
}

/**
 * FORWARD_AUTH_ENABLED against what actually happens:
 * - on, but no peer is trusted (TRUSTED_PROXY_IPS empty, no trust-any) → WARN:
 *   forward auth cannot sign anyone in;
 * - off, but identity headers arrived from a trusted proxy recently (seen by
 *   this replica) → WARN: either a forward-auth install that missed the upgrade
 *   step, or a proxy passing client-sent identity headers through (which would
 *   become a sign-in bypass the moment forward auth is turned on).
 */
export function checkForwardAuthEnabledPosture(): SecuritySelfCheckFinding {
    const enabled = config.FORWARD_AUTH_ENABLED === true;
    const posture = forwardAuthTrustPosture();
    if (enabled && posture === 'fail-closed') {
        return finding({
            id: 'forward-auth.enabled-posture',
            method: 'forward-auth',
            type: 'config-static',
            status: 'warn',
            title: 'Forward auth is on, but no proxy is trusted',
            detail: 'FORWARD_AUTH_ENABLED is on and TRUSTED_PROXY_IPS is empty, so identity headers are rejected from every peer. Nobody can sign in through the forward-auth proxy.',
            remediation:
                'Set TRUSTED_PROXY_IPS to the address your reverse proxy connects from, or turn Forward Auth off if you only use built-in login or OIDC.',
            evidence: 'forward-auth.ts:identityHeaderVerdict',
        });
    }
    if (!enabled) {
        const sighting = getIgnoredForwardAuthSighting();
        if (sighting && Date.now() - sighting.lastSeenAt < DISABLED_HEADER_RECENT_MS) {
            return finding({
                id: 'forward-auth.enabled-posture',
                method: 'forward-auth',
                type: 'config-static',
                status: 'warn',
                title: 'Identity headers arrive while forward auth is off',
                detail: `A trusted proxy (${sighting.lastPeer}) sent ${sighting.lastHeaders.join(', ')} on ${sighting.count} request(s) since this server started (last ${new Date(sighting.lastSeenAt).toISOString()}). They were ignored because FORWARD_AUTH_ENABLED is off.`,
                remediation:
                    'If you sign in through a forward-auth proxy, turn Forward Auth on. Otherwise make the reverse proxy strip these headers from client requests: if it passes them through, they become a sign-in bypass as soon as forward auth is turned on.',
                evidence: 'forward-auth-disabled-observer.ts',
            });
        }
    }
    return finding({
        id: 'forward-auth.enabled-posture',
        method: 'forward-auth',
        type: 'config-static',
        status: 'pass',
        title: enabled
            ? 'Forward auth is on and a proxy is trusted'
            : 'Forward auth is off and no identity headers arrived since this server started',
        detail: enabled
            ? `FORWARD_AUTH_ENABLED is on with trust posture "${posture}".`
            : 'FORWARD_AUTH_ENABLED is off. Identity headers are ignored from every peer; this server process has not seen one from a trusted proxy in the last day (each replica reports only its own requests).',
        evidence: 'forward-auth.ts:identityHeaderVerdict',
    });
}

/**
 * TRUSTED_PROXY_IPS is empty AND trust-any is not set AND not dev.
 * This means identity headers are silently rejected (fail-closed), which is
 * secure but means forward-auth won't work. It also makes every client-address
 * decision (rate-limit keys, token allowed_ips, stream-token IP binding)
 * collapse to the proxy address, since those use the raw peer (security review
 * 2026-09-12, C12/C13/C15) and never a spoofable X-Forwarded-For.
 *
 * Per spec: FAIL when unpinned + not trust-any + not dev.
 */
export function checkProxyUnpinned(): SecuritySelfCheckFinding {
    const posture = forwardAuthTrustPosture();
    // allowlist = pinned → pass
    if (posture === 'allowlist') {
        return finding({
            id: 'proxy.unpinned',
            method: 'forward-auth',
            type: 'config-static',
            status: 'pass',
            title: 'Proxy IPs are pinned',
            detail: 'TRUSTED_PROXY_IPS is configured. Forward-auth peer trust is bounded.',
            evidence: 'client-ip.ts:shouldHonorForwardedFor',
        });
    }
    // trust-any = already covered by proxy.trust-any
    if (posture === 'trust-any') {
        return finding({
            id: 'proxy.unpinned',
            method: 'forward-auth',
            type: 'config-static',
            status: 'skipped',
            title: 'Proxy unpinned check skipped (trust-any posture)',
            detail: 'LUMASTRA_TRUST_ANY_PROXY=true — see proxy.trust-any finding.',
            evidence: 'client-ip.ts:shouldHonorForwardedFor',
        });
    }
    // fail-closed + forward auth off + not dev ⇒ WARN: no identity header could
    // be read anyway, so only the client-address half of the finding applies.
    if (!devFeaturesEnabled && config.FORWARD_AUTH_ENABLED !== true) {
        return finding({
            id: 'proxy.unpinned',
            method: 'forward-auth',
            type: 'config-static',
            status: 'warn',
            title: 'Proxy IPs not pinned (client addresses collapse to the proxy)',
            detail: 'TRUSTED_PROXY_IPS is empty. Forward auth is off, so no identity header is read either way. Security decisions that key on the client address — auth and mint rate limits, PAT/service-token allowed_ips, stream-token IP binding — deliberately use the raw TCP peer rather than X-Forwarded-For, so behind a reverse proxy they all see the proxy address: every user shares one rate-limit bucket and a token allowed_ips list can only ever match the proxy. Without a reverse proxy this is expected.',
            remediation:
                'Behind a reverse proxy that strips client-sent identity headers, set TRUSTED_PROXY_IPS to an address that belongs to that proxy alone (a compose proxy with a fixed IP).',
            evidence: 'client-ip.ts:shouldHonorForwardedFor',
        });
    }
    // fail-closed + not dev ⇒ FAIL
    if (!devFeaturesEnabled) {
        return finding({
            id: 'proxy.unpinned',
            method: 'forward-auth',
            type: 'config-static',
            status: 'fail',
            title: 'Proxy IPs not pinned (forward-auth fail-closed)',
            detail: 'TRUSTED_PROXY_IPS is empty and LUMASTRA_TRUST_ANY_PROXY is not set. Forward-auth identity headers are rejected from all peers (fail-closed). Security decisions that key on the client address — auth and mint rate limits, PAT/service-token allowed_ips, stream-token IP binding — deliberately use the raw TCP peer rather than X-Forwarded-For, so behind an unpinned proxy they all see the proxy address: every user shares one rate-limit bucket and a token allowed_ips list can only ever match the proxy.',
            remediation:
                'Set TRUSTED_PROXY_IPS to the IP(s) of your reverse proxy, or set LUMASTRA_TRUST_ANY_PROXY=true only on a private single-host deployment.',
            evidence: 'client-ip.ts:shouldHonorForwardedFor',
        });
    }
    // fail-closed + dev ⇒ skipped (dev is already flagged by dev.features-enabled)
    return finding({
        id: 'proxy.unpinned',
        method: 'forward-auth',
        type: 'config-static',
        status: 'skipped',
        title: 'Proxy unpinned check skipped (dev mode)',
        detail: 'TRUSTED_PROXY_IPS is empty in dev mode. This is expected on a local dev instance.',
        evidence: 'client-ip.ts:shouldHonorForwardedFor',
    });
}

/**
 * TRUSTED_PROXY_IPS lists a range wider than /24 or an IPv6 range. Every
 * address in the list may set the client IP, and with FORWARD_AUTH_ENABLED=true
 * the identity headers too, so a LAN range lets any device on it sign in as
 * anyone. Threshold and the Kubernetes exception: trusted-proxy-ranges.ts.
 */
export function checkProxyWideRange(): SecuritySelfCheckFinding {
    const forwardAuthEnabled = config.FORWARD_AUTH_ENABLED === true;
    const report = describeWideTrustedProxyRanges({
        trustedProxyIps: process.env.TRUSTED_PROXY_IPS,
        forwardAuthEnabled,
        kubernetes: runsOnKubernetes(),
    });
    if (!report) {
        return finding({
            id: 'proxy.wide-range',
            method: 'forward-auth',
            type: 'config-static',
            status: 'pass',
            title: 'TRUSTED_PROXY_IPS lists no wide range',
            detail: `TRUSTED_PROXY_IPS has no IPv4 range wider than /${MIN_TRUSTED_PROXY_PREFIX_V4} and no IPv6 range.`,
            evidence: 'trusted-proxy-ranges.ts',
        });
    }
    return finding({
        id: 'proxy.wide-range',
        method: 'forward-auth',
        type: 'config-static',
        status: report.severity,
        title:
            report.severity === 'info'
                ? 'TRUSTED_PROXY_IPS lists a wide range (Kubernetes)'
                : forwardAuthEnabled
                  ? 'TRUSTED_PROXY_IPS lists a wide range while forward auth is on'
                  : 'TRUSTED_PROXY_IPS lists a wide range',
        detail: report.message,
        remediation: report.remediation,
        evidence: 'trusted-proxy-ranges.ts',
    });
}

/**
 * STREAM_TOKEN_WILDCARD_IP=false (an operator opted OUT of the default
 * wildcard-IP behavior to pin stream tokens to the requester's IP) while the
 * proxy posture is not `allowlist` (TRUSTED_PROXY_IPS unset).
 *
 * WARN, not FAIL: this is a no-op misconfiguration, not an access-control
 * hole. `getClientIpStrict`/`getClientIpStrictFromRequest` (security review
 * P2) fall back to the raw TCP peer whenever TRUSTED_PROXY_IPS is unset —
 * that is what keeps mint/refresh/validate from disagreeing under a spoofed
 * `X-Forwarded-For`, but it also means every request through the SAME reverse
 * proxy resolves to that ONE peer address. So with no allowlist pinned,
 * turning this setting on does not restore per-client IP binding — it
 * degrades to "every client behind this proxy shares one bound IP", which
 * still breaks the AirPlay/Chromecast handoff this setting exists to trade
 * away, for no real per-client security gain. The setting is only meaningful
 * once `TRUSTED_PROXY_IPS` is pinned (posture = `allowlist`), which is when
 * the strict resolver actually reads a distinct value per client from
 * `X-Forwarded-For`. Parity with the `allowed_ips` reverse-proxy hint shown
 * in the service-token creation form (2026-09-12 C15).
 */
export function checkStreamTokenIpPinningIneffective(): SecuritySelfCheckFinding {
    const wildcardIp = getConfigValue('STREAM_TOKEN_WILDCARD_IP') !== false;
    const posture = forwardAuthTrustPosture();
    // CLIENT_IP_PROXY_IPS (Helm router) pins the client IP without touching the identity posture.
    if (wildcardIp || posture === 'allowlist' || clientIpProxiesPinned()) {
        return finding({
            id: 'stream-token.ip-pinning-ineffective',
            method: 'forward-auth',
            type: 'config-static',
            status: 'pass',
            title: 'Stream-token IP pinning is not in an ineffective state',
            detail: wildcardIp
                ? 'STREAM_TOKEN_WILDCARD_IP is at its default (true) — stream tokens are not IP-bound, so proxy posture is not relevant to this check.'
                : 'STREAM_TOKEN_WILDCARD_IP=false and TRUSTED_PROXY_IPS is pinned — stream-token IP binding reads a distinct per-client address.',
            evidence: 'client-ip.ts:getClientIpStrict',
        });
    }
    return finding({
        id: 'stream-token.ip-pinning-ineffective',
        method: 'forward-auth',
        type: 'config-static',
        status: 'warn',
        title: 'Stream-token IP pinning is enabled but has no proxy allowlist to bind to',
        detail: `STREAM_TOKEN_WILDCARD_IP=false with forward-auth posture "${posture}" (TRUSTED_PROXY_IPS and CLIENT_IP_PROXY_IPS unset). The strict IP resolver behind stream-token binding falls back to the raw TCP peer when unpinned, so every client behind the same reverse proxy resolves to that ONE address — this setting does not restore per-client binding in that state, it only breaks AirPlay/Chromecast/tvOS handoff (which needs the token to be usable from a different device's IP) for no real per-client security gain.`,
        remediation:
            'Set TRUSTED_PROXY_IPS (or CLIENT_IP_PROXY_IPS, which grants no identity trust) to your reverse-proxy IP(s) so the strict resolver can read a distinct client IP per request, or leave STREAM_TOKEN_WILDCARD_IP at its default (true) if you need casting/AirPlay support.',
        evidence: 'client-ip.ts:getClientIpStrict',
    });
}

// ── Tier 3 — Per-method config-static posture ────────────────────────────────

/**
 * Native session TTL is excessive (> 90 days ⇒ WARN).
 */
export function checkNativeSessionTtl(): SecuritySelfCheckFinding {
    const ttl = config.NATIVE_AUTH_SESSION_TTL_DAYS;
    const WARN_THRESHOLD = 90;
    if (ttl > WARN_THRESHOLD) {
        return finding({
            id: 'native.session-ttl',
            method: 'native',
            type: 'config-static',
            status: 'warn',
            title: 'Native session TTL is very long',
            detail: `NATIVE_AUTH_SESSION_TTL_DAYS is ${ttl} day(s), which exceeds the recommended maximum of ${WARN_THRESHOLD} days. Long-lived sessions increase the window of opportunity if a session cookie is stolen.`,
            remediation: `Set NATIVE_AUTH_SESSION_TTL_DAYS to ${WARN_THRESHOLD} or fewer for better security hygiene.`,
            evidence: 'config.ts:316',
        });
    }
    return finding({
        id: 'native.session-ttl',
        method: 'native',
        type: 'config-static',
        status: 'pass',
        title: 'Native session TTL is acceptable',
        detail: `NATIVE_AUTH_SESSION_TTL_DAYS is ${ttl} day(s) (≤ ${WARN_THRESHOLD}).`,
        evidence: 'config.ts:316',
    });
}

/**
 * Native login enabled on this instance (informational).
 */
export function checkNativeEnabled(): SecuritySelfCheckFinding {
    const enabled = config.AUTH_NATIVE_LOGIN_ENABLED;
    return finding({
        id: 'native.enabled',
        method: 'native',
        type: 'config-static',
        status: 'pass',
        title: enabled ? 'Native login is enabled' : 'Native login is disabled',
        detail: enabled
            ? 'AUTH_NATIVE_LOGIN_ENABLED=true. Users can authenticate with a username and password stored in the local database.'
            : 'AUTH_NATIVE_LOGIN_ENABLED=false. Password-based native login is not available.',
        evidence: 'config.ts:310',
    });
}

/**
 * AUTH_OIDC_LINK_BY_USERNAME=true — account-takeover risk on self-service IdPs.
 * A user who can freely set their preferred_username at the IdP can claim
 * another account by matching an existing username.
 */
export function checkOidcLinkByUsername(): SecuritySelfCheckFinding {
    const oidcEnabled = config.AUTH_OIDC_ENABLED;
    if (!oidcEnabled) {
        return finding({
            id: 'oidc.link-by-username',
            method: 'oidc',
            type: 'config-static',
            status: 'skipped',
            title: 'OIDC username-link check skipped',
            detail: 'AUTH_OIDC_ENABLED is false — OIDC link-by-username check is not applicable.',
        });
    }
    const linkByUsername = config.AUTH_OIDC_LINK_BY_USERNAME;
    if (linkByUsername) {
        return finding({
            id: 'oidc.link-by-username',
            method: 'oidc',
            type: 'config-static',
            status: 'warn',
            title: 'OIDC link-by-username is enabled',
            detail: 'AUTH_OIDC_LINK_BY_USERNAME=true. If your IdP allows users to freely choose their preferred_username, a user could claim another account (including an admin) by matching its username. Only enable this when the IdP administratively controls usernames.',
            remediation:
                'Prefer link-by-verified-email (AUTH_OIDC_LINK_BY_VERIFIED_EMAIL, default on). Only use link-by-username when your IdP prevents free username selection.',
            evidence: 'config.ts:368',
        });
    }
    return finding({
        id: 'oidc.link-by-username',
        method: 'oidc',
        type: 'config-static',
        status: 'pass',
        title: 'OIDC link-by-username is disabled',
        detail: 'AUTH_OIDC_LINK_BY_USERNAME=false. Account linking via username is not active.',
        evidence: 'config.ts:368',
    });
}

/**
 * OIDC enabled but client ID or secret is missing.
 */
export function checkOidcMissingClient(): SecuritySelfCheckFinding {
    const oidcEnabled = config.AUTH_OIDC_ENABLED;
    if (!oidcEnabled) {
        return finding({
            id: 'oidc.missing-client',
            method: 'oidc',
            type: 'config-static',
            status: 'skipped',
            title: 'OIDC client credentials check skipped',
            detail: 'AUTH_OIDC_ENABLED is false — OIDC client credentials check is not applicable.',
        });
    }
    const clientId = config.AUTH_OIDC_CLIENT_ID;
    const clientSecret = config.AUTH_OIDC_CLIENT_SECRET;
    const missingFields: string[] = [];
    if (!clientId) missingFields.push('AUTH_OIDC_CLIENT_ID');
    if (!clientSecret) missingFields.push('AUTH_OIDC_CLIENT_SECRET');
    if (missingFields.length > 0) {
        return finding({
            id: 'oidc.missing-client',
            method: 'oidc',
            type: 'config-static',
            status: 'fail',
            title: 'OIDC client credentials missing',
            detail: `AUTH_OIDC_ENABLED=true but the following required fields are empty: ${missingFields.join(', ')}. OIDC authentication will fail at runtime.`,
            remediation:
                'Set AUTH_OIDC_CLIENT_ID and AUTH_OIDC_CLIENT_SECRET to the values from your IdP application registration.',
            evidence: 'config.ts:335,340',
        });
    }
    return finding({
        id: 'oidc.missing-client',
        method: 'oidc',
        type: 'config-static',
        status: 'pass',
        title: 'OIDC client credentials present',
        detail: 'AUTH_OIDC_CLIENT_ID and AUTH_OIDC_CLIENT_SECRET are both set.',
        evidence: 'config.ts:335,340',
    });
}

/**
 * Effective jellyfinCompat on → public bypass surface present (informational).
 */
export function checkCompatJellyfinEnabled(): SecuritySelfCheckFinding {
    const enabled = features.jellyfinCompat;
    return finding({
        id: 'compat.jellyfin-enabled',
        method: 'jellyfin-compat',
        type: 'config-static',
        status: 'pass',
        title: enabled
            ? 'Jellyfin compatibility layer is active'
            : 'Jellyfin compatibility layer is inactive',
        detail: enabled
            ? 'The /j/ Jellyfin-compat surface is enabled (FEATURE_JELLYFIN_COMPAT=true). Jellyfin-native clients can connect, but this surface bypasses the central forward-auth gate. It serves Lumastra\u2019s own catalog, so it is active whether or not a Jellyfin server is configured.'
            : 'The /j/ Jellyfin-compat surface is not active (FEATURE_JELLYFIN_COMPAT=false).',
        evidence: 'config.ts:5396',
    });
}

/**
 * FEATURE_SUBSONIC_COMPAT on → per-client tokens stored plaintext at rest (WARN).
 */
export function checkCompatSubsonicEnabled(): SecuritySelfCheckFinding {
    const enabled = config.FEATURE_SUBSONIC_COMPAT;
    if (enabled) {
        return finding({
            id: 'compat.subsonic-enabled',
            method: 'subsonic-compat',
            type: 'config-static',
            status: 'warn',
            title: 'Subsonic compatibility layer is active',
            detail: 'FEATURE_SUBSONIC_COMPAT=true. The OpenSubsonic protocol requires per-client credentials to be stored in a recoverable form (plaintext at rest). Ensure the database is protected at rest.',
            remediation:
                'If Subsonic clients are not in use, disable FEATURE_SUBSONIC_COMPAT. If required, ensure database encryption at rest and restrict DB access.',
            evidence: 'config.ts:908',
        });
    }
    return finding({
        id: 'compat.subsonic-enabled',
        method: 'subsonic-compat',
        type: 'config-static',
        status: 'pass',
        title: 'Subsonic compatibility layer is inactive',
        detail: 'FEATURE_SUBSONIC_COMPAT=false. The /subsonic/rest/ surface is not active.',
        evidence: 'config.ts:908',
    });
}

/**
 * Subsonic accepts ?u=/?p=/?apiKey= in query string → credentials captured in
 * access logs. WARN when subsonic compat is enabled.
 */
export function checkCompatSubsonicCredsInQuery(): SecuritySelfCheckFinding {
    const enabled = config.FEATURE_SUBSONIC_COMPAT;
    if (!enabled) {
        return finding({
            id: 'compat.subsonic-creds-in-query',
            method: 'subsonic-compat',
            type: 'config-static',
            status: 'skipped',
            title: 'Subsonic query-credential check skipped',
            detail: 'FEATURE_SUBSONIC_COMPAT=false — Subsonic query-credential check is not applicable.',
        });
    }
    return finding({
        id: 'compat.subsonic-creds-in-query',
        method: 'subsonic-compat',
        type: 'config-static',
        status: 'warn',
        title: 'Subsonic credentials transmitted in query string',
        detail: 'The OpenSubsonic protocol passes credentials (?u=, ?p=, ?apiKey=) in the query string. These are captured verbatim in access logs, proxy logs, and browser history, leaking credentials to anyone with log access.',
        remediation:
            'Ensure access logs are access-controlled and rotated. Consider restricting Subsonic to internal-only access at the edge. If not needed, disable FEATURE_SUBSONIC_COMPAT.',
        evidence: 'config.ts:908',
    });
}

// ── Tier 4 — Device verification base URL ───────────────────────────────────

/**
 * DEVICE_VERIFICATION_BASE_URL unset → device-flow verification URI derived
 * from the request Host header (host-header poisoning / phishing risk).
 */
export function checkDeviceVerificationBaseUrl(): SecuritySelfCheckFinding {
    const baseUrl = config.DEVICE_VERIFICATION_BASE_URL;
    if (!baseUrl) {
        return finding({
            id: 'device.verification-base-url',
            method: 'token',
            type: 'config-static',
            status: 'warn',
            title: 'Device verification base URL not configured',
            detail: 'DEVICE_VERIFICATION_BASE_URL is not set. The device-flow verification URI is derived from the request Host header, which is controllable by the client. A poisoned Host header can redirect users to an attacker-controlled verification page (phishing).',
            remediation:
                'Set DEVICE_VERIFICATION_BASE_URL to the canonical public origin of this instance, e.g. DEVICE_VERIFICATION_BASE_URL=https://lumastra.example.com.',
            evidence: 'config.ts:1664; device-code.service.ts:99',
        });
    }
    return finding({
        id: 'device.verification-base-url',
        method: 'token',
        type: 'config-static',
        status: 'pass',
        title: 'Device verification base URL is configured',
        detail: 'DEVICE_VERIFICATION_BASE_URL is set. The device-flow verification URI uses a canonical base URL rather than the request Host header.',
        evidence: 'config.ts:1664',
    });
}

// ── Runner ───────────────────────────────────────────────────────────────────

/** Ordered list of all config-rule check functions. */
/**
 * Sealed settings.json values that did NOT open with the current master key.
 *
 * `decryptLoadedConfig` drops such a value and the app silently runs on the
 * default — the classic symptom of swapping LUMASTRA_MASTER_KEY without running
 * the rotation first, or of a replica that does not share the config volume
 * holding master.key (security review 2026-09-12, C9).
 */
export function checkUndecryptableConfigSecrets(): SecuritySelfCheckFinding {
    const keys = getUndecryptableConfigKeys();
    if (keys.length === 0) {
        return finding({
            id: 'config.undecryptable-secrets',
            method: 'secrets',
            type: 'config-static',
            status: 'pass',
            title: 'All sealed settings decrypt',
            detail: 'Every enc:v1: value in settings.json opened with the current master key.',
            evidence: 'config.service.ts:decryptLoadedConfig',
        });
    }
    return finding({
        id: 'config.undecryptable-secrets',
        method: 'secrets',
        type: 'config-static',
        status: 'fail',
        title: 'Sensitive settings cannot be decrypted',
        detail: `${keys.length} sensitive setting(s) in settings.json are sealed with a key this instance does not hold and are NOT in effect — the app is running on their defaults: ${keys.join(', ')}. The most likely cause is that LUMASTRA_MASTER_KEY was changed without running the master-key rotation first, or that this replica does not share the config volume holding master.key.`,
        remediation:
            'Restore the previous LUMASTRA_MASTER_KEY, restart, and run POST /api/admin/secrets/rotate before swapping the key — or re-enter these settings in Admin → Settings. See docs/security/master-key-rotation.md.',
        evidence: 'config.service.ts:decryptLoadedConfig',
    });
}

/**
 * A standalone Live TV proxy is configured (LIVETV_SOURCE=standalone +
 * STREAM_PROXY_URL set) while LUMASTRA_MASTER_KEY is unset — the master key
 * was therefore auto-generated into <configDir>/master.key on first boot
 * (crypto/master-key.ts resolveMasterKey()).
 *
 * That matters specifically for this topology: the standalone proxy
 * (lumastra-proxy in docker-compose.example.yml) is a separate,
 * network-facing container that transcodes attacker-influenced Live TV
 * streams and must never be handed master.key — the encryption-at-rest key
 * for every stored secret (PATs, service tokens, webhook secrets, plugin/
 * Subsonic/Jellyfin credentials). The example compose file mounts only a
 * dedicated ffmpeg-cache volume into the proxy, never the `config` volume
 * that holds the key, but a hand-edited compose file or another orchestrator
 * could still share it. An explicit LUMASTRA_MASTER_KEY removes the
 * dependency on which container's /config volume happened to generate the
 * key first, and makes "the proxy doesn't have it" simple to audit — you
 * just check whether the env var was ever handed to that container.
 *
 * Reads `getMasterKeySource()`, NOT `process.env.LUMASTRA_MASTER_KEY`
 * (C25): `resolveMasterKey()` back-fills that env var on the file/generated/
 * race-loss paths too, so checking it directly can never distinguish an
 * operator-set key from one auto-generated into `master.key` — precisely the
 * posture this rule exists to flag.
 */
export function checkProxyMasterKeyEnv(): SecuritySelfCheckFinding {
    const standaloneProxyConfigured =
        config.LIVETV_SOURCE === 'standalone' && config.STREAM_PROXY_URL.trim() !== '';
    const masterKeySource = getMasterKeySource();
    // fix-round-1: 'none' means resolveMasterKey() has not run in THIS
    // process yet — which also means its env back-fill (the reason this rule
    // can't trust process.env once resolution HAS happened) hasn't happened
    // either. Reading process.env directly is therefore still accurate here,
    // and skipping it would give an operator who genuinely set
    // LUMASTRA_MASTER_KEY a spurious warn if this rule is ever evaluated
    // before first resolution (e.g. a future caller that doesn't go through
    // the normal boot -> decryptLoadedConfig -> resolveMasterKey() path).
    const masterKeyFromEnv =
        masterKeySource === 'env' ||
        (masterKeySource === 'none' && !!process.env.LUMASTRA_MASTER_KEY?.trim());

    if (standaloneProxyConfigured && !masterKeyFromEnv) {
        return finding({
            id: 'proxy.master-key-not-explicit',
            method: 'secrets',
            type: 'config-static',
            status: 'warn',
            title: 'Standalone Live TV proxy configured with an auto-generated master key',
            detail: 'LIVETV_SOURCE=standalone and STREAM_PROXY_URL are set, but LUMASTRA_MASTER_KEY is unset — the encryption-at-rest key for every stored secret was auto-generated into master.key on first boot. The standalone proxy container must never be handed that key.',
            remediation:
                'Set LUMASTRA_MASTER_KEY to a strong random value (openssl rand -hex 32) in your .env, and only give it to the web/worker containers — never mount master.key or the `config` volume into lumastra-proxy.',
            evidence:
                'crypto/master-key.ts:getMasterKeySource; docker-compose.example.yml:lumastra-proxy',
        });
    }
    return finding({
        id: 'proxy.master-key-not-explicit',
        method: 'secrets',
        type: 'config-static',
        status: 'pass',
        title: 'Master key posture OK for the configured Live TV topology',
        detail: standaloneProxyConfigured
            ? 'LUMASTRA_MASTER_KEY is set explicitly.'
            : 'No standalone Live TV proxy is configured (LIVETV_SOURCE is not "standalone" or STREAM_PROXY_URL is unset).',
        evidence: 'config.ts:LIVETV_SOURCE,STREAM_PROXY_URL',
    });
}

/**
 * SETUP_UNLOCK left set (security review 6, ruling S-C5c-2). The variable is a
 * one-shot recovery for an install that lost every admin: at each start it
 * removes the setup lock while no admin exists. Left in place, the next time
 * the admins disappear (an IdP demotion or rename of the admin group) a restart
 * reopens the public first-run setup to anyone who can reach it.
 */
export function checkSetupUnlockLeftSet(): SecuritySelfCheckFinding {
    if (config.SETUP_UNLOCK) {
        return finding({
            id: 'setup.unlock-left-set',
            method: 'native',
            type: 'config-static',
            status: 'warn',
            title: 'SETUP_UNLOCK is still set',
            detail: 'SETUP_UNLOCK is a one-time recovery for an install with no admin. While it stays set, every restart that finds no admin removes the setup lock, and the public first-run setup at /setup is open to anyone who can reach it until an admin is created.',
            remediation:
                'Remove SETUP_UNLOCK from the container environment once an admin exists, and recreate the container.',
            evidence: 'config.ts:SETUP_UNLOCK; setup-lock.service.ts:reconcileSetupLock',
        });
    }
    return finding({
        id: 'setup.unlock-left-set',
        method: 'native',
        type: 'config-static',
        status: 'pass',
        title: 'Setup lock recovery is not armed',
        detail: 'SETUP_UNLOCK is not set; completed first-run setup stays locked.',
        evidence: 'config.ts:SETUP_UNLOCK',
    });
}

const CONFIG_RULES: ReadonlyArray<() => SecuritySelfCheckFinding> = [
    // Tier 1
    checkOidcAllowInsecure,
    checkDevFeaturesEnabled,
    checkJwtSecretMissing,
    checkJwtSecretStrength,
    checkOidcScopesMissingOpenid,
    checkProxyTrustAny,
    checkProxyUnpinned,
    checkProxyWideRange,
    checkForwardAuthEnabledPosture,
    checkStreamTokenIpPinningIneffective,
    // Tier 3 config-static
    checkNativeSessionTtl,
    checkNativeEnabled,
    checkOidcLinkByUsername,
    checkOidcMissingClient,
    checkCompatJellyfinEnabled,
    checkCompatSubsonicEnabled,
    checkCompatSubsonicCredsInQuery,
    // Tier 4 config-static
    checkDeviceVerificationBaseUrl,
    checkUndecryptableConfigSecrets,
    checkProxyMasterKeyEnv,
    checkSetupUnlockLeftSet,
];

/**
 * Run all config-static security checks and return the findings.
 *
 * Each rule is run independently in a try/catch — a rule that throws is
 * surfaced as an `error`-status finding, never propagated.
 */
export function runConfigRules(): SecuritySelfCheckFinding[] {
    const results: SecuritySelfCheckFinding[] = [];
    for (const rule of CONFIG_RULES) {
        try {
            results.push(rule());
        } catch (err) {
            // A rule failure must not abort the other rules.
            const name = rule.name ?? 'unknown';
            results.push(
                finding({
                    id: `config-rules.error.${name}`,
                    method: 'secrets',
                    type: 'config-static',
                    status: 'error',
                    title: `Config rule "${name}" threw an unexpected error`,
                    detail: err instanceof Error ? err.message : String(err),
                }),
            );
        }
    }
    return results;
}
