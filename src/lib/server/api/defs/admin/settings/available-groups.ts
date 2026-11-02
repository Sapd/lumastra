// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/available-groups.ts
 *
 * GET /api/admin/available-groups — every group name an admin can reference from
 * a group-valued setting (for group-picker UI components).
 *
 * ## Both sources, not just one
 *
 * This used to read `users.groups` alone. That column is the IdP projection —
 * written by the IdP-facing paths (forward-auth, device authorize, OIDC and
 * auth-plugin login/provisioning) and by the native-admin / admin-create paths
 * (`ADMIN_GROUPS` or `[]`) — and in-app access groups are deliberately never
 * written into it. So on a
 * native-auth install, or on any install where an in-app group exists that no IdP
 * also asserts, the picker came back EMPTY (or short) even though
 * `/admin/settings/access` had the group sitting right there. An admin would
 * create `bookclub`, add three members, then find nothing to select.
 *
 * The union mirrors the one `builders/social-visibility.builder.ts` computes at
 * read time for the same reason: `users.groups` ∪ `user_access_groups →
 * access_groups.name` is what "which groups does this person belong to" actually
 * means here, so it is also what "which groups exist" has to mean.
 *
 * Note the two sources differ in shape: `access_groups` rows exist whether or not
 * anyone is a member, while `users.groups` names only appear once some user
 * carries them. An empty in-app group is therefore listed — correctly, since an
 * admin may well configure the setting before populating the group.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET → { groups: string[] }
 * 503 → dependency_unavailable when DB is down
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // btrim + empty-drop on both arms: `users.groups` is stored verbatim from
            // the IdP and has been observed carrying padded entries, which would
            // otherwise surface as a blank-looking option that never matches.
            const rows = await sql<{ group_name: string }[]>`
                SELECT DISTINCT group_name FROM (
                    SELECT btrim(unnest(groups)) AS group_name
                    FROM users
                    WHERE groups IS NOT NULL
                    UNION
                    SELECT btrim(name) AS group_name
                    FROM access_groups
                ) AS all_groups
                WHERE group_name <> ''
                ORDER BY group_name
            `;
            return json({ groups: rows.map((r) => r.group_name) });
        },
    },
});
