// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — dev-only; returns 404 in production

import { z } from 'zod';
import { dev } from '$app/environment';
import { typedJson } from '$lib/server/utils/typed-response.js';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';

const TestAuthResponseSchema = z
    .object({
        success: z.boolean().optional(),
        message: z.string().optional(),
        error: z.string().optional(),
    })
    .passthrough();

/**
 * Test endpoint to simulate authentication failures
 * Only available in development mode
 */
export const GET: RequestHandler = withErrorHandler(async ({ url }) => {
    if (!dev) {
        return new Response(null, { status: 404 });
    }

    const mode = url.searchParams.get('mode');

    switch (mode) {
        case '401':
            return new Response(JSON.stringify({ error: 'Authentication required' }), {
                status: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Auth-Required': 'true',
                },
            });

        case '403':
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
                status: 403,
                headers: {
                    'Content-Type': 'application/json',
                },
            });

        case 'network-error':
            // Simulate a network error by throwing
            throw new Error('Network error');

        case 'auth-message':
            // Simulate auth error in successful response
            return typedJson(TestAuthResponseSchema, {
                error: 'Authentication required',
                message: 'No authentication headers present',
            });

        default:
            return typedJson(TestAuthResponseSchema, {
                success: true,
                message: 'Test endpoint working',
            });
    }
});
