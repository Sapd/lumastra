// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/security-self-check-run — admin security self-check trigger endpoint def.
 *
 * POST /api/admin/security-self-check/run → bare SecuritySelfCheckReport object.
 * Auth: admin. Errors: problem+json incl. 503 dependency_unavailable.
 *
 * The only side effect is an ephemeral, read-scoped service token minted for the
 * forward-auth reflection probe (TTL ~120s), revoked after the run. All checks are
 * otherwise read-only.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { config, features } from '$lib/server/config.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { runSecuritySelfCheck } from '$lib/server/services/security-self-check/runner.js';

/**
 * Resolve the public base URL used for edge probes. Prefer the dedicated
 * PUBLIC_BASE_URL; fall back to DEVICE_VERIFICATION_BASE_URL for backward
 * compatibility. Returns null so edge probes report `skipped` when neither is set.
 */
function resolveEdgeBaseUrl(): string | null {
    const configured = (config.PUBLIC_BASE_URL || config.DEVICE_VERIFICATION_BASE_URL).trim();
    return configured ? configured : null;
}

/**
 * Install-wide single-flight: each run mints a service token and probes the
 * public edge, so concurrent runs (two tabs, two admins, two replicas) share
 * one. The TTL bounds a lock whose holder died; a run takes well under it.
 */
const RUN_LOCK_KEY = 'security-self-check:running';
const RUN_LOCK_TTL_SEC = 120;

async function acquireRunLock(): Promise<'acquired' | 'busy' | 'no-lock'> {
    const client = getCoordinationClient();
    if (!client) return 'no-lock';
    try {
        const res = await client.customCommand([
            'SET',
            RUN_LOCK_KEY,
            '1',
            'NX',
            'EX',
            String(RUN_LOCK_TTL_SEC),
        ]);
        return res === 'OK' ? 'acquired' : 'busy';
    } catch {
        // Valkey hiccup: the declarative rate limit still bounds runs.
        return 'no-lock';
    }
}

async function releaseRunLock(): Promise<void> {
    try {
        await getCoordinationClient()?.customCommand(['DEL', RUN_LOCK_KEY]);
    } catch {
        // The TTL frees it.
    }
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    // Restores the limit the route had before the mount migration (it used
    // withAdminHeavyRateLimit). Install-wide key: every admin and replica
    // shares one budget, because each run mints a token and hits the edge.
    rateLimit: { limit: 3, windowSec: 60, keyBy: () => 'admin:security-self-check' },
    handlers: {
        POST: async (event, _ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'Security self-check requires a database connection',
                );
            }

            const adminUsername = event.locals.user?.username;
            if (!adminUsername) {
                // requireAdmin (via enforce) already guarantees an admin user, but the
                // mintToken closure needs a resolvable creator username — guard defensively.
                return ApiProblem.unauthorized();
            }

            const baseUrl = resolveEdgeBaseUrl();

            /**
             * Mint a short-lived (~120s), READ-scoped service token for the
             * forward-auth reflection probe. When device auth is disabled the /api/v1
             * surface hard-503s, so we fail the mint loudly — the edge-probe family
             * treats a mint failure as `skipped` (never `fail`), keeping the report honest.
             */
            const mintToken = async (): Promise<{
                token: string;
                revoke: () => Promise<void>;
            }> => {
                if (!features.deviceAuth) {
                    throw new Error(
                        'Device auth is disabled; ephemeral service tokens cannot be minted.',
                    );
                }
                const service = getServiceTokenService();
                const { token, id } = await service.create({
                    name: `security-self-check-${Date.now()}`,
                    description:
                        'Ephemeral token for the admin security self-check forward-auth probe',
                    createdBy: adminUsername,
                    scopes: ['read'],
                    // ~120 seconds expressed in days — enough headroom for the round-trip
                    // through the edge under clock skew; the edge-probe family also revokes
                    // the token explicitly after the probe.
                    expiresInDays: 120 / 86_400,
                });
                return {
                    token,
                    revoke: async () => {
                        await service.revoke(id);
                    },
                };
            };

            const lock = await acquireRunLock();
            if (lock === 'busy') {
                return problem('conflict', {
                    error: 'A security self-check is already running. Try again in a moment.',
                    retryAfter: 10,
                });
            }

            let report;
            try {
                report = await runSecuritySelfCheck({ sql, baseUrl, mintToken });
            } finally {
                if (lock === 'acquired') await releaseRunLock();
            }

            // Re-stamp ranAt at the route boundary (runner already stamps it; this
            // keeps the timestamp authoritative at the response edge).
            report.ranAt = new Date().toISOString();

            // It mints a service token and probes the public edge — record who ran it.
            auditLog('security.self-check.run', 'security', auditActor(event), {
                ...report.summary,
            });

            return json(report);
        },
    },
});
