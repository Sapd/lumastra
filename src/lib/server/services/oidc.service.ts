// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OIDC Relying-Party service.
 *
 * Drives the Authorization Code + PKCE flow against a single configured OpenID
 * Connect provider and resolves the verified identity to a local user. Mints a
 * normal `lumastra_session` via the existing session service, so OIDC adds ZERO
 * per-request hot-path code — it rides the cookie populator + UserContext like
 * native login does.
 *
 * Security model:
 *   - state + nonce + PKCE on every request; state is server-side single-use
 *     (oidc-tx-store) AND mirrored to an HttpOnly cookie the callback must match,
 *     defending against login-CSRF.
 *   - openid-client verifies the ID token signature, iss, aud, exp and nonce.
 *   - Account linking resolves first by the stable issuer-scoped (provider, sub).
 *     It auto-links to an existing account by email ONLY when the IdP asserts the
 *     email as VERIFIED and it matches exactly one active, administrator-attested
 *     account email. A different subject already bound to that provider blocks
 *     linking. Otherwise a new user is provisioned.
 *   - Groups come from a configurable claim, synced to users.groups every login;
 *     admin is derived from ADMIN_GROUPS (with the admin_pinned manual override).
 *
 * AGPL-core; no module boundary touched.
 */

import { createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isUserAdmin } from '$lib/server/auth.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';
import {
    getUserById,
    getUserByUsername,
    getActiveUsersByEmail,
    upsertUser,
} from '$lib/server/database/queries/index.js';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';
import {
    linkUserByAdminEmail,
    oidcProviderKey,
    resolveUserIdByIdentity,
    recordIdentityBestEffort,
    provisionUserWithIdentity,
    IdentityProvisionRaceError,
    FirstRunAlreadyCompletedError,
} from '$lib/server/services/user-identity.service.js';
import {
    ensureSetupLocked,
    warnIfLastAdminDemoted,
} from '$lib/server/services/setup-lock.service.js';
import {
    parseClaims,
    extractGroups,
    deriveBaseUsername,
    deriveUsernameCandidate,
    type OidcClaims,
} from '$lib/server/services/oidc-claims.js';
import { storeTx, consumeTx } from '$lib/server/services/oidc-tx-store.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import { classifyFetchFailure, describeFetchFailure } from '$lib/server/utils/fetch-error-cause.js';
import * as m from '$lib/paraglide/messages';

const logger = Logger.for('OIDC');
const OIDC_PROBE_TIMEOUT_SECONDS = 5;
const MAX_ACTIVE_OIDC_PROBES = 2;
let activeOidcProbes = 0;

// ── Errors (mapped to HTTP status by the route) ──────────────────────────────

/** OIDC isn't enabled or is missing required config. */
export class OidcNotConfiguredError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'OidcNotConfiguredError';
    }
}
/** State/nonce/transaction validation failed (CSRF, replay, expiry). */
export class OidcStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OidcStateError';
    }
}
/** Token exchange or ID-token verification failed. */
export class OidcTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OidcTokenError';
    }
}
/** First user to onboard via OIDC must be in an admin group. */
export class OidcFirstUserNotAdminError extends Error {
    constructor() {
        super('The first user must be a member of an admin group.');
        this.name = 'OidcFirstUserNotAdminError';
    }
}
/** The resolved account is disabled (local kill-switch). */
export class OidcAccountDisabledError extends Error {
    constructor() {
        super('This account is disabled.');
        this.name = 'OidcAccountDisabledError';
    }
}

/**
 * Whether OIDC is enabled AND minimally configured (issuer + client id).
 *
 * Delegates to the derived config getter so the auth-path callers that must NOT
 * import this module (forward-auth middleware, boot preflight — openid-client is
 * heavy) evaluate the identical predicate.
 */
export function isOidcConfigured(): boolean {
    return config.AUTH_OIDC_LOGIN_AVAILABLE;
}

// ── Discovery (cached) ───────────────────────────────────────────────────────

interface CachedConfig {
    fingerprint: string;
    config: oidc.Configuration;
}
let cached: CachedConfig | null = null;

/** Fingerprint of the inputs that change the discovered configuration. */
function configFingerprint(): string {
    // Hash the secret VALUE (not just presence) so rotating the secret invalidates
    // the cached Configuration — otherwise a rotated secret would keep using the
    // stale one until process restart. Server-side, in-memory only.
    const secret = config.AUTH_OIDC_CLIENT_SECRET;
    const secretHash = secret
        ? createHash('sha256').update(secret).digest('hex').slice(0, 16)
        : '0';
    return [
        config.AUTH_OIDC_ISSUER,
        config.AUTH_OIDC_CLIENT_ID,
        secretHash,
        config.AUTH_OIDC_ALLOW_INSECURE ? '1' : '0',
    ].join('|');
}

export interface OidcProbeConfig {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    groupsClaim: string;
}

async function getOidcConfig(
    opts: { fresh?: boolean; candidate?: OidcProbeConfig } = {},
): Promise<oidc.Configuration> {
    if (!opts.candidate && !isOidcConfigured()) {
        throw new OidcNotConfiguredError(
            'OIDC is not enabled or is missing AUTH_OIDC_ISSUER / AUTH_OIDC_CLIENT_ID.',
        );
    }
    const fingerprint = configFingerprint();
    if (!opts.candidate && !opts.fresh && cached && cached.fingerprint === fingerprint)
        return cached.config;

    const issuer = opts.candidate?.issuer ?? config.AUTH_OIDC_ISSUER;
    const insecure = !opts.candidate && config.AUTH_OIDC_ALLOW_INSECURE;
    let issuerUrl: URL;
    try {
        issuerUrl = new URL(issuer);
    } catch {
        throw new OidcNotConfiguredError(m.setup_oidc_issuer_invalid());
    }
    if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
        throw new OidcNotConfiguredError(m.setup_oidc_issuer_invalid());
    }
    if (!insecure && issuerUrl.protocol !== 'https:') {
        throw new OidcNotConfiguredError(m.setup_oidc_issuer_https());
    }

    const secret = opts.candidate?.clientSecret ?? config.AUTH_OIDC_CLIENT_SECRET;
    if (insecure) {
        // Loud, unmissable warning: this disables TLS verification for ALL OIDC
        // traffic (discovery/token/userinfo), exposing the ID-token exchange to
        // MitM. It exists only for local plain-HTTP test IdPs. Logged once per
        // discovery (cached), so it recurs only on config change / restart.
        logger.warn(
            '⚠ AUTH_OIDC_ALLOW_INSECURE is ENABLED — TLS verification is DISABLED for all ' +
                'OIDC requests. This is for LOCAL TEST IdPs ONLY and MUST NOT be used in production.',
        );
    }
    const options: oidc.DiscoveryRequestOptions = {
        timeout: opts.fresh ? OIDC_PROBE_TIMEOUT_SECONDS : 15,
    };
    if (insecure) options.execute = [oidc.allowInsecureRequests];
    if (opts.fresh) {
        const deadline = AbortSignal.timeout(OIDC_PROBE_TIMEOUT_SECONDS * 1000);
        options[oidc.customFetch] = (url, init) =>
            globalThis.fetch(url, {
                ...init,
                body: undefined,
                redirect: 'error',
                signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
            });
    }

    try {
        const discovered = await oidc.discovery(
            issuerUrl,
            opts.candidate?.clientId ?? config.AUTH_OIDC_CLIENT_ID,
            secret || undefined,
            undefined,
            options,
        );
        if (!opts.candidate && !opts.fresh) cached = { fingerprint, config: discovered };
        return discovered;
    } catch (error) {
        const failure = classifyFetchFailure(error);
        logger.warn('OIDC discovery failed', {
            failure,
            error: describeFetchFailure(error, [secret]),
        });
        const message =
            failure === 'tls'
                ? m.setup_oidc_discovery_tls()
                : failure === 'unreachable'
                  ? m.setup_oidc_discovery_unreachable()
                  : m.setup_oidc_discovery_invalid();
        throw new OidcNotConfiguredError(message, { cause: error });
    }
}

/** Clear the cached discovery (e.g. after a config change). Mainly for tests. */
export function resetOidcConfigCache(): void {
    cached = null;
}

/**
 * Result of a discovery probe — powers the first-run wizard's "Test connection"
 * button. Never contains secrets: only public discovery metadata + derived checks.
 */
export interface OidcProbeResult {
    /** Discovery document fetched + parsed successfully. */
    ok: boolean;
    /** Human-readable failure reason when `ok` is false (already non-leaky). */
    error?: string;
    /** `true` when AUTH_OIDC_ALLOW_INSECURE disabled TLS verification for the probe. */
    insecure: boolean;
    /** Scopes the app is configured to request (AUTH_OIDC_SCOPES). */
    requestedScopes: string[];
    /** OP-advertised issuer (from the discovery document). */
    issuer?: string;
    /** Key public endpoints, for the operator to eyeball. */
    endpoints?: {
        authorization?: string;
        token?: string;
        userinfo?: string;
        jwks?: string;
        endSession?: string;
    };
    /** scopes_supported from discovery, when the OP advertises it. */
    scopesSupported?: string[];
    /** Requested scopes the OP does NOT advertise (only when scopesSupported known). */
    missingScopes?: string[];
    /** `true`/`false` when the OP advertises code_challenge_methods_supported; else undefined. */
    supportsPkceS256?: boolean;
    /** `true` when the OP advertises back-channel logout support; else undefined. */
    supportsBackchannelLogout?: boolean;
    /** The configured groups claim (AUTH_OIDC_GROUPS_CLAIM) — admin mapping reads it. */
    groupsClaim: string;
    /** claims_supported from discovery, when the OP advertises it. */
    claimsSupported?: string[];
    /**
     * Whether the OP advertises the configured groups claim. Only set for a simple
     * (non-nested) claim name AND when claims_supported is advertised — otherwise
     * undefined ("unknown"), since many OPs omit custom claims from the list.
     */
    groupsClaimAdvertised?: boolean;
    /** Whether the OP advertises an `email` claim (link-by-verified-email needs it). */
    emailAdvertised?: boolean;
    /** Whether the OP advertises a `preferred_username` claim (username derivation). */
    preferredUsernameAdvertised?: boolean;
}

/**
 * Probe the configured OIDC issuer's discovery document and derive a few sanity
 * checks (scope coverage, PKCE S256, back-channel logout). Read-only, uses ONLY
 * server config or an unsaved setup candidate, and reuses the same discovery
 * path (+ https / allow-insecure guards) the login flow uses. Failures resolve to
 * `{ ok: false, error }` rather than throwing, so the wizard can render them.
 */
export async function probeOidcDiscovery(candidate?: OidcProbeConfig): Promise<OidcProbeResult> {
    const requestedScopes = (candidate?.scopes ?? config.AUTH_OIDC_SCOPES)
        .split(/\s+/)
        .filter(Boolean);
    const groupsClaim = candidate?.groupsClaim ?? config.AUTH_OIDC_GROUPS_CLAIM;
    const insecure = !candidate && config.AUTH_OIDC_ALLOW_INSECURE;
    // Before the first admin exists, unauthenticated callers can choose an issuer.
    // LAN/private IdPs and distinct failure messages are intentional: no private-range
    // denylist, so this remains a bounded reachability oracle during setup. Discovery
    // rejects redirects, has a five-second deadline, and shares two process-wide slots
    // across oidc-config and oidc-test, in addition to their shared per-IP rate limit.
    // Reject overflow immediately rather than accepting an unbounded wait queue.
    if (activeOidcProbes >= MAX_ACTIVE_OIDC_PROBES) {
        return {
            ok: false,
            error: m.setup_oidc_discovery_busy(),
            insecure,
            requestedScopes,
            groupsClaim,
        };
    }
    activeOidcProbes++;
    try {
        // Fresh discovery: a cached Configuration answered "ok" while the IdP
        // was down or its discovery document had changed. A failure here does
        // not clear the cache, so working logins keep working.
        const cfg = await getOidcConfig({ fresh: true, candidate });
        const meta = cfg.serverMetadata();

        // A falsy issuer means a broken/incomplete discovery document — report it as
        // a failure rather than a reachable "ok" (mirrors getOidcServerMetadata).
        const validEndpoint = (value: unknown): boolean => {
            if (typeof value !== 'string' || !value) return false;
            try {
                const endpoint = new URL(value);
                return (
                    !endpoint.username &&
                    !endpoint.password &&
                    !endpoint.hash &&
                    (endpoint.protocol === 'https:' || (insecure && endpoint.protocol === 'http:'))
                );
            } catch {
                return false;
            }
        };
        if (
            !validEndpoint(meta.issuer) ||
            !validEndpoint(meta.authorization_endpoint) ||
            !validEndpoint(meta.token_endpoint) ||
            !validEndpoint(meta.jwks_uri)
        ) {
            return {
                ok: false,
                error: m.setup_oidc_discovery_invalid(),
                insecure,
                requestedScopes,
                groupsClaim,
            };
        }

        const asStringArray = (v: unknown): string[] | undefined =>
            Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;

        const scopesSupported = asStringArray(meta.scopes_supported);
        const missingScopes = scopesSupported
            ? requestedScopes.filter((s) => !scopesSupported.includes(s))
            : undefined;
        const ccm = asStringArray(meta.code_challenge_methods_supported);

        // Claim-mapping sanity: the first OIDC sign-in must land in an admin group
        // (mapped from the groups claim), so surface whether the OP advertises the
        // claims we depend on. claims_supported is optional AND often omits custom
        // claims (groups especially) → treat "advertised" checks as best-effort:
        // undefined = unknown, never a hard fail.
        const claimsSupported = asStringArray(meta.claims_supported);
        // A nested path (a.b.c) can't be matched against the flat claims_supported
        // list, so only check simple, top-level claim names.
        const groupsClaimIsSimple = groupsClaim.length > 0 && !groupsClaim.includes('.');
        const groupsClaimAdvertised =
            claimsSupported && groupsClaimIsSimple
                ? claimsSupported.includes(groupsClaim)
                : undefined;

        return {
            ok: true,
            insecure,
            requestedScopes,
            issuer: meta.issuer,
            endpoints: {
                authorization: meta.authorization_endpoint,
                token: meta.token_endpoint,
                userinfo: meta.userinfo_endpoint,
                jwks: meta.jwks_uri,
                endSession: meta.end_session_endpoint,
            },
            scopesSupported,
            missingScopes,
            // Only assert PKCE support when the OP actually advertises the list;
            // an OP that omits it may still support S256 → leave undefined ("unknown").
            supportsPkceS256: ccm ? ccm.includes('S256') : undefined,
            supportsBackchannelLogout:
                meta.backchannel_logout_supported === true ? true : undefined,
            groupsClaim,
            claimsSupported,
            groupsClaimAdvertised,
            emailAdvertised: claimsSupported ? claimsSupported.includes('email') : undefined,
            preferredUsernameAdvertised: claimsSupported
                ? claimsSupported.includes('preferred_username')
                : undefined,
        };
    } catch (error) {
        const message =
            error instanceof OidcNotConfiguredError
                ? error.message
                : m.setup_oidc_discovery_invalid();
        return {
            ok: false,
            error: message,
            insecure,
            requestedScopes,
            groupsClaim,
        };
    } finally {
        activeOidcProbes--;
    }
}

/** OP issuer + JWKS URI from cached discovery — for logout-token verification. */
export async function getOidcServerMetadata(): Promise<{ issuer: string; jwksUri: string }> {
    const cfg = await getOidcConfig();
    const meta = cfg.serverMetadata();
    if (!meta.issuer) {
        // A falsy issuer would cause jose's jwtVerify to skip issuer validation,
        // accepting tokens from any issuer. Treat this as a configuration error.
        throw new OidcNotConfiguredError('OP discovery returned an empty issuer.');
    }
    if (!meta.jwks_uri) {
        throw new OidcNotConfiguredError('OP discovery has no jwks_uri.');
    }
    return { issuer: meta.issuer, jwksUri: meta.jwks_uri };
}

// ── Flow: start ──────────────────────────────────────────────────────────────

export interface OidcLoginStart {
    /** URL to redirect the browser to (the IdP authorization endpoint). */
    authorizationUrl: string;
    /** Opaque state value; the route also stores this in an HttpOnly cookie. */
    state: string;
}

/**
 * Begin a login: generate PKCE + state + nonce, persist the transaction, and build
 * the authorization URL. `returnTo` must already be a validated same-origin
 * relative path (open-redirect guard lives in the route).
 */
export async function startLogin(params: {
    redirectUri: string;
    returnTo: string;
}): Promise<OidcLoginStart> {
    const cfg = await getOidcConfig();

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const stored = await storeTx(state, {
        nonce,
        codeVerifier,
        returnTo: params.returnTo,
        redirectUri: params.redirectUri,
    });
    if (!stored) {
        throw new OidcStateError('Could not start login (session cache unavailable).');
    }

    const authorizationUrl = oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: params.redirectUri,
        scope: config.AUTH_OIDC_SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
    });

    return { authorizationUrl: authorizationUrl.href, state };
}

// ── Flow: callback (exchange + verify + parse) ───────────────────────────────

export interface OidcCallbackResult {
    claims: OidcClaims;
    /** Validated same-origin relative path to land on. */
    returnTo: string;
    /** OP session id (`sid`) from the ID token, if the OP issues one (enables
     *  per-session Back-Channel Logout). Absent → sub-scoped logout only. */
    sessionId?: string;
}

/**
 * Validate the callback and return the verified, normalized claims. Verifies that
 * the query `state` matches the cookie-bound `state` (login-CSRF), consumes the
 * single-use transaction, exchanges the code (openid-client checks
 * sig/iss/aud/exp/nonce/PKCE), and optionally enriches from UserInfo.
 */
export async function handleCallback(params: {
    currentUrl: URL;
    cookieState: string | null;
    /**
     * Opaque correlation reference minted by /auth/oidc/callback and shown to the
     * user as "(reference: …)". Threaded through so the log lines in here — which
     * are often the ones that actually explain a failure — can be greped with the
     * same key the user pasted into their bug report. Never leaves the log.
     */
    ref?: string;
}): Promise<OidcCallbackResult> {
    const cfg = await getOidcConfig();

    const queryState = params.currentUrl.searchParams.get('state');
    if (!queryState || !params.cookieState || queryState !== params.cookieState) {
        throw new OidcStateError('Login state mismatch (possible CSRF or expired login).');
    }

    const tx = await consumeTx(queryState);
    if (!tx) {
        throw new OidcStateError('Unknown or expired login transaction.');
    }

    let tokens;
    try {
        tokens = await oidc.authorizationCodeGrant(cfg, params.currentUrl, {
            pkceCodeVerifier: tx.codeVerifier,
            expectedState: queryState,
            expectedNonce: tx.nonce,
            idTokenExpected: true,
        });
    } catch (error) {
        throw new OidcTokenError(`Token exchange/verification failed: ${String(error)}`);
    }

    const idClaims = tokens.claims();
    if (!idClaims || typeof idClaims.sub !== 'string') {
        throw new OidcTokenError('ID token missing or has no subject.');
    }

    let raw: Record<string, unknown> = { ...idClaims };

    // Optionally enrich from UserInfo when the ID token lacks groups or email.
    const groupsPath = config.AUTH_OIDC_GROUPS_CLAIM;
    const needsEnrichment =
        config.AUTH_OIDC_USERINFO &&
        (extractGroups(raw, groupsPath).length === 0 || typeof raw.email !== 'string');
    if (needsEnrichment) {
        try {
            const userinfo = await oidc.fetchUserInfo(cfg, tokens.access_token, idClaims.sub);
            // ID token claims win on conflict; userinfo only fills gaps.
            raw = { ...(userinfo as Record<string, unknown>), ...idClaims };
        } catch (error) {
            logger.warn('UserInfo fetch failed; continuing with ID-token claims only', {
                error: String(error),
                ref: params.ref,
            });
        }
    }

    const claims = parseClaims(raw, groupsPath);
    if (!claims.subject || !claims.issuer) {
        throw new OidcTokenError('ID token missing sub/iss after parsing.');
    }

    // Operational nudge: a configured NESTED groups path that resolves to nothing is
    // almost always a misconfiguration (wrong path, or an array intermediate — the
    // terminal node must itself be the array). Silently empty groups would deny
    // admin / permissions with no clue, so surface it.
    if (groupsPath.includes('.') && claims.groups.length === 0) {
        logger.warn('OIDC groups claim resolved to no groups; check AUTH_OIDC_GROUPS_CLAIM', {
            groupsClaim: groupsPath,
            ref: params.ref,
        });
    }

    // Treat an empty-string sid as absent so we never store '' (which would later
    // match unrelated empty-sid rows in a sid-scoped logout).
    const sessionId =
        typeof idClaims.sid === 'string' && idClaims.sid.length > 0 ? idClaims.sid : undefined;

    return { claims, returnTo: tx.returnTo, sessionId };
}

// ── Account resolution / provisioning ────────────────────────────────────────

export type OidcLinkType =
    'existing-identity' | 'linked-by-email' | 'linked-by-username' | 'provisioned';

export interface ResolvedOidcUser {
    userId: string;
    username: string;
    isAdmin: boolean;
    linkType: OidcLinkType;
}

/**
 * Sync groups + admin for a RETURNING OIDC-identity login. Admin is PROMOTE-ONLY:
 * OIDC group membership can GRANT admin but never silently DEMOTES an existing
 * admin. Demotion is a deliberate admin action (PATCH /unpin) — auto-demoting on a
 * login whose groups happen to lack admin risks accidental last-admin lockout, and
 * would let a verified-email link strip a matched admin. Pinned admins are already
 * protected by upsertUser's CASE; for non-pinned users we pass `currentIsAdmin ||
 * groupAdmin` so is_admin never drops below its current value.
 *
 * X3 FIX (security review 2026-09-23, final fix wave): `upsertUser()`'s
 * return value used to be discarded entirely — an OIDC re-promotion (a
 * previously-demoted, unpinned admin whose OIDC groups now grant admin
 * again) never restored their admin-scoped PAT/service-token access, the
 * exact "narrowed forever" bug fix-plan-3 fixed for the OTHER admin-sync
 * paths.
 *
 * STALE-COMMENT CORRECTION (fix round 3, MINOR): this paragraph originally
 * claimed `upserted.demoted` is always `false` by construction here, so
 * "only the restore arm is ever reachable" — true of the round-1 approach,
 * which fed the upsert's own column-based `demoted`/`promoted` flags to the
 * shared transition helper. Round 2's X3-OIDC-arm fix (see the comment on
 * the Formula-A `before`/`after` capture below) replaced that: it computes
 * the FORMULA-A verdict before and after this write + `syncUserGroups()`,
 * which CAN see a real demotion (an unpinned admin-by-group user losing
 * their IdP admin group) even though the column write stays promote-only.
 * Both the demote and the restore arm of `applyAdminStatusTransition()` are
 * reachable from here now. Best-effort: never throws, only warns, matching
 * `forward-auth.ts`'s identical posture for its own IdP-sync narrow/restore.
 */
async function syncUserOnLogin(
    sql: postgres.Sql,
    username: string,
    groups: string[],
    currentIsAdmin: boolean,
): Promise<void> {
    // X3 FIX (fix round 2 — the round-1 "structurally unreachable" analysis
    // was REFUTED by re-review): `upsertUser()`'s `demoted`/`promoted` flags
    // are COLUMN-based and, by this function's own promote-only design, the
    // column can never DECREASE from this call — but `syncUserGroups()` right
    // below rewrites `users.groups`, and for an UNPINNED user Formula A does
    // NOT read the column at all (it reads groups + in-app). So losing the
    // IdP admin group on an OIDC login for an unpinned admin-by-group user
    // IS a real Formula-A demotion, even though the column-based flags never
    // see it (repro: unpinned, is_admin column stuck `true` from a past
    // login, groups now lack the admin group — Formula A goes true→false,
    // `upserted.demoted` stays `false` throughout). Capture the Formula-A
    // verdict BEFORE this write (and before `syncUserGroups`) and again AFTER
    // both have committed, and feed THAT pair to the shared transition
    // helper instead of the column-based flags. This does NOT change the
    // promote-only column write itself (`isAdmin: currentIsAdmin ||
    // isUserAdmin(groups)` below is untouched) — only which signal decides
    // the CREDENTIAL narrow/restore.
    const before = await resolveOwnerAdminStatus(sql, username);

    // The upsert's own return value (`demoted`/`promoted`, column-based) is
    // deliberately NOT used to drive the credential transition any more —
    // see the comment above.
    await upsertUser(sql, {
        username,
        isAdmin: currentIsAdmin || isUserAdmin(groups),
    });
    // syncUserGroups invalidates the admin/max-age caches this write feeds
    // (security review 5, C4 + Shape C) — a returning OIDC login used to
    // write groups without invalidating either.
    await syncUserGroups(sql, username, groups);

    if (before) {
        try {
            const after = await resolveOwnerAdminStatus(sql, username);
            if (after) {
                const { applyAdminStatusTransition } =
                    await import('$lib/server/services/credential-revocation.service.js');
                const { failedStores } = await applyAdminStatusTransition(
                    sql,
                    after.userId,
                    username,
                    before.isAdmin,
                    after.isAdmin,
                );
                if (failedStores.length > 0) {
                    logger.warn('OIDC login: some admin-scoped credential stores failed to sync', {
                        username,
                        failedStores,
                    });
                }
                // Setup lock (S-C5c-2): the OIDC genesis admin is unpinned too,
                // so an IdP change can remove the last admin here as well.
                if (before.isAdmin && !after.isAdmin) {
                    await warnIfLastAdminDemoted(sql, {
                        username,
                        source: 'oidc',
                        adminGroupNames: config.ADMIN_GROUPS,
                        demotedUserId: after.userId,
                    });
                }
            }
        } catch (e) {
            logger.warn(
                'OIDC login: failed to sync admin-scoped credentials after admin transition',
                {
                    username,
                    error: String(e),
                },
            );
        }
    }
}

/**
 * Make sure the setup lock exists after this sign-in produced an admin
 * (ruling S-C5c-2). Best-effort: a failure must not fail the sign-in, and the
 * next container start re-writes a missing lock whenever an admin exists.
 */
async function lockSetupForNewAdmin(
    sql: postgres.Sql,
    userId: string,
    ref: string | undefined,
): Promise<void> {
    try {
        await ensureSetupLocked(sql, userId);
    } catch (error) {
        logger.warn('OIDC login: could not write the setup lock for a new admin', {
            error: String(error),
            ref,
        });
    }
}

/**
 * Resolve the verified OIDC claims to a local user, provisioning or linking as
 * needed. This is the security-critical heart — see the account-linking model in
 * the module header. `firstRunRequiresAdmin` mirrors completeForwardAuthSetup: on a
 * fresh install the first onboarding user must be an admin.
 */
export async function resolveOrProvisionOidcUser(
    sql: postgres.Sql,
    claims: OidcClaims,
    opts: { firstRunRequiresAdmin: boolean; ref?: string },
): Promise<ResolvedOidcUser> {
    if (!claims.subject || !claims.issuer) {
        throw new OidcTokenError('Cannot resolve user: claims missing sub/iss.');
    }

    const provider = oidcProviderKey(claims.issuer);
    const groups = claims.groups;
    const groupAdmin = isUserAdmin(groups);

    // 1) Stable resolution by (provider, sub).
    const existingUserId = await resolveUserIdByIdentity(sql, provider, claims.subject);
    if (existingUserId) {
        const user = await getUserById(sql, existingUserId);
        if (user) {
            if (user.disabled_at) throw new OidcAccountDisabledError();
            await recordIdentityBestEffort(sql, {
                provider,
                subject: claims.subject,
                userId: existingUserId,
                email: claims.email,
                emailVerified: claims.emailVerified,
            });
            await syncUserOnLogin(sql, user.username, groups, user.is_admin);
            const effectiveAdmin = user.admin_pinned ? user.is_admin : user.is_admin || groupAdmin; // promote-only
            // This sign-in made an existing account admin (first run after an
            // unlock, or any IdP promotion): make sure setup is locked
            // (ruling S-C5c-2).
            if (effectiveAdmin && (opts.firstRunRequiresAdmin || !user.is_admin)) {
                await lockSetupForNewAdmin(sql, existingUserId, opts.ref);
            }
            return {
                userId: existingUserId,
                username: user.username,
                isAdmin: effectiveAdmin,
                linkType: 'existing-identity',
            };
        }
        // Identity points at a vanished user (FK should prevent this) — fall through.
    }

    // First-run admin gate (before creating/linking anything).
    if (opts.firstRunRequiresAdmin && !groupAdmin) {
        throw new OidcFirstUserNotAdminError();
    }

    // 2) Link ONLY by a verified, unambiguous, administrator-attested email.
    if (config.AUTH_OIDC_LINK_BY_VERIFIED_EMAIL && claims.emailVerified && claims.email) {
        const matches = await getActiveUsersByEmail(sql, claims.email);
        if (matches.length === 1) {
            const target = await linkUserByAdminEmail(sql, {
                userId: matches[0].id,
                email: claims.email,
                identity: { provider, subject: claims.subject },
            });
            if (target) {
                // Preserve privileges on first link; later stable-identity logins
                // sync groups through the ordinary existing-identity path.
                logger.info('Linked OIDC login to existing account by verified email', {
                    username: target.username,
                });
                return {
                    userId: target.id,
                    username: target.username,
                    isAdmin: target.is_admin,
                    linkType: 'linked-by-email',
                };
            }
        }
        if (matches.length > 1) {
            // Ambiguous — never guess a takeover target; provision a fresh account.
            logger.warn('OIDC verified email matches multiple accounts; provisioning new', {
                matchCount: matches.length,
                ref: opts.ref,
            });
        }
    }

    // 2b) OPT-IN, LESS SAFE: link by matching username (native→OIDC migration).
    // A username is not a verified identity proof, so this is gated behind an
    // explicit admin flag and tried only after verified-email linking. We match the
    // username the token explicitly signals (preferred_username / email local-part),
    // never the generic provisioning fallback, and never a disabled account.
    if (config.AUTH_OIDC_LINK_BY_USERNAME) {
        const candidate = deriveUsernameCandidate(claims);
        if (candidate) {
            const existing = await getUserByUsername(sql, candidate);
            if (existing && !existing.disabled_at) {
                await recordIdentityBestEffort(sql, {
                    provider,
                    subject: claims.subject,
                    userId: existing.id,
                    email: claims.email,
                    emailVerified: claims.emailVerified,
                });
                // Preserve the pre-existing account's privileges on link (see the
                // verified-email path); syncing happens on subsequent logins.
                logger.warn('Linked OIDC login to existing account by USERNAME match', {
                    username: existing.username,
                    ref: opts.ref,
                });
                return {
                    userId: existing.id,
                    username: existing.username,
                    isAdmin: existing.is_admin,
                    linkType: 'linked-by-username',
                };
            }
        }
    }

    // 3) Provision a brand-new user + identity.
    const base = deriveBaseUsername(claims);
    try {
        const provisioned = await provisionUserWithIdentity(sql, {
            baseUsername: base,
            isAdmin: groupAdmin,
            groups,
            email: claims.emailVerified ? claims.email : null,
            emailVerified: claims.emailVerified,
            // `users.display_name` renders to OTHER users (viewer lists on a
            // shared screen) and to admins, so the IdP's `name` claim is
            // attacker-influenced free text at a write boundary — sanitised on
            // exactly the same grounds as the forward-auth name header. A claim
            // that sanitises away entirely becomes null, i.e. fall back to the
            // username rather than persist a blank label.
            displayName: claims.name ? sanitizeDisplayName(claims.name) || null : null,
            identity: { provider, subject: claims.subject },
            // First run: the same check-then-act under FIRST_ADMIN_LOCK_KEY as
            // native and forward-auth setup, writing the setup lock with the
            // new admin (ruling S-C5c-2).
            firstRunSetup: opts.firstRunRequiresAdmin
                ? { adminGroupNames: config.ADMIN_GROUPS }
                : undefined,
        });
        // A first-run provision wrote the lock in its own transaction; any
        // other new admin makes sure it exists (ruling S-C5c-2).
        if (groupAdmin && !opts.firstRunRequiresAdmin) {
            await lockSetupForNewAdmin(sql, provisioned.userId, opts.ref);
        }
        return {
            userId: provisioned.userId,
            username: provisioned.username,
            isAdmin: groupAdmin,
            linkType: 'provisioned',
        };
    } catch (error) {
        // Setup completed between the caller's first-run check and the
        // first-admin lock. Nothing was written; resolve this sign-in as an
        // ordinary post-setup login, exactly as if it had arrived a moment
        // later. Admin still comes only from the IdP groups (`groupAdmin`).
        if (error instanceof FirstRunAlreadyCompletedError) {
            return resolveOrProvisionOidcUser(sql, claims, {
                ...opts,
                firstRunRequiresAdmin: false,
            });
        }
        // Concurrent first-login for the same subject — re-resolve the winner.
        if (error instanceof IdentityProvisionRaceError) {
            const winner = await resolveUserIdByIdentity(sql, provider, claims.subject);
            if (winner) {
                const user = await getUserById(sql, winner);
                if (user?.disabled_at) throw new OidcAccountDisabledError();
                if (user) {
                    await syncUserOnLogin(sql, user.username, groups, user.is_admin);
                    const winnerAdmin = user.admin_pinned
                        ? user.is_admin
                        : user.is_admin || groupAdmin;
                    if (winnerAdmin && !user.is_admin) {
                        await lockSetupForNewAdmin(sql, winner, opts.ref);
                    }
                    return {
                        userId: winner,
                        username: user.username,
                        isAdmin: winnerAdmin,
                        linkType: 'existing-identity',
                    };
                }
            }
        }
        throw error;
    }
}
