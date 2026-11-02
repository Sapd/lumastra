// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/social-audience.ts
 *
 * GET /api/admin/social-audience — the RESOLVED effect of the listening-audience
 * settings, as opposed to their configured values.
 *
 * The Sharing & Privacy section shows configuration. Configuration is not the
 * thing an operator actually needs to know: "Automatic" plus a group list does not
 * tell you how many people can see each other, and the gap between the two is
 * where privacy accidents live. Switching an instance from a 4-person group to the
 * household audience is a one-word edit that changes the audience by an order of
 * magnitude, and nothing on the page would have said so.
 *
 * Returns counts ONLY — never names. An admin can look up users elsewhere; this
 * endpoint exists to make a setting's blast radius legible, and a name list would
 * be new disclosure for no added clarity.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET → { mode, audienceSize, sharingCount, hiddenCount, configuredGroups }
 * 503 → dependency_unavailable when DB is down
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getDesignatedTrustGroups,
    resolveSocialAudienceMode,
} from '$lib/server/database/queries/builders/social-visibility.builder.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const mode = resolveSocialAudienceMode();
            const designated = getDesignatedTrustGroups();

            // Liveness matches the visibility predicate exactly — a soft-deleted or
            // deactivated account is not in anyone's audience, so counting it here
            // would overstate the reach.
            const live = sql`u.deleted_at IS NULL AND u.disabled_at IS NULL`;

            // Group membership is the same union the predicate computes: the IdP
            // projection in `users.groups` OR in-app access groups. Folded through
            // Postgres `lower()` on both sides, for the same collation reason.
            const inAudience =
                mode === 'household'
                    ? sql`true`
                    : sql`(
                        EXISTS (
                            SELECT 1 FROM unnest(COALESCE(u.groups, ARRAY[]::text[])) AS g(name)
                            WHERE lower(btrim(g.name)) = ANY(
                                SELECT lower(btrim(d.name)) FROM unnest(${designated}::text[]) AS d(name)
                            )
                        )
                        OR EXISTS (
                            SELECT 1 FROM user_access_groups uag
                            JOIN access_groups ag ON ag.id = uag.group_id
                            WHERE uag.user_id = u.id
                              AND lower(btrim(ag.name)) = ANY(
                                SELECT lower(btrim(d.name)) FROM unnest(${designated}::text[]) AS d(name)
                              )
                        )
                    )`;

            const rows = await sql<
                { audience_size: number; sharing_count: number; hidden_count: number }[]
            >`
                SELECT
                    count(*)::int AS audience_size,
                    count(*) FILTER (
                        WHERE u.share_audiobook_activity
                          AND NOT COALESCE(u.hide_streams, false)
                    )::int AS sharing_count,
                    count(*) FILTER (WHERE COALESCE(u.hide_streams, false))::int AS hidden_count
                FROM users u
                WHERE ${live} AND ${inAudience}
            `.catch(() => null);

            if (rows === null) return ApiProblem.dependencyUnavailable('Database unavailable');
            const row = rows[0];

            return json({
                mode,
                audienceSize: row?.audience_size ?? 0,
                sharingCount: row?.sharing_count ?? 0,
                hiddenCount: row?.hidden_count ?? 0,
                configuredGroups: designated,
            });
        },
    },
});
