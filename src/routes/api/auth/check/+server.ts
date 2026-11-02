// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — auth-state probe; reachable pre-auth

// Auth check endpoint - returns 200 if authenticated, will get 302 from Authentik if not
import { z } from 'zod';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import type { RequestHandler } from './$types';

const AuthCheckResponseSchema = z
    .object({
        authenticated: z.boolean(),
        timestamp: z.string(),
    })
    .passthrough();

export const GET: RequestHandler = withErrorHandler(async () => {
    // If we reach here, user is authenticated (Authentik didn't redirect)
    return typedJson(
        AuthCheckResponseSchema,
        {
            authenticated: true,
            timestamp: new Date().toISOString(),
        },
        {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                Pragma: 'no-cache',
            },
        },
    );
});
