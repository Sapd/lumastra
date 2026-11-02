// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiProblem } from '$lib/server/api/problem.js';
import type { CreateRequestOutcome } from '$lib/server/services/request-manager.service.js';

export function requestPermissionProblem(): Response {
    return ApiProblem.forbidden(
        'You do not have permission to submit media requests. Contact an administrator.',
    );
}

export function createOutcomeToProblem(outcome: CreateRequestOutcome): Response | null {
    switch (outcome.kind) {
        case 'created':
            return null;
        case 'not_permitted':
            return requestPermissionProblem();
        case 'rate_limited':
            return ApiProblem.rateLimited(
                Math.max(1, Math.ceil(outcome.resetAt - Date.now() / 1000)),
            );
        case 'unresolvable':
            switch (outcome.reason) {
                case 'unsupported_provider':
                    return ApiProblem.validationFailed(outcome.error ?? 'Unsupported provider');
                case 'not_found':
                    return ApiProblem.notFound('Media not found in TMDB');
                case 'api_error':
                    return ApiProblem.badGateway(outcome.error ?? 'Provider API error');
                default:
                    return ApiProblem.validationFailed(
                        outcome.error ?? 'Failed to resolve media ID',
                    );
            }
        case 'dependency_unavailable':
            return ApiProblem.dependencyUnavailable('Jellyseerr is not reachable');
        case 'quota_exceeded':
            return ApiProblem.quotaExceeded(
                {
                    bucket: outcome.bucket,
                    limit: outcome.limit,
                    used: outcome.used,
                    remaining: 0,
                },
                {
                    error: `${outcome.bucket === 'movie' ? 'Movie' : 'Series'} request quota exhausted — resets in ${outcome.days} day(s).`,
                },
            );
        case 'create_failed':
            return ApiProblem.badGateway(outcome.error);
    }
}
