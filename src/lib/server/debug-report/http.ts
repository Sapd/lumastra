// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Small HTTP helpers shared by the debug report defs (spec §3, §5.6): the
 * rate-limit key and the `Cache-Control: no-store` every report response carries.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { DebugReportConfigurationError } from './errors.js';

/** Headers of every debug report response, success or refusal. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = { 'Cache-Control': 'no-store' };

/** Adds `Cache-Control: no-store` to a response built elsewhere (a problem response). */
export function noStore(response: Response): Response {
    response.headers.set('Cache-Control', 'no-store');
    return response;
}

/**
 * Rate-limit key: one budget per credential and endpoint. A diagnostics token has
 * its own id; a session falls back to the user id.
 */
export function debugReportRateKey(event: RequestEvent, endpoint: string): string {
    const principal = event.locals.principal;
    const credential = principal?.credentialId ?? principal?.userId ?? 'anonymous';
    return `${principal?.kind ?? 'anonymous'}:${credential}:${endpoint}`;
}

/** Translate only the typed fail-closed config error; other errors keep their normal handling. */
export function debugReportFailure(error: unknown): Response {
    if (error instanceof DebugReportConfigurationError) {
        return noStore(ApiProblem.dependencyUnavailable('Configuration not loaded'));
    }
    throw error;
}
