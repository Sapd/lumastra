// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/health/config — config doctor report over HTTP (admin only).
//
// Same checks the CLI (`npm run doctor`) and the container boot STEP 0 run, but
// queryable at runtime so the admin UI can surface a config error/warning banner
// without an operator shelling into the container. Admin-gated because it
// reflects server configuration.

import type { RequestHandler } from './$types.js';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { runConfigDoctor, runConfigDoctorWithDb } from '$lib/server/preflight/config-doctor.js';
import { toConfigHealthView } from '$lib/server/preflight/config-health-view.js';
import { getDb } from '$lib/server/database/connection.js';
import { ConfigHealthResponseSchema } from '$lib/schemas/api-admin-responses.js';
import {
    workerPresence,
    WORKER_MISSING_MESSAGE,
    WORKER_MISSING_REMEDIATION,
} from '$lib/server/services/worker-presence.service.js';

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        // Use the DB-aware doctor so the response also flags an embedding column
        // dimension mismatch (provider switched without migrating the vector
        // column). Falls back to the env-only report when no DB handle is
        // available — the doctor must never throw here.
        const sql = getDb();
        const report = sql ? await runConfigDoctorWithDb(sql) : runConfigDoctor();
        // The banner renders what this endpoint returns; `embedding.no-provider`
        // is filtered out here because the attention bell owns it now.
        const view = toConfigHealthView(report);
        const e = report.resolved.embedding;
        // Runtime, not config: no dedicated worker heartbeat after the startup
        // grace (an upgrade without the worker container). An error, so the
        // banner cannot be dismissed while nothing runs in the background.
        const issues = [...view.issues];
        if (workerPresence.get().status === 'missing') {
            issues.unshift({
                category: 'runtime',
                severity: 'error',
                code: 'runtime.worker-missing',
                message: WORKER_MISSING_MESSAGE,
                remediation: WORKER_MISSING_REMEDIATION,
            });
        }
        const runtimeErrors = issues.length - view.issues.length;
        return typedJson(ConfigHealthResponseSchema, {
            ok: view.ok && runtimeErrors === 0,
            errorCount: view.errorCount + runtimeErrors,
            warningCount: view.warningCount,
            issues: issues.map((i) => ({
                category: i.category,
                severity: i.severity,
                code: i.code,
                message: i.message,
                remediation: i.remediation,
            })),
            embedding: {
                provider: e.provider,
                model: e.model,
                dimensions: e.dimensions,
                modelSource: e.modelSource,
                dimensionSource: e.dimensionSource,
                hasProvider: e.hasProvider,
            },
        });
    }),
);
