// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dismiss onboarding endpoint.
 * POST: Dismiss entire onboarding or a specific step.
 * Body: { step?: string } — if step is provided, dismiss that step; otherwise dismiss all.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    dismissAllOnboarding,
    dismissOnboardingStep,
} from '$lib/server/database/queries/onboarding.queries.js';
import { json } from '@sveltejs/kit';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const POST: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals, request }) => {
        if (!localsIsAdmin(locals)) {
            return ApiResponses.forbidden('Only admins can dismiss onboarding');
        }

        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiResponses.error(
                    'Database not available',
                    'Database connection not established',
                    503,
                );
            }

            const VALID_STEPS = new Set([
                'library_paths',
                'tmdb_config',
                'library_scan',
                'ai_config',
                'onboarding_dismissed',
            ]);

            const body = (await readBoundedJson(request).catch(() => ({}))) as Record<
                string,
                unknown
            >;
            const step = body?.step as string | undefined;
            const username = locals.user.username;

            if (step && !VALID_STEPS.has(step)) {
                return ApiResponses.badRequest('Invalid step key');
            }

            if (step) {
                await dismissOnboardingStep(sql, step, username);
            } else {
                await dismissAllOnboarding(sql, username);
            }

            return json({ success: true });
        } catch (error) {
            return ApiResponses.error('Failed to dismiss onboarding', error as Error);
        }
    }),
);
