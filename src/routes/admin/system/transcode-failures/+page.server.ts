// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /admin/system/transcode-failures — Admin transcode failure reporting page loader.
 *
 * Admin gating is enforced by the parent `/admin` layout (+layout.server.ts
 * redirects non-admins). The incident list and session chains are fetched
 * client-side (same approach as the audit log page); this loader's only job
 * is to supply the redaction roots.
 *
 * `formatFailureReport` (see $lib/shared/transcode-failure-report.ts) needs
 * the configured media library roots and the transcode working directory to
 * redact paths out of a copied report. Those are server-side values and must
 * not be hardcoded in the component, so they are loaded here and passed down
 * as the `roots` prop.
 */

import type { PageServerLoad } from './$types';
import type { RedactOptions } from '$lib/shared/transcode-failure-report.js';
import { getDb } from '$lib/server/database/connection.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { config } from '$lib/server/config.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals }) => {
    const sql = getDb();
    // Filesystem-backed library paths only (the default) — a remote-provider
    // sentinel URI is not something a redaction rule should ever match against.
    const libraryPaths = sql ? await getEnabledLibraryPaths(sql) : [];

    const roots: RedactOptions = {
        libraryRoots: libraryPaths.map((p) => p.path),
        transcodeRoot: config.FFMPEG_TRANSCODE_DIR,
    };

    return {
        // Surfaced for the page header; admin gating already happened in the layout.
        isAdmin: localsIsAdmin(locals),
        roots,
    };
};
