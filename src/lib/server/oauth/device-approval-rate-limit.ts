// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type { UserId } from '$lib/shared/user-id.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiProblem } from '$lib/server/api/problem.js';

/** Shared browser/bearer lookup and decision budgets. Code digests are never logged. */
export async function checkDeviceApprovalRateLimit(
    userId: UserId,
    normalizedCode: string,
    clientIp: string,
): Promise<Response | null> {
    const user = await checkRateLimit(`oauth:approval:user:${userId}`, 10, 60);
    if (!user.allowed)
        return ApiProblem.rateLimited(Math.max(1, user.resetAt - Math.floor(Date.now() / 1000)));
    const ip = await checkRateLimit(`oauth:approval:ip:${clientIp}`, 20, 60);
    if (!ip.allowed)
        return ApiProblem.rateLimited(Math.max(1, ip.resetAt - Math.floor(Date.now() / 1000)));
    const hash = createHash('sha256').update(normalizedCode).digest('hex');
    const code = await checkRateLimit(`oauth:approval:code:${userId}:${hash}`, 10, 60);
    if (!code.allowed)
        return ApiProblem.rateLimited(Math.max(1, code.resetAt - Math.floor(Date.now() / 1000)));
    return null;
}
