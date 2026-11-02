// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one mapping from an admin list row to its issue badges. The browser
 * list, the series drill-down and the detail page's issues strip all call it,
 * so an item shows the same issues on every surface.
 */

import type { AdminMediaRow } from '$lib/server/database/queries/admin-media.queries.js';
import { deriveMediaIssues, type MediaIssue } from '$lib/shared/media-issues.js';

export function issuesForAdminRow(r: AdminMediaRow, jellyfinEnabled: boolean): MediaIssue[] {
    return deriveMediaIssues(
        {
            mediaType: r.media_type,
            filesLost: r.files_lost,
            hasTmdb: r.tmdb_id !== null,
            hasPoster: r.has_poster,
            hasOverview: r.has_overview,
            hasFiles: r.has_files,
            jellyfinLinked: r.jellyfin_linked,
            isDuplicate: r.is_duplicate,
            episodeProblems: r.episode_problem_count,
            fileIssues: {
                health: r.health_issue_types ?? [],
                healthDetails: (r.health_issue_details ?? []).map((d) => ({
                    type: d.type,
                    detail: d.detail ?? undefined,
                    filePath: d.file_path ?? undefined,
                })),
                integrity: r.integrity_issues ?? [],
            },
        },
        { jellyfinEnabled },
    );
}
