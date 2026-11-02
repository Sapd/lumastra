// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/gdpr-export — GDPR Art. 15 data export.
 *
 * GET /api/admin/users/:username/gdpr-export
 *   Returns a JSON attachment containing all per-user personal data.
 *   Raw response (application/json attachment — not the API envelope).
 *   Pre-stream errors use problem+json.
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { collectUserExport } from '$lib/server/database/queries/gdpr-export.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { attachmentDisposition } from '$lib/server/utils/content-disposition.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';

const logger = Logger.for('GdprExportEndpoint');

/**
 * `collectUserExport()` walks every per-user table; an export is a rare,
 * deliberate admin action, not a polling target. Mirrors the DELETE limiter in
 * `index.ts` (admin/users review 2026-10-07, item 8c).
 */
const EXPORT_RATE_LIMIT = { limit: 10, windowSeconds: 300 };

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    raw: true,
    handlers: {
        GET: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can export an admin's personal data",
            );
            if (ceilingErr) return ceilingErr;

            const requestedBy =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'unknown';
            const rl = await checkRateLimit(
                `gdpr-export:${getClientIpStrict(event)}:${requestedBy}`,
                EXPORT_RATE_LIMIT.limit,
                EXPORT_RATE_LIMIT.windowSeconds,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(
                    Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000)),
                );
            }

            logger.info('GDPR export requested', { targetUsername: username, requestedBy });

            const exportData = await collectUserExport(db, username);
            if (!exportData) return ApiProblem.notFound(`User '${username}' not found`);

            // Audit every export — GDPR Art. 15 requests should be traceable.
            auditLog('user.gdpr_export', username, auditActor(event), {
                targetUsername: username,
                exportedAt: exportData.exported_at,
            });

            const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const filename = `lumastra-export-${username}-${dateStr}.json`;
            const body = JSON.stringify(exportData, null, 2);

            return new Response(body, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    // The username is part of `filename` and is only validated as
                    // non-empty, so it can contain a quote.
                    'Content-Disposition': attachmentDisposition(filename),
                    'Cache-Control': 'no-store',
                },
            });
        },
    },
});
