// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { problem } from '$lib/server/api/problem.js';

export { AuthDependencyUnavailableError, isDependencyError } from './dependency-error.js';

export function authUnavailableResponse(options?: { beforeHandler?: boolean }): Response {
    const response = problem('dependency_unavailable', {
        error: 'Authentication temporarily unavailable. Retrying shortly.',
        retryAfter: 5,
    });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Lumastra-Auth-Unavailable', 'true');
    // Only the central auth gate can promise a mutation never reached its handler.
    if (options?.beforeHandler) response.headers.set('X-Lumastra-Auth-Retry', 'true');
    return response;
}
