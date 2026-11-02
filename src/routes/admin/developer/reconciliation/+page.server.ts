// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Developer → Reconciliation log (admin IA redesign, spec §3.7): the raw
 * sync-quarantine feed, extracted from the media browser's old Quarantine
 * tab (removed in step:fix-matches) into its own Developer-only page. No
 * operator badge anywhere points at this data (spec: "ex-Quarantine, no
 * operator badge") — it self-reconciles automatically and is rarely needed
 * manually; this page exists for developers diagnosing why an item didn't
 * auto-resolve, not as an operator queue.
 *
 * The API (`getQuarantineEntries`/`resolveQuarantineEntry` in $lib/api/admin
 * and their backing routes) was untouched by the tab's removal — this page
 * just re-wires a UI to it.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireDevTools } from '$lib/server/admin/require-dev-tools.js';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

// Entirely client-fetching (getQuarantineEntries), same as the tab it
// replaces — no server data needed beyond the auth + Developer-section gate.
export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        redirect(302, appPath('/'));
    }
    requireDevTools();
    return {};
};
