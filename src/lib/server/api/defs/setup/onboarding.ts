// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/setup/onboarding.ts
 *
 *   GET  /api/v1/setup/onboarding  — read instance-wide onboarding state
 *   PATCH /api/v1/setup/onboarding — dismiss all or a specific step
 *
 * Singleton setup-state resource. Instance-wide; admin-only.
 *
 * PATCH body: { dismiss: 'all' | <stepKey> }
 * On success: returns the updated onboarding state (200).
 *
 * Auth: {kind:'admin'} — both GET and PATCH require admin.
 *
 * This def was already using the def+mount() pattern inline inside
 * `src/routes/api/v1/setup/onboarding/+server.ts`; moved here (unchanged
 * behaviour) so `docs` can be embedded verbatim from the former sibling
 * `_openapi.ts`, matching the standard Phase 3 defs/ layout.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getOnboardingSteps,
    autoDetectOnboardingCompletion,
    dismissOnboardingStep,
    dismissAllOnboarding,
} from '$lib/server/database/queries/onboarding.queries.js';
import type { OnboardingStep as OnboardingStepRow } from '$lib/server/database/queries/onboarding.queries.js';
import { isRecord } from '$lib/utils/data-extraction.js';

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

/** Valid step keys — mirrors the onboarding_state seed data. */
const VALID_STEPS = new Set([
    'library_paths',
    'tmdb_config',
    'library_scan',
    'ai_config',
    'onboarding_dismissed',
]);

/**
 * The real accepted `dismiss` grammar: the literal 'all' plus every known step
 * key. Both the mount() gate and the published OpenAPI request schema derive
 * from the same VALID_STEPS set (never a hardcoded copy) so the contract and
 * the handler's whitelist can never drift.
 */
const DISMISS_TARGETS = ['all', ...VALID_STEPS] as [string, ...string[]];

/**
 * PATCH body schema for /setup/onboarding — used as BOTH the mount() gate and
 * the documented request schema. `dismiss` is required and closed to
 * {'all'} ∪ VALID_STEPS; unknown fields are stripped. The handler re-checks
 * VALID_STEPS as defense-in-depth (and for the legacy non-mount path).
 */
const OnboardingPatchBodySchema = z.object({
    dismiss: z
        .enum(DISMISS_TARGETS)
        .describe('"all" to dismiss every step, or a specific step key'),
});

const OnboardingStepSchema = z.object({
    key: z.string(),
    completed: z.boolean(),
    dismissed: z.boolean(),
    dismissedBy: z.string().nullable().optional(),
    dismissedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
});

/**
 * Map a raw onboarding_steps row (snake_case) to the camelCase response shape.
 * Both GET and PATCH build their `steps` array identically — keep them in sync
 * by mapping through this helper so the response matches OnboardingStepSchema.
 */
function mapOnboardingStep(s: OnboardingStepRow) {
    return {
        key: s.step_key,
        completed: s.completed,
        dismissed: s.dismissed,
        dismissedBy: s.dismissed_by ?? undefined,
        dismissedAt: s.dismissed_at ?? undefined,
        completedAt: s.completed_at ?? undefined,
    };
}

const OnboardingResponseSchema = z.object({
    allDismissed: z.boolean().meta({ description: 'True when all steps have been dismissed' }),
    steps: z.array(OnboardingStepSchema),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get onboarding state',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns the instance-wide onboarding state. Admin-only.',
            responses: {
                200: { schema: OnboardingResponseSchema, description: 'Onboarding state' },
                401: 'Authentication required',
                403: 'Admin required',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Admin'],
            summary: 'Dismiss onboarding step(s)',
            stability: 'stable',
            auth: 'bearer',
            description: 'Dismisses all onboarding steps or a specific step by key. Admin-only.',
            body: OnboardingPatchBodySchema,
            responses: {
                200: { schema: OnboardingResponseSchema, description: 'Updated onboarding state' },
                400: 'Validation error',
                401: 'Authentication required',
                403: 'Admin required',
                404: 'Step key not found',
                500: 'Internal server error',
            },
        },
    },
    request: {
        // PATCH reads the body; GET has no input contract.
        // body is only validated on PATCH/PUT/POST/DELETE — GET is unaffected.
        body: OnboardingPatchBodySchema,
    },
    handlers: {
        GET: async (_event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            await autoDetectOnboardingCompletion(sql);
            const steps = await getOnboardingSteps(sql);
            const allDismissed =
                steps.find((s) => s.step_key === 'onboarding_dismissed')?.dismissed ?? false;

            return json({ steps: steps.map(mapOnboardingStep), allDismissed });
        },

        PATCH: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed([
                    { field: 'body', message: 'Request body must be valid JSON' },
                ]);
            }

            if (!isRecord(body)) {
                return ApiProblem.validationFailed([
                    { field: 'body', message: 'Expected JSON object' },
                ]);
            }

            const dismiss = body.dismiss as string | undefined;
            if (typeof dismiss !== 'string' || !dismiss) {
                return ApiProblem.validationFailed([
                    { field: 'dismiss', message: '"dismiss" is required (\'all\' or a step key)' },
                ]);
            }

            const adminUsername =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'unknown';

            if (dismiss === 'all') {
                await dismissAllOnboarding(sql, adminUsername);
            } else {
                if (!VALID_STEPS.has(dismiss)) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'dismiss',
                            message: `Unknown step key: ${dismiss}. Valid values: ${[...VALID_STEPS].join(', ')}`,
                        },
                    ]);
                }
                await dismissOnboardingStep(sql, dismiss, adminUsername);
            }

            // Return the updated state
            const steps = await getOnboardingSteps(sql);
            const allDismissed =
                steps.find((s) => s.step_key === 'onboarding_dismissed')?.dismissed ?? false;

            return json({ steps: steps.map(mapOnboardingStep), allDismissed });
        },
    },
});
