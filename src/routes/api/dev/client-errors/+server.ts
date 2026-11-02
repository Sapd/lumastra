// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — dev-only; returns 404 in production

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('dev:client-errors');

const LOG_FILE = resolve('client-errors.log');

/**
 * POST /api/dev/client-errors
 * Dev-only endpoint that appends client-side errors to client-errors.log.
 * Accepts schema mismatches and other client errors for easier debugging.
 */
export const POST: RequestHandler = withErrorHandler(async ({ request }) => {
    if (!dev) {
        return new Response(null, { status: 404 });
    }

    try {
        const body = (await readBoundedJson(request)) as {
            endpoint?: string;
            type?: string;
            errors?: unknown;
            timestamp?: string;
        };

        const line = JSON.stringify({
            time: body.timestamp || new Date().toISOString(),
            type: body.type || 'unknown',
            endpoint: body.endpoint || '',
            errors: body.errors,
        });

        await appendFile(LOG_FILE, line + '\n', 'utf-8');

        return new Response(null, { status: 204 });
    } catch (e) {
        logger.warn('Failed to write client error log', { error: e });
        return new Response(null, { status: 500 });
    }
});
