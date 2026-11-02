// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/recent-plays — "what was played recently, and by whom".
 *
 * GET /api/admin/fix/recent-plays → RecentPlays.
 * Auth: admin. Errors: problem+json.
 *
 * ## Why this exists
 *
 * /admin/fix/why-transcode needs a media id and had no way to produce one. The
 * operator pasted a UUID by hand, so a mistyped or spliced id reached the API
 * and came back a bare 422 — a dead end with nothing to click. Offering the
 * recent plays removes the typing entirely.
 *
 * ## Sourced from play_sessions, deliberately
 *
 * The same table the decision is read from, so every row offered here is
 * guaranteed to have a decision to show. A picker built from `media_items` would
 * offer titles that were never played and answer "no sessions recorded" for most
 * of them — a list that mostly leads nowhere is worse than no list.
 *
 * One row per media item (the newest session for each), because the question the
 * page answers is per ITEM; ten sessions of the same film are one entry here and
 * ten rows on the page itself.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import type { RecentPlays } from '$lib/components/admin/fix/recent-plays.schema.js';

/** Enough to cover "what was just played", short enough to read at a glance. */
const MAX_PLAYS = 25;

/**
 * Newest sessions read to find MAX_PLAYS distinct items. Repeat plays of one
 * item can use up the window, in which case fewer than MAX_PLAYS are listed;
 * the picker is a convenience, so that is the right trade against a full scan.
 */
const SCAN_SESSIONS = 500;

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getAdminDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            const rows = await sql<
                {
                    media_id: string;
                    media_title: string;
                    username: string | null;
                    started_at: Date;
                    play_method: string;
                    client_name: string | null;
                }[]
            >`
                SELECT DISTINCT ON (ps.media_id)
                       ps.media_id,
                       mi.title AS media_title,
                       u.username,
                       ps.started_at,
                       ps.play_method,
                       ps.client_name
                  -- Bounded: only the newest sessions can hold the newest
                  -- distinct items, so the scan never grows with all-time
                  -- history (this page is opened on busy servers).
                  FROM (
                        SELECT media_id, user_id, started_at, play_method, client_name
                          FROM play_sessions
                         ORDER BY started_at DESC
                         LIMIT ${SCAN_SESSIONS}
                       ) ps
                  JOIN media_items mi ON mi.id = ps.media_id
                  LEFT JOIN users u ON u.id = ps.user_id
                 ORDER BY ps.media_id, ps.started_at DESC
            `;

            // DISTINCT ON requires its own leading ORDER BY, so the newest-first
            // ordering the reader wants has to be applied after the fact.
            const plays = rows
                .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
                .slice(0, MAX_PLAYS);

            const payload: RecentPlays = {
                generatedAt: new Date().toISOString(),
                plays: plays.map((r) => ({
                    mediaId: r.media_id,
                    mediaTitle: r.media_title,
                    username: r.username,
                    startedAt: new Date(r.started_at).toISOString(),
                    playMethod: r.play_method,
                    clientName: r.client_name,
                })),
            };

            return json(payload);
        },
    },
});
