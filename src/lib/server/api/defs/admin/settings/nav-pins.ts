// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/nav-pins.ts
 *
 * GET    /api/admin/nav-pins — list all navigation pins
 * POST   /api/admin/nav-pins — add a navigation pin
 * DELETE /api/admin/nav-pins — remove a navigation pin
 *
 * POST and DELETE carry different body shapes, so body validation is done
 * per-handler rather than at the def level.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET    → { pins: NavPin[] }
 * POST   → { message: string, href: string }
 * DELETE → { message: string, href: string }
 * 503    → dependency_unavailable when DB is down
 * 422    → validation_failed on bad body
 * 404    → not_found when pin doesn't exist (DELETE)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getNavPins,
    addNavPin,
    removeNavPin,
    type AdminNavPinRow,
} from '$lib/server/database/queries/index.js';
import { adminNavPinBodySchema, adminNavUnpinBodySchema } from '$lib/schemas/common.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAllAdminNavPaths } from '$lib/config/admin-nav.js';

const logger = Logger.for('AdminNavPins');
const MAX_PINS = 10;

function transformRow(row: AdminNavPinRow) {
    return {
        href: row.href,
        label: row.label,
        sortOrder: row.sort_order,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rows = await getNavPins.all(sql, {});
            return json({ pins: rows.map(transformRow) });
        },

        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid request body');
            }
            const parsed = adminNavPinBodySchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }

            const { href, label } = parsed.data;
            // Only a page of the nav manifest can be pinned: the admin layout
            // hides any other pin on load, so it would be saved, never shown,
            // impossible to unpin from the UI, and still count toward the cap.
            if (!getAllAdminNavPaths().has(href)) {
                return ApiProblem.validationFailed([
                    { field: 'href', message: 'Only admin navigation pages can be pinned' },
                ]);
            }

            const existing = await getNavPins.all(sql, {});
            // The insert is an upsert on href, so re-pinning (a label change)
            // never adds a row and must not be refused at the cap.
            const isNew = !existing.some((p) => p.href === href);
            if (isNew && existing.length >= MAX_PINS) {
                return ApiProblem.validationFailed(`Maximum ${MAX_PINS} pinned items allowed`);
            }

            await addNavPin.execute(sql, { href, label });
            logger.info('Nav pin added', { href, label });

            return json({ message: 'Pin added', href });
        },

        DELETE: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid request body');
            }
            const parsed = adminNavUnpinBodySchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }

            const { href } = parsed.data;
            const result = await removeNavPin.all(sql, { href });

            if (result.length === 0) {
                return ApiProblem.notFound('Pinned item not found');
            }

            logger.info('Nav pin removed', { href });
            return json({ message: 'Pin removed', href });
        },
    },
});
