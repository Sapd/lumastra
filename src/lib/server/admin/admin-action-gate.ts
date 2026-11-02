// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one gate every form action under /admin must call first.
 *
 * Why this exists: the /admin layout refuses non-admins in its `load`, but
 * SvelteKit runs a page's form ACTION before any load runs. So the layout
 * redirect never protected `POST /admin/…?/save`; any authenticated user could
 * write any config key (security review 2026-09-12, C4/C5). Loads are not
 * gates for actions — actions gate themselves, with this.
 *
 * Usage, as the first statement of the action:
 *   const denied = denyUnlessAdmin(locals);
 *   if (denied) return denied;
 *
 * The custom ESLint rule `admin-actions-require-gate` enforces exactly that
 * shape on every `+page.server.ts` under src/routes/admin, and
 * `src/routes/admin/admin-actions-require-admin.test.ts` proves it end to end.
 */

import { fail, type ActionFailure } from '@sveltejs/kit';
import type { PrincipalKind } from '$lib/server/api/principal.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export type AdminActionLocals = {
    user?: { username?: string; ownerIsAdmin?: boolean } | null;
    /**
     * Narrowed to the fields `auditActor()`-equivalent code in the settings
     * form-action helpers needs for R5 attribution — not the full `Principal`,
     * so this gate stays decoupled from the api/ layer's full type.
     */
    principal?: {
        username: string;
        kind: PrincipalKind;
        credentialId?: string;
        isAdmin?: boolean;
    } | null;
};

export type AdminDenied = ActionFailure<{ error: string }>;

/** `fail(403)` unless the caller is admin (`localsIsAdmin`); `null` when the caller may proceed. */
export function denyUnlessAdmin(locals: AdminActionLocals | null | undefined): AdminDenied | null {
    if (localsIsAdmin(locals)) return null;
    return fail(403, { error: 'Admin access required' });
}
