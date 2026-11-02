// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-safe json() replacement that validates responses against Zod schemas in dev mode.
 * In production: zero overhead, just calls json().
 *
 * Usage:
 *   import { typedJson } from '$lib/server/utils/typed-response.js';
 *   import { MyResponseSchema } from '$lib/schemas/my-responses.js';
 *   return typedJson(MyResponseSchema, { field: 'value' });
 */

import { json } from '@sveltejs/kit';
import { type ZodType, type z } from 'zod';
import { dev } from '$app/environment';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('TypedResponse');

/** Extract the caller's file path from a stack trace */
function getCallerLocation(): string {
    const stack = new Error().stack;
    if (!stack) return 'unknown';

    // Skip: Error, getCallerLocation, typedJson → caller is frame 3+
    const lines = stack.split('\n');
    for (const line of lines.slice(3)) {
        // Match file paths like /src/routes/api/foo/+server.ts:123
        const match = line.match(/(src\/routes\/[^\s:)]+(?::\d+)?)/);
        if (match) return match[1];
    }

    // Fallback: any src/ path
    for (const line of lines.slice(3)) {
        const match = line.match(/(src\/[^\s:)]+(?::\d+)?)/);
        if (match) return match[1];
    }

    return 'unknown';
}

/**
 * Type-safe json() replacement that validates responses against Zod schemas in dev mode.
 * In production: zero overhead, just calls json().
 */
export function typedJson<S extends ZodType>(
    schema: S,
    data: z.infer<S>,
    init?: ResponseInit,
): Response {
    if (!dev) {
        return json(data, init);
    }

    // Dev mode: validate and check for stripped fields
    try {
        const parseResult = schema.safeParse(data);

        if (!parseResult.success) {
            const caller = getCallerLocation();
            logger.error(`Response validation failed in ${caller}`, parseResult.error as Error, {
                fields: parseResult.error.flatten().fieldErrors,
            });
            // Fail open — still return the data
            return json(data, init);
        }

        // Check for stripped fields (schema too narrow)
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            const originalKeys = Object.keys(data as Record<string, unknown>);
            const parsedKeys = Object.keys(parseResult.data as Record<string, unknown>);
            const strippedKeys = originalKeys.filter((k) => !parsedKeys.includes(k));

            if (strippedKeys.length > 0) {
                const caller = getCallerLocation();
                logger.warn(`Schema strips fields in ${caller} — update schema to include them`, {
                    strippedFields: strippedKeys,
                });
            }
        }
    } catch (err) {
        logger.error('typedJson validation threw', err as Error);
    }

    return json(data, init);
}
