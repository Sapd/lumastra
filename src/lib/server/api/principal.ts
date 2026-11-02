// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * principal.ts — normalized identity for EVERY credential path.
 *
 * `Principal` is the single representation that `enforce()` in mount.ts reads.
 * It is populated by `resolveAuth` in forward-auth.ts for every credential path
 * (forward-auth, session, PAT, service token, JWT, stream token) so that
 * `enforce()` NEVER needs to inspect headers, URL prefixes, or credential type
 * to make auth decisions.
 *
 * Fixes the "admin-token-rejected bug class":
 *   - Sessions keep their group/pin verdict (isAdmin from DB).
 *   - Tokens (PAT/svc/device JWT) are admin ONLY when ownerIsAdmin AND an
 *     explicit admin-equivalent scope is present — closes the inverse leak
 *     where a low-scope PAT owned by an admin was treated as admin.
 *
 * Design invariants:
 *   - `enforce()` reads ONLY from `Principal` — never from the URL prefix or
 *     raw headers. Surface is cosmetic only.
 *   - `deriveIsAdmin()` is the SINGLE helper that implements the two-condition
 *     rule consistently across all credential kinds.
 *   - `expandScopes()` is called once at principal-build time; `enforce()` and
 *     `scopeGranted()` consult the expanded set.
 */

import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Credential kind
// ---------------------------------------------------------------------------

/**
 * Which credential path produced this Principal.
 *
 * `forward_auth` — Authentik/proxy identity headers (browser, authenticated surface).
 * `session`       — server-minted native/OIDC session cookie.
 * `bearer`        — OAuth device-flow JWT access token.
 * `pat`           — Personal Access Token (`pat_*`).
 * `service_token` — Service Token (`svc_*`).
 * `stream_token`  — Short-lived streaming session token (`stream_*`).
 */
export type PrincipalKind =
    | 'forward_auth'
    | 'session'
    | 'bearer'
    | 'pat'
    | 'service_token'
    | 'stream_token'
    /**
     * A Jellyfin client on /j: a password session (the owner's full credential,
     * admin when the owner is) or a /j API key (never admin). Built by the
     * compat middleware, not resolveAuth.
     */
    | 'jellyfin_compat';

// ---------------------------------------------------------------------------
// Principal type
// ---------------------------------------------------------------------------

/**
 * Normalized identity stashed on `event.locals.principal`.
 *
 * Built once per request by `resolveAuth` (forward-auth.ts); read by
 * `enforce()` in mount.ts. Every field is stable across the request lifetime.
 *
 * `scopes` is the EXPANDED scope set (after `expandScopes()`). Callers must
 * not call `expandScopes()` again — check membership directly.
 */
export interface Principal {
    /** Which credential path resolved this identity. */
    kind: PrincipalKind;
    /** Set only by validated non-impersonating service-token resolution; never inferred from a username. */
    syntheticServiceIdentity?: boolean;

    /**
     * Stable `users.id` UUID — the canonical user-data key.
     * Never use `username` for data queries; always use this.
     */
    userId: UserId;

    /** Display/login handle. Mutable; for display only. */
    username: string;

    /**
     * Effective group memberships (IdP + in-app, already merged by resolveAuth).
     * These are the FULL effective groups, not just the credential's snapshot.
     */
    userGroups: string[];

    /**
     * Expanded scope set. For session/forward-auth/stream-token credentials that
     * carry no explicit scopes, this is derived from group-based permissions
     * (e.g. `['read', 'write', 'admin']` for an admin session).
     * For token credentials, this is the token's explicit scopes after expansion.
     */
    scopes: string[];

    /**
     * True when this identity has admin authority.
     *
     * Computed by `deriveIsAdmin()`:
     *   - Session/forward_auth: group/pin verdict from DB.
     *   - Token credentials: ownerIsAdmin AND explicit admin-equivalent scope.
     *
     * `enforce({kind:'admin'})` reads ONLY this field — never re-derives.
     */
    isAdmin: boolean;

    /**
     * Device-flow `client_id` claim, present ONLY on `kind === 'bearer'`.
     *
     * ATTRIBUTION METADATA — never grants authority. `enforce()` must never
     * read this field. Device approval conservatively refuses matching client
     * IDs to prevent self-approval. `/oauth/device` is unauthenticated and has no
     * client-registration step, so this string is entirely self-declared: any
     * caller can claim `lumastra-ios`. It rides on Principal only because that
     * is the one object carried from `resolveAuth` to the handlers, and its
     * consumers label the play surface and device-approval audit trail.
     */
    clientId?: string;

    /**
     * The specific credential that produced this identity, when the credential
     * path has one: the PAT id (`kind:'pat'`), the service-token id
     * (`kind:'service_token'`), the session id (`kind:'session'`), or the
     * streaming-session id (`kind:'stream_token'`). `undefined` for
     * `forward_auth` (a proxy header identity has no single credential row)
     * and for any bearer JWT that carries no `deviceSessionId` claim.
     *
     * Generic `enforce()` must never read this field. The device-approval gate
     * additionally resolves a bearer credentialId against live database session
     * rows to require independent sign-in and persist approval lineage. It also
     * lets `auditActor()` (audit-log.ts) record which credential performed an
     * audited admin action, so
     * a stolen PAT/service token is attributable to that credential rather
     * than just to the username it authenticates as.
     */
    credentialId?: string;

    /**
     * The service token's `allowed_path_prefixes`, present ONLY on
     * `kind === 'service_token'` and only when the token is path-bound.
     *
     * Server-authoritative (copied from the validated `service_tokens` row),
     * never client-supplied. `tokenEnvelopeDenial()` has already refused any
     * request outside these prefixes before a handler runs; no handler needs to
     * re-check them (the integration endpoints gate on the `integrations:read`
     * grant instead — see `tokenOwnerIsAdmin`).
     */
    tokenPathPrefixes?: string[];

    /**
     * The service token's OWNER verdict (Formula A, resolved by
     * `owner_user_id` on every request in `token-identity.ts`), present ONLY
     * on `kind === 'service_token'` for a non-impersonating token that holds
     * the `integrations:read` or `diagnostics:read` grant. Authorization input
     * for `integrationTokenDenial()` (`auth/integration-token.ts`) and
     * `diagnosticsAccessDenial()` (`auth/diagnostics-grant.ts`): those grants
     * confer no `isAdmin`, yet still need an owner who is an administrator.
     * Absent means "not established" and is treated as `false`.
     */
    tokenOwnerIsAdmin?: boolean;
}

// ---------------------------------------------------------------------------
// deriveIsAdmin() — the single admin-gate rule
// ---------------------------------------------------------------------------

/**
 * Derive admin status for a principal being built.
 *
 * Two paths:
 *   1. Session/forward-auth/stream-token: use the DB-authoritative verdict
 *      already computed by resolveAuth (passed as `sessionIsAdmin`).
 *   2. Token credentials (PAT/svc/device JWT): admin IFF ownerIsAdmin (groups)
 *      AND the token carries an explicit admin-equivalent scope
 *      (`'admin'` or `'tasks:admin'`).
 *
 * This closes two bugs:
 *   - A low-scope PAT owned by an admin → NOT admin (scopes don't include admin).
 *   - An admin PAT/svc token → IS admin (explicit scope + owner is admin).
 *
 * `forceNonAdmin` is a kill-switch: a service token with forceNonAdmin=true
 * is never admin regardless of scope or owner group.
 *
 * LOAD-BEARING INVARIANT (fix round 1, Important #4, 2026-09-13 deferred
 * fix): `hasAdminScope`'s `'tasks:admin'` branch is not just this function's
 * own concern. `middleware/auth.ts`'s `requireAdmin()` (the gate on ~50
 * legacy route files under `src/routes/`) and `token-minting.ts`'s
 * `callerIsAdmin()` (the minting ceiling) both resolve their Bearer-token
 * admin verdict through the shared `resolveBearerAdminPrincipal()` helper
 * (`$lib/server/auth/resolve-bearer-principal.ts`), which calls THIS
 * function via `buildPrincipal()`. So the moment `'tasks:admin'` becomes a
 * mintable PAT/service-token scope (today `patScopeSchema` /
 * `serviceTokenScopeSchema` do not admit it — no credential can carry it),
 * a `tasks:admin`-only token owned by an admin would acquire admin on ALL
 * of: every `kind:'admin'` mount() def, every legacy `requireAdmin()` route,
 * AND the token-minting ceiling — not just the task-system surface its name
 * suggests. If you widen the scope vocabulary to allow `tasks:admin` to be
 * minted, revisit whether that blast radius is still intended.
 */
export function deriveIsAdmin(input: {
    kind: PrincipalKind;
    /** DB-authoritative admin verdict for session/forward-auth credentials. */
    sessionIsAdmin: boolean;
    /** True when the credential owner is in an admin group. */
    ownerIsAdmin: boolean;
    /** The token's raw (not yet expanded) scopes. Empty for session/stream creds. */
    tokenScopes: string[];
    /** Service-token kill-switch; always false for non-service-token creds. */
    forceNonAdmin: boolean;
}): boolean {
    const { kind, sessionIsAdmin, ownerIsAdmin, tokenScopes, forceNonAdmin } = input;

    switch (kind) {
        case 'forward_auth':
        case 'session':
        case 'jellyfin_compat':
            // Session/proxy: the DB resolved this already (pin-aware). A /j
            // password session passes the owner's verdict, a /j API key false.
            return sessionIsAdmin;

        case 'stream_token':
            // Stream tokens are tightly scoped to one playback item — never admin.
            return false;

        case 'bearer':
        case 'pat':
        case 'service_token': {
            // Token path: require BOTH ownerIsAdmin AND an explicit admin scope.
            if (forceNonAdmin) return false;
            const hasAdminScope =
                tokenScopes.includes('admin') || tokenScopes.includes('tasks:admin');
            return hasAdminScope && ownerIsAdmin;
        }

        default: {
            // Exhaustiveness guard
            const _exhaustive: never = kind;
            void _exhaustive;
            return false;
        }
    }
}

// ---------------------------------------------------------------------------
// expandScopes() — coarse-alias expansion
// ---------------------------------------------------------------------------

/**
 * Expand coarse scope aliases into their constituent fine-grained scopes.
 *
 *   - `admin`  grants everything (superset of write + read).
 *   - `write`  grants read-class operations + user-data mutations.
 *   - `write`  does NOT grant `tasks:run` or `webhooks:write` (those require
 *              explicit grants — a generic write scope must not bootstrap
 *              privileged system-task or webhook access).
 *   - `read`   grants read-only access.
 *
 * The expanded set is a deduplicated superset of the input.
 * The wire format stays `string[]` — no DB migration needed.
 */
export function expandScopes(raw: string[]): string[] {
    const out = new Set(raw);

    if (out.has('admin')) {
        // admin is a superset of everything
        out.add('write');
        out.add('read');
        out.add('tasks:read');
        out.add('tasks:run');
        out.add('tasks:admin');
        out.add('runs:read');
        out.add('webhooks:write');
        out.add('media:read');
        out.add('media:write');
        out.add('sessions:read');
        out.add('sessions:write');
        out.add('requests:read');
        out.add('requests:admin');
        // Admin scopes — all granted by the coarse 'admin' alias
        out.add('users:read');
        out.add('users:admin');
        out.add('access:admin');
        out.add('tokens:admin');
        out.add('library:read');
        out.add('library:admin');
        out.add('media:admin');
        out.add('livetv:admin');
        out.add('providers:read');
        out.add('providers:admin');
        out.add('playback:read');
        out.add('playback:admin');
        out.add('metrics:read');
        return [...out];
    }

    if (out.has('write')) {
        // write is a superset of read and user-data mutation scopes
        out.add('read');
        out.add('media:read');
        out.add('media:write');
        out.add('sessions:read');
        out.add('requests:read');
        // Note: tasks:run and webhooks:write are NOT included — require explicit grant.
        // Note: requests:admin is NOT included — requires explicit grant (scope=all).
        // Note: admin scopes are NOT included in write — require explicit grant.
    }

    if (out.has('read')) {
        // `tasks:read` auto-grant REMOVED (2026-09-18 fix-plan-4, Shape C
        // ruling — ledger.md "Design rulings (Shape B and Shape C)"). Every
        // non-admin session used to inherit `tasks:read` here, which is what
        // let findings C2/C4/C5 recur after 2026-09-12 C16 moved six sibling
        // endpoints to `tasks:admin` one at a time. `tasks:read` is not a
        // mintable PAT/service-token scope (patScopeSchema /
        // serviceTokenScopeSchema in schemas/admin.ts admit neither
        // `tasks:read` nor `runs:read`), so removing the auto-grant costs
        // nothing on the token surface — see the ruling's production
        // measurement (14 live credentials, zero holding either scope).
        // This is ONE of two producers: `scopeGranted()`'s matching
        // `case 'tasks:read'` in tasks/api-auth.ts must split identically,
        // or `mount.ts`'s `{kind:'scope'}` branch re-grants it independently
        // — see that function's docstring.
        //
        // `runs:read` auto-grant REMOVED 2026-10-07 (reverses the 2026-09-13
        // P4 ruling): GET /runs/{id} returns every run's input, scope and
        // error with no ownership check, the list and /runs/stream are
        // system-wide, and no non-admin client calls them (user sync status
        // has its own endpoints; the Apple apps never call runs). It now
        // comes only from `tasks:admin` / `admin` below — and must stay split
        // identically in tasks/api-auth.ts `scopeGranted()`.
        out.add('media:read');
        out.add('sessions:read');
        out.add('requests:read');
    }

    // Hierarchical expansions: child scopes grant their read equivalents.
    // users:admin grants users:read
    if (out.has('users:admin')) {
        out.add('users:read');
    }
    // library:admin grants library:read
    if (out.has('library:admin')) {
        out.add('library:read');
    }
    // providers:admin grants providers:read
    if (out.has('providers:admin')) {
        out.add('providers:read');
    }
    // media:admin grants media:read (and media:write — all three are management access)
    if (out.has('media:admin')) {
        out.add('media:read');
        out.add('media:write');
    }
    // playback:admin grants playback:read
    if (out.has('playback:admin')) {
        out.add('playback:read');
    }
    // tasks:admin grants tasks:read, runs:read, and metrics:read
    if (out.has('tasks:admin')) {
        out.add('tasks:read');
        out.add('runs:read');
        out.add('metrics:read');
    }

    return [...out];
}

// ---------------------------------------------------------------------------
// isAdminClassScope() / stripAdminScopes() — the single "is this scope
// admin?" predicate, and the forceNonAdmin kill-switch built on top of it
// ---------------------------------------------------------------------------

/**
 * True for the coarse `admin` alias and every fine-grained `<area>:admin`
 * scope (`tasks:admin`, `users:admin`, `providers:admin`, `tokens:admin`, …).
 *
 * This is the CANONICAL "is this scope admin-class?" predicate — it used to
 * be duplicated (this file's `stripAdminScopes` inlined the same
 * `s !== 'admin' && !s.endsWith(':admin')` check that `token-minting.ts`'s
 * minting ceiling also inlined separately). `token-minting.ts` now re-exports
 * this definition instead of keeping its own copy, so the two can no longer
 * drift (security review 2026-09-15, C4 fix-round global constraint: collapse
 * duplicated security decisions rather than patching both copies). Credential
 * stores that need to identify their own admin-class rows (PAT service,
 * service-token service — see `credential-revocation.service.ts`
 * `narrowAdminScopedCredentialsForUser`) import this too, so "admin-class"
 * means the same thing at mint time, at strip time, and at narrow time.
 */
export function isAdminClassScope(scope: string): boolean {
    return scope === 'admin' || scope.endsWith(':admin');
}

/**
 * Remove every admin-class scope. Order and the remaining scopes are kept.
 *
 * `forceNonAdmin` promises a token is "never admin regardless of scopes". That
 * has to hold for the scope-gated admin plane too (`{kind:'scope', anyOf:
 * ['users:admin']}` and ~140 similar defs read `principal.scopes`, not
 * `principal.isAdmin`), so the SAME rule runs here and in the legacy
 * `authenticate()` path. Security review 2026-09-12, C2.
 */
export function stripAdminScopes(scopes: readonly string[]): string[] {
    return scopes.filter((s) => !isAdminClassScope(s));
}

/**
 * Must this credential's admin-class scopes be stripped before expansion?
 *
 * True when the kill-switch is set (`forceNonAdmin`), or when a TOKEN
 * credential (`pat`, `service_token`, `bearer`) belongs to an owner who is
 * not currently admin (`ownerIsAdmin` = the live Formula-A verdict the
 * token-identity producer resolved). A token can never hold more than its
 * owner: an `['admin']` PAT of a demoted admin keeps `read`/`write` only if
 * it carries them explicitly, exactly like a `forceNonAdmin` token.
 *
 * For a service token `ownerIsAdmin` is the producer's synthesised verdict
 * (creator — or impersonation target — currently admin AND the token carries
 * the literal `'admin'` scope). The only mintable admin-class scope is
 * `'admin'` itself, so that is the same question; a legacy row holding a
 * fine-grained `<area>:admin` scope without `'admin'` is stripped
 * (fail-closed).
 *
 * Shared by `buildPrincipal()` and `tasks/api-auth.ts`'s `authenticate()` —
 * the two scope producers — so they cannot disagree.
 */
export function stripsAdminScopesForToken(
    kind: PrincipalKind,
    input: { ownerIsAdmin: boolean; forceNonAdmin: boolean },
): boolean {
    if (input.forceNonAdmin) return true;
    switch (kind) {
        case 'bearer':
        case 'pat':
        case 'service_token':
            return !input.ownerIsAdmin;
        case 'forward_auth':
        case 'session':
        case 'stream_token':
        case 'jellyfin_compat':
            // No stored scopes: buildPrincipal() derives them from isAdmin.
            return false;
        default: {
            // Exhaustiveness guard — a new credential kind must decide here.
            const _exhaustive: never = kind;
            void _exhaustive;
            return true;
        }
    }
}

// ---------------------------------------------------------------------------
// buildPrincipal() — convenience factory used by forward-auth.ts
// ---------------------------------------------------------------------------

/**
 * Build a `Principal` from already-resolved identity fields.
 *
 * Called once per credential path after validation succeeds. The caller is
 * responsible for providing correct `sessionIsAdmin` / `ownerIsAdmin` values
 * (derived from the DB or group-check, not from the raw token).
 */
export function buildPrincipal(input: {
    kind: PrincipalKind;
    userId: UserId;
    username: string;
    userGroups: string[];
    /** Raw token scopes (empty for session/forward-auth). */
    tokenScopes?: string[];
    /** DB-authoritative isAdmin for session/forward-auth paths. */
    sessionIsAdmin?: boolean;
    /** True when the credential owner's groups include an admin group. */
    ownerIsAdmin?: boolean;
    /** Service-token forceNonAdmin kill-switch. */
    forceNonAdmin?: boolean;
    /**
     * Device-flow `client_id` claim (bearer arm only). Attribution only —
     * see `Principal.clientId`.
     */
    clientId?: string;
    /**
     * The credential's own id (PAT id / service-token id / session id /
     * stream-session id). Attribution only — see `Principal.credentialId`.
     */
    credentialId?: string;
    /** Service-token path envelope — see `Principal.tokenPathPrefixes`. */
    tokenPathPrefixes?: string[];
    /** Service-token owner verdict — see `Principal.tokenOwnerIsAdmin`. */
    tokenOwnerIsAdmin?: boolean;
}): Principal {
    const tokenScopes = input.tokenScopes ?? [];
    const sessionIsAdmin = input.sessionIsAdmin ?? false;
    const ownerIsAdmin = input.ownerIsAdmin ?? false;
    const forceNonAdmin = input.forceNonAdmin ?? false;

    const isAdmin = deriveIsAdmin({
        kind: input.kind,
        sessionIsAdmin,
        ownerIsAdmin,
        tokenScopes,
        forceNonAdmin,
    });

    // For session/forward-auth/stream-token credentials that carry no explicit
    // token scopes, derive their scope set from group-based permissions:
    // admin sessions get all scopes; normal sessions get read+write.
    let rawScopes: string[];
    if (tokenScopes.length === 0) {
        rawScopes = isAdmin ? ['admin'] : ['read', 'write'];
    } else {
        rawScopes = tokenScopes;
    }

    // Strip FIRST, expand SECOND (X2 fix, security review 2026-09-23 final
    // wave — reverses this function's own prior "expand first, strip second"
    // comment). Expanding first let a forceNonAdmin `['admin']` token keep
    // every admin-only AREA scope the coarse alias expanded into (`tasks:run`,
    // `tasks:read`, `webhooks:write`, `users:read`, `metrics:read`, …):
    // `isAdminClassScope()`/`stripAdminScopes()` only remove the literal
    // `'admin'`/`'<area>:admin'` entries, not their non-':admin'-suffixed
    // siblings, so those survived a strip that ran AFTER expansion had
    // already produced them. `tasks/api-auth.ts`'s `authenticate()` never had
    // this bug — it strips the RAW, unexpanded scopes and never expands at
    // all (`scopeGranted()` handles the scope-equivalence checks itself) —
    // this reorder makes `buildPrincipal()` match that ALREADY-correct
    // producer via the SAME shared `stripAdminScopes()` helper, rather than
    // the two producers deciding "is this scope admin-class" at different
    // points in the pipeline. Cost: a forceNonAdmin token that was minted
    // with nothing but the coarse `admin` alias now loses every scope
    // entirely (it must be re-minted with explicit scopes) — an EXPLICIT
    // non-admin scope alongside `admin` (e.g. `['admin','media:read']`)
    // still survives on its own merits, since stripping only ever removes
    // admin-class entries, never anything else.
    //
    // Demoted-owner strip (2026-10-02): a TOKEN credential whose owner is
    // NOT currently admin loses its admin-class scopes too, by the SAME
    // strip-then-expand rule. Before this, only `forceNonAdmin` stripped:
    // `deriveIsAdmin()` already denied `isAdmin` to an `['admin']` PAT/svc
    // token whose owner had been demoted, but `scopes` kept the full
    // `expandScopes(['admin'])` set, and every `{kind:'scope'}` def reads
    // `scopes`, never `isAdmin` — so `metrics:read`, `users:read`,
    // `tasks:admin`, … stayed granted. The demotion paths' own
    // `narrowAdminScopedCredentialsForUser()` covered only an explicit
    // `setIsAdmin(false)`/unpin; losing the admin GROUP (IdP or in-app)
    // narrowed nothing. Deciding it here, per request, from the live
    // Formula-A `ownerIsAdmin` closes every demotion route at once. Sessions
    // and stream tokens are untouched (their scopes are derived from
    // `isAdmin` above, never stored). `stripsAdminScopesForToken()` is the
    // one predicate — `tasks/api-auth.ts`'s `authenticate()` calls it too.
    const strippedRaw = stripsAdminScopesForToken(input.kind, { ownerIsAdmin, forceNonAdmin })
        ? stripAdminScopes(rawScopes)
        : rawScopes;
    const scopes = expandScopes(strippedRaw);

    return {
        kind: input.kind,
        userId: input.userId,
        username: input.username,
        userGroups: input.userGroups,
        scopes,
        isAdmin,
        // Only ever set by the bearer arm; `undefined` everywhere else, which
        // is what deriveSurface() reads as "no first-party claim".
        ...(input.clientId ? { clientId: input.clientId } : {}),
        // Attribution only — see Principal.credentialId. Absent for
        // forward_auth and any bearer JWT with no deviceSessionId claim.
        ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        ...(input.kind === 'service_token' && input.tokenPathPrefixes?.length
            ? { tokenPathPrefixes: [...input.tokenPathPrefixes] }
            : {}),
        ...(input.kind === 'service_token' && input.tokenOwnerIsAdmin !== undefined
            ? { tokenOwnerIsAdmin: input.tokenOwnerIsAdmin }
            : {}),
    };
}
