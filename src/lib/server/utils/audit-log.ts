// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { Logger } from './logger';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { principalBeforeDelegation } from '$lib/server/api/delegate.js';
import type { PrincipalKind } from '$lib/server/api/principal.js';

const logger = Logger.for('AuditLog');

/**
 * The actor performing an audited action, as an object rather than a bare
 * username — carries the credential KIND and its specific id (PAT id /
 * service-token id / session id / stream-session id) so a stolen PAT/service
 * token is attributable to that credential, not just to the username it
 * authenticates as (security review 2026-09-13, R5).
 *
 * `auditLog()` still accepts a bare `string | null` for callers that only
 * have a username in hand (legacy form) — both forms write the same row,
 * with `principalKind`/`credentialId` left `null` for the legacy form.
 */
export interface AuditActor {
    /** Display/login handle, or `null` when no identity resolved (→ 'system'). */
    username: string | null;
    /** Which credential path produced this identity, when known. */
    kind?: PrincipalKind;
    /** The specific credential's own id (PAT id, service-token id, …). */
    credentialId?: string;
    /**
     * True when this action ran through `delegateToAdmin()` — the actor is
     * the OUTER (pre-delegation) caller, not the synthetic elevated identity
     * the delegated handler ran under.
     */
    delegated?: boolean;
}

/**
 * Build an `AuditActor` for the caller of `event`, for passing straight into
 * `auditLog()`.
 *
 * Reads, in order:
 *   1. `principalBeforeDelegation(event)` — when this call is running INSIDE
 *      a `delegateToAdmin()` handoff, this is the outer, pre-delegation
 *      principal (the real caller, before the temporary admin elevation).
 *      When present, the returned actor carries `delegated: true`.
 *   2. `event.locals.principal` — the normalized identity resolved by
 *      `resolveAuth`/`authenticate()` for every credential path (forward-auth,
 *      session, PAT, service token, JWT, stream token).
 *   3. `event.locals.user` — legacy fallback for surfaces that never
 *      materialize a Principal; carries a username only, no kind/credentialId.
 *
 * Returns `{ username: null }` (→ logged/stored as `'system'`) when none of
 * the three resolve, matching the previous `adminUsername ?? null` behaviour.
 */
export function auditActor(event: RequestEvent): AuditActor {
    const preDelegation = principalBeforeDelegation(event);
    const principal = preDelegation ?? event.locals.principal;
    if (principal) {
        return {
            username: principal.username,
            kind: principal.kind,
            credentialId: principal.credentialId,
            ...(preDelegation ? { delegated: true } : {}),
        };
    }
    const user = event.locals.user;
    if (user?.username) {
        return { username: user.username };
    }
    return { username: null };
}

/**
 * `auditActor()`'s counterpart for callers that only have a `locals`-shaped
 * object in hand, not the full `RequestEvent` — form-action helpers
 * (`settings-helpers.ts`, `+page.server.ts` actions) that take `locals` as a
 * parameter rather than `event`. There is no `delegateToAdmin()` handoff on
 * these surfaces (form actions are never reached via the token/delegation
 * path), so this skips the `principalBeforeDelegation` lookup `auditActor()`
 * does and reads `principal ?? user` directly.
 */
export function auditActorFromLocals(locals: {
    principal?: { username: string; kind?: PrincipalKind; credentialId?: string } | null;
    user?: { username?: string | null } | null;
}): AuditActor {
    if (locals.principal) {
        return {
            username: locals.principal.username,
            kind: locals.principal.kind,
            credentialId: locals.principal.credentialId,
        };
    }
    if (locals.user?.username) {
        return { username: locals.user.username };
    }
    return { username: null };
}

/**
 * Emit a structured audit log entry for a sensitive admin action.
 *
 * Goes to stdout via the app's Logger (see `logger.ts` — a hand-rolled
 * console formatter, not Winston). Operators ship logs to ELK/Loki/Datadog
 * for retention. The structured fields are the contract — keep them stable.
 *
 * ALSO writes a best-effort row to `audit_log` (source='admin') in PostgreSQL
 * (since migration 16.107.0; previously `admin_audit_log`).
 * The DB write is fire-and-forget — a slow or absent DB never blocks the
 * HTTP response, and a failure is logged at WARN and swallowed.
 *
 * `actor` accepts either:
 *   - the legacy bare `string | null` (a username, or `null` for no identity)
 *   - an `AuditActor` object (preferred — build one with `auditActor(event)`
 *     at every call site that has a `RequestEvent` in hand), which also
 *     records the credential kind and id so the row is attributable to a
 *     specific PAT/service token, not just a username.
 */
export function auditLog(
    action: string,
    target: string,
    actor: string | null | AuditActor,
    details?: Record<string, unknown>,
): void {
    const normalized: AuditActor =
        typeof actor === 'string' || actor === null ? { username: actor } : actor;
    const actorName = normalized.username ?? 'system';

    // Spread `details` FIRST so the fixed audit fields always win — callers
    // can't accidentally clobber `audit`/`action`/`target`/`adminUsername`
    // by passing colliding keys.
    logger.info(`[AUDIT] ${action}`, {
        ...(details ?? {}),
        audit: true,
        action,
        target,
        adminUsername: actorName,
        ...(normalized.kind ? { principalKind: normalized.kind } : {}),
        ...(normalized.credentialId ? { credentialId: normalized.credentialId } : {}),
        ...(normalized.delegated ? { delegated: true } : {}),
    });

    // Best-effort async DB sink — MUST NOT be awaited and MUST have a .catch().
    // A missing DB pool (getDb() returns null) is silently skipped, same as
    // appendAuditEvent in the task observability module.
    void (async () => {
        try {
            const sql = getDb();
            if (!sql) return;
            await insertAdminAuditEvent(sql, {
                instanceId: config.INSTANCE_ID,
                actor: actorName,
                principalKind: normalized.kind ?? null,
                credentialId: normalized.credentialId ?? null,
                action,
                target,
                outcome: 'ok',
                detail: details,
            });
        } catch (err) {
            logger.warn('[AUDIT] DB sink failed (best-effort)', {
                action,
                target,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    })();
}
