// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared shaping helper for the native (built-in) web-login list surfaced at
 * `/api/user/sessions` (owner-scoped list/revoke) and, downstream, the
 * `/settings/sessions` page loader. Lives here (not colocated with the routes)
 * so both can import it without a cross-route path.
 */

import { createHash } from 'node:crypto';
import type { UserSessionRow } from '$lib/server/database/queries/user-sessions.queries.js';

export interface WebLoginView {
    id: string;
    createdAt: string;
    lastUsedAt: string | null;
    userAgent: string | null;
    ip: string | null;
    current: boolean;
}

/**
 * SHA-256 hex of a plaintext native-session token — mirrors the private
 * `hashToken` in `session.service.ts` (same algorithm, over the same opaque
 * token string) so a token read from the request cookie can be matched
 * against a stored `user_sessions.token_hash` without re-exporting that
 * service's internals.
 */
export function hashSessionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/** Shape native-session rows for the client. Never emits token_hash. */
export function toWebLoginViews(
    rows: UserSessionRow[],
    currentTokenHash: string | null,
): WebLoginView[] {
    return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        lastUsedAt:
            r.last_used_at == null
                ? null
                : r.last_used_at instanceof Date
                  ? r.last_used_at.toISOString()
                  : String(r.last_used_at),
        userAgent: r.user_agent,
        ip: r.ip,
        current: !!currentTokenHash && r.token_hash === currentTokenHash,
    }));
}
