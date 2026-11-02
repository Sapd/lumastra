// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sync quarantine bulk triage — /admin/library/quarantine.
 *
 * Groups unresolved `sync_quarantine` rows by series so an operator can act
 * on a whole series' backlog at once instead of reviewing thousands of rows
 * individually (see reconciliation-backfill.ts / episode-reconciliation.service.ts
 * for what quarantines a row). Not yet linked from any nav — reached directly
 * by URL until an operator surface (e.g. a HealthStrip chip) points at it.
 *
 * Data is fetched client-side (QuarantineTriagePanel) so bulk actions can
 * refetch without a full page navigation; this load function only gates access.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }
    return {};
};
