// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/diagnostics/[id]/github-report.ts
 *
 * GET /api/admin/diagnostics/{id}/github-report — a redacted, allowlist-projected
 * report of a Jellyfin-client (/j) diagnostic, plus a prefilled GitHub issue URL.
 * Nothing is sent anywhere: the admin's browser opens the URL.
 *
 * The builder lives in the jellyfin-compat tree and is resolved via
 * the AGPL registry (module boundary). 404 when none is registered (AGPL-only
 * build), 409 when the row is not a /j diagnostic.
 *
 * Auth: admin. Internal surface only — see ../index.ts's doc comment.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { deriveSubSecret } from '$lib/server/crypto/secret-box.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getClientDiagnosticById,
    getLogBundleBlob,
} from '$lib/server/database/queries/client-diagnostics.queries.js';
import { EVENT_LIMITS, GithubReportResponseSchema } from '$lib/schemas/client-diagnostics.js';
import {
    inflateBounded,
    InflateLimitError,
    InflateFormatError,
} from '$lib/server/services/client-diagnostics/gzip.js';
import {
    withBundleSlot,
    BundleBusyError,
} from '$lib/server/services/client-diagnostics/semaphore.js';
import {
    getJellyfinReportBuilder,
    isJellyfinReportable,
} from '$lib/server/compat/jellyfin-report-provider.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const logger = Logger.for('AdminDiagnostics:GithubReport');

// Bounded: a 20-digit id is an "integer" to zod and an out-of-range 500 to Postgres.
const ParamsSchema = z.object({
    id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

// Fallback when no master key is configured: tags then differ per restart.
const processSecret = randomBytes(32).toString('hex');

function idTagSecret(): string {
    return deriveSubSecret(resolveMasterKey(), 'github-report-id-tags') || processSecret;
}

/**
 * This server's own host names — configured public origins plus the Host the admin
 * reached it by — so the builder can scrub them from free text (log excerpts name
 * the server the app connected to). Hostnames only; ports are scrubbed separately.
 */
function serverHosts(event: RequestEvent): string[] {
    const out = new Set<string>();
    const add = (v: string | null | undefined): void => {
        const raw = v?.split(',')[0]?.trim();
        if (!raw) return;
        try {
            const host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname;
            if (host) out.add(host.replace(/^\[|\]$/g, '').toLowerCase());
        } catch {
            // not a URL/host: nothing to scrub
        }
    };
    add(config.PUBLIC_BASE_URL);
    add(config.DEVICE_VERIFICATION_BASE_URL);
    add(process.env.ORIGIN);
    add(event.url?.host);
    add(event.request?.headers.get('host'));
    add(event.request?.headers.get('x-forwarded-host'));
    return [...out];
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { params: ParamsSchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Diagnostics'],
            summary: 'Redacted GitHub report for a Jellyfin-client diagnostic',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Builds a redacted report (ids hashed; IPs, tokens, emails, URL hosts and the ' +
                "server's own host names removed; a log excerpt can still hold titles, names or " +
                'paths) and a prefilled ' +
                'GitHub issue URL for a /j-sourced diagnostic. Only compat incidents and Jellyfin ' +
                'client log uploads qualify.',
            responses: {
                200: { schema: GithubReportResponseSchema, description: 'Redacted report' },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'Diagnostic not found, or not available in this build',
                409: 'Not a Jellyfin-client diagnostic',
                503: 'Database unavailable or busy',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const build = getJellyfinReportBuilder();
            if (!build) return ApiProblem.notFound('Not available in this build');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { id } = ctx.input!.params!;
            const row = await getClientDiagnosticById(sql, id);
            if (!row) return ApiProblem.notFound('Diagnostic not found');
            const payload = (row.payload ?? {}) as Record<string, unknown>;
            if (!isJellyfinReportable({ kind: row.kind, payload })) {
                return ApiProblem.conflict('Only Jellyfin-client diagnostics can be reported here');
            }

            let logText: string | null = null;
            if (row.kind === 'log_bundle') {
                const blob = await getLogBundleBlob(sql, id);
                if (blob) {
                    try {
                        const inflated = await withBundleSlot(() =>
                            inflateBounded(blob.content, EVENT_LIMITS.bundleInflatedBytes, {
                                keepText: true,
                            }),
                        );
                        logText = inflated.text ?? null;
                    } catch (err) {
                        if (err instanceof BundleBusyError) {
                            return ApiProblem.dependencyUnavailable('busy, retry shortly');
                        }
                        if (err instanceof InflateLimitError || err instanceof InflateFormatError) {
                            // Corrupt/oversized bundle: report without the log excerpt.
                            logger.warn('github-report: log bundle unreadable, omitting excerpt', {
                                id,
                                error: err.message,
                            });
                            logText = null;
                        } else {
                            throw err;
                        }
                    }
                }
            }

            auditLog('client_diagnostics.github_report', String(id), auditActor(event), {});
            return json(
                GithubReportResponseSchema.parse(
                    build({
                        serverVersion: config.APP_VERSION,
                        secret: idTagSecret(),
                        kind: row.kind,
                        platform: row.platform,
                        appVersion: row.app_version ?? null,
                        occurredAt: new Date(row.occurred_at).toISOString(),
                        payload,
                        logText,
                        serverHosts: serverHosts(event),
                    }),
                ),
            );
        },
    },
});
