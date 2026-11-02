// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolveBearerAdminPrincipal() — the ONE shared helper that resolves a full
 * `Principal` from a raw Bearer PAT/service token, for every call site that
 * needs a Bearer-only ADMIN identity outside `resolveAuth`'s normal
 * credential paths:
 *
 *   - `mount.ts`'s `enforce()` {kind:'admin'} TERTIARY fallback (a Bearer
 *     caller on a `kind:'admin'` def that forward-auth's "Bearer exception"
 *     never built a Principal for — see hooks.server.ts).
 *   - `middleware/auth.ts`'s `requireAdmin()` (the same fallback for the 22
 *     total `requireAdmin()`-gated route files under `src/routes/` — 5 of
 *     them under `src/routes/api/admin`, the rest elsewhere — counted at
 *     HEAD, security review 5 §3 C1; this used to say "~50" and was never
 *     recounted).
 *   (`token-minting.ts`'s `callerIsAdmin()` used this fallback too until
 *   2026-10-09; it now reads only the principal the mount gate resolved.)
 *
 * FIX (security review 5, 2026-09-23, fix-plan-5 Task 3 — C1, C2, the IP
 * outage). This helper used to do its OWN credential validation
 * (`svc.validate(token)`/`patService.validate(token)` with NO client IP and
 * NO envelope/scope-gate) and its OWN identity resolution (the service-token
 * branch always read `resolveOwnerAdminStatus(sql, validated.createdBy)` —
 * the CREATOR — and never looked at `validated.actAsUser` at all). That
 * disagreed with `/api/v1` on three axes for the exact same credential: an
 * impersonating token was judged by its target on `/api/v1` and its creator
 * here (C1); a token's `allowedPathPrefixes`/`allowedMethods` envelope was
 * enforced on `/api/v1` and ignored here (C2); and an IP-allowlisted token
 * was rejected here even from an allowed peer, because no client IP ever
 * reached `validate()` (the IP outage). All three are now fixed by routing
 * through the SAME two-step producer `/api/v1` (`forward-auth.ts`) and the
 * `{kind:'scope'}` fallback (`tasks/api-auth.ts`) also use —
 * `$lib/server/auth/token-identity.ts` — instead of re-deriving a verdict
 * here. See that module's doc comment for the full account.
 *
 * Gated on `features.deviceAuth` FIRST, before any header parsing (fix-plan-5
 * Task 4 review, fix round 1, Important 2): with the flag off, every caller
 * of this helper gets `null` unconditionally, matching the `/api/v1` and
 * `/api/admin` Bearer-exception kill-switch semantics fixed elsewhere in the
 * same task. Not used by `/metrics` (`tasks/api-auth.ts`'s `authenticate()`
 * calls `token-identity.ts` directly), so that scrape is unaffected.
 *
 * ONLY ever returns a non-null `Principal` for an admin-eligible token: it
 * short-circuits to `null` before the identity-resolution DB round trip when
 * the token carries no admin-class scope at all (`isAdminClassScope`), since
 * `deriveIsAdmin()` requires an explicit `'admin'`/`'tasks:admin'` scope AND
 * `ownerIsAdmin` — absent ANY admin-class scope, `deriveIsAdmin()` can never
 * be true regardless of what the DB lookup would return. Every current
 * caller only consults the ADMIN verdict (never a non-admin Principal's
 * identity), so this short-circuit is safe to apply here rather than at each
 * call site — see the 2026-09-13 deferred-fix report (item 15) for the
 * equivalence argument. This short-circuit, and the `forceNonAdmin`
 * short-circuit right after it, sit BETWEEN `token-identity.ts`'s step 1
 * (credential validation + envelope gate — NOT the `/api/v1`-only
 * scope/method gate, which is deliberately plane-specific; see
 * `v1ScopeMethodDenial`'s doc comment) and step 2 (identity resolution) —
 * the reason those two steps are separate exports rather than one combined
 * function.
 *
 * CAVEAT (fix round 1, Important #3): "safe for every current caller" is an
 * `.isAdmin`-only claim — it does NOT mean `null` and "a resolved,
 * non-admin `Principal`" are interchangeable in general. `mount.ts`'s
 * TERTIARY branch has a SIDE EFFECT (`event.locals.principal =
 * bearerPrincipal`) that a LATER arm of a `{kind:'any', specs:[...]}`
 * composite can observe even when THIS arm denies — so whether the
 * short-circuit fired (no side effect) or a real DB lookup ran (side effect,
 * non-admin Principal) can change a later arm's outcome. See the invariant
 * comment at that call site (`mount.ts`, the TERTIARY `case 'admin'` branch)
 * before relying on this helper's null/non-null distinction anywhere else.
 */

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import type { RequestEvent } from '@sveltejs/kit';
import type { Principal } from '$lib/server/api/principal.js';
import { isAdminClassScope } from '$lib/server/api/token-minting.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { routedPathname } from '$lib/server/auth/routed-pathname.js';
import { features } from '$lib/server/config.js';
import {
    validateBearerCredential,
    resolveTokenIdentity,
    type TokenRequestCtx,
} from '$lib/server/auth/token-identity.js';

export async function resolveBearerAdminPrincipal(event: RequestEvent): Promise<Principal | null> {
    // Fix-plan-5 Task 4 review, fix round 1, Important 2: every call site
    // of this helper (mount.ts TERTIARY, middleware/auth.ts requireAdmin())
    // sits BEHIND hooks.server.ts's
    // `hasBearer` carve-out, which is ALSO now gated on `features.deviceAuth`
    // — but a caller holding both a valid non-admin SESSION and an
    // admin-scoped Bearer header reaches this helper regardless of that
    // carve-out (the session already satisfies resolveAuth, so
    // hooks.server.ts's 403 backstop never fires for it). Gate here too so
    // turning FEATURE_DEVICE_AUTH off is a real kill-switch for every plane
    // this helper feeds, not just the header-only case. Safe for `/metrics`:
    // `tasks/api-auth.ts`'s `authenticate()` never calls this helper (it
    // goes through `token-identity.ts` directly) — grepped
    // `resolveBearerAdminPrincipal` call sites to confirm.
    if (!features.deviceAuth) return null;

    const raw = event.request.headers.get('authorization') ?? '';
    const match = /^bearer[ \t]+(\S.*)$/i.exec(raw.trim());
    if (!match) return null;
    const token = match[1].trim();
    if (!token) return null;
    if (!token.startsWith('pat_') && !token.startsWith('svc_')) return null;

    try {
        // SECURITY (IP outage fix): getClientIpStrict, not getClientIp — the
        // strict/non-spoofable variant is what `validate()` compares against
        // a token's `allowed_ips` and persists to `last_used_ip`. Before this
        // fix, this helper never passed ANY client IP into `validate()`, so
        // an IP-allowlisted token was rejected unconditionally on
        // /api/admin/*, even from an allowed peer.
        const ctx: TokenRequestCtx = {
            clientIp: getClientIpStrict(event),
            method: event.request.method,
            // The routed path, as forward-auth passes it: an encoded or
            // locale-prefixed spelling is judged by the route it reaches.
            pathname: routedPathname(event.url),
        };

        // Step 1: credential validation (allowed_ips/revocation/expiry/
        // creator-lifecycle, inside validate()) + the shared envelope gate
        // (C2 fix — this helper used to call validate() with no envelope
        // check at all). Deliberately does NOT include the `/api/v1`-only
        // scope/method gate — see `v1ScopeMethodDenial`'s doc comment.
        const step1 = await validateBearerCredential(token, ctx);
        if (!step1.ok) return null;
        const { validated } = step1.credential;

        // Short-circuit: a forceNonAdmin token can never be admin regardless
        // of scope or owner, so skip the identity round trip entirely.
        if (validated.forceNonAdmin) return null;
        // Item 15: no admin-class scope at all -> deriveIsAdmin() can never
        // be true, regardless of ownerIsAdmin. Skip the DB round trip
        // entirely.
        if (!validated.scopes.some(isAdminClassScope)) return null;

        // Step 2: Formula-A identity resolution (C1 fix — for an
        // impersonating service token this now judges the TARGET, via the
        // same code path /api/v1 uses, instead of re-checking the CREATOR).
        // jellyfinUserId is never read by any caller of this helper.
        const step2 = await resolveTokenIdentity(step1.credential, { resolveJellyfinId: false });
        if (!step2.ok) return null;
        return step2.identity.principal;
    } catch (error) {
        if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
        return null;
    }
}
