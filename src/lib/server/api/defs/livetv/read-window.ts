// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { ApiProblem, problem } from '$lib/server/api/problem.js';

export const MAX_SPAN_SECONDS = 24 * 60 * 60;
export const ProgramsWindowSchema = z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
});

export function validateReadWindow(input: { from: string; to: string }): Response | null {
    const parsed = ProgramsWindowSchema.safeParse(input);
    if (!parsed.success) return ApiProblem.validationFailed(parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'), message: issue.message,
    })));
    const span = Date.parse(input.to) - Date.parse(input.from);
    if (span <= 0) return ApiProblem.validationFailed([{ field: 'to', message: 'Must be after from' }]);
    if (span > MAX_SPAN_SECONDS * 1000) return problem('validation_failed', {
        error: 'Time window exceeds maximum of 24 hours',
        details: { maxSpanSeconds: MAX_SPAN_SECONDS },
    });
    return null;
}

export function encodeGuideCursor(stationId: string): string {
    return Buffer.from(JSON.stringify({ v: 1, stationId })).toString('base64url');
}

export function decodeGuideCursor(cursor: string): string | null {
    try {
        const parsed = z.object({ v: z.literal(1), stationId: z.string().min(1) }).strict()
            .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
        return encodeGuideCursor(parsed.stationId) === cursor ? parsed.stationId : null;
    } catch {
        return null;
    }
}
