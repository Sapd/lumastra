// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * delegate.ts — delegation bridge for admin route handlers.
 *
 * When a scope gate has already authenticated the caller,
 * the underlying admin handler still runs `requireAdmin` as a second gate.
 * `delegateToAdmin()` marks the request (isDelegatedAdmin) so that second
 * gate passes, then removes the mark. The principal is never elevated.
 *
 * This is intentional and safe: the scope gate is the authoritative
 * auth check for the token surface; we never skip it here.
 *
 * Only use this helper AFTER a scope check has already succeeded.
 *
 * Identity sourcing (review finding 3):
 *   - `locals.principal` MUST be present — it is the resolved, validated
 *     identity for this request. If absent, we fail closed with 403.
 *   - When `locals.user` is absent or lacks `isAdmin`, the synthetic user
 *     is built from `locals.principal` (userId + username), not from thin
 *     air. This ensures downstream admin handlers log/query with a real
 *     identity rather than undefined fields.
 *
 * @example
 * ```ts
 * import { enforce } from '$lib/server/api/mount.js';
 * import { delegateToAdmin } from '$lib/server/api/delegate.js';
 * import { POST as adminPOST } from '../../../admin/media/[id]/rescan/+server.js';
 *
 * export const POST = async (event) => {
 *   const err = await enforce({ kind: 'scope', anyOf: ['media:admin'] }, event);
 *   if (err) return err;
 *   return delegateToAdmin(event, adminPOST);
 * };
 * ```
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';
import type { Principal } from '$lib/server/api/principal.js';
import { problem } from '$lib/server/api/problem.js';

/**
 * The principal that passed the OUTER gate, for the duration of a delegated
 * call. Handlers that hand out authority (token minting) must judge the caller
 * by this. Since 2026-10-13 `locals.principal` is no longer elevated, so it is
 * the same credential; kept for callers that ask explicitly.
 * Keyed by event so nothing leaks across requests; cleared in `finally`.
 */
const preDelegationPrincipal = new WeakMap<RequestEvent, Principal>();

/**
 * Requests inside a delegateToAdmin() call. Only the admin GATES honour it
 * (enforce's `admin` arm, requireAdmin(), authenticate()'s admin-session arm):
 * the caller's principal stays as it is, so helpers the delegated handler calls
 * (localsIsAdmin, media access, audit) still see the real credential.
 */
const delegationDepth = new WeakMap<RequestEvent, number>();

/** Is this request inside a delegateToAdmin() handoff? For admin gates only. */
export function isDelegatedAdmin(event: RequestEvent): boolean {
    return (delegationDepth.get(event) ?? 0) > 0;
}

/**
 * The unelevated principal while inside `delegateToAdmin()`, else `undefined`
 * (outside a delegation `locals.principal` IS the unelevated one).
 */
export function principalBeforeDelegation(event: RequestEvent): Principal | undefined {
    return preDelegationPrincipal.get(event);
}

/**
 * Call `handler` as a delegated admin call: the request is marked for the
 * admin gates (isDelegatedAdmin) and, when there is no admin user object, a
 * synthetic one carries the identity. The principal is left alone. Both are
 * undone after the handler returns (or throws).
 *
 * Fails closed (403) when `locals.principal` is absent — a resolved Principal
 * is required to provide a real userId/username for the synthetic user object.
 */
export async function delegateToAdmin(
    event: RequestEvent,
    handler: RequestHandler,
): Promise<Response> {
    // Fail closed: principal must be set by resolveAuth before we reach here.
    // Without it we cannot build a user object with a real identity.
    const principal = event.locals.principal;
    if (!principal) {
        return problem('forbidden', {
            error: 'No resolved principal — delegateToAdmin requires a prior scope check.',
        });
    }

    const origUser = event.locals.user;
    // eslint-disable-next-line callback-safety/no-locals-user-is-admin -- delegation raises the owner flag for the call and restores it after
    const userPatchNeeded = !origUser?.ownerIsAdmin;
    // The delegated handler is itself mounted with `auth: { kind: 'admin' }`,
    // and enforce() treats a present Principal as AUTHORITATIVE. Instead of
    // making the principal admin for everything the handler calls, the request
    // is marked (isDelegatedAdmin) and only the admin gates accept the mark, so
    // a least-privilege scope token (e.g. `media:admin`) passes the inner gate
    // its scope already passed at the outer one, and nothing more.
    //
    // Safe because delegateToAdmin is unreachable without a prior successful
    // scope check (see the callers: `enforce({kind:'scope', …})` immediately
    // precedes every call) and we fail closed above when no Principal exists.

    if (userPatchNeeded) {
        // Build the synthetic user from the resolved Principal so that downstream
        // admin handlers always receive a real userId + username, never undefined.
        // All other UserContext fields are carried over from the existing user
        // object (if one exists), falling back to safe defaults.
        event.locals.user = {
            ...(origUser ?? {}),
            userId: principal.userId,
            username: principal.username,
            ownerIsAdmin: true,
        } as UserContext;
    }

    // Nested delegations keep the OUTERMOST caller and its mark.
    const outer = preDelegationPrincipal.get(event);
    if (!outer) preDelegationPrincipal.set(event, principal);
    // A depth count, not a flag: overlapping delegations on one event (a
    // Promise.all fan-out) must not clear each other's mark.
    delegationDepth.set(event, (delegationDepth.get(event) ?? 0) + 1);

    try {
        return await handler(event);
    } finally {
        if (!outer) preDelegationPrincipal.delete(event);
        const depth = (delegationDepth.get(event) ?? 1) - 1;
        if (depth > 0) delegationDepth.set(event, depth);
        else delegationDepth.delete(event);
        if (userPatchNeeded) {
            event.locals.user = origUser;
        }
    }
}
