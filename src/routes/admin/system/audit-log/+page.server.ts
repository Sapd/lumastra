// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /admin/system/audit-log — Admin Audit Log page loader.
 *
 * Admin gating is enforced by the parent `/admin` layout (+layout.server.ts
 * redirects non-admins). No SSR data load — all data is fetched client-side
 * to keep the infinite-scroll / filter UX simple, exactly as AuditFeed.svelte does.
 */

import type { PageServerLoad } from './$types';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = ({ locals }) => {
    return {
        // Surfaced for the page header; admin gating already happened in the layout.
        isAdmin: localsIsAdmin(locals),
    };
};
