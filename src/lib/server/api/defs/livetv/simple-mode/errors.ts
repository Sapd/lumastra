// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Maps simple-mode service errors to problem+json responses (self and admin defs). */

import { ApiProblem } from '$lib/server/api/problem.js';
import type { SimpleModeError } from '$lib/server/services/livetv/simple-mode.service.js';

export function simpleModeProblem(error: SimpleModeError): Response {
    switch (error.kind) {
        case 'pin_required':
            return ApiProblem.forbidden('This setup is locked; enter the PIN', {
                details: 'pin_required',
            });
        case 'pin_invalid':
            return ApiProblem.forbidden('Wrong PIN', { details: 'pin_invalid' });
        case 'rate_limited':
            return ApiProblem.rateLimited(error.retryAfter);
        case 'unknown_channel':
            return ApiProblem.notFound('Unknown channel');
        case 'invalid':
            return ApiProblem.validationFailed(error.message);
    }
}
