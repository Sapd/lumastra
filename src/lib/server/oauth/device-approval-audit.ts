// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip.js';
import { getTcpPeer } from '$lib/server/utils/tcp-peer.js';
import { auditActor, auditLog } from '$lib/server/utils/audit-log.js';

/** Also used at the authentication boundary, which may reject before mount. */
export async function auditDeviceApprovalFailure(
    event: RequestEvent,
    response: Response,
): Promise<void> {
    if (response.status < 400 || event.route?.id !== '/api/v1/oauth/device/approve') return;
    try {
        const actor = auditActor(event);
        const key = createHash('sha256')
            .update(
                JSON.stringify([
                    actor.kind ?? 'anonymous',
                    actor.credentialId ??
                        event.locals.principal?.userId ??
                        getClientIpStrictFromRequest(event.request, () => getTcpPeer(event)),
                ]),
            )
            .digest('hex');
        // Independent of the guessing limiter: refused credential kinds and
        // malformed bodies must be visible without making audit storage floodable.
        if (!(await checkRateLimit(`oauth:approval:audit:${key}`, 3, 60)).allowed) return;
        const reason =
            (
                {
                    401: 'unauthorized',
                    403: 'credential_forbidden',
                    404: 'code_unavailable',
                    413: 'body_too_large',
                    422: 'invalid_request',
                    429: 'rate_limited',
                    503: 'dependency_unavailable',
                } as Record<number, string>
            )[response.status] ?? 'request_failed';
        auditLog('oauth.device.approve_denied', 'device-approval', actor, {
            principalKind: actor.kind ?? 'anonymous',
            credentialId: actor.credentialId ?? null,
            reason,
        });
    } catch {
        // Audit is best effort, like auditLog's database sink. Never log request
        // bodies, URLs or error messages here: all may contain the user code.
    }
}
