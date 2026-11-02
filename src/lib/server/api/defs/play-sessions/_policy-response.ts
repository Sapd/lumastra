// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { problem } from '$lib/server/api/problem.js';
import { PlayMethodSchema } from '$lib/schemas/play-sessions.js';
import type { PolicyError } from '$lib/server/services/play-sessions.service.js';

export function playbackPolicyResponse(error: PolicyError): Response {
    switch (error.kind) {
        case 'prefetch_requires_current_session':
            return problem('prefetch_requires_current_session', { details: { suggestion: 'Start with purpose=play' } });
        case 'stream_limit_exceeded':
            return problem('stream_limit', {
                status: 422,
                details: { active: error.active, limit: error.limit },
            });
        case 'download_limit_exceeded':
            return problem('quota_exceeded', {
                error: 'Too many audiobook downloads are prepared at once; finish or cancel one first.',
                details: {
                    bucket: 'audiobook_downloads',
                    limit: error.limit,
                    used: error.active,
                    remaining: 0,
                },
            });
        case 'transcode_not_allowed':
            return problem('transcode_not_allowed', {
                details: {
                    allowedMethods: error.allowed_methods.flatMap((method) => {
                        const parsed = PlayMethodSchema.safeParse(method);
                        return parsed.success ? [parsed.data] : [];
                    }),
                    suggestion: error.suggestion,
                },
            });
        case 'ip_restriction':
            return problem('ip_restricted', {
                details: { graceRemainingSeconds: error.grace_remaining_seconds },
            });
        case 'source_incompatible': {
            const requested = PlayMethodSchema.safeParse(error.requested);
            return problem('source_incompatible', {
                details: {
                    requestedMethod: requested.success ? requested.data : undefined,
                    reason: error.reason,
                    suggestion: error.suggestion,
                },
            });
        }
        case 'plugin_denied':
            return problem('plugin_denied', {
                details: { plugin: error.plugin, reason: error.reason },
            });
    }
}
